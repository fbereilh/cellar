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
import { execute, ensureMojoMagic, KernelExecuteAborted } from './kernel';
import { setOutputs, setOutputsLive, setLastRun, clearOutputsLive, getCell } from './notebook';
import { publish } from './events';
import { isChatCell, isMojoCell, isSqlCell } from '../cellLanguage';
import { sqlToPython } from './sql';
import { mojoMissingOutput, mojoToCellSource, type MojoSetup } from './mojo';
import { executeChatRun, chatReplyOutput } from './chat/run-chat';
import { OutputAccumulator, OUTPUT_FLUSH_MS, type StreamDelta } from './output-accumulator';
import { registerRunOutputs, unregisterRunOutputs } from './run-output-registry';
import { noteRunStarted } from './run-queue';
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
	onEvent?: (
		event:
			| RunStreamEvent
			| { type: 'run:start'; cellId: string; at: number }
			| { type: 'output-append'; index: number; base: number; keep: number; chunk: string }
			| ({ type: 'run:end' } & LastRun)
	) => void;
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
	// Publish the start on all three channels a client can learn it from, all
	// carrying THIS `startedAt` — the same origin `durationMs` below is measured
	// from, so a live elapsed clock and the settled badge that replaces it can never
	// disagree. The queue snapshot is the one a client that missed the events reads
	// (a tab connecting, or a notebook mounting, mid-run); the other two are for
	// clients already listening (SSE) and for this run's own caller (NDJSON).
	noteRunStarted(nb, cellId, startedAt);
	publish({ type: 'run:start', nb, cellId, actor, at: startedAt, originId });
	onEvent?.({ type: 'run:start', cellId, at: startedAt });

	// A SQL cell stores raw SQL but the kernel is Python: compile it to the
	// `spark.sql(...)` wrapper at run time (source on disk stays SQL). Everything
	// downstream - persist, stamp, broadcast - is identical to a code cell.
	// A CHAT cell never reaches the kernel at all: its source is a question the
	// ChatEngine answers (see chat/run-chat.ts), streamed through this same
	// accumulator so the wire, persist and clear behavior stay identical.
	// A MOJO cell stores bare Mojo and compiles to the `%%mojo` cell magic, which
	// exists only after `import mojo.notebook` has run in this session - so the run
	// is preceded by a lazy, once-per-session setup (see mojo.ts for why it is not
	// an `initKernel` injection). A setup that did not take is reported as the
	// cell's OWN error output below, carrying the install command, rather than
	// letting IPython answer with `UsageError: Cell magic function %%mojo not
	// found`, which says nothing about the toolchain.
	const cell = getCell(cellId, nb);
	const isChat = isChatCell(cell);
	const isMojo = isMojoCell(cell);
	// NULL means NO VERDICT - the kernel could not be reached, or the bounded setup
	// did not settle in time. Either way we fall through to `execute()`, which owns
	// the run watchdog and reports honestly (`kernel_unavailable` where that is what
	// happened): claiming a missing TOOLCHAIN on a reading that observed nothing
	// would name a cause nobody saw, and would send the user installing 534 MB they
	// may already have.
	let mojoSetup: MojoSetup | null = null;
	if (isMojo) {
		try {
			mojoSetup = await ensureMojoMagic(nb);
		} catch {
			/* no verdict; see above */
		}
	}
	const execSource = isSqlCell(cell) ? sqlToPython(source) : isMojo ? mojoToCellSource(source) : source;

	// Bound + coalesce the run's output across all three consumers (persist, SSE
	// broadcast, this caller's stream). The accumulator merges consecutive
	// same-stream chunks and caps runaway output; `emit` fans each committed/updated
	// element out with its STABLE index. A growing stream element is re-emitted as a
	// small `run:output-append` DELTA (only the bytes that changed since the last
	// flush) instead of its whole buffer, so a slow streaming cell no longer
	// re-broadcasts O(size) to every tab each tick — see output-accumulator's header.
	// The full-element `run:output` is kept for the element's first emission and for
	// rich/marker outputs; a dropped delta is a no-op on the client and resyncs with
	// one `load()`, which is authoritative because each emit also mirrors the
	// accumulator's current outputs into the in-memory doc (setOutputsLive) so a
	// mid-run read returns the last-flushed text rather than empty.
	const emit = (output: CellOutput, index: number, delta?: StreamDelta) => {
		if (delta) {
			publish({ type: 'run:output-append', nb, cellId, index, base: delta.base, keep: delta.keep, chunk: delta.chunk, originId });
			onEvent?.({ type: 'output-append', index, base: delta.base, keep: delta.keep, chunk: delta.chunk });
		} else {
			publish({ type: 'run:output', nb, cellId, output, index, originId });
			onEvent?.({ type: 'output', output, index });
		}
		// Keep the live doc current (in-memory only, no persist/event) so a client that
		// desynced does ONE load() that genuinely resyncs. `acc.outputs` is already
		// updated for this emit; a shallow copy detaches the doc from the array the
		// accumulator keeps mutating in place.
		setOutputsLive(cellId, acc.outputs.slice(), nb);
	};
	const acc = new OutputAccumulator(emit);
	// Publish this run's accumulator so a mid-run "clear outputs" of this cell can
	// discard what it has produced so far (see run-output-registry). Removed in the
	// `finally` below, which spans the persist: a clear landing between the last
	// flush and `setOutputs` must still be able to keep the pre-clear buffer off disk.
	registerRunOutputs(nb, cellId, acc);
	// Flush buffered stream text on a ~40ms tick so a long run shows live progress;
	// ordering with rich outputs is preserved by flushing immediately before each
	// (in `acc.push`) and at run end (`acc.finish`), not by this timer.
	const flushTimer = setInterval(() => acc.flush(), OUTPUT_FLUSH_MS);
	if (typeof flushTimer.unref === 'function') flushTimer.unref();

	let status = 'ok';
	let session: SessionId | null = null;
	let kernelDown = false;
	let outputs: CellOutput[];
	try {
		try {
			if (mojoSetup && !mojoSetup.ready) {
				// The probe ANSWERED, and it answered that the toolchain is absent - a
				// probe that could not answer is NO VERDICT (null) and never lands here,
				// so this branch never asserts an absence nobody observed. The kernel is
				// alive - `ensureMojoMagic` started it and ran a probe in it - so this run
				// really did happen in `mojoSetup.session`'s namespace and is stamped with
				// it: reporting no session would drop the cell into `error_persisted`, the
				// label agents are told to distrust as a leftover from a previous session,
				// for a failure raised seconds ago.
				session = mojoSetup.session ?? null;
				acc.push(mojoMissingOutput(mojoSetup));
				status = 'error';
			} else if (isChat) {
				// No kernel, no session epoch: the reply streams from the ChatEngine into
				// the same accumulator. `session` stays null - a chat run touches no
				// namespace, so ran_this_session honestly reads false.
				status = (await executeChatRun({ nb, cellId, question: source, acc })).status;
			} else {
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
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			acc.push({
				output_type: 'error',
				ename: 'CellarError',
				evalue: message,
				traceback: [message]
			});
			status = 'error';
			// `kernelDown` means one thing only: execute() threw before it ever had a kernel
			// in hand (the sidecar was unreachable), which is why the absent session epoch
			// stands in for it. A chat run never has a kernel, so its failures are never
			// "kernel down" - and neither is an ABORT: a run force-settled while parked on
			// the exec lock (F2) also throws with no session, but the kernel it was queued
			// behind was demonstrably alive and busy. Reporting that as kernel_unavailable
			// asserts an unreachable kernel that was never observed, and drops the cell into
			// `error_persisted` - the label agents are told to distrust as a leftover from a
			// previous session, for a run that was aborted seconds ago.
			if (session === null && !isChat && !(err instanceof KernelExecuteAborted)) kernelDown = true;
		} finally {
			clearInterval(flushTimer);
		}
		// Flush the tail + finalize the truncation marker; this is the array we persist.
		outputs = acc.finish();

		// A SUCCESSFUL chat run finalizes its streamed text into ONE markdown
		// display_data (built from the accumulator's SURVIVING text, so a mid-run
		// clear truncates the reply exactly as it truncates a kernel cell's output)
		// and re-emits it as a full frame at the same stable index - the client's
		// applyOutput replaces in place, snapping the live stream to rendered
		// markdown. Failures pass through untouched: their message is already a
		// display_data of its own.
		//
		// NOT when the accumulator tripped a cap: it appended a truncation marker as
		// a SECOND stream element, and the finalize only republishes index 0 - there
		// is no retract frame, so folding two elements into one would persist ONE
		// output while every client still held the marker at index 1, orphaned until
		// a reload. A capped reply therefore stays as streamed text beside its honest
		// marker; the client's array and the document agree, which outranks rendering
		// the markdown for a reply that is already incomplete.
		if (isChat && status === 'ok' && !acc.wasCapped) {
			const reply = chatReplyOutput(outputs);
			if (reply) {
				outputs = [reply];
				publish({ type: 'run:output', nb, cellId, output: reply, index: 0, originId });
				onEvent?.({ type: 'output', output: reply, index: 0 });
			}
		}

		// A notebook is "loaded in the kernel" iff it has a live kernel entry, which the
		// manager tracks directly — no separate marking step. A kernel-down run (session
		// === null) touched no namespace; either way there is nothing to record here.

		setOutputs(cellId, outputs, nb); // clean-on-save persists the .ipynb
	} finally {
		unregisterRunOutputs(nb, cellId);
	}
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
