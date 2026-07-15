import { subscribe, sseFrame } from '$lib/server/events';
import { queueStateAll } from '$lib/server/run-queue';
import { widgetSnapshot } from '$lib/server/widgets';
import { listKernels } from '$lib/server/kernel';

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
 *
 * Each published event is serialized to its SSE frame ONCE (in `events.js`) and
 * the shared string is fanned out to every open stream — a runaway cell that
 * emits many events no longer re-`JSON.stringify`s each one per connected tab.
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
			// The bus hands each subscriber the event AND its pre-serialized `frame`
			// (built once per publish, shared across all tabs); write it straight
			// through. Seed events below are sent only to THIS new connection, so they
			// build their own frame via `sseFrame`.
			const send = (_event, frame) => enqueue(frame);
			const seed = (event) => enqueue(sseFrame(event));

			enqueue(`data: ${JSON.stringify({ type: 'hello', at: Date.now() })}\n\n`);
			// Seed the run queue on every (re)connect: `queue:changed` only fires on a
			// change, so a tab that connects mid-queue would otherwise show no badges
			// until the next enqueue.
			seed({ type: 'queue:changed', global: true, ...queueStateAll() });
			// Seed live ipywidgets (tqdm bars) too: a tab connecting mid-run must see
			// models opened before it was listening. A full snapshot, so it self-heals.
			seed({ type: 'widget:sync', global: true, ...widgetSnapshot() });
			// Seed the live kernel list so the Kernels sidebar reflects kernels already
			// running when this tab connects. Also a full snapshot — self-healing.
			seed({ type: 'kernel:status', global: true, kernels: listKernels() });
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
