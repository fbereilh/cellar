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
 * Each committed/updated element is surfaced through `onEmit(output, index)`
 * with its STABLE index in the accumulated array: a growing coalesced stream
 * re-emits at the same index (the client overwrites that one element instead of
 * rebuilding the array), a fresh output takes the next index. `outputs` is the
 * final capped+coalesced array the caller persists.
 *
 * Pure of any Cellar state — it only transforms an output stream — so it is
 * unit-tested directly (`tests/unit/output-accumulator.test.ts`).
 */
import type { CellOutput, StreamOutput } from './types';

/** Coalesce/broadcast tick: flush buffered stream text at most this often (ms). */
export const OUTPUT_FLUSH_MS = 40;

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

export type EmitFn = (output: CellOutput, index: number) => void;

export class OutputAccumulator {
	/** The coalesced, capped output array — what the caller persists. */
	readonly outputs: CellOutput[] = [];

	private readonly caps: OutputCaps;
	private readonly onEmit: EmitFn;

	// Buffered, not-yet-committed stream text for the current contiguous run.
	private pending: { name: string; text: string; index: number } | null = null;

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
			// run is open (a rich/other-stream output closes it first).
			this.pending = { name, text, index: this.outputs.length };
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
	 */
	flush(): void {
		if (!this.pending) return;
		const { name, text, index } = this.pending;
		const out: StreamOutput = { output_type: 'stream', name, text };
		if (index < this.outputs.length) this.outputs[index] = out;
		else this.outputs.push(out);
		this.onEmit(out, index);
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
