/**
 * Client-side accessor for the CROSS-PROJECT user-setting store.
 *
 * The exact shape of `$lib/uiState`, one store up: the server owns the file
 * (`$lib/server/user-settings.ts`, under `~/.cellar/`), it is delivered by SSR
 * (`+page.server.js` → `data.userSettings`) and hydrated during `+page.svelte`'s
 * init, so a reader gets it **synchronously** with no fetch and no flash.
 *
 * There is no `localStorage` migration here, and that is not an omission: this
 * store has no `localStorage` past to migrate FROM, and a per-origin mirror would
 * be scoped to one dynamic port - the very thing a cross-project setting must
 * outlive.
 *
 * What it holds is a DEFAULT, and only ever that. The per-project store answers
 * for a project that has an answer; this answers for a project that has never been
 * asked. Readers seed from it, never override with it - see the `getUi` /
 * `getUserSetting` pairing at the Databricks affix fields.
 */

import { browser } from '$app/environment';

const FLUSH_DEBOUNCE_MS = 300;

let cache: Record<string, unknown> = {};
let hydrated = false;

let pending: Record<string, unknown> = {};
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** Seed the cache from the SSR-provided store. Called once from `+page.svelte`. */
export function hydrateUserSettings(initial: unknown): void {
	if (initial && typeof initial === 'object' && !Array.isArray(initial)) {
		cache = { ...(initial as Record<string, unknown>) };
	}
	hydrated = true;
	// A setting changed just before the tab closes must still reach the server;
	// flush synchronously past the debounce window.
	if (browser) window.addEventListener('pagehide', () => flushNow(true));
}

/** Current value for `key`, or `fallback` if unset / before hydration. */
export function getUserSetting<T>(key: string, fallback: T): T {
	return hydrated && Object.prototype.hasOwnProperty.call(cache, key)
		? (cache[key] as T)
		: fallback;
}

/** Set `key` to `value` (pass `null` to delete) and schedule a server write. */
export function setUserSetting(key: string, value: unknown): void {
	if (value === null) delete cache[key];
	else cache[key] = value;
	pending[key] = value;
	scheduleFlush();
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
		fetch('/api/user-settings', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
			keepalive
		}).catch(() => {});
	} catch {}
}
