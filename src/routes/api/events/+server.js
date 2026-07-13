import { subscribe } from '$lib/server/events';
import { queueStateAll } from '$lib/server/run-queue';
import { widgetSnapshot } from '$lib/server/widgets';

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
			// Global events (the kernel run queue) carry no per-notebook `seq`, so they
			// carry no SSE `id:` either — there is no gap to detect in a full snapshot.
			const send = (event) =>
				enqueue((event.seq == null ? '' : `id: ${event.seq}\n`) + `data: ${JSON.stringify(event)}\n\n`);

			enqueue(`data: ${JSON.stringify({ type: 'hello', at: Date.now() })}\n\n`);
			// Seed the run queue on every (re)connect: `queue:changed` only fires on a
			// change, so a tab that connects mid-queue would otherwise show no badges
			// until the next enqueue.
			send({ type: 'queue:changed', global: true, ...queueStateAll() });
			// Seed live ipywidgets (tqdm bars) too: a tab connecting mid-run must see
			// models opened before it was listening. A full snapshot, so it self-heals.
			send({ type: 'widget:sync', global: true, ...widgetSnapshot() });
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
