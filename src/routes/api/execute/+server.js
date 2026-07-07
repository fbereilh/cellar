import { execute } from '$lib/server/kernel.js';

/**
 * Execute one code cell and stream its outputs back live in this response
 * body as newline-delimited JSON (one event object per line). The browser
 * reads the body incrementally, so outputs appear as they arrive.
 */
export async function POST({ request }) {
	const { code } = await request.json();
	const encoder = new TextEncoder();

	const stream = new ReadableStream({
		async start(controller) {
			const send = (event) => {
				controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
			};
			try {
				await execute(code ?? '', send);
			} catch (err) {
				send({ type: 'error', ename: 'CellarError', evalue: String(err?.message ?? err), traceback: [String(err?.message ?? err)] });
			} finally {
				controller.close();
			}
		}
	});

	return new Response(stream, {
		headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache' }
	});
}
