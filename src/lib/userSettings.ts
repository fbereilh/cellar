/**
 * Client-side accessor for the CROSS-PROJECT user-setting store.
 *
 * The exact shape of `$lib/uiState`, one store up: the server owns the file
 * (`$lib/server/user-settings.ts`, under `~/.cellar/`), it is delivered by SSR
 * (`+page.server.js` → `data.userSettings`) and hydrated during `+page.svelte`'s
 * init, so a reader gets it **synchronously** with no fetch and no flash. The
 * cache, the debounce and the unload flush are literally the same code
 * (`$lib/clientStore`), so a fix to any of them reaches both stores.
 *
 * There is no `localStorage` migration here, and that is not an omission: this
 * store has no `localStorage` past to migrate FROM, and a per-origin mirror would
 * be scoped to one dynamic port - the very thing a cross-project setting must
 * outlive.
 *
 * What it holds is a DEFAULT, and only ever that. The per-project store answers
 * for a project that has an answer; this answers for a project that has never been
 * asked. Readers seed from it, never override with it - see the `getUi` /
 * `getUserSettingText` pairing at the Databricks affix fields.
 */

import { createClientStore } from '$lib/clientStore';

const store = createClientStore('/api/user-settings');

/** Seed the cache from the SSR-provided store. Called once from `+page.svelte`. */
export function hydrateUserSettings(initial: unknown): void {
	store.hydrate(initial);
}

/**
 * Current value for `key`, or `fallback` if unset / before hydration.
 *
 * MODULE-PRIVATE, deliberately. The store is untyped JSON, so `fallback` states the
 * expected shape but proves nothing about what is really there - and every value
 * this store holds today ends up in a NAME. Exporting the untyped read beside the
 * guarded one left the rule below as documentation a caller had to remember; keeping
 * it in here makes `getUserSettingText` the only way in, so there is nothing to
 * remember. A future caller that genuinely needs a non-text setting exports its own
 * guarded accessor beside that one, rather than reopening this.
 */
function getUserSetting<T>(key: string, fallback: T): T {
	return store.get(key, fallback);
}

/**
 * A setting read as TEXT, with anything that is not a string degrading to `''`.
 *
 * The ONE read this module offers, and the reason it is shared rather than a
 * `typeof` check at each surface. This store is untyped JSON on disk and
 * `/api/user-settings` accepts any JSON value, so a hand-edited
 * `~/.cellar/settings.json` (or a PUT) can put a number where a prefix belongs - and
 * the consumers hand it straight to `expandDateTokens`, whose `text.replace` then
 * throws inside a render-time `$derived`. Nothing in this app mounts a
 * `<svelte:boundary>`, so that throw does not cost one field: it takes the whole
 * render tree with it. Degrading to "no affix" is both the safe reading and the
 * honest one - a value that is not text was never an affix.
 */
export function getUserSettingText(key: string): string {
	const value = getUserSetting<unknown>(key, '');
	return typeof value === 'string' ? value : '';
}

/** Set `key` to `value` (pass `null` to delete) and schedule a server write. */
export function setUserSetting(key: string, value: unknown): void {
	store.set(key, value);
	for (const fn of listeners) fn();
}

const listeners = new Set<() => void>();

/**
 * Run `fn` whenever a setting changes; returns the unsubscribe.
 *
 * A DEFAULT is read by long-lived surfaces (the Databricks panel is mounted lazily
 * and then kept mounted for the session), so a one-shot read latches whatever the
 * store held when they happened to mount - which is how a default set in Settings
 * came to reach the sidebar only after a reload. The notification is what lets a
 * reader stay a reader; it is deliberately a bare "something changed" rather than a
 * key/value, so the subscriber re-derives through its own precedence rule instead
 * of learning a second, drifting copy of it.
 */
export function onUserSettingsChange(fn: () => void): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}
