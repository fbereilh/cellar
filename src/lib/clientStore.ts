/**
 * The mechanism behind Cellar's two BROWSER-side preference accessors - the
 * per-project `uiState.ts` (`/api/ui-state`) and the cross-project
 * `userSettings.ts` (`/api/user-settings`).
 *
 * The browser half of the same argument `$lib/server/json-store.ts` makes about
 * the server half: the two accessors differ in exactly one thing, WHICH endpoint
 * they PUT to, and therefore what belongs in them; everything else - the
 * synchronous SSR-seeded cache, the `hasOwnProperty` read guard (so a stored
 * `undefined`/`false` is not mistaken for "unset"), `null` deleting a key, the
 * debounced write and the `keepalive` flush on `pagehide` - is one set of rules
 * that has to hold identically for both. Kept as two copies it did not merely
 * repeat itself: a correction to the debounce window or to the unload flush would
 * silently reach only one of them, and the one it missed is the one whose bug
 * shows up as a preference that vanished when the tab closed.
 *
 * What stays OUT of here is what genuinely differs: `uiState`'s one-time
 * `localStorage` migration (threaded in as the `afterSeed` hook, since it is the
 * only caller that has anything to seed) and `userSettings`' change notification
 * (layered on top of `set`, since only a store holding cross-project DEFAULTS has
 * long-lived readers that must re-derive when one moves).
 *
 * Each store owns its own instance, so their caches, pending patches and timers
 * stay independent - a write to one can never flush the other.
 */

import { browser } from '$app/environment';

const FLUSH_DEBOUNCE_MS = 300;

export interface ClientStore {
	/**
	 * Seed the cache from the SSR-provided map, run `afterSeed` (browser only, once
	 * the cache is readable), and arm the unload flush. Called once per store from
	 * `+page.svelte`'s init, before any child reads a preference.
	 */
	hydrate(initial: unknown, afterSeed?: () => void): void;
	/** Whether the store carries a value for `key` (a stored `null` was deleted). */
	has(key: string): boolean;
	/** Current value for `key`, or `fallback` if unset / before hydration. The store
	 *  is untyped JSON, so the caller states the expected shape via `fallback`. */
	get<T>(key: string, fallback: T): T;
	/** Set `key` to `value` (pass `null` to delete) and schedule a server write. */
	set(key: string, value: unknown): void;
	/** Like `set`, but PUTs immediately and resolves once the write is acknowledged. */
	setNow(key: string, value: unknown): Promise<void>;
}

/** A store synchronised with the server map behind `endpoint`. */
export function createClientStore(endpoint: string): ClientStore {
	let cache: Record<string, unknown> = {};
	let hydrated = false;

	let pending: Record<string, unknown> = {};
	let flushTimer: ReturnType<typeof setTimeout> | null = null;

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
			fetch(endpoint, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
				keepalive
			}).catch(() => {});
		} catch {}
	}

	return {
		hydrate(initial, afterSeed) {
			if (initial && typeof initial === 'object' && !Array.isArray(initial)) {
				cache = { ...(initial as Record<string, unknown>) };
			}
			hydrated = true;
			if (browser) {
				afterSeed?.();
				// A preference changed just before the tab closes must still reach the
				// server; flush synchronously past the debounce window.
				window.addEventListener('pagehide', () => flushNow(true));
			}
		},
		has(key) {
			return hydrated && Object.prototype.hasOwnProperty.call(cache, key);
		},
		get<T>(key: string, fallback: T): T {
			return hydrated && Object.prototype.hasOwnProperty.call(cache, key)
				? (cache[key] as T)
				: fallback;
		},
		set(key, value) {
			if (value === null) delete cache[key];
			else cache[key] = value;
			pending[key] = value;
			scheduleFlush();
		},
		async setNow(key, value) {
			if (value === null) delete cache[key];
			else cache[key] = value;
			delete pending[key]; // this synchronous write wins over any queued debounced value
			if (!browser) return;
			try {
				await fetch(endpoint, {
					method: 'PUT',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ [key]: value })
				});
			} catch {
				// A failed persist leaves the caller's optimistic local state in place; see
				// the call site for what that degrades to.
			}
		}
	};
}
