/**
 * Cellar - watching open workspace files for EXTERNAL on-disk changes.
 *
 * The problem this exists for: an agent (or a terminal, or another editor)
 * rewrites a file Cellar has open in a tab, and the tab never finds out. A
 * `FileTab` reads its file exactly once, in `onMount`; there is no polling and no
 * revalidation, so its content is a snapshot taken at open time, forever. Worse,
 * a save from that stale tab writes the snapshot back over the external edit.
 *
 * Three design decisions here are each forced by a MEASUREMENT, not by taste.
 * Re-measure before changing any of them (`tests/unit/file-watch.test.ts` pins
 * all three, including a CONTROL test for the first):
 *
 * 1. **Watch the containing DIRECTORY, never the file.** `fs.watch(<file>)` binds
 *    to the inode and goes permanently silent at the first rename-replace - not
 *    just for the rename, but for every later in-place write too. And a
 *    rename-replace is exactly how an LLM edit tool writes: Claude Code's own
 *    `Edit`/`Write` were measured writing a sibling `<name>.tmp.<pid>.<hex>` and
 *    `rename()`ing it over the target (the inode changes). A per-file watch
 *    therefore appears to work in a one-edit hand test and then silently stops -
 *    the worst possible failure shape. One `fs.watch` per directory, shared by
 *    every open file in it, is the requirement rather than a robustness nicety.
 *
 * 2. **Debounce before reading.** Bursts coalesce unevenly (5 rapid writes were
 *    measured arriving as 4 events), and a NON-atomic writer - a shell redirect,
 *    a python script - is observable mid-write: reading on the first event of a
 *    streaming write returned a 0-byte document. The quiet period is what makes
 *    the delivered content a whole document rather than a truncated flash.
 *
 * 3. **Decide on a content HASH, not on the event.** On macOS every
 *    `fs.watch(dir)` event is reported as `rename`, including a plain in-place
 *    overwrite - the event name carries no information at all. Hashing is what
 *    tells a real change from a `touch`, and it doubles as echo suppression for
 *    Cellar's own saves (`noteKnownContent`), so a save never bounces back into
 *    the tab that made it.
 *
 * Deliberately NOT a recursive workspace watch: that fires for `.git`, `build/`,
 * `.venv`, `node_modules` (the very directories `fstree.ts`'s IGNORE_DIRS exists
 * to exclude) and every kernel run rewriting an `.ipynb` would ripple through it.
 * Watching only the directories that hold OPEN files bounds the event volume by
 * what the user has open, not by workspace size.
 *
 * Deliberately no `chokidar`: it solves these same problems, but it is ~15
 * transitive dependencies to replace this module, and the measured behaviours are
 * simple enough to handle directly. If this ever needs to grow into a recursive
 * workspace watch, revisit that - hand-rolling gets expensive there.
 *
 * Transport-agnostic on purpose: this module knows nothing about SSE or the event
 * bus. `src/hooks.server.js` bridges `onExternalChange` to `publishGlobal` via the
 * pure `fileChangedEvent` below, which is what lets the whole watcher be unit
 * tested against a real filesystem with no server running.
 */
import { watch, existsSync, statSync, type FSWatcher } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, basename, sep } from 'node:path';
import { resolveInWorkspace, readWorkspaceFile } from './fstree';
import { MAX_FILE_BYTES } from './limits.js';

/**
 * Quiet period before a watcher event is acted on. Long enough to collapse a
 * burst and to let a non-atomic writer finish (see decision 2 above), short
 * enough that a sync still feels immediate.
 */
export const SETTLE_MS = 120;

/**
 * Ceiling on how many files are watched at once. Registration happens on READ
 * (see `watchFileForChanges`), so nothing tells us when a tab closes - this LRU
 * is what makes that safe: the coldest file's watch is dropped on overflow and
 * the watcher set can never grow without bound. Generous relative to how many
 * files anyone has open; the cost is one `fs.watch` handle per DIRECTORY, not
 * per file, so realistically 1-3 handles.
 */
export const MAX_WATCHED_FILES = 64;

/**
 * Largest content a `file:changed` event may carry inline. Over this the event
 * names the path and hash only and the tab refetches - the SSE stream also
 * carries kernel output deltas at ~40ms and pays per byte, so it must never be
 * used to move a multi-MB export.
 */
export const MAX_INLINE_EVENT_BYTES = 256 * 1024;

/**
 * Largest file this module will WATCH at all - the sibling of `git.ts`'s
 * `MAX_DECORATION_BYTES`, and a deliberate decision rather than an oversight.
 *
 * Every settled event costs a synchronous `readFileSync` + sha256 over the WHOLE
 * file, on the one process that also carries the kernel websockets, the ~40ms SSE
 * output-delta fan-out and the in-process MCP server. `readWorkspaceFile` admits
 * `.html` up to `MAX_HTML_FILE_BYTES` (15 MB) - exactly the self-contained export
 * this feature otherwise wants to keep live - so without a ceiling an agent
 * regenerating one in a loop charges a 15 MB read+hash per settle, and again on
 * the refetch the inline-size gate forces.
 *
 * The ceiling is `MAX_FILE_BYTES` uniformly, WITHOUT the per-path `.html`
 * exception: it bounds the worst case hard while keeping live sync for every text
 * file the feature targets (`.md`/`.py`/`.json`/`.toml` are all far under it). The
 * accepted cost is that a >2 MB export no longer live-syncs and falls back to the
 * tab's window-focus revalidation - one GET when the user looks at it, rather than
 * a multi-MB read on every write.
 */
export const MAX_WATCHED_FILE_BYTES = MAX_FILE_BYTES;

/** A real, settled content change to a watched file. `content: null` = deleted. */
export interface ExternalChange {
	/** Workspace-relative path, exactly as the tab addresses it. */
	path: string;
	content: string | null;
	/** sha256 of the content; `''` for a deleted file. */
	hash: string;
}

/**
 * The wire shape published on the bus. `content` is present only when the file
 * is small enough to inline (see `MAX_INLINE_EVENT_BYTES`); otherwise the tab
 * refetches. `deleted` is explicit rather than inferred from a missing
 * `content`, since an omitted-because-large payload must not read as a deletion.
 */
export interface FileChangedEvent {
	type: 'file:changed';
	path: string;
	hash: string;
	deleted: boolean;
	content?: string;
}

interface DirWatch {
	watcher: FSWatcher;
	/** basename -> workspace-relative path, for every open file in this directory. */
	files: Map<string, string>;
}

/** One `fs.watch` per directory containing at least one watched file. */
const dirs = new Map<string, DirWatch>();
/**
 * relPath -> the sha256 we last DELIVERED or WROTE. The echo-suppression state:
 * a change whose hash matches this is either our own save coming back or a
 * no-op rewrite, and is dropped. Insertion order doubles as the LRU order.
 */
const known = new Map<string, string>();
/** relPath -> pending settle timer. */
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<(change: ExternalChange) => void>();

const DELETED_HASH = '';

function hashOf(content: string): string {
	return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Absolute path for a workspace-relative one, or null if it escapes the workspace. */
function absOf(relPath: string): string | null {
	try {
		return resolveInWorkspace(relPath);
	} catch {
		return null;
	}
}

/**
 * Is this file past `MAX_WATCHED_FILE_BYTES`? One `stat`, no read - which is the
 * point: it is what keeps a file we will not deliver from costing a full
 * read+hash. A path that cannot be stat'd (absent, unreadable) is NOT refused:
 * there is no evidence of size, and a deletion still has to be reportable.
 */
function overWatchCeiling(abs: string): boolean {
	try {
		const st = statSync(abs);
		return st.isFile() && st.size > MAX_WATCHED_FILE_BYTES;
	} catch {
		return false;
	}
}

/**
 * Start watching `relPath` for external changes, idempotently.
 *
 * Called from `GET /api/fs/file` - the read that opens a file into a tab IS the
 * registration signal, and it already holds the content, which seeds the
 * known-hash for free.
 *
 * There is deliberately NO unwatch-on-tab-close, and the LRU is not merely a
 * convenience that lets us skip it. Two reasons, in order:
 *
 *  - Cellar supports several browser windows on one workspace (the whole SSE
 *    design assumes it), and the server holds no refcount of who has a file
 *    open. An unwatch driven by one tab closing would silently stop the OTHER
 *    window's live sync - a worse bug than a spare watcher, and an invisible one.
 *  - A browser that is killed, crashes or loses its connection sends no close
 *    signal at all, so an explicit registry would leak exactly when it matters.
 *
 * The LRU bounds the set regardless of any of that, which is what makes "no
 * client lifecycle plumbing" safe rather than merely cheap. A file evicted while
 * still open falls back to the tab's window-focus revalidation.
 *
 * That multi-window guarantee is only as good as the seeding rule below: because
 * every window's focus revalidation lands here, a re-read must never overwrite
 * the known hash, or one window's read swallows the change for all the others.
 * `unwatchUnder` is the one deliberate stop, for a path the explorer has just
 * destroyed or renamed away - no window can be watching a name that is gone.
 */
export function watchFileForChanges(relPath: string, currentContent?: string): void {
	const abs = absOf(relPath);
	if (!abs) return;

	// Past the ceiling: refuse BEFORE any state is recorded, so an oversize file
	// leaves neither an LRU entry nor a directory watcher behind. `unwatchFile`
	// rather than a bare return, because this path is also reached by a re-read of
	// a file that has GROWN past the ceiling since it was registered.
	if (overWatchCeiling(abs)) {
		unwatchFile(relPath);
		return;
	}

	// Seed the known hash ONLY on first registration, from the content the caller
	// already holds (without one, read it). A wrong seed is not cosmetic: it would
	// make the file's CURRENT state look like a change and fire a spurious reload
	// the first time anything touches the directory.
	//
	// An EXISTING entry therefore wins over the caller's content, and that ordering
	// is load-bearing rather than tidiness. Registration is on READ, and the read is
	// also issued by each tab's window-focus revalidation - so a read landing inside
	// a pending settle window would otherwise re-seed the hash to the very content
	// that settle is about to deliver, `settle` would find no change, and it would
	// publish NOTHING. The reading tab is fine (it has the content in its own
	// response); every OTHER browser window on this workspace silently misses the
	// change until its own focus - which is exactly the multi-window live sync the
	// no-unwatch-on-close rule below exists to protect. Delivering the change once
	// more to the tab that read it is the harmless direction: the client
	// short-circuits when the content already matches what it holds.
	let hash: string;
	if (known.has(relPath)) hash = known.get(relPath)!;
	else if (currentContent != null) hash = hashOf(currentContent);
	else {
		try {
			hash = existsSync(abs) ? hashOf(readWorkspaceFile(relPath)) : DELETED_HASH;
		} catch {
			hash = DELETED_HASH;
		}
	}
	// Re-insert so this file is the most recently used (Map preserves insertion order).
	known.delete(relPath);
	known.set(relPath, hash);

	const dir = dirname(abs);
	let entry = dirs.get(dir);
	if (!entry) {
		let watcher: FSWatcher;
		try {
			watcher = watch(dir, { recursive: false });
		} catch {
			// No watch available for this directory (unsupported filesystem, gone,
			// permissions). Degrade to today's behaviour - no live sync - rather
			// than failing the read that triggered it. The hash seeded above is dead
			// state now (nothing will ever consult it) and the LRU only prunes what a
			// successful registration added, so drop it: on a filesystem where
			// `fs.watch` never works, every read would otherwise add a permanent
			// entry and the map would grow for the life of the process.
			known.delete(relPath);
			return;
		}
		entry = { watcher, files: new Map() };
		dirs.set(dir, entry);
		watcher.on('change', (_type, filename) => onDirEvent(dir, filename));
		// A watcher error is terminal for that directory; drop it so a later open
		// can try again from scratch.
		watcher.on('error', () => closeDir(dir));
	}
	entry.files.set(basename(abs), relPath);
	enforceLimit();
}

/** Stop watching `relPath`, closing its directory watcher when it was the last file there. */
export function unwatchFile(relPath: string): void {
	const abs = absOf(relPath);
	clearTimeout(timers.get(relPath));
	timers.delete(relPath);
	known.delete(relPath);
	if (!abs) return;
	const dir = dirname(abs);
	const entry = dirs.get(dir);
	if (!entry) return;
	entry.files.delete(basename(abs));
	if (entry.files.size === 0) closeDir(dir);
}

/**
 * Stop watching `relPath` AND everything nested under it.
 *
 * The sidebar's delete/rename/move ops are the callers, beside the `dropDocs` /
 * `shutdownKernelsUnder` they already run: that name is gone, so its entry can
 * only ever settle into a deletion nobody is listening for, and until the LRU
 * evicted it, it occupied a slot a genuinely open file could have held. Folder
 * shaped for the same reason those two are - a folder op takes every file under
 * it with it, and each of those leaves an entry of its own.
 */
export function unwatchUnder(relPath: string): void {
	unwatchFile(relPath);
	const abs = absOf(relPath);
	if (!abs) return;
	const prefix = abs + sep;
	for (const key of [...known.keys()]) {
		const keyAbs = absOf(key);
		if (keyAbs != null && keyAbs.startsWith(prefix)) unwatchFile(key);
	}
}

/** Close every watcher and forget all state (server shutdown; test teardown). */
export function unwatchAll(): void {
	for (const dir of [...dirs.keys()]) closeDir(dir);
	for (const timer of timers.values()) clearTimeout(timer);
	timers.clear();
	known.clear();
}

/**
 * Record content Cellar itself is about to write, so the resulting watcher event
 * is recognised as our own echo and dropped. Called by `PUT /api/fs/file` BEFORE
 * the write - the event can arrive as soon as the bytes land, so recording after
 * would race and bounce the save back into the tab that made it.
 */
export function noteKnownContent(relPath: string, content: string): void {
	// Only for a file already being watched. Recording a hash for anything else
	// would put an entry in the LRU that no directory watcher backs.
	if (known.has(relPath)) known.set(relPath, hashOf(content));
}

/** Subscribe to settled external changes. Returns an unsubscribe function. */
export function onExternalChange(fn: (change: ExternalChange) => void): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

/**
 * Project a change onto the bus event shape, applying the inline-size gate.
 * Pure, so the gate is unit-testable without a running server.
 */
export function fileChangedEvent(change: ExternalChange): FileChangedEvent {
	const { path, content, hash } = change;
	const inline = content !== null && Buffer.byteLength(content, 'utf8') <= MAX_INLINE_EVENT_BYTES;
	return {
		type: 'file:changed',
		path,
		hash,
		deleted: content === null,
		...(inline ? { content: content as string } : {})
	};
}

/**
 * Introspection for tests: how many directory watchers and files are live, and
 * how many paths hold a known-hash entry. `tracked` is reported separately
 * because the two can only ever agree by construction - an entry with no watcher
 * behind it is a leak the LRU cannot prune, so a test has to be able to see it.
 */
export function watchStats(): { dirs: number; files: number; tracked: number } {
	let files = 0;
	for (const entry of dirs.values()) files += entry.files.size;
	return { dirs: dirs.size, files, tracked: known.size };
}

function closeDir(dir: string): void {
	const entry = dirs.get(dir);
	if (!entry) return;
	dirs.delete(dir);
	try {
		entry.watcher.close();
	} catch {
		/* already closed */
	}
}

/**
 * A directory reported activity. The event NAME is noise (macOS calls everything
 * `rename`), and `filename` may be absent on some platforms - so when we cannot
 * tell which file moved, every watched file in that directory is re-checked. The
 * hash gate downstream makes an unnecessary check free of consequence.
 */
function onDirEvent(dir: string, filename: string | Buffer | null): void {
	const entry = dirs.get(dir);
	if (!entry) return;
	const name = filename == null ? null : filename.toString();
	if (name == null) {
		for (const relPath of entry.files.values()) schedule(relPath);
		return;
	}
	const relPath = entry.files.get(name);
	// A sibling we do not have open - notably the `<name>.tmp.<pid>.<hex>` an
	// atomic writer stages next to the target. Ignored; the rename onto the real
	// name produces its own event.
	if (relPath) schedule(relPath);
}

function schedule(relPath: string): void {
	clearTimeout(timers.get(relPath));
	timers.set(
		relPath,
		setTimeout(() => {
			timers.delete(relPath);
			settle(relPath);
		}, SETTLE_MS)
	);
}

/** The quiet period elapsed: read, hash, and deliver only a genuine change. */
function settle(relPath: string): void {
	if (!known.has(relPath)) return; // unwatched while the timer was pending
	const abs = absOf(relPath);
	if (!abs) return;
	// It grew past the ceiling after registration. Stop watching it outright
	// rather than paying a `stat` per event forever: the read+hash this guards is
	// the whole cost, and the tab's window-focus revalidation still covers it.
	if (overWatchCeiling(abs)) {
		unwatchFile(relPath);
		return;
	}

	let content: string | null;
	if (!existsSync(abs)) {
		content = null;
	} else {
		try {
			content = readWorkspaceFile(relPath);
		} catch {
			// Too large, binary, or it vanished between the check and the read.
			// Say nothing rather than deliver something we cannot vouch for.
			return;
		}
	}

	const hash = content === null ? DELETED_HASH : hashOf(content);
	if (known.get(relPath) === hash) return; // our own save, or a touch with no edit
	known.set(relPath, hash);

	const change: ExternalChange = { path: relPath, content, hash };
	for (const fn of listeners) {
		try {
			fn(change);
		} catch {
			/* a listener must never break the watcher */
		}
	}
}

/** Drop the coldest watched files until the set is back inside `MAX_WATCHED_FILES`. */
function enforceLimit(): void {
	while (known.size > MAX_WATCHED_FILES) {
		const coldest = known.keys().next().value as string | undefined;
		if (coldest === undefined) return;
		unwatchFile(coldest);
	}
}
