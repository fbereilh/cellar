import { describe, it, expect } from 'vitest';
import { OutputAccumulator, type OutputCaps } from '../../src/lib/server/output-accumulator';
import type { CellOutput } from '../../src/lib/server/types';

/** Collect every (output, index) the accumulator emits, in order. */
function withRecorder(caps?: Partial<OutputCaps>) {
	const emits: Array<{ output: CellOutput; index: number }> = [];
	const full = {
		maxStreamBytes: 1_000,
		maxItems: 10,
		maxTotalBytes: 5_000,
		...caps
	};
	const acc = new OutputAccumulator((output, index) => emits.push({ output, index }), full);
	return { acc, emits };
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
