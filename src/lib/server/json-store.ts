/**
 * The mechanism behind Cellar's two flat JSON preference stores - the per-project
 * `ui-state.ts` (`<ws>/.cellar/ui-state.json`) and the cross-project
 * `user-settings.ts` (`~/.cellar/settings.json`).
 *
 * The two differ in exactly one thing, WHERE the file is, and therefore what
 * belongs in it; everything else - lazy load, a corrupt file reading as empty, a
 * copy on read, `null` deleting a key, the debounced write and the synchronous
 * flush on exit - is one set of rules that must hold identically for both. Kept as
 * two copies it did not merely repeat itself: a correction to the debounce, the
 * exit flush or the corrupt-file handling would silently reach only one of them,
 * and the one it missed is the one whose bug shows up as a preference that
 * vanished on shutdown.
 *
 * The path is a FUNCTION, not a string, and that is load-bearing rather than
 * stylistic: `ui-state` resolves its store under `workspaceRoot()` and
 * `user-settings` honours `CELLAR_USER_SETTINGS`, both of which are read per call
 * so a redirected env (or a rebound workspace) answers for the store that is in
 * force now instead of the one that was in force at import.
 *
 * Each store owns its own instance, so their caches, timers and dirty flags stay
 * independent - a write to one can never flush the other.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { writeFileAtomic } from '$lib/server/write-file-atomic.js';

const WRITE_DEBOUNCE_MS = 250;

/** A flat `key → value` map, as persisted. */
export type JsonStoreData = Record<string, unknown>;

/** The identity of a file's contents: inode, nanosecond mtime, size. */
interface FileStamp {
	ino: bigint;
	mtimeNs: bigint;
	size: bigint;
}

function sameStamp(a: FileStamp | null, b: FileStamp | null): boolean {
	if (a === null || b === null) return a === b;
	return a.ino === b.ino && a.mtimeNs === b.mtimeNs && a.size === b.size;
}

export interface JsonStore {
	/** The whole map (a copy, so callers can't mutate the cache). */
	get(): JsonStoreData;
	/**
	 * Shallow-merge `patch` into the store. A `null` value deletes the key.
	 * Returns the updated map. Disk write is debounced.
	 */
	set(patch: JsonStoreData | null | undefined): JsonStoreData;
	/** Flush any pending write synchronously. */
	flush(): void;
	/** Flush, then drop the in-memory copy so the next read comes from disk. Tests only. */
	reset(): void;
}

/** A store persisted at whatever `storePath()` resolves to at the moment it is used. */
export function createJsonStore(storePath: () => string): JsonStore {
	let cache: JsonStoreData | null = null;
	let writeTimer: ReturnType<typeof setTimeout> | null = null;
	let dirty = false;
	let exitHookInstalled = false;
	/** What the file looked like when this cache was loaded, or last written. */
	let loadedStamp: FileStamp | null = null;

	/**
	 * A cheap identity for the file's current contents - `null` when it is not there.
	 *
	 * `bigint` for the NANOSECOND mtime rather than the millisecond one: the whole
	 * point is telling two writes apart, and a same-size edit (`GLOBAL_` → `OTHER_`)
	 * inside one millisecond is not far-fetched.
	 *
	 * Size and INODE are folded in because mtime alone is not a discriminator on
	 * every filesystem: NFS and some container overlays keep coarse timestamps, so a
	 * same-size external write inside one tick would compare EQUAL, and since nothing
	 * else moves the stamp the cache would then be stale for good - the exact
	 * permanent staleness `load` orders its stamp to avoid, and the module's own
	 * `GLOBAL_` → `OTHER_` example is same-length. The inode closes it at zero cost:
	 * `statSync` already returns it, and every write here goes through temp+rename,
	 * which installs a NEW inode even when mtime and size do not move.
	 */
	function fileStamp(p: string): FileStamp | null {
		try {
			const st = statSync(p, { bigint: true });
			return { ino: st.ino, mtimeNs: st.mtimeNs, size: st.size };
		} catch {
			return null;
		}
	}

	/**
	 * Read the file into the cache. `keep` is the cache to fall back on when the read
	 * fails: a FIRST load has nothing to keep, so a missing or unparseable file is an
	 * empty store - but a RE-load must not wipe a good cache, since the likeliest way
	 * a parse fails on a file we already read is catching another process mid-write.
	 *
	 * The stamp is taken BEFORE the read, and that ordering is the whole guarantee.
	 * Another instance's write can land inside the read window; stamped afterwards it
	 * would mark content this cache does NOT hold as already loaded, and since nothing
	 * else moves the stamp the store would then be stale for good - exactly the
	 * failure the reload exists to prevent, and one no test would ever see. Taken
	 * first, the same race costs one redundant re-read on the next access instead.
	 */
	function load(keep: JsonStoreData | null): JsonStoreData {
		const p = storePath();
		const stamp = fileStamp(p);
		let next: JsonStoreData | null = null;
		try {
			// Dynamic boundary: our own on-disk JSON.
			const parsed: unknown = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) next = parsed as JsonStoreData;
			else next = {};
		} catch {
			next = keep;
		}
		cache = next ?? {};
		loadedStamp = stamp;
		return cache;
	}

	/**
	 * The cache, re-read from disk when the file has changed underneath it.
	 *
	 * A plain load-once cache is right for a store only ONE process writes, and wrong
	 * for one that is shared: `user-settings.ts` lives under `~/.cellar/` and Cellar
	 * runs an instance per repo, so a default set in one instance was invisible to
	 * every instance already running - permanently, since nothing ever re-read the
	 * file. The stamp (mtime + size) is compared per read, so the reload costs one
	 * `stat` on a path that is read at page load and kernel start, never in a loop.
	 *
	 * Our OWN unwritten changes always win: while a debounced write is pending the
	 * cache is newer than the file by definition, so a `dirty` store is never
	 * reloaded - otherwise a preference would revert between being set and being
	 * persisted.
	 */
	function ensureLoaded(): JsonStoreData {
		if (cache === null) return load(null);
		if (dirty) return cache;
		if (sameStamp(fileStamp(storePath()), loadedStamp)) return cache;
		return load(cache);
	}

	/**
	 * Persist the cache.
	 *
	 * ATOMICALLY, because the global store is one file under `~/.cellar/` that every
	 * running instance reads and writes: a crash / SIGKILL / ENOSPC mid-write leaves a
	 * truncated file, which the (correct) corrupt-file-reads-empty rule then turns
	 * into a SILENT loss of the user's cross-project defaults on the next boot.
	 *
	 * Through `write-file-atomic.js`'s `writeFileAtomic` rather than `atomic-write.ts`'s
	 * `atomicWriteFileSync`, and the difference is the point: temp+rename installs a
	 * NEW inode, so a writer that does not resolve a symlink first replaces a
	 * dotfile-manager's link with a regular file, and one that does not carry the
	 * target's mode across reverts a `chmod 600` store to the umask default. Both are
	 * live cases for `~/.cellar/settings.json`. The two atomic writers coexist
	 * deliberately for now: the other one serves the `.ipynb` path, i.e. the user's
	 * PRIMARY data, so unifying them is its own change (see `write-file-atomic.js`).
	 *
	 * `dirty` is cleared only once the write has RETURNED, and that ordering is the
	 * whole protection against a failed one. Cleared first, a throw (ENOSPC, EACCES, a
	 * read-only home, a directory where the file belongs) dropped both guards at once:
	 * the exit hook's flush saw a clean store and no-opped, so nothing retried, and
	 * `loadedStamp` still described the file we never replaced - so the moment any
	 * other instance wrote it the stamp moved, `ensureLoaded` reloaded, and the setting
	 * the user had just made silently REVERTED to the other instance's value. Left set,
	 * the cache stays authoritative and every later `set` reschedules a write; a
	 * persistently failing one keeps an unpersisted value, which is strictly better
	 * than a silent revert (hence no retry counter that would eventually give up).
	 */
	function flush(): void {
		if (writeTimer) {
			clearTimeout(writeTimer);
			writeTimer = null;
		}
		if (!dirty || cache === null) return;
		try {
			const p = storePath();
			const payload = JSON.stringify(cache, null, 2) + '\n';
			writeFileAtomic(p, payload);
			dirty = false;
			// Our own write is not a change to catch up on - but only while the file
			// still IS the one we wrote. A concurrent write landing between the rename
			// and this stat would otherwise be recorded as loaded, the same permanent
			// staleness `load` orders its stamp to avoid; a size that disagrees with the
			// bytes we just wrote proves that happened, and drops us to a re-read.
			const stamp = fileStamp(p);
			loadedStamp = stamp && stamp.size === BigInt(Buffer.byteLength(payload)) ? stamp : null;
		} catch {}
	}

	// The unref'd debounce timer won't fire if the process exits inside its window;
	// flush synchronously on exit so a just-changed value is never dropped.
	function installExitHook(): void {
		if (exitHookInstalled) return;
		exitHookInstalled = true;
		process.once('exit', flush);
	}

	function scheduleWrite(): void {
		dirty = true;
		installExitHook();
		if (writeTimer) return;
		writeTimer = setTimeout(flush, WRITE_DEBOUNCE_MS);
		// Don't keep the process alive just for a pending prefs write.
		if (typeof writeTimer.unref === 'function') writeTimer.unref();
	}

	return {
		get() {
			return { ...ensureLoaded() };
		},
		set(patch) {
			const store = ensureLoaded();
			if (patch && typeof patch === 'object' && !Array.isArray(patch)) {
				for (const [key, value] of Object.entries(patch)) {
					if (value === null) delete store[key];
					else store[key] = value;
				}
			}
			scheduleWrite();
			return { ...store };
		},
		flush,
		reset() {
			flush();
			// Dropping the copy discards whatever a failed flush left unwritten, so the
			// dirty flag has to go with it - kept, it would short-circuit `ensureLoaded`
			// and the next read would never reach the disk this exists to re-read from.
			cache = null;
			dirty = false;
			loadedStamp = null;
		}
	};
}
