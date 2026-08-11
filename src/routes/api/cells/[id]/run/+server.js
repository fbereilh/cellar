import { getCell, setSource, resolveNotebookPath } from '$lib/server/notebook';
import { enqueueRun } from '$lib/server/run-queue';
import { executeCellRun, clearOutputsForQueue } from '$lib/server/run';

/**
 * Run one cell. The given source is saved to the document, executed, and its
 * outputs streamed back live as newline-delimited JSON to the initiating tab
 * while also being accumulated into the cell's `outputs` and persisted to the
 * `.ipynb` on done.
 *
 * Each notebook has its own kernel, so the run first takes a ticket from that
 * notebook's FIFO (`run-queue.js`). When the notebook's kernel is free the ticket
 * resolves immediately and nothing about this route's behavior changes. When it
 * is busy — with this tab's own cell, another tab's, or an agent's — the run
 * WAITS its turn rather than being dropped (another NOTEBOOK being busy never
 * queues this one). The response stream stays open across the wait, so the tab
 * that asked for the run is still the tab that renders it.
 *
 * The execution itself — persist, stamp, broadcast — belongs to `executeCellRun`
 * (`run.js`), shared with the MCP `run_cell` tool and the imports cell, so what
 * "running a cell" means cannot drift between them. This route owns only the
 * queue ticket and the NDJSON stream: `onEvent` forwards the run lifecycle to the
 * initiating tab, which drops its own `originId`-tagged SSE echo and would
 * otherwise never learn its run started.
 *
 * ONLY A CODE CELL EXECUTES, and that is enforced at EACH ENTRY POINT rather than
 * in the shared core: here for HTTP, in `mcp/service.ts` for `run_cell`, and in
 * `jupytext-actions.ts`'s `runAllCells`, which filters to `cell_type === 'code'`
 * before calling `executeCellRun`. `executeCellRun` is deliberately NOT the gate -
 * each door owes its caller a different refusal SHAPE (this route's terminal
 * `run:refused` NDJSON frame, MCP's `status:'skipped'` result), which the core has
 * no way to speak - so a new run path must bring its own check, not inherit one.
 * Without it the route handed whatever source it was POSTed straight to the
 * kernel: a raw cell (verbatim text for a downstream tool) sent its YAML
 * frontmatter to Python, and the resulting `SyntaxError` was written into that
 * cell's in-memory `outputs` where the UI showed it - then vanished on reload,
 * because `serialize` drops outputs for any non-code cell. The submitted source is still SAVED first, so a `Mod-Enter` in a
 * raw cell persists the edit rather than losing it.
 */
export async function POST({ params, request }) {
	const { source, nb, originId } = await request.json();
	setSource(params.id, source ?? '', nb, originId);

	const canonicalNb = resolveNotebookPath(nb);
	const cellId = params.id;

	// Refused BEFORE `enqueueRun`, so a cell that can never execute never takes a
	// queue slot. A terminal NDJSON frame at HTTP 200 rather than a 400: this route
	// already answers "accepted but did not run" that way (`run:duplicate`,
	// `run:cancelled`), and the client's reader ignores frame types it has no
	// branch for - so `started` stays false, the outputs are untouched and no
	// spinner is ever set, with no client change required for correctness.
	const target = getCell(cellId, nb);
	if (target && target.cell_type !== 'code') {
		const refusal =
			JSON.stringify({ type: 'run:refused', cellId, reason: 'not-a-code-cell', cell_type: target.cell_type }) + '\n';
		return new Response(refusal, {
			headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache' }
		});
	}

	const encoder = new TextEncoder();

	// Claim the kernel before opening the stream, so the queue reflects submission
	// order rather than the order the streams happen to start in.
	const ticket = enqueueRun({ nb: canonicalNb, cellId, actor: 'user', source: source ?? '' });

	const stream = new ReadableStream({
		async start(controller) {
			const send = (event) => {
				try {
					controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
				} catch {
					// The client vanished mid-run; the run still completes and persists.
				}
			};

			// Pressing Run on a cell that is already running or already queued must not
			// enqueue it twice. The queue kept our newly submitted source, so the
			// pending run will execute what the user last asked for.
			if (ticket.duplicate) {
				send({ type: 'run:duplicate', cellId, position: ticket.position });
				controller.close();
				return;
			}

			// Clear the cell's stale output the instant it enters the queue, not when
			// its turn finally comes. Empties the in-memory doc + broadcasts run:cleared
			// to other tabs; this tab drops that SSE echo (originId), so `send` clears it
			// here on its own NDJSON stream.
			clearOutputsForQueue({ nb: canonicalNb, cellId, originId, onEvent: send });

			try {
				await ticket.wait();
			} catch (err) {
				// A restart / interrupt / rebind dropped this pending run before it ever
				// touched a kernel: no outputs, no lastRun stamp, nothing to invalidate.
				send({ type: 'run:cancelled', cellId, reason: err?.reason ?? 'cancelled' });
				controller.close();
				return;
			}

			// The kernel is ours. Read the source the cell holds NOW: a queued cell may
			// have been edited (or re-submitted) while it waited, and running what the
			// user last submitted is what makes the no-double-enqueue rule safe.
			const cell = getCell(cellId, nb);
			if (!cell) {
				send({ type: 'run:cancelled', cellId, reason: 'cell_removed' });
				ticket.done();
				controller.close();
				return;
			}

			try {
				await executeCellRun({
					nb: canonicalNb,
					cellId,
					actor: 'user',
					source: ticket.source() ?? cell.source ?? '',
					originId,
					onEvent: send
				});
			} finally {
				// Hand the kernel to the next queued run only once this one is fully
				// persisted and broadcast, so the wire order stays run:end → run:start.
				ticket.done();
				controller.close();
			}
		},
		cancel() {
			// The tab went away while this run was still waiting its turn. Drop it
			// rather than executing a run nobody is listening to. Identity-checked, so
			// a *duplicate* request's stream closing can never cancel the real pending
			// run behind the same cell; a run already executing is likewise untouched
			// (its outputs still persist to the `.ipynb`).
			ticket.cancel?.('client_disconnected');
		}
	});

	return new Response(stream, {
		headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache' }
	});
}
