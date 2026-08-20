/**
 * Cross-project user settings - the GLOBAL sibling of the per-project
 * `ui-state.ts`, and the only durable store Cellar has that is not tied to one
 * workspace.
 *
 * **Why a third store rather than one of the two that existed.** `localStorage`
 * is scoped per ORIGIN and the app port is dynamic (`bin/cellar.js` binds
 * `listen(0)`), so anything kept there is gone on the next relaunch - the reason
 * `ui-state.ts` exists at all. `ui-state.ts` itself is durable but lives in the
 * workspace's own `.cellar/`, so it can only ever answer for the project it is in.
 * A preference that is about the PERSON rather than the project ("this is how I
 * name my uploads") has to outlive both, which leaves a file under `~/.cellar/` -
 * where the instance registry and the host venv already live.
 *
 * Deliberately the same flat `key → value` shape, the same debounce and the same
 * exit-flush as `ui-state.ts`: two stores are enough, and a second CONVENTION on
 * top of a second store is what makes a third one expensive to reason about. What
 * differs is only WHERE it is and, therefore, what belongs in it - so the
 * mechanism itself is literally shared (`json-store.ts`) rather than mirrored,
 * and this module is only a PATH plus the keys that belong at it.
 *
 * **Where a setting ALSO exists per project, what belongs here is a DEFAULT,
 * never the live value.** The per-project store stays authoritative for a project
 * that has an answer of its own; this supplies the answer for a project that has
 * never been asked. Keeping that direction fixed is what stops a global preference
 * silently rewriting settings the user made per project - the reader's job is to
 * seed, never to override. A setting with no per-project counterpart, because it
 * is about the PERSON rather than the project (the chat account slot, and the chat
 * model and web-search opt-in the engine reads at run time), IS the live value and
 * is read straight off this store.
 *
 * `~/.cellar/` is outside every checkout, so nothing here can show up as a git diff.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { createJsonStore, type JsonStoreData } from '$lib/server/json-store';

/** The flat setting map persisted to `~/.cellar/settings.json`. */
export type UserSettings = JsonStoreData;

/**
 * The default prefix/postfix a project inherits when it has none of its own.
 *
 * Re-exported from the browser-safe `$lib/uploadDefaults` rather than declared
 * here: the two writers of these keys are the Settings pane and the Databricks
 * panel, both browser modules that cannot import this one, and a second spelling
 * would not throw - it would read as a default the user set and Cellar ignored.
 */
export { UPLOAD_PREFIX_DEFAULT_KEY, UPLOAD_POSTFIX_DEFAULT_KEY } from '$lib/uploadDefaults';

/**
 * `~/.cellar/settings.json`, or whatever `CELLAR_USER_SETTINGS` names.
 *
 * The override is what makes this store TESTABLE at all: the default path is a real
 * file belonging to the person running the suite, so a test that exercised it
 * without one would be rewriting their own settings to assert something about them.
 * The same reason it exists is the reason it is read on every call rather than
 * captured once - a test sets it per run, and a cached path would answer for the
 * previous one. It is a plain path read, so the cost is nil.
 */
function storePath(): string {
	const override = process.env.CELLAR_USER_SETTINGS;
	return override && override.trim() ? override : join(homedir(), '.cellar', 'settings.json');
}

const store = createJsonStore(storePath);

/** The whole setting map (a copy, so callers can't mutate the cache). */
export function getUserSettings(): UserSettings {
	return store.get();
}

/**
 * Shallow-merge `patch` (a flat key→value map) into the store. A `null` value
 * deletes the key. Returns the updated map. Disk write is debounced.
 */
export function setUserSettings(patch: UserSettings | null | undefined): UserSettings {
	return store.set(patch);
}

/** Drop the in-memory copy, so the next read comes from disk. Tests only. */
export function __resetUserSettingsCache(): void {
	store.reset();
}
