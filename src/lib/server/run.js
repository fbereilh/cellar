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
import { execute } from './kernel.js';
import { setOutputs, setLastRun } from './notebook.js';
import { publish } from './events.js';

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
export async function executeCellRun({ nb, cellId, actor, source, originId, onEvent }) {
	const startedAt = Date.now();
	publish({ type: 'run:start', nb, cellId, actor, at: startedAt, originId });
	onEvent?.({ type: 'run:start', cellId, at: startedAt });

	const outputs = [];
	let status = 'ok';
	let session = null;
	let kernelDown = false;
	try {
		const reply = await execute(source, (ev) => {
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
		const output = {
			output_type: 'error',
			ename: 'CellarError',
			evalue: String(err?.message ?? err),
			traceback: [String(err?.message ?? err)]
		};
		outputs.push(output);
		publish({ type: 'run:output', nb, cellId, output, originId });
		onEvent?.({ type: 'output', output });
		status = 'error';
		// execute() threw before it ever had a kernel in hand, so there is no session
		// to stamp: this failure is the run the caller just asked for, not a leftover.
		if (session === null) kernelDown = true;
	}

	setOutputs(cellId, outputs, nb); // clean-on-save persists the .ipynb
	// Runtime-only run metadata (stripped from disk by clean.js); `at` = run start,
	// so "ran X ago" reads as when the run began.
	const lastRun = {
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
