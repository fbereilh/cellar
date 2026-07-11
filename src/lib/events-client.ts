/**
 * Cellar — shared client event stream (one `EventSource` per browser tab).
 *
 * Every mounted `LiveNotebook` subscribes here rather than opening its own
 * `EventSource`, so a tab holds a single `/api/events` connection no matter how
 * many notebooks are open — staying well under the HTTP/1.1 ~6-connection cap
 * that would otherwise starve regular API calls. The connection is opened
 * lazily on the first subscriber and closed when the last one leaves.
 *
 * Listeners receive parsed event objects, plus a synthetic `{ type: 'sse:open' }`
 * on every (re)connect so each notebook can resync itself as the correctness
 * backstop (`EventSource` reconnects on its own).
 */
import { browser } from '$app/environment';
import type { DispatchedEvent } from '$lib/server/types';

/** A synthetic frame emitted on every (re)connect so a notebook can resync. */
export interface SseOpenEvent {
	type: 'sse:open';
}

/** Anything a subscriber receives: a bus event, or the synthetic open frame. */
export type ClientEvent = DispatchedEvent | SseOpenEvent;

/** A subscriber callback. */
export type EventListener = (ev: ClientEvent) => void;

/**
 * Per-tab origin id. A UI run's POST carries this; the server echoes it on the
 * published run events, so the initiating tab can drop its own echo (it already
 * renders that run from the `/run` NDJSON response) while other tabs — and all
 * agent runs, which carry no origin — render live.
 */
export const originId = browser && globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : 'ssr';

let source: EventSource | null = null;
const listeners = new Set<EventListener>();
/**
 * The most recent `queue:changed` snapshot. The kernel's run queue only
 * broadcasts on a change, so a notebook mounted while a cell is already queued
 * (a second tab, or a notebook opened mid-run) would show no queue badge until
 * the next enqueue. Replaying the latest snapshot to a new subscriber closes
 * that window — it is a full snapshot, so replaying it is always safe.
 */
let lastQueue: ClientEvent | null = null;

function ensureSource(): void {
	if (source || !browser) return;
	source = new EventSource('/api/events');
	source.addEventListener('message', (msg: MessageEvent) => {
		let ev: ClientEvent;
		try {
			ev = JSON.parse(msg.data);
		} catch {
			return;
		}
		if (ev.type === 'queue:changed') lastQueue = ev;
		for (const listener of listeners) listener(ev);
	});
	// Fires on the initial connect and on every automatic reconnect.
	source.addEventListener('open', () => {
		for (const listener of listeners) listener({ type: 'sse:open' });
	});
}

/**
 * Subscribe to the shared event stream. Returns an unsubscribe function; the
 * underlying `EventSource` closes once the last subscriber unsubscribes.
 */
export function subscribeEvents(listener: EventListener): () => void {
	if (!browser) return () => {};
	listeners.add(listener);
	ensureSource();
	if (lastQueue) listener(lastQueue); // catch a late subscriber up on the run queue
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0 && source) {
			source.close();
			source = null;
			lastQueue = null; // the next connect re-seeds it (the SSE stream sends a snapshot)
		}
	};
}
