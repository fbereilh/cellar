/**
 * Cellar — bounded, coalescing output accumulator for one cell run.
 *
 * A single chatty or runaway cell (a `tqdm` bar, a tight `print` loop, a
 * `while True: print(x)`) degrades the whole pipeline: the server accumulates
 * one output object per IOPub message with no cap, and every one of those is
 * broadcast + persisted. This sits between the kernel's raw per-message output
 * stream (`execute()`'s `onEvent`) and the three consumers of a run's output —
 * the persisted `.ipynb`, the SSE broadcast, and the initiating tab's NDJSON
 * stream — so all three see the SAME coalesced, capped result.
 *
 * Two jobs:
 *
 *  - **Coalesce.** Consecutive `stream` chunks of the same name (stdout/stderr)
 *    are merged into one growing text element rather than one element per
 *    chunk. The merge is flushed on a timer tick (`flush()`, driven every
 *    ~40ms by the run loop) so a long run still shows live progress, and
 *    immediately before any non-stream output and at run end so ordering with
 *    display/error/result outputs is preserved EXACTLY — a display between two
 *    stdout chunks yields `[stream, display, stream]`, never a reorder or a
 *    cross-boundary merge.
 *
 *  - **Cap.** Total output is bounded three ways: coalesced stream text bytes
 *    (the fast-growing runaway case), total output element count, and total
 *    bytes across all outputs (the heap backstop). Once any cap is exceeded,
 *    further output is dropped and a single honest truncation marker is
 *    appended (stderr stream), whose text is finalized at run end with how much
 *    was dropped. So `while True: print(x)` can never grow the server heap
 *    without bound.
 *
 * Each committed/updated element is surfaced through `onEmit(output, index, delta?)`
 * with its STABLE index in the accumulated array: a fresh output takes the next
 * index, a growing coalesced stream re-emits at the same index. To keep a slow
 * streaming cell from re-broadcasting its whole buffer every ~40ms flush (an
 * O(size × ticks) blowup on the SSE fan-out — measured 91× traffic
 * amplification), a growing stream element does NOT re-emit its full text each
 * tick: the FIRST materialization emits the whole element (`delta` absent, the
 * client establishes it) and every subsequent flush emits only a `StreamDelta`
 * describing what changed since the last emission, so per-run wire cost is
 * O(size), not O(size × ticks). Rich outputs and the truncation marker are
 * one-shot and always emit the full element.
 *
 * Every STREAM_CHECKPOINT_EVERY-th NON-idle emission is promoted back to a FULL
 * element (a checkpoint) even though only the tail changed. That periodic full
 * frame is the resync mechanism: a tab that missed the first frame or an earlier
 * delta (an agent/background/cross-tab viewer, or a reconnect mid-stream) DROPS
 * the un-appliable deltas and re-adopts the whole element at the next checkpoint,
 * so a desync self-heals within N ticks with no client refetch — a mid-run
 * `load()` returns EMPTY (the doc's outputs are only persisted at run end) and
 * each per-tick delta would re-trigger it into a refetch storm. The amortized
 * wire stays O(size): checkpoints add only a 1/N slice of ticks re-sending the
 * buffer, not the pre-fix O(size × ticks).
 *
 * The delta is a tail-splice, not a pure append, because the terminal reducer
 * (CR-overwrite collapse) can rewrite earlier bytes of the element: `keep` is the
 * offset up to which the prior text is unchanged and `chunk` is what follows, so
 * `new = prev.slice(0, keep) + chunk` reconstructs it exactly. A plain
 * (non-terminal) stream reduces to identity and only ever appends, so `keep`
 * equals the prior length with no scan (the fast path for the common streaming-log
 * case); a terminal buffer diffs to the common prefix. `base` is the length the
 * client's element must currently have for the splice to be valid — a mismatch
 * (a delta dropped, or a reconnect refetch racing a live delta) means the client
 * is out of sync, so it discards the delta and self-heals at the next full-frame
 * checkpoint rather than corrupting the text. `outputs` is the final
 * capped+coalesced array the caller persists (always the full reduced text; the
 * delta protocol is purely a wire optimization).
 *
 * Pure of any Cellar state — it only transforms an output stream — so it is
 * unit-tested directly (`tests/unit/output-accumulator.test.ts`).
 */
import type { CellOutput, StreamOutput } from './types';
import { isTerminalStyle, reduceCheap } from './terminal';

/** Coalesce/broadcast tick: flush buffered stream text at most this often (ms). */
export const OUTPUT_FLUSH_MS = 40;

/**
 * Every Nth NON-IDLE emission of a growing stream element is promoted from a
 * `StreamDelta` to a FULL-element emission (a `run:output` at the stable index).
 * That periodic checkpoint is the resync mechanism: it re-establishes the whole
 * element for any tab that missed the first full frame or an earlier delta (an
 * agent/background/cross-tab viewer, or a reconnect mid-stream), so an out-of-sync
 * client can DROP un-appliable deltas and simply adopt the next checkpoint rather
 * than refetching the notebook per tick. It bounds the un-synced window to at most
 * N ticks while keeping amortized wire cost O(size) (each checkpoint adds only a
 * 1/N overhead). At the ~40ms flush tick, N=25 is ~1s.
 */
export const STREAM_CHECKPOINT_EVERY = 25;

/** Caps. Chosen so they bite only on runaway output; a normal run never trips them. */
export interface OutputCaps {
	/** Max bytes of coalesced stream text across the whole run (the print-loop bound). */
	maxStreamBytes: number;
	/** Max number of output elements (the display/rich-in-a-loop bound). */
	maxItems: number;
	/** Max total bytes across all outputs (the heap backstop for rich output). */
	maxTotalBytes: number;
}

export const DEFAULT_CAPS: OutputCaps = {
	maxStreamBytes: 500_000, // ~500 KB of stdout/stderr text
	maxItems: 4096,
	maxTotalBytes: 10_000_000 // 10 MB
};

/** nbformat stream text may be a string or an array of line strings; normalize. */
function asText(text: string | string[]): string {
	return Array.isArray(text) ? text.join('') : text;
}

function byteLen(s: string): number {
	return Buffer.byteLength(s, 'utf8');
}

/** Serialized byte size of a non-stream output (for the total-bytes cap). */
function outputBytes(o: CellOutput): number {
	if (o.output_type === 'stream') return byteLen(asText(o.text));
	try {
		return byteLen(JSON.stringify(o));
	} catch {
		return 0;
	}
}

/**
 * A wire-delta for a growing stream element: reconstruct the element's text as
 * `prev.slice(0, keep) + chunk`. `base` = the length the client's current text
 * must have for the splice to apply (else it drops the delta and resyncs at the
 * next full-frame checkpoint). For a pure append `keep === base`; a terminal
 * CR-rewrite gives `keep < base`.
 */
export interface StreamDelta {
	base: number;
	keep: number;
	chunk: string;
}

/**
 * Surfaces a committed/updated output. `delta` is present only for a re-emission
 * of an already-established growing stream element (see the module header): when
 * given, broadcast the small delta instead of the full `output`.
 */
export type EmitFn = (output: CellOutput, index: number, delta?: StreamDelta) => void;

export class OutputAccumulator {
	/** The coalesced, capped output array — what the caller persists. */
	readonly outputs: CellOutput[] = [];

	private readonly caps: OutputCaps;
	private readonly onEmit: EmitFn;

	// Buffered stream text for the current contiguous run. `emitted` is the reduced
	// text last handed to `onEmit` for this element (null until its first emission),
	// so a flush can diff against it and broadcast only the delta. `sinceFull` counts
	// deltas emitted since the last FULL frame (the first emission or a checkpoint), so
	// every STREAM_CHECKPOINT_EVERY-th non-idle emission re-emits the whole element.
	private pending: { name: string; text: string; index: number; emitted: string | null; sinceFull: number } | null = null;

	private streamBytes = 0; // committed + pending stream text
	private totalBytes = 0; // all outputs
	private capped = false;
	private markerIndex: number | null = null;
	private droppedItems = 0;
	private droppedBytes = 0;
	private capReason = '';

	constructor(onEmit: EmitFn, caps: OutputCaps = DEFAULT_CAPS) {
		this.onEmit = onEmit;
		this.caps = caps;
	}

	/** Feed one raw output from the kernel. */
	push(output: CellOutput): void {
		if (output.output_type === 'stream') this.pushStream(output.name, asText(output.text));
		else this.pushRich(output);
	}

	private pushStream(name: string, text: string): void {
		if (!text) return;
		// A different stream (stdout↔stderr) closes the current element and opens a
		// new one — same-stream text only ever coalesces.
		if (this.pending && this.pending.name !== name) this.closePending();

		if (this.capped) {
			// Keep counting for the marker, but never grow the heap.
			this.droppedBytes += byteLen(text);
			return;
		}

		const remaining = Math.min(
			this.caps.maxStreamBytes - this.streamBytes,
			this.caps.maxTotalBytes - this.totalBytes
		);
		const size = byteLen(text);
		if (size > remaining) {
			// Fit what we can (respecting UTF-8 boundaries via a char-wise trim), then cap.
			const kept = remaining > 0 ? truncateToBytes(text, remaining) : '';
			if (kept) this.appendStream(name, kept);
			this.droppedBytes += size - byteLen(kept);
			this.trip(
				this.streamBytes >= this.caps.maxStreamBytes
					? `stream output exceeded ${this.caps.maxStreamBytes.toLocaleString('en-US')} bytes`
					: `total output exceeded ${this.caps.maxTotalBytes.toLocaleString('en-US')} bytes`
			);
			return;
		}
		this.appendStream(name, text);
	}

	/**
	 * Buffer stream text into the currently-open contiguous stream element
	 * (coalescing). The element's index is fixed when the run opens and stays
	 * stable across flush ticks, so the live broadcast re-emits at that one index
	 * and the client overwrites a single element instead of appending per chunk.
	 */
	private appendStream(name: string, text: string): void {
		this.streamBytes += byteLen(text);
		this.totalBytes += byteLen(text);
		if (this.pending && this.pending.name === name) {
			this.pending.text += text;
		} else {
			// Open a new contiguous stream run at the next slot. Not materialized into
			// `outputs` until flush(); no other element can take this slot while the
			// run is open (a rich/other-stream output closes it first). `emitted` is
			// null so the first flush emits the whole element (delta absent).
			this.pending = { name, text, index: this.outputs.length, emitted: null, sinceFull: 0 };
		}
	}

	private pushRich(output: CellOutput): void {
		// Ordering: any buffered stream must land BEFORE this output.
		this.closePending();

		if (this.capped) {
			this.droppedItems += 1;
			this.droppedBytes += outputBytes(output);
			return;
		}
		const size = outputBytes(output);
		if (this.outputs.length + 1 > this.caps.maxItems) {
			this.droppedItems += 1;
			this.droppedBytes += size;
			this.trip(`output exceeded ${this.caps.maxItems.toLocaleString('en-US')} items`);
			return;
		}
		if (this.totalBytes + size > this.caps.maxTotalBytes) {
			this.droppedItems += 1;
			this.droppedBytes += size;
			this.trip(`total output exceeded ${this.caps.maxTotalBytes.toLocaleString('en-US')} bytes`);
			return;
		}
		this.totalBytes += size;
		const index = this.outputs.length;
		this.outputs.push(output);
		this.onEmit(output, index);
	}

	/**
	 * Commit the currently-open stream element's text into `outputs` and emit it,
	 * WITHOUT closing the element — subsequent same-stream chunks keep extending it
	 * and re-emit at the same index. Idempotent and cheap when nothing is pending
	 * (the timer calls it every tick).
	 *
	 * The FIRST flush of an element emits the whole element (so the client can
	 * establish it); every later flush emits only a `StreamDelta` of what changed
	 * since the previous emission, so a slow streaming cell costs O(new bytes) on
	 * the wire per tick instead of O(whole buffer). A tick with no new bytes since
	 * the last emission broadcasts nothing.
	 *
	 * Every STREAM_CHECKPOINT_EVERY-th non-idle emission is promoted back to a FULL
	 * frame (a checkpoint) so a tab that missed the first frame or a delta can resync
	 * by adopting it — bounding the un-synced window to N ticks while keeping the
	 * amortized wire cost O(size).
	 */
	flush(): void {
		if (!this.pending) return;
		const { name, text, index } = this.pending;
		// Keep `pending.text` raw — coalescing across chunks and the byte caps both
		// depend on the full reassembled text (and Phase 2's VT emulator will too).
		// Emit the terminal-reduced COPY so persist (.ipynb), the SSE broadcast, the
		// agent read, and the render all see the collapsed final line instead of
		// hundreds of `\r`-overwrite frames. Plain logs skip reduction entirely.
		const terminal = isTerminalStyle(text);
		const reduced = terminal ? reduceCheap(text) : text;
		const prev = this.pending.emitted;
		// Idle timer tick: nothing has changed since the last emission, so don't
		// re-broadcast the element at all (and don't advance the checkpoint counter).
		if (prev !== null && reduced === prev) return;
		const out: StreamOutput = { output_type: 'stream', name, text: reduced };
		if (index < this.outputs.length) this.outputs[index] = out;
		else this.outputs.push(out);
		// The first emission is always a full frame; thereafter every non-idle emission
		// advances the counter and every STREAM_CHECKPOINT_EVERY-th one is re-emitted
		// full (a resync checkpoint). Either full path sends the whole element and
		// resets the counter; a delta increments it.
		const checkpoint = prev !== null && this.pending.sinceFull + 1 >= STREAM_CHECKPOINT_EVERY;
		if (prev === null || checkpoint) {
			// Full frame: the client (re)establishes the element from `out.text` — the
			// first materialization, or a periodic checkpoint that lets a desynced tab
			// adopt the whole element and resume splicing.
			this.onEmit(out, index);
			this.pending.sinceFull = 0;
		} else {
			// A plain (non-terminal) stream reduces to identity and only ever grows by
			// appending, so `prev` is a strict prefix of `reduced`: keep its whole
			// length with no scan (the O(new bytes) fast path). A terminal buffer can
			// rewrite its tail (CR collapse), so diff to the common prefix.
			const keep = terminal ? commonPrefixLen(prev, reduced) : prev.length;
			this.onEmit(out, index, { base: prev.length, keep, chunk: reduced.slice(keep) });
			this.pending.sinceFull += 1;
		}
		this.pending.emitted = reduced;
	}

	/** Commit and CLOSE the open stream element, so the next output takes a new slot. */
	private closePending(): void {
		this.flush();
		this.pending = null;
	}

	/** Record that a cap was hit and append the (initially terse) truncation marker. */
	private trip(reason: string): void {
		if (this.capped) return;
		this.capped = true;
		this.capReason = reason;
		this.closePending(); // land + close any pending stream before the marker
		const marker: StreamOutput = {
			output_type: 'stream',
			name: 'stderr',
			text: `\n... output truncated: ${reason} ...\n`
		};
		this.markerIndex = this.outputs.length;
		this.outputs.push(marker);
		this.onEmit(marker, this.markerIndex);
	}

	/**
	 * Flush the tail, finalize the truncation marker with the totals dropped, and
	 * return the final output array. Call once, at run end.
	 */
	finish(): CellOutput[] {
		this.flush();
		if (this.capped && this.markerIndex != null) {
			const parts = [`... output truncated: ${this.capReason}`];
			if (this.droppedItems > 0) parts.push(`${this.droppedItems.toLocaleString('en-US')} further outputs`);
			if (this.droppedBytes > 0) parts.push(`${this.droppedBytes.toLocaleString('en-US')} bytes`);
			const suffix = this.droppedItems > 0 || this.droppedBytes > 0 ? ` (${parts.slice(1).join(', ')} suppressed)` : '';
			const marker: StreamOutput = {
				output_type: 'stream',
				name: 'stderr',
				text: `\n... output truncated: ${this.capReason}${suffix} ...\n`
			};
			this.outputs[this.markerIndex] = marker;
			this.onEmit(marker, this.markerIndex);
		}
		return this.outputs;
	}

	get wasCapped(): boolean {
		return this.capped;
	}
}

/** Length (in UTF-16 code units) of the common leading prefix of `a` and `b`. */
function commonPrefixLen(a: string, b: string): number {
	const n = Math.min(a.length, b.length);
	let i = 0;
	while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
	return i;
}

/** Trim a string to at most `maxBytes` UTF-8 bytes without splitting a code point. */
function truncateToBytes(s: string, maxBytes: number): string {
	if (byteLen(s) <= maxBytes) return s;
	// Binary search the char boundary whose byte length fits.
	let lo = 0;
	let hi = s.length;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (byteLen(s.slice(0, mid)) <= maxBytes) lo = mid;
		else hi = mid - 1;
	}
	return s.slice(0, lo);
}
