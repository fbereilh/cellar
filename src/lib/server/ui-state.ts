/**
 * Per-project UI-preference store.
 *
 * The app port is dynamic (`bin/cellar.js` binds `listen(0)`), so every launch
 * is a fresh `127.0.0.1:PORT` origin and the browser's `localStorage` - scoped
 * per origin - starts empty. Any UI preference kept only in `localStorage`
 * therefore resets on every relaunch. This store is the port-independent home
 * for those preferences: a single JSON file under the workspace's `.cellar/`
 * dir, tied to the PROJECT rather than the port, delivered to the browser via
 * SSR (`+page.server.js`) so it survives relaunches with no flash.
 *
 * `.cellar/` is already gitignored in full, so this file is local per-checkout
 * state and never shows up as a git diff.
 *
 * Disk writes are debounced so a rapid burst (dragging the sidebar resizer)
 * coalesces into one write, with a synchronous flush on process exit so nothing
 * in the debounce window is lost on shutdown, and the cache re-reads the file
 * when it changes underneath it. That whole mechanism is `json-store.ts`, shared
 * with the cross-project `user-settings.ts`: the two stores differ only in WHERE
 * the file is, so a fix to the debounce or the exit flush has to reach both, and
 * what lives here is the path plus the preferences that belong at it.
 */

import { join } from 'node:path';
import { createJsonStore, type JsonStoreData } from '$lib/server/json-store';
import { workspaceRoot } from '$lib/server/fstree';
import { ADD_PROJECT_ROOT_KEY, projectRootEnabled } from '$lib/server/projectRoot';
import {
	DBX_RUNTIME_KEY,
	DBX_RUNTIME_VERSION_KEY,
	shouldInjectDatabricksRuntime,
	databricksRuntimeEnabled,
	databricksRuntimeOverride,
	databricksRuntimeVersionOverride,
	databricksRuntimeVersion as resolveDatabricksRuntimeVersion
} from '$lib/server/databricksRuntime';

/** The flat preference map persisted to `.cellar/ui-state.json`. */
export type UiState = JsonStoreData;

function storePath(): string {
	return join(workspaceRoot(), '.cellar', 'ui-state.json');
}

const store = createJsonStore(storePath);

/** The whole preference map (a copy, so callers can't mutate the cache). */
export function getUiState(): UiState {
	return store.get();
}

/**
 * Shallow-merge `patch` (a flat key→value map) into the store. A `null` value
 * deletes the key. Returns the updated map. Disk write is debounced.
 */
export function setUiState(patch: UiState | null | undefined): UiState {
	return store.set(patch);
}

/**
 * Whether a notebook's kernel should have its project root on `sys.path`
 * (default TRUE). That root is the one the kernel PROCESS was started at: the
 * notebook's declared code root when it has one, else the workspace root - the
 * default (see `notebookRoot.ts`). Read at kernel-start time by `kernel.ts`; an
 * env override (`CELLAR_ADD_PROJECT_ROOT`) wins over the stored value. See
 * `projectRoot.ts`.
 */
export function addProjectRootToPath(): boolean {
	return projectRootEnabled(store.get()[ADD_PROJECT_ROOT_KEY], process.env.CELLAR_ADD_PROJECT_ROOT);
}

/**
 * Whether to inject `DATABRICKS_RUNTIME_VERSION` at kernel start for a notebook
 * that IS (`bound`) or IS NOT bound to a Databricks cluster. Default OFF - it is an
 * explicit opt-in via the sidebar's Runtime toggle, so connecting a cluster alone
 * never enables it - and additionally SCOPED to a connected notebook so a
 * purely-local kernel is never told it is on Databricks (which would change mlflow
 * & co.); an env override (`CELLAR_DATABRICKS_RUNTIME`) forces it either way. Read
 * at kernel-start time by `kernel.ts`. See `databricksRuntime.ts`.
 */
export function injectDatabricksRuntime(bound: boolean): boolean {
	return shouldInjectDatabricksRuntime(
		store.get()[DBX_RUNTIME_KEY],
		process.env.CELLAR_DATABRICKS_RUNTIME,
		bound
	);
}

/**
 * The STORED runtime preference, with no env override folded in - what the sidebar's
 * Runtime toggle reflects, as opposed to `injectDatabricksRuntime`'s decision (which
 * also weighs the override and the connection scope).
 *
 * The panel used to read this once, from the browser's own copy of the store, at
 * mount. That was fine while the toggle was the only writer; it is not now that
 * `databricks_runtime` (MCP) writes the same preference server-side. A stale toggle
 * is not cosmetic here: clicking it applies `!runtimeOn`, so a toggle showing OFF
 * over an already-ON preference restarts the kernel, wipes the namespace, and
 * changes nothing - exactly the "a control that cannot do its work must not claim
 * it did" defect the card's other states are built to avoid. Reported from the
 * server so the panel can re-seed from the one authority, which also covers a
 * second Cellar instance or a hand-edited store.
 *
 * Resolved through `databricksRuntimeEnabled` with NO env value, so the
 * only-an-explicit-stored-true rule is reused rather than copied.
 */
export function databricksRuntimePreference(): boolean {
	return databricksRuntimeEnabled(store.get()[DBX_RUNTIME_KEY]);
}

/**
 * Whether the runtime decision is FORCED by `CELLAR_DATABRICKS_RUNTIME` (`true`/
 * `false`), or `null` when the store decides. Surfaced to the sidebar so it can say
 * the environment is in control rather than presenting a state the user can change:
 * a forced decision survives every toggle and every kernel restart, so offering an
 * "Apply now" restart there would clear the namespace and change nothing. Derived
 * from the same predicate the inject decision uses. See `databricksRuntime.ts`.
 */
export function databricksRuntimeForced(): boolean | null {
	return databricksRuntimeOverride(process.env.CELLAR_DATABRICKS_RUNTIME);
}

/**
 * The Databricks runtime version string to advertise (default a recent LTS line).
 * An env override (`CELLAR_DATABRICKS_RUNTIME_VERSION`) wins over the stored value.
 * See `databricksRuntime.ts`.
 */
export function databricksRuntimeVersion(): string {
	return resolveDatabricksRuntimeVersion(
		store.get()[DBX_RUNTIME_VERSION_KEY],
		process.env.CELLAR_DATABRICKS_RUNTIME_VERSION
	);
}

/**
 * The version `CELLAR_DATABRICKS_RUNTIME_VERSION` forces, or `null` when the store
 * decides. The independent sibling of `databricksRuntimeForced` (either override can be
 * set without the other), surfaced for the same reason: a forced version survives every
 * edit and every kernel restart, so the Runtime card must state that the environment
 * holds it instead of offering an edit-then-restart that clears the namespace and applies
 * nothing. Derived from the same resolver the version decision uses.
 */
export function databricksRuntimeVersionForced(): string | null {
	return databricksRuntimeVersionOverride(process.env.CELLAR_DATABRICKS_RUNTIME_VERSION);
}
