/**
 * Client-side accessor for the per-project UI-preference store.
 *
 * The server owns the preferences (`$lib/server/ui-state.js`, a JSON file under
 * the workspace's `.cellar/`). They are delivered to the browser via SSR
 * (`+page.server.js` → `data.uiState`) and handed here through `hydrateUiState`
 * during `+page.svelte`'s init, so every consumer reads them **synchronously**
 * from the in-memory cache with no fetch and no flash - the fix for the
 * dynamic-port bug where a per-origin `localStorage` reset every preference on
 * each relaunch.
 *
 * Reads are `getUi(key, fallback)`; writes are `setUi(key, value)`, which update
 * the cache immediately and PUT back to the server, debounced so a rapid burst
 * (dragging a resizer) coalesces into one request. The server store is the
 * cross-launch source of truth; there is deliberately no `localStorage` mirror.
 *
 * The cache, the debounce and the unload flush are `$lib/clientStore`'s, shared
 * with the cross-project `$lib/userSettings` rather than mirrored there. What is
 * local to this store is what is genuinely local: the one-time `localStorage`
 * migration below, and `setUiNow`.
 */

import { createClientStore } from '$lib/clientStore';

/** localStorage keys we one-time migrate; everything under this prefix except… */
const LS_PREFIX = 'cellar-';
/**
 * …the keys deliberately left on `localStorage`. Keybinding rebindings are a
 * global user preference (about the person, not this project's layout), so they
 * do not belong in the per-project `.cellar/` store - see the PR notes.
 */
const LS_SKIP = new Set(['cellar-shortcuts']);

const store = createClientStore('/api/ui-state');

/**
 * Seed the cache from the SSR-provided store, then one-time migrate any prefs a
 * returning same-port user still has in `localStorage`. Called once from
 * `+page.svelte` before any child reads a preference.
 */
export function hydrateUiState(initial: unknown): void {
	store.hydrate(initial, migrateFromLocalStorage);
}

/** Current value for `key`, or `fallback` if unset / before hydration. The store
 * is untyped JSON, so the caller states the expected shape via `fallback`. */
export function getUi<T>(key: string, fallback: T): T {
	return store.get(key, fallback);
}

/** Set `key` to `value` (pass `null` to delete) and schedule a server write. */
export function setUi(key: string, value: unknown): void {
	store.set(key, value);
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
 *
 * A failed persist degrades to "runtime applies on the next kernel start"; the
 * caller's optimistic local state still reflects the user's choice.
 */
export async function setUiNow(key: string, value: unknown): Promise<void> {
	await store.setNow(key, value);
}

/**
 * The server store is the cross-launch source of truth, so a value that only
 * exists in a returning same-port user's `localStorage` is seeded into it once.
 * A key the server already knows always wins (it is never overwritten).
 */
function migrateFromLocalStorage() {
	try {
		for (let i = 0; i < localStorage.length; i++) {
			const key = localStorage.key(i);
			if (!key || !key.startsWith(LS_PREFIX) || LS_SKIP.has(key)) continue;
			if (store.has(key)) continue;
			const raw = localStorage.getItem(key);
			if (raw == null) continue;
			let value: unknown;
			try {
				value = JSON.parse(raw);
			} catch {
				value = raw; // legacy non-JSON value (e.g. the raw theme name)
			}
			store.set(key, value);
		}
	} catch {}
}
