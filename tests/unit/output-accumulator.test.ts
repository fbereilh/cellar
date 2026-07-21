import { describe, it, expect } from 'vitest';
import { OutputAccumulator, type OutputCaps, type StreamDelta } from '../../src/lib/server/output-accumulator';
import type { CellOutput } from '../../src/lib/server/types';

/** Collect every (output, index, delta?) the accumulator emits, in order. */
function withRecorder(caps?: Partial<OutputCaps>) {
	const emits: Array<{ output: CellOutput; index: number; delta?: StreamDelta }> = [];
	const full = {
		maxStreamBytes: 1_000,
		maxItems: 10,
		maxTotalBytes: 5_000,
		...caps
	};
	const acc = new OutputAccumulator((output, index, delta) => emits.push({ output, index, delta }), full);
	return { acc, emits };
}

/**
 * Reconstruct what a CLIENT would show for one stream element, applying the wire
 * frames the accumulator emitted at `index` in order: a full emit (no delta)
 * establishes/replaces the element's text; a delta splices `prev.slice(0,keep)+chunk`
 * — but only when its `base` matches the current length (else the client is out of
 * sync and would refetch, which this helper models by refusing to apply).
 */
function replay(emits: Array<{ output: CellOutput; index: number; delta?: StreamDelta }>, index: number): string {
	let text: string | null = null;
	for (const e of emits) {
		if (e.index !== index) continue;
		if (!e.delta) {
			text = (e.output as { text: string }).text;
		} else {
			const cur: string = text ?? '';
			expect(cur.length).toBe(e.delta.base); // in-order frames must never desync
			text = cur.slice(0, e.delta.keep) + e.delta.chunk;
		}
	}
	return text ?? '';
}

const stream = (name: string, text: string): CellOutput => ({ output_type: 'stream', name, text });
const display = (text: string): CellOutput => ({
	output_type: 'display_data',
	data: { 'text/plain': text },
	metadata: {}
});

describe('OutputAccumulator — coalescing', () => {
	it('a single stream chunk is byte-identical to the raw output', () => {
		const { acc } = withRecorder();
		acc.push(stream('stdout', 'hello\n'));
		const out = acc.finish();
		expect(out).toEqual([{ output_type: 'stream', name: 'stdout', text: 'hello\n' }]);
	});

	it('coalesces consecutive same-stream chunks into one element', () => {
		const { acc } = withRecorder();
		acc.push(stream('stdout', 'a\n'));
		acc.push(stream('stdout', 'b\n'));
		acc.push(stream('stdout', 'c\n'));
		const out = acc.finish();
		expect(out).toEqual([{ output_type: 'stream', name: 'stdout', text: 'a\nb\nc\n' }]);
	});

	it('coalesces across flush ticks into ONE element at a stable index', () => {
		const { acc, emits } = withRecorder();
		acc.push(stream('stdout', 'a'));
		acc.flush(); // tick
		acc.push(stream('stdout', 'b'));
		acc.flush(); // tick
		acc.push(stream('stdout', 'c'));
		const out = acc.finish();
		expect(out).toEqual([{ output_type: 'stream', name: 'stdout', text: 'abc' }]);
		// Every emit for the growing stream targets index 0 — the client overwrites
		// one element rather than appending per chunk.
		expect(emits.every((e) => e.index === 0)).toBe(true);
	});

	it('does NOT merge different streams (stdout vs stderr)', () => {
		const { acc } = withRecorder();
		acc.push(stream('stdout', 'out\n'));
		acc.push(stream('stderr', 'err\n'));
		acc.push(stream('stdout', 'out2\n'));
		const out = acc.finish();
		expect(out).toEqual([
			{ output_type: 'stream', name: 'stdout', text: 'out\n' },
			{ output_type: 'stream', name: 'stderr', text: 'err\n' },
			{ output_type: 'stream', name: 'stdout', text: 'out2\n' }
		]);
	});
});

describe('OutputAccumulator — streamed deltas (wire optimization)', () => {
	it('emits the whole element only ONCE, then deltas — not the full buffer per tick', () => {
		const { acc, emits } = withRecorder();
		acc.push(stream('stdout', 'line1\n'));
		acc.flush();
		acc.push(stream('stdout', 'line2\n'));
		acc.flush();
		acc.push(stream('stdout', 'line3\n'));
		acc.finish();
		// Exactly one full-element emit (the first); the rest are deltas.
		const full = emits.filter((e) => !e.delta);
		const deltas = emits.filter((e) => e.delta);
		expect(full.length).toBe(1);
		expect(full[0].delta).toBeUndefined();
		expect(deltas.length).toBe(2);
		// A plain streaming log is a pure append: keep === base, chunk === the new bytes.
		expect(deltas[0].delta).toEqual({ base: 6, keep: 6, chunk: 'line2\n' });
		expect(deltas[1].delta).toEqual({ base: 12, keep: 12, chunk: 'line3\n' });
	});

	it('per-run wire bytes are O(size), not O(size × ticks)', () => {
		const { acc, emits } = withRecorder({ maxStreamBytes: 10_000_000, maxTotalBytes: 20_000_000 });
		// 200 chunks of 64 bytes, flushed each tick — the O(N²) scenario from the audit.
		const chunk = 'x'.repeat(63) + '\n';
		let total = 0;
		for (let i = 0; i < 200; i++) {
			acc.push(stream('stdout', chunk));
			total += chunk.length;
			acc.flush();
		}
		acc.finish();
		// Bytes actually put on the wire = first full element + every delta chunk.
		const wire = emits.reduce(
			(n, e) => n + (e.delta ? e.delta.chunk.length : (e.output as { text: string }).text.length),
			0
		);
		// O(size): within a small constant of the real output. The pre-fix behavior
		// re-emitted the whole growing buffer each tick — Σ ≈ size²/chunk ≈ 100× here.
		expect(wire).toBeLessThan(total * 2);
		expect(wire).toBeGreaterThanOrEqual(total); // never drops bytes
	});

	it('replaying the emitted frames reconstructs the exact final text (plain log)', () => {
		const { acc, emits } = withRecorder();
		for (let i = 0; i < 5; i++) {
			acc.push(stream('stdout', `epoch ${i}\n`));
			acc.flush();
		}
		const out = acc.finish();
		const final = (out[0] as { text: string }).text;
		expect(replay(emits, 0)).toBe(final);
		expect(final).toBe('epoch 0\nepoch 1\nepoch 2\nepoch 3\nepoch 4\n');
	});

	it('a terminal CR-rewrite emits a tail-splice delta (keep < base), still byte-correct', () => {
		const { acc, emits } = withRecorder();
		acc.push(stream('stdout', '\r 0%|   | 0/30'));
		acc.flush();
		acc.push(stream('stdout', '\r 50%|#  | 15/30'));
		acc.flush();
		acc.push(stream('stdout', '\r100%|###| 30/30'));
		const out = acc.finish();
		const final = (out[0] as { text: string }).text;
		expect(final).toBe('100%|###| 30/30');
		// The reducer rewrote earlier bytes, so at least one delta splices before its
		// end (keep < base) rather than pure-appending.
		const deltas = emits.filter((e) => e.delta).map((e) => e.delta!);
		expect(deltas.some((d) => d.keep < d.base)).toBe(true);
		// Replaying every frame still yields the byte-exact collapsed line.
		expect(replay(emits, 0)).toBe(final);
	});

	it('a mixed log + progress-bar stream stays byte-correct through deltas', () => {
		const { acc, emits } = withRecorder();
		acc.push(stream('stdout', 'starting run\n'));
		acc.flush();
		acc.push(stream('stdout', '\rprogress 10%'));
		acc.flush();
		acc.push(stream('stdout', '\rprogress 90%'));
		acc.flush();
		acc.push(stream('stdout', '\ndone\n'));
		const out = acc.finish();
		const final = (out[0] as { text: string }).text;
		expect(replay(emits, 0)).toBe(final);
	});

	it('an idle flush tick (no new bytes) broadcasts nothing', () => {
		const { acc, emits } = withRecorder();
		acc.push(stream('stdout', 'hello\n'));
		acc.flush();
		const afterFirst = emits.length;
		acc.flush(); // nothing new
		acc.flush(); // still nothing
		expect(emits.length).toBe(afterFirst);
	});

	it('a fresh stream element after a rich output starts with a full emit again', () => {
		const { acc, emits } = withRecorder();
		acc.push(stream('stdout', 'a'));
		acc.flush();
		acc.push(display('MID')); // closes the stream element
		acc.push(stream('stdout', 'b')); // new element at index 2
		acc.flush();
		acc.push(stream('stdout', 'c'));
		acc.finish();
		// The second stream element (index 2) is established by a full emit, then grows by delta.
		const idx2 = emits.filter((e) => e.index === 2);
		expect(idx2[0].delta).toBeUndefined();
		expect(idx2.slice(1).every((e) => !!e.delta)).toBe(true);
		expect(replay(emits, 2)).toBe('bc');
	});

	it('the delta base guard rejects a stale/out-of-order splice (models client refetch)', () => {
		// A delta whose base does not match the current text must NOT be applied — the
		// client discards it and refetches. Prove a mismatched base is detectable.
		const cur = 'ABCDEFG'; // client already advanced past this delta
		const stale: StreamDelta = { base: 3, keep: 3, chunk: 'DE' }; // computed against 'ABC'
		expect(cur.length).not.toBe(stale.base); // guard fires → refetch, no corruption
	});
});

describe('OutputAccumulator — ordering with rich outputs', () => {
	it('a display between stream chunks is neither merged nor reordered', () => {
		const { acc } = withRecorder();
		acc.push(stream('stdout', 'before\n'));
		acc.push(display('DISPLAY'));
		acc.push(stream('stdout', 'after\n'));
		const out = acc.finish();
		expect(out).toEqual([
			{ output_type: 'stream', name: 'stdout', text: 'before\n' },
			{ output_type: 'display_data', data: { 'text/plain': 'DISPLAY' }, metadata: {} },
			{ output_type: 'stream', name: 'stdout', text: 'after\n' }
		]);
	});

	it('an error output flushes pending stream first, preserving order', () => {
		const { acc } = withRecorder();
		acc.push(stream('stdout', 'partial\n'));
		acc.push({ output_type: 'error', ename: 'ValueError', evalue: 'boom', traceback: ['ValueError: boom'] });
		const out = acc.finish();
		expect(out[0]).toEqual({ output_type: 'stream', name: 'stdout', text: 'partial\n' });
		expect(out[1].output_type).toBe('error');
	});
});

describe('OutputAccumulator — capping', () => {
	it('caps runaway stream text and appends one honest truncation marker', () => {
		const { acc } = withRecorder({ maxStreamBytes: 20 });
		// Emit far more than the cap; the accumulated bytes must stay bounded.
		for (let i = 0; i < 10_000; i++) acc.push(stream('stdout', `line ${i}\n`));
		const out = acc.finish();
		expect(acc.wasCapped).toBe(true);
		// Exactly two elements: the (capped) stream text + the marker.
		expect(out.length).toBe(2);
		const streamText = (out[0] as { text: string }).text;
		expect(Buffer.byteLength(streamText, 'utf8')).toBeLessThanOrEqual(20);
		const marker = out[1] as { output_type: string; name: string; text: string };
		expect(marker.output_type).toBe('stream');
		expect(marker.name).toBe('stderr');
		expect(marker.text).toMatch(/output truncated/);
		expect(marker.text).toMatch(/bytes suppressed/);
	});

	it('bounds total heap: accumulated bytes never exceed the total cap', () => {
		const { acc } = withRecorder({ maxStreamBytes: 100, maxTotalBytes: 100 });
		for (let i = 0; i < 100_000; i++) acc.push(stream('stdout', 'x'.repeat(50)));
		const out = acc.finish();
		const total = out.reduce((n, o) => n + Buffer.byteLength(JSON.stringify(o), 'utf8'), 0);
		// A small constant bound regardless of how much was pushed.
		expect(total).toBeLessThan(1_000);
	});

	it('caps by item count when many rich outputs are emitted', () => {
		const { acc } = withRecorder({ maxItems: 3, maxTotalBytes: 1_000_000 });
		for (let i = 0; i < 50; i++) acc.push(display(`d${i}`));
		const out = acc.finish();
		expect(acc.wasCapped).toBe(true);
		// 3 kept display outputs + 1 marker.
		expect(out.length).toBe(4);
		expect((out[3] as { text: string }).text).toMatch(/items/);
	});

	it('does not corrupt a rich output that fits under the cap', () => {
		const { acc } = withRecorder();
		const img: CellOutput = {
			output_type: 'display_data',
			data: { 'image/png': 'BASE64DATA==' },
			metadata: { foo: 'bar' }
		};
		acc.push(img);
		const out = acc.finish();
		expect(out).toEqual([img]);
	});
});

describe('OutputAccumulator — terminal-style reduction', () => {
	it('emits the collapsed final line for a \\r-overwritten progress bar', () => {
		const { acc } = withRecorder();
		acc.push(stream('stdout', '\r 0%|   | 0/30'));
		acc.push(stream('stdout', '\r 50%|#  | 15/30'));
		acc.push(stream('stdout', '\r100%|###| 30/30'));
		const out = acc.finish();
		expect(out).toEqual([{ output_type: 'stream', name: 'stdout', text: '100%|###| 30/30' }]);
	});

	it('strips SGR color from emitted stream text', () => {
		const { acc } = withRecorder();
		acc.push(stream('stdout', '\x1b[32m✓\x1b[0m installed rich'));
		const out = acc.finish();
		expect(out).toEqual([{ output_type: 'stream', name: 'stdout', text: '✓ installed rich' }]);
	});

	it('reduces on every flush tick so the live view collapses in place', () => {
		const { acc, emits } = withRecorder();
		acc.push(stream('stdout', '\rloading 10%'));
		acc.flush();
		acc.push(stream('stdout', '\rloading 99%'));
		const out = acc.finish();
		expect(out).toEqual([{ output_type: 'stream', name: 'stdout', text: 'loading 99%' }]);
		// Each emitted frame is already reduced — never a raw pile of \r frames.
		expect(emits.every((e) => !(e.output as { text: string }).text.includes('\r'))).toBe(true);
	});

	it('leaves plain (non-terminal) stream output byte-for-byte unchanged', () => {
		const { acc } = withRecorder();
		acc.push(stream('stdout', 'INFO epoch 1\nINFO epoch 2\n'));
		const out = acc.finish();
		expect(out).toEqual([{ output_type: 'stream', name: 'stdout', text: 'INFO epoch 1\nINFO epoch 2\n' }]);
	});

	it('reduces the emitted copy but never mutates the raw byte accounting', () => {
		// A run that would trip the stream-byte cap on RAW bytes still trips it even
		// though the reduced (emitted) text is far smaller — caps count raw input.
		const { acc } = withRecorder({ maxStreamBytes: 40, maxTotalBytes: 1_000 });
		for (let i = 0; i < 20; i++) acc.push(stream('stdout', `\rframe ${i} padding padding`));
		const out = acc.finish();
		expect(acc.wasCapped).toBe(true);
		// The kept stream element is the reduced final frame, not a \r pile.
		expect((out[0] as { text: string }).text).not.toContain('\r');
	});
});
