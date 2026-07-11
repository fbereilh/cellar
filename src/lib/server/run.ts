/**
 * Cellar — the one cell-execution core.
 *
 * Three callers need to run a cell against the shared kernel: the UI's `/run`
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
import { execute, markNotebookLoaded } from './kernel';
import { setOutputs, setLastRun, clearOutputsLive, getCell } from './notebook';
import { publish } from './events';
import { isSqlCell } from '../cellLanguage';
import { sqlToPython } from './sql';
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
	// Clear stale output the moment execution starts (the caller already holds the
	// kernel, so this is post-queue): the browser clears on the `run:start` frame
	// below, and this keeps the live in-memory model in step so a tab loading
	// mid-run reads an empty cell rather than the prior run's outputs.
	clearOutputsLive(cellId, nb);
	publish({ type: 'run:start', nb, cellId, actor, at: startedAt, originId });
	onEvent?.({ type: 'run:start', cellId, at: startedAt });

	// A SQL cell stores raw SQL but the kernel is Python: compile it to the
	// `spark.sql(...)` wrapper at run time (source on disk stays SQL). Everything
	// downstream - persist, stamp, broadcast - is identical to a code cell.
	const cell = getCell(cellId, nb);
	const execSource = isSqlCell(cell) ? sqlToPython(source) : source;

	const outputs: CellOutput[] = [];
	let status = 'ok';
	let session: SessionId | null = null;
	let kernelDown = false;
	try {
		const reply = await execute(execSource, (ev) => {
			if (ev.type === 'output') {
				outputs.push(ev.output);
				publish({ type: 'run:output', nb, cellId, output: ev.output, originId });
			} else if (ev.type === 'kernel') {
				session = ev.session;
			}
			onEvent?.(ev);
		});
		status = reply?.status ?? 'ok';
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const output: CellOutput = {
			output_type: 'error',
			ename: 'CellarError',
			evalue: message,
			traceback: [message]
		};
		outputs.push(output);
		publish({ type: 'run:output', nb, cellId, output, originId });
		onEvent?.({ type: 'output', output });
		status = 'error';
		// execute() threw before it ever had a kernel in hand, so there is no session
		// to stamp: this failure is the run the caller just asked for, not a leftover.
		if (session === null) kernelDown = true;
	}

	// A real kernel session executed this cell (session != null) → its state now
	// lives in the shared namespace, so this notebook is "loaded in the kernel".
	// A kernel-down run (session === null) touched no namespace and is skipped.
	if (session !== null) markNotebookLoaded(nb, session);

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
