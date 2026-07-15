/**
 * Cellar — in-process server→client event bus.
 *
 * A single-process pub/sub used to push live document/run activity to open
 * browser tabs over SSE (`src/routes/api/events/+server.js`). Every run entry
 * point (the UI `/run` route and the MCP run tools) publishes here, so an
 * agent-driven run reaches an already-open browser with no reload.
 *
 * Runs in the same Node process as the notebook document, the kernel bridge,
 * and the in-process MCP server (`src/hooks.server.js`), so there is nothing to
 * serialize across processes — a plain `EventEmitter` is the whole transport.
 *
 * Each event is stamped with a per-notebook monotonic `seq`, delivered as the
 * SSE `id:` field. The client tracks the last `seq` it applied for a notebook
 * and refetches that notebook on a detected gap (the correctness backstop).
 */
import { EventEmitter } from 'node:events';
import type { CellarEvent, PublishedEvent, GlobalEvent, DispatchedEvent } from './types';

const emitter = new EventEmitter();
// One listener per open SSE stream; a browser may hold several tabs open.
emitter.setMaxListeners(0);

const seqs = new Map<string, number>(); // canonical notebook id (absolute path) -> last seq

/**
 * The full SSE frame for a dispatched event — computed ONCE here, then fanned out
 * to every subscriber. A runaway cell that emits many events would otherwise
 * `JSON.stringify` the same event once per open tab; serializing once and sharing
 * the string keeps the broadcast O(tabs) in bytes copied, not O(tabs) in
 * stringify passes. Per-notebook events carry an SSE `id:` (their `seq`, for
 * gap detection); global snapshots carry none.
 */
export function sseFrame(event: DispatchedEvent): string {
	const seq = (event as PublishedEvent).seq;
	const idLine = seq == null ? '' : `id: ${seq}\n`;
	return idLine + `data: ${JSON.stringify(event)}\n\n`;
}

/** Emit an event plus its pre-serialized frame to every subscriber. */
function emit(event: DispatchedEvent): void {
	emitter.emit('event', event, sseFrame(event));
}

/**
 * Publish an event to every open stream. Stamps a per-notebook monotonic `seq`
 * and returns the enriched event (with `seq`) for callers that want it.
 */
export function publish(event: CellarEvent): PublishedEvent {
	const nb = event.nb;
	const seq = (seqs.get(nb) ?? 0) + 1;
	seqs.set(nb, seq);
	const full: PublishedEvent = { ...event, seq };
	emit(full);
	return full;
}

/**
 * Publish an event that belongs to no single notebook — today, the kernel run
 * queue, which spans every open notebook because the kernel does. It carries no
 * `seq`: each such event is a FULL state snapshot, so a missed one is corrected
 * by the next rather than needing gap detection. The client dispatches these
 * before its per-notebook `nb`/`seq` filter.
 */
export function publishGlobal<T extends Record<string, unknown>>(
	event: T
): T & { global: true } {
	const full = { ...event, global: true as const };
	emit(full as unknown as DispatchedEvent);
	return full;
}

/**
 * Subscribe to all events. The listener receives the event object AND its
 * pre-serialized SSE `frame` string (see `sseFrame`) — the SSE route writes the
 * shared frame directly, so the payload is serialized once per publish regardless
 * of how many tabs are connected. Returns an unsubscribe function.
 */
export function subscribe(listener: (event: DispatchedEvent, frame: string) => void): () => void {
	emitter.on('event', listener);
	return () => emitter.off('event', listener);
}
