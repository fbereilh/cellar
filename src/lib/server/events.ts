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
 * Publish an event to every open stream. Stamps a per-notebook monotonic `seq`
 * and returns the enriched event (with `seq`) for callers that want it.
 */
export function publish(event: CellarEvent): PublishedEvent {
	const nb = event.nb;
	const seq = (seqs.get(nb) ?? 0) + 1;
	seqs.set(nb, seq);
	const full: PublishedEvent = { ...event, seq };
	emitter.emit('event', full);
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
	emitter.emit('event', full);
	return full;
}

/** Subscribe to all events; returns an unsubscribe function. */
export function subscribe(listener: (event: DispatchedEvent) => void): () => void {
	emitter.on('event', listener);
	return () => emitter.off('event', listener);
}
