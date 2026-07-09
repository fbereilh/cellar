import { subscribe } from '$lib/server/events.js';

/**
 * Server-Sent Events stream — one per browser tab, carrying live document/run
 * events for *all* notebooks (each tagged with its canonical `nb` id; the
 * client filters per mounted notebook). Chosen over WebSocket because the push
 * is one-directional (every client action already goes over REST/NDJSON) and a
 * long-lived `ReadableStream` `Response` is first-class under adapter-node.
 *
 * Emits a `hello` on connect, a ~15s heartbeat comment to keep the connection
 * from idling out through proxies, and tears the subscription + timer down when
 * the client disconnects. `EventSource` reconnects automatically; the client
 * refetches affected notebooks on (re)connect and on a detected `seq` gap.
 */
const HEARTBEAT_MS = 15000;

export function GET({ request }) {
	const encoder = new TextEncoder();
	let unsubscribe = null;
	let heartbeat = null;

	function cleanup() {
		if (unsubscribe) {
			unsubscribe();
			unsubscribe = null;
		}
		if (heartbeat) {
			clearInterval(heartbeat);
			heartbeat = null;
		}
	}

	const stream = new ReadableStream({
		start(controller) {
			const enqueue = (chunk) => {
				try {
					controller.enqueue(encoder.encode(chunk));
					return true;
				} catch {
					// Stream already closed (client vanished mid-write) — stop pushing.
					cleanup();
					return false;
				}
			};
			const send = (event) => enqueue(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);

			enqueue(`data: ${JSON.stringify({ type: 'hello', at: Date.now() })}\n\n`);
			unsubscribe = subscribe(send);
			heartbeat = setInterval(() => enqueue(': heartbeat\n\n'), HEARTBEAT_MS);

			request.signal.addEventListener('abort', cleanup);
		},
		cancel() {
			cleanup();
		}
	});

	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache, no-transform',
			connection: 'keep-alive'
		}
	});
}
