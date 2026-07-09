import { execute } from '$lib/server/kernel.js';
import { setSource, setOutputs, resolveNotebookPath } from '$lib/server/notebook.js';
import { publish } from '$lib/server/events.js';

/**
 * Run one cell. The given source is saved to the document, executed, and its
 * outputs streamed back live as newline-delimited JSON to the initiating tab
 * while also being accumulated into the cell's `outputs` and persisted to the
 * `.ipynb` on done.
 *
 * The same run lifecycle is broadcast over the event bus (`run:start` /
 * `run:output` / `run:end`, tagged `actor:'user'`) so *other* open tabs stay in
 * sync. The event carries the caller's `originId`; the initiating tab drops its
 * own echo (it renders from the NDJSON stream below), so a user's run never
 * double-renders.
 */
export async function POST({ params, request }) {
	const { source, nb, originId } = await request.json();
	setSource(params.id, source ?? '', nb, originId);

	const canonicalNb = resolveNotebookPath(nb);
	const cellId = params.id;
	const startedAt = Date.now();

	const encoder = new TextEncoder();
	const outputs = [];

	const stream = new ReadableStream({
		async start(controller) {
			const send = (event) => controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
			publish({ type: 'run:start', nb: canonicalNb, cellId, actor: 'user', at: startedAt, originId });
			let status = 'ok';
			try {
				const reply = await execute(source ?? '', (ev) => {
					if (ev.type === 'output') {
						outputs.push(ev.output);
						publish({ type: 'run:output', nb: canonicalNb, cellId, output: ev.output, originId });
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
			} finally {
				setOutputs(cellId, outputs, nb); // clean-on-save persists the .ipynb
				publish({ type: 'run:end', nb: canonicalNb, cellId, actor: 'user', at: Date.now(), durationMs: Date.now() - startedAt, status, originId });
				controller.close();
			}
		}
	});

	return new Response(stream, {
		headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache' }
	});
}
