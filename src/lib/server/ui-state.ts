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
 * The in-memory `cache` is the source of truth once loaded; disk writes are
 * debounced so a rapid burst (dragging the sidebar resizer) coalesces into one
 * write, with a synchronous flush on process exit so nothing in the debounce
 * window is lost on shutdown.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { workspaceRoot } from '$lib/server/fstree';

const WRITE_DEBOUNCE_MS = 250;

/** The flat preference map persisted to `.cellar/ui-state.json`. */
export type UiState = Record<string, unknown>;

let cache: UiState | null = null;
let writeTimer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;
let exitHookInstalled = false;

function storePath(): string {
	return join(workspaceRoot(), '.cellar', 'ui-state.json');
}

/** Load the store from disk once; a missing / unparseable file is an empty store. */
function ensureLoaded(): UiState {
	if (cache !== null) return cache;
	try {
		const p = storePath();
		// Dynamic boundary: our own on-disk JSON.
		const parsed: unknown = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
		cache = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as UiState) : {};
	} catch {
		cache = {};
	}
	return cache;
}

/** The whole preference map (a copy, so callers can't mutate the cache). */
export function getUiState(): UiState {
	return { ...ensureLoaded() };
}

/**
 * Shallow-merge `patch` (a flat key→value map) into the store. A `null` value
 * deletes the key. Returns the updated map. Disk write is debounced.
 */
export function setUiState(patch: UiState | null | undefined): UiState {
	const store = ensureLoaded();
	if (patch && typeof patch === 'object' && !Array.isArray(patch)) {
		for (const [key, value] of Object.entries(patch)) {
			if (value === null) delete store[key];
			else store[key] = value;
		}
	}
	scheduleWrite();
	return { ...store };
}

function scheduleWrite(): void {
	dirty = true;
	installExitHook();
	if (writeTimer) return;
	writeTimer = setTimeout(flush, WRITE_DEBOUNCE_MS);
	// Don't keep the process alive just for a pending prefs write.
	if (typeof writeTimer.unref === 'function') writeTimer.unref();
}

function flush(): void {
	if (writeTimer) {
		clearTimeout(writeTimer);
		writeTimer = null;
	}
	if (!dirty || cache === null) return;
	dirty = false;
	try {
		const p = storePath();
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, JSON.stringify(cache, null, 2) + '\n');
	} catch {}
}

// The unref'd debounce timer won't fire if the process exits inside its window;
// flush synchronously on exit so a just-changed preference is never dropped.
function installExitHook(): void {
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	process.once('exit', flush);
}
