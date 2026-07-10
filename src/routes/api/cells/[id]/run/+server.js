import { execute } from '$lib/server/kernel.js';
import { getCell, setSource, setOutputs, setLastRun, resolveNotebookPath } from '$lib/server/notebook.js';
import { publish } from '$lib/server/events.js';
import { enqueueRun } from '$lib/server/run-queue.js';

/**
 * Run one cell. The given source is saved to the document, executed, and its
 * outputs streamed back live as newline-delimited JSON to the initiating tab
 * while also being accumulated into the cell's `outputs` and persisted to the
 * `.ipynb` on done.
 *
 * There is one kernel for the whole app, so the run first takes a ticket from
 * the kernel-global FIFO (`run-queue.js`). When the kernel is free the ticket
 * resolves immediately and nothing about this route's behavior changes. When it
 * is busy — with this tab's own cell, another tab's, another notebook's, or an
 * agent's — the run WAITS its turn rather than being dropped. The response
 * stream stays open across the wait, so the tab that asked for the run is still
 * the tab that renders it.
 *
 * The same run lifecycle is broadcast over the event bus (`run:start` /
 * `run:output` / `run:end`, tagged `actor:'user'`) so *other* open tabs stay in
 * sync. The event carries the caller's `originId`; the initiating tab drops its
 * own echo (it renders from the NDJSON stream below), so a user's run never
 * double-renders. The "queued" affordance instead rides the queue's own
 * `queue:changed` broadcast, which every tab applies — a queue is global state,
 * not one tab's action, so it has no echo to suppress.
 */
export async function POST({ params, request }) {
	const { source, nb, originId } = await request.json();
	setSource(params.id, source ?? '', nb, originId);

	const canonicalNb = resolveNotebookPath(nb);
	const cellId = params.id;

	const encoder = new TextEncoder();
	const outputs = [];

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
			const code = ticket.source() ?? cell.source ?? '';

			const startedAt = Date.now();
			publish({ type: 'run:start', nb: canonicalNb, cellId, actor: 'user', at: startedAt, originId });
			// The initiating tab drops the SSE echo above, so this is how it learns its
			// own run actually STARTED (rather than merely being accepted into the queue).
			send({ type: 'run:start', cellId, at: startedAt });
			let status = 'ok';
			// The kernel-session epoch this run STARTED in - the only record that this
			// cell ran against the namespace that exists now (see notebook.js
			// `setLastRun`). It arrives on execute()'s `kernel` event, stays null when
			// no kernel could be started, and is never re-read afterwards: an
			// autorestart mid-run bumps the live epoch, and this cell must then read as
			// not-this-session.
			let session = null;
			let kernelDown = false;
			try {
				const reply = await execute(code, (ev) => {
					if (ev.type === 'output') {
						outputs.push(ev.output);
						publish({ type: 'run:output', nb: canonicalNb, cellId, output: ev.output, originId });
					} else if (ev.type === 'kernel') {
						session = ev.session;
					}
					send(ev);
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
				publish({ type: 'run:output', nb: canonicalNb, cellId, output, originId });
				send({ type: 'output', output });
				status = 'error';
				// execute() threw before it ever had a kernel in hand, so no session
				// exists to stamp. Mark the attempt so the agent-facing run_status reads
				// `error_kernel_unavailable` (a LIVE failure) rather than
				// `error_persisted` (leftover, which the doctrine says to ignore).
				if (session === null) kernelDown = true;
			} finally {
				setOutputs(cellId, outputs, nb); // clean-on-save persists the .ipynb
				// Runtime-only run metadata; `at` = run start so "ran X ago" reads as
				// when the run began. Stripped from disk by clean.js (report §4.2).
				const lastRun = { at: startedAt, durationMs: Date.now() - startedAt, actor: 'user', status, session, ...(kernelDown ? { kernel_unavailable: true } : {}) };
				setLastRun(cellId, lastRun, nb);
				// Also send it on the initiating tab's NDJSON stream: that tab drops
				// its own `run:end` SSE echo (originId match), so this is how it learns
				// the metadata to render its own badge.
				send({ type: 'run:end', ...lastRun });
				publish({ type: 'run:end', nb: canonicalNb, cellId, ...lastRun, originId });
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
