/**
 * Cellar — the one cell-execution core.
 *
 * Three callers need to run a cell against a notebook's kernel: the UI's `/run`
 * route, the MCP `run_cell` tool, and the imports cell (`imports-cell.js`). They
 * differ only in how they answer their caller — an NDJSON stream, a JSON tool
 * result, nothing — never in what executing a cell MEANS. That shared meaning
 * lives here, so a third run path cannot quietly drift from the run_status
 * doctrine the other two implement.
 *
 * What it is NOT: the queue. Claiming the kernel stays with each caller, because
 * each answers a refused (`duplicate`) or dropped (`cancelled`) ticket in its own
 * shape. Take the ticket, await it, then call this; release in a `finally`.
 *
 *   const ticket = enqueueRun({ nb, cellId, actor, source });
 *   await ticket.wait();
 *   try { return await executeCellRun({ nb, cellId, actor, source: ticket.source() }); }
 *   finally { ticket.done(); }
 */
import { execute } from './kernel';
import { setOutputs, setLastRun, clearOutputsLive, getCell } from './notebook';
import { publish } from './events';
import { isSqlCell } from '../cellLanguage';
import { sqlToPython } from './sql';
import { OutputAccumulator, OUTPUT_FLUSH_MS } from './output-accumulator';
import type { Actor, CellOutput, LastRun, SessionId, RunStreamEvent, CellRunResult } from './types';

/** Arguments to `executeCellRun`. */
export interface CellRunArgs {
	/** Absolute notebook path. */
	nb: string;
	cellId: string;
	actor: Actor;
	source: string;
	originId?: string | null;
	/** Receives, in wire order, run:start, every execute() frame, and run:end. */
	onEvent?: (event: RunStreamEvent | { type: 'run:start'; cellId: string; at: number } | ({ type: 'run:end' } & LastRun)) => void;
}

/**
 * Execute `source` as cell `cellId` of notebook `nb` (an ABSOLUTE path): stream
 * its outputs, persist them, stamp the runtime-only run metadata, and broadcast
 * the `run:start` / `run:output` / `run:end` lifecycle so every open tab reflects
 * it. The caller must already hold the kernel (see above).
 *
 * `onEvent` receives, in wire order, the synthesized `run:start`, every raw
 * `execute()` event, and the closing `run:end` — which is precisely what the UI
 * route forwards down its NDJSON stream to the initiating tab (that tab drops its
 * own SSE echo by `originId`, so this is the only way it learns its run started).
 *
 * `session` is the kernel-session epoch the run STARTED in, captured from
 * `execute()`'s `kernel` event and never re-read afterwards: an autorestart
 * mid-run bumps the live epoch, and this cell must then read as
 * not-this-session. `kernel_unavailable` marks the case where `execute()` threw
 * before any kernel existed, so no session can be stamped at all and the error is
 * LIVE rather than leftover.
 */
export async function executeCellRun({ nb, cellId, actor, source, originId, onEvent }: CellRunArgs): Promise<CellRunResult> {
	const startedAt = Date.now();
	// Clear stale output. For a queued run this already happened at ENQUEUE
	// (`clearOutputsForQueue`), so this is an idempotent backstop that also covers
	// any run path which did not clear on enqueue; clearing an already-empty cell is
	// a no-op. The browser likewise clears on the `run:start` frame below, and this
	// keeps the live in-memory model in step so a tab loading mid-run reads an empty
	// cell rather than the prior run's outputs.
	clearOutputsLive(cellId, nb);
	publish({ type: 'run:start', nb, cellId, actor, at: startedAt, originId });
	onEvent?.({ type: 'run:start', cellId, at: startedAt });

	// A SQL cell stores raw SQL but the kernel is Python: compile it to the
	// `spark.sql(...)` wrapper at run time (source on disk stays SQL). Everything
	// downstream - persist, stamp, broadcast - is identical to a code cell.
	const cell = getCell(cellId, nb);
	const execSource = isSqlCell(cell) ? sqlToPython(source) : source;

	// Bound + coalesce the run's output across all three consumers (persist, SSE
	// broadcast, this caller's stream). The accumulator merges consecutive
	// same-stream chunks and caps runaway output; `emit` fans each committed/updated
	// element out with its STABLE index so the broadcast re-emits a growing stream at
	// one index (the client overwrites that element) instead of appending per chunk.
	const emit = (output: CellOutput, index: number) => {
		publish({ type: 'run:output', nb, cellId, output, index, originId });
		onEvent?.({ type: 'output', output, index });
	};
	const acc = new OutputAccumulator(emit);
	// Flush buffered stream text on a ~40ms tick so a long run shows live progress;
	// ordering with rich outputs is preserved by flushing immediately before each
	// (in `acc.push`) and at run end (`acc.finish`), not by this timer.
	const flushTimer = setInterval(() => acc.flush(), OUTPUT_FLUSH_MS);
	if (typeof flushTimer.unref === 'function') flushTimer.unref();

	let status = 'ok';
	let session: SessionId | null = null;
	let kernelDown = false;
	try {
		const reply = await execute(nb, execSource, (ev) => {
			if (ev.type === 'output') {
				acc.push(ev.output);
			} else if (ev.type === 'kernel') {
				session = ev.session;
				onEvent?.(ev);
			} else {
				onEvent?.(ev);
			}
		});
		status = reply?.status ?? 'ok';
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		acc.push({
			output_type: 'error',
			ename: 'CellarError',
			evalue: message,
			traceback: [message]
		});
		status = 'error';
		// execute() threw before it ever had a kernel in hand, so there is no session
		// to stamp: this failure is the run the caller just asked for, not a leftover.
		if (session === null) kernelDown = true;
	} finally {
		clearInterval(flushTimer);
	}
	// Flush the tail + finalize the truncation marker; this is the array we persist.
	const outputs = acc.finish();

	// A notebook is "loaded in the kernel" iff it has a live kernel entry, which the
	// manager tracks directly — no separate marking step. A kernel-down run (session
	// === null) touched no namespace; either way there is nothing to record here.

	setOutputs(cellId, outputs, nb); // clean-on-save persists the .ipynb
	// Runtime-only run metadata (stripped from disk by clean.js); `at` = run start,
	// so "ran X ago" reads as when the run began.
	const lastRun: LastRun = {
		at: startedAt,
		durationMs: Date.now() - startedAt,
		actor,
		status,
		session,
		...(kernelDown ? { kernel_unavailable: true } : {})
	};
	setLastRun(cellId, lastRun, nb);
	onEvent?.({ type: 'run:end', ...lastRun });
	publish({ type: 'run:end', nb, cellId, ...lastRun, originId });

	return { outputs, status, session, kernelDown, lastRun };
}

/**
 * Clear a cell's LIVE outputs the moment its run is QUEUED, rather than waiting
 * for the kernel to free. Empties the in-memory doc and broadcasts a `run:cleared`
 * event so every open tab empties the cell right away — otherwise the prior run's
 * output lingers under the "queued · N" badge until the cell's turn finally comes.
 *
 * Call it once per FRESH (non-duplicate) enqueue, right after taking the ticket. A
 * duplicate submission is already running or already queued, so its outputs were
 * cleared when it first entered — clearing again would wipe a live run's output.
 *
 * It is idempotent (clearing an already-empty cell is a no-op) and touches no disk
 * — persist happens once, at run:end via `setOutputs` — so queuing writes no
 * transient empty-output `.ipynb`. When `onEvent` is given it also emits the frame
 * on the caller's own stream: the UI `/run` route passes its NDJSON `send`, so the
 * initiating tab (which drops its own `originId`-tagged SSE echo) still clears
 * immediately instead of only when the run eventually starts.
 */
export function clearOutputsForQueue({
	nb,
	cellId,
	originId,
	onEvent
}: {
	nb: string;
	cellId: string;
	originId?: string | null;
	onEvent?: (event: { type: 'run:cleared'; cellId: string }) => void;
}): void {
	clearOutputsLive(cellId, nb);
	onEvent?.({ type: 'run:cleared', cellId });
	publish({ type: 'run:cleared', nb, cellId, originId });
}
