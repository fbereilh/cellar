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

/**
 * Per-tab origin id. A UI run's POST carries this; the server echoes it on the
 * published run events, so the initiating tab can drop its own echo (it already
 * renders that run from the `/run` NDJSON response) while other tabs — and all
 * agent runs, which carry no origin — render live.
 */
export const originId = browser && globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : 'ssr';

let source = null;
const listeners = new Set();

function ensureSource() {
	if (source || !browser) return;
	source = new EventSource('/api/events');
	source.addEventListener('message', (msg) => {
		let ev;
		try {
			ev = JSON.parse(msg.data);
		} catch {
			return;
		}
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
export function subscribeEvents(listener) {
	if (!browser) return () => {};
	listeners.add(listener);
	ensureSource();
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0 && source) {
			source.close();
			source = null;
		}
	};
}
