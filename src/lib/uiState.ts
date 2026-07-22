/**
 * Client-side accessor for the per-project UI-preference store.
 *
 * The server owns the preferences (`$lib/server/ui-state.js`, a JSON file under
 * the workspace's `.cellar/`). They are delivered to the browser via SSR
 * (`+page.server.js` → `data.uiState`) and handed here through `hydrateUiState`
 * during `+page.svelte`'s init, so every consumer reads them **synchronously**
 * from the in-memory `cache` with no fetch and no flash - the fix for the
 * dynamic-port bug where a per-origin `localStorage` reset every preference on
 * each relaunch.
 *
 * Reads are `getUi(key, fallback)`; writes are `setUi(key, value)`, which update
 * the cache immediately and PUT back to the server, debounced so a rapid burst
 * (dragging a resizer) coalesces into one request. The server store is the
 * cross-launch source of truth; there is deliberately no `localStorage` mirror.
 */

import { browser } from '$app/environment';

const FLUSH_DEBOUNCE_MS = 300;
/** localStorage keys we one-time migrate; everything under this prefix except… */
const LS_PREFIX = 'cellar-';
/**
 * …the keys deliberately left on `localStorage`. Keybinding rebindings are a
 * global user preference (about the person, not this project's layout), so they
 * do not belong in the per-project `.cellar/` store - see the PR notes.
 */
const LS_SKIP = new Set(['cellar-shortcuts']);

let cache: Record<string, unknown> = {};
let hydrated = false;

let pending: Record<string, unknown> = {};
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Seed the cache from the SSR-provided store, then one-time migrate any prefs a
 * returning same-port user still has in `localStorage`. Called once from
 * `+page.svelte` before any child reads a preference.
 */
export function hydrateUiState(initial: unknown): void {
	if (initial && typeof initial === 'object' && !Array.isArray(initial)) {
		cache = { ...(initial as Record<string, unknown>) };
	}
	hydrated = true;
	if (browser) {
		migrateFromLocalStorage();
		// A preference changed just before the tab closes must still reach the
		// server; flush synchronously past the debounce window.
		window.addEventListener('pagehide', () => flushNow(true));
	}
}

/** Current value for `key`, or `fallback` if unset / before hydration. The store
 * is untyped JSON, so the caller states the expected shape via `fallback`. */
export function getUi<T>(key: string, fallback: T): T {
	return hydrated && Object.prototype.hasOwnProperty.call(cache, key)
		? (cache[key] as T)
		: fallback;
}

/** Set `key` to `value` (pass `null` to delete) and schedule a server write. */
export function setUi(key: string, value: unknown): void {
	if (value === null) delete cache[key];
	else cache[key] = value;
	pending[key] = value;
	scheduleFlush();
}

/**
 * Like `setUi`, but PUTs the change to the server IMMEDIATELY and resolves once
 * the write is acknowledged - for the rare caller that must guarantee the server
 * store already reflects the value before a FOLLOWING server action reads it. The
 * Databricks runtime toggle is the one such caller: it must persist the on/off (and
 * version) preference server-side before restarting the kernel, because the restart
 * re-reads the store to decide whether to inject `DATABRICKS_RUNTIME_VERSION`, and
 * the debounced `setUi` PUT could still be in flight. This write supersedes any
 * value the debounced path had queued for the same key. A no-op off the browser.
 */
export async function setUiNow(key: string, value: unknown): Promise<void> {
	if (value === null) delete cache[key];
	else cache[key] = value;
	delete pending[key]; // this synchronous write wins over any queued debounced value
	if (!browser) return;
	try {
		await fetch('/api/ui-state', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ [key]: value })
		});
	} catch {
		// A failed persist degrades to "runtime applies on the next kernel start"; the
		// caller's optimistic local state still reflects the user's choice.
	}
}

/**
 * The server store is the cross-launch source of truth, so a value that only
 * exists in a returning same-port user's `localStorage` is seeded into it once.
 * A key the server already knows always wins (it is never overwritten).
 */
function migrateFromLocalStorage() {
	let seeded = false;
	try {
		for (let i = 0; i < localStorage.length; i++) {
			const key = localStorage.key(i);
			if (!key || !key.startsWith(LS_PREFIX) || LS_SKIP.has(key)) continue;
			if (Object.prototype.hasOwnProperty.call(cache, key)) continue;
			const raw = localStorage.getItem(key);
			if (raw == null) continue;
			let value: unknown;
			try {
				value = JSON.parse(raw);
			} catch {
				value = raw; // legacy non-JSON value (e.g. the raw theme name)
			}
			cache[key] = value;
			pending[key] = value;
			seeded = true;
		}
	} catch {}
	if (seeded) scheduleFlush();
}

function scheduleFlush(): void {
	if (!browser || flushTimer) return;
	flushTimer = setTimeout(() => flushNow(false), FLUSH_DEBOUNCE_MS);
}

function flushNow(keepalive: boolean): void {
	if (flushTimer) {
		clearTimeout(flushTimer);
		flushTimer = null;
	}
	const body = pending;
	if (Object.keys(body).length === 0) return;
	pending = {};
	try {
		fetch('/api/ui-state', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
			keepalive
		}).catch(() => {});
	} catch {}
}
