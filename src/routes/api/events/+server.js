import { subscribe, sseFrame } from '$lib/server/events';
import { queueStateAll } from '$lib/server/run-queue';
import { widgetSnapshot } from '$lib/server/widgets';
import { listKernels } from '$lib/server/kernel';
import { createBackpressureMonitor } from '$lib/server/sse-backpressure';

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
 *
 * Backpressure: the `ReadableStream` queue is unbounded, so a connected-but-not-
 * reading peer (asleep laptop, half-open TCP) would buffer every event in server
 * heap until TCP resets. A `desiredSize` monitor reaps a connection whose send
 * buffer stays backed up past a grace window (see `sse-backpressure.ts`); the
 * client's `EventSource` reconnects and resyncs, so the stuck peer recovers
 * cleanly while a healthy, draining client is never touched.
 */
const HEARTBEAT_MS = 15000;
/**
 * How long `controller.desiredSize` may stay `<= 0` (send buffer backing up)
 * before the connection is reaped. Conservative on purpose: a healthy client
 * drains a burst in well under a second, so a full 15s of continuous backup is a
 * strong dead-peer signal, not a momentary dip.
 */
const BACKPRESSURE_GRACE_MS = 15000;
/** How often to sample `desiredSize`, so a stuck peer is reaped even between events. */
const BACKPRESSURE_CHECK_MS = 5000;

export function GET({ request }) {
	const encoder = new TextEncoder();
	let unsubscribe = null;
	let heartbeat = null;
	let backpressureTimer = null;

	function cleanup() {
		if (unsubscribe) {
			unsubscribe();
			unsubscribe = null;
		}
		if (heartbeat) {
			clearInterval(heartbeat);
			heartbeat = null;
		}
		if (backpressureTimer) {
			clearInterval(backpressureTimer);
			backpressureTimer = null;
		}
	}

	const stream = new ReadableStream({
		start(controller) {
			// Reap a peer whose send buffer stays backed up past the grace window.
			// `controller.error()` (not `close()`) is deliberate: it discards the
			// buffered chunks immediately, actually recovering the heap the stuck
			// client was holding. The client's `EventSource` reconnects + resyncs.
			const monitor = createBackpressureMonitor({
				controller,
				graceMs: BACKPRESSURE_GRACE_MS,
				onReap: () => {
					cleanup();
					try {
						controller.error(new Error('sse backpressure: client not draining'));
					} catch {
						// Already closed/errored — nothing to reap.
					}
				}
			});
			const enqueue = (chunk) => {
				try {
					controller.enqueue(encoder.encode(chunk));
					// Sampling right after each write catches a runaway-cell flood to a
					// stuck peer as fast as the grace allows, not only on the periodic tick.
					monitor.check();
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
			// Sample `desiredSize` on a steady cadence so a stuck peer is reaped even
			// when no events are flowing (the heartbeat alone is too coarse for a 15s
			// grace, and a low-event-rate leak would otherwise linger).
			backpressureTimer = setInterval(() => monitor.check(), BACKPRESSURE_CHECK_MS);

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
