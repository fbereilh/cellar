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
 * Where a setting ALSO exists per project, what this holds is a DEFAULT and only
 * ever that: the per-project store answers for a project that has an answer, this
 * answers for a project that has never been asked, and readers seed from it rather
 * than override with it - see the `getUi` / `getUserSettingText` pairing at the
 * Databricks affix fields. A setting that is about the PERSON and has no
 * per-project counterpart (the chat model and web-search opt-in) is the live value
 * instead, read straight off this store by the server when a chat cell runs -
 * which is why those two write through `setUserSettingNow` below.
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
 * expected shape but proves nothing about what is really there - and what this store
 * holds ends up somewhere a wrong shape is expensive: a NAME the app renders and
 * uploads under, or a CAPABILITY a chat run is granted. Exporting the untyped read
 * beside the guarded ones left that rule as documentation a caller had to remember;
 * keeping it in here makes the guarded accessors below the only way in, so there is
 * nothing to remember. A future caller whose setting fits neither shape exports its
 * own guarded accessor beside them, rather than reopening this.
 */
function getUserSetting<T>(key: string, fallback: T): T {
	return store.get(key, fallback);
}

/**
 * A setting read as TEXT, with anything that is not a string degrading to `''`.
 *
 * The read for every setting that becomes TEXT (`getUserSettingFlag` below is its one
 * sibling), and the reason it is shared rather than a `typeof` check at each
 * surface. This store is untyped JSON on disk and
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

/**
 * A setting read as a strict opt-in FLAG: only a literal stored `true` is true.
 *
 * The guarded accessor for the non-text settings (the module comment above names
 * this as the extension path). Strictness is the point, not a convenience: the
 * flags read through this gate CAPABILITY (chat web search), so a hand-edited
 * `"true"`, `1`, or `{}` in the untyped store must read as OFF - the same
 * `=== true` rule the server side applies (`chatWebSearchEnabled`), so the two
 * sides cannot disagree about what the store says.
 */
export function getUserSettingFlag(key: string): boolean {
	return getUserSetting<unknown>(key, false) === true;
}

/** Set `key` to `value` (pass `null` to delete) and schedule a server write. */
export function setUserSetting(key: string, value: unknown): void {
	store.set(key, value);
	for (const fn of listeners) fn();
}

/**
 * Like `setUserSetting`, but PUTs IMMEDIATELY and resolves once the write is
 * acknowledged - the `setUiNow` rule (`$lib/uiState`), applied to this store for
 * the same reason: a preference the SERVER re-reads during a LATER user action
 * must be durable before that action can run, and the debounced path leaves a
 * ~300ms window in which it is not.
 *
 * The chat-cell settings are exactly that shape. `run-chat.ts` reads them off
 * `getUserSettings()` when a chat cell RUNS, so unchecking "Allow web search"
 * and running a cell inside the debounce window would still spawn the child with
 * `--tools`/`--allowedTools WebSearch` and put notebook-derived queries on the
 * wire after the user opted out - the exact outcome the toggle exists to
 * prevent. The model key is the same shape at a lesser cost (one run billed to
 * the wrong model), and rides the same write so the two cannot diverge.
 *
 * This write supersedes any value the debounced path had queued for the same
 * key. A no-op off the browser. A failed persist leaves the caller's optimistic
 * local state in place, so the pane still shows the user's choice and the next
 * write retries it.
 *
 * Subscribers are notified SYNCHRONOUSLY, as `setUserSetting` notifies them:
 * `store.setNow` updates the local cache before it ever touches the network, so
 * holding the notification until the ack would leave every long-lived reader
 * showing the old value for the length of the round trip - or for good, if the
 * PUT hangs.
 */
export function setUserSettingNow(key: string, value: unknown): Promise<void> {
	const written = store.setNow(key, value);
	for (const fn of listeners) fn();
	return written;
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
