import { execute } from '$lib/server/kernel.js';
import { setSource, setOutputs } from '$lib/server/notebook.js';

/**
 * Run one cell. The given source is saved to the document, executed, and its
 * outputs streamed back live as newline-delimited JSON while also being
 * accumulated into the cell's `outputs` and persisted to the `.ipynb` on done.
 */
export async function POST({ params, request }) {
	const { source } = await request.json();
	setSource(params.id, source ?? '');

	const encoder = new TextEncoder();
	const outputs = [];

	const stream = new ReadableStream({
		async start(controller) {
			const send = (event) => controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
			try {
				await execute(source ?? '', (ev) => {
					if (ev.type === 'output') outputs.push(ev.output);
					send(ev);
				});
			} catch (err) {
				const output = {
					output_type: 'error',
					ename: 'CellarError',
					evalue: String(err?.message ?? err),
					traceback: [String(err?.message ?? err)]
				};
				outputs.push(output);
				send({ type: 'output', output });
			} finally {
				setOutputs(params.id, outputs); // clean-on-save persists the .ipynb
				controller.close();
			}
		}
	});

	return new Response(stream, {
		headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache' }
	});
}
