/**
 * Cellar — workspace filesystem helpers (shell sidebar file tree).
 *
 * Read-only-ish view of the workspace folder for the left-sidebar file tree,
 * plus safe read/write of individual files opened into editor tabs. Every path
 * is resolved against the workspace root and rejected if it escapes it — the
 * browser never gets to read/write arbitrary paths on disk.
 *
 * Independent of the canonical notebook document (notebook.js); this module
 * only touches the filesystem for the shell's file tree + file tabs.
 */
import {
	readdirSync,
	readFileSync,
	writeFileSync,
	statSync,
	existsSync,
	mkdirSync,
	renameSync,
	rmSync,
	cpSync,
	appendFileSync,
	openSync,
	fsyncSync,
	closeSync,
	linkSync,
	lstatSync,
	copyFileSync,
	constants
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join, resolve, relative, sep, basename, dirname } from 'node:path';
import { isHtmlPath } from '$lib/htmlPreview';
import { copyName, freeName } from '$lib/filePaste';
import { MAX_FILE_BYTES, MAX_HTML_FILE_BYTES, MAX_UPLOAD_BYTES } from '$lib/server/limits.js';

// Directories that are noise for a workspace file tree.
const IGNORE_DIRS = new Set([
	'node_modules',
	'.git',
	'.venv',
	'.svelte-kit',
	'build',
	'.DS_Store',
	'__pycache__',
	'.ipynb_checkpoints'
]);

const MAX_DEPTH = 8; // guard against pathological deep trees

/**
 * Byte ceiling for opening `relPath` into a tab. HTML gets the higher one (see
 * `limits.js` for why, and for the save-side limit derived from it).
 *
 * Identity comes from the same `isHtmlPath` the rest of the feature resolves
 * (preview kind, syntax highlighting, the file icon), so there is one answer to
 * "is this an HTML file" and never an ad-hoc extension test here.
 */
function maxFileBytesFor(relPath: string): number {
	return isHtmlPath(relPath) ? MAX_HTML_FILE_BYTES : MAX_FILE_BYTES;
}

/**
 * One node in the workspace file tree (`buildTree`'s recursive shape). The
 * on-the-wire property is `type` (kept verbatim — the browser's file-tree
 * consumer reads `node.type`), typed here as a 'file' | 'dir' union.
 */
export interface TreeNode {
	name: string;
	path: string;
	type: 'file' | 'dir';
	/** Present (possibly empty) only on directory nodes. */
	children?: TreeNode[];
}

/** Result of `buildTree()`. */
export interface WorkspaceTree {
	root: string;
	name: string;
	tree: TreeNode[];
}

export function workspaceRoot(): string {
	return process.env.CELLAR_WORKSPACE || process.cwd();
}

/**
 * Resolve a workspace-relative path to an absolute one, guaranteeing it stays
 * inside the workspace. Throws on traversal (`..`) or absolute escapes.
 */
export function resolveInWorkspace(relPath: string): string {
	const root = resolve(workspaceRoot());
	const abs = resolve(root, relPath ?? '');
	if (abs !== root && !abs.startsWith(root + sep)) {
		throw new Error('path escapes workspace');
	}
	return abs;
}

/** Build a nested {name, path, type, children?} tree of the workspace. */
export function buildTree(): WorkspaceTree {
	const root = resolve(workspaceRoot());
	function walk(absDir: string, depth: number): TreeNode[] {
		let entries;
		try {
			entries = readdirSync(absDir, { withFileTypes: true });
		} catch {
			return [];
		}
		const nodes: TreeNode[] = [];
		for (const e of entries) {
			if (e.name.startsWith('.') && e.name !== '.gitignore') continue;
			if (e.isDirectory() && IGNORE_DIRS.has(e.name)) continue;
			const abs = join(absDir, e.name);
			const rel = relative(root, abs).split(sep).join('/');
			if (e.isDirectory()) {
				nodes.push({
					name: e.name,
					path: rel,
					type: 'dir',
					children: depth < MAX_DEPTH ? walk(abs, depth + 1) : []
				});
			} else if (e.isFile()) {
				nodes.push({ name: e.name, path: rel, type: 'file' });
			}
		}
		// Directories first, then files; each alphabetically.
		nodes.sort((a, b) => {
			if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
			return a.name.localeCompare(b.name);
		});
		return nodes;
	}
	return { root, name: basename(root) || root, tree: walk(root, 0) };
}

/** A file's identity for change detection: what a `stat` can tell us, and nothing more. */
export interface FileStat {
	size: number;
	mtimeMs: number;
}

/**
 * `stat` a workspace file - no read, no size ceiling.
 *
 * This is the cheap half of the tab's window-focus revalidation: one `stat`
 * instead of a whole-file read + serialize + transfer for a file that has not
 * moved. It is a SHORT-CIRCUIT, so it may only ever cause an EXTRA read, never a
 * missed change - which is why it throws rather than guessing on anything it
 * cannot answer (absent, not a file, escaping the workspace); the caller falls
 * back to the full read.
 */
export function statWorkspaceFile(relPath: string): FileStat {
	const abs = resolveInWorkspace(relPath);
	const st = statSync(abs);
	if (!st.isFile()) throw new Error('not a file');
	return { size: st.size, mtimeMs: st.mtimeMs };
}

/** Read a workspace file's text content. Throws on escape / too-large / binary. */
export function readWorkspaceFile(relPath: string): string {
	const abs = resolveInWorkspace(relPath);
	const st = statSync(abs);
	if (!st.isFile()) throw new Error('not a file');
	if (st.size > maxFileBytesFor(relPath)) throw new Error('file too large to open');
	const buf = readFileSync(abs);
	// Cheap binary sniff: a NUL byte in the first 4KB → treat as binary.
	const slice = buf.subarray(0, Math.min(buf.length, 4096));
	if (slice.includes(0)) throw new Error('binary file');
	return buf.toString('utf8');
}

/**
 * Write text content to a workspace file (used by editor-tab save).
 *
 * Refused above the SAME per-path ceiling `readWorkspaceFile` enforces: a save
 * that lands bytes the reader will not reopen strands the file the moment its
 * tab closes ("file too large to open" from then on). This is the ceiling on the
 * FILE, so its message names that ceiling - distinct from the front-end's 413,
 * which is adapter-node refusing the request body before any handler runs (a
 * document that big opens read-only in the first place; see `$lib/saveLimit.ts`).
 * Nothing is written on refusal: the original file is left exactly as it was.
 */
export function writeWorkspaceFile(relPath: string, content: string | null | undefined): void {
	const abs = resolveInWorkspace(relPath);
	const text = content ?? '';
	const max = maxFileBytesFor(relPath);
	if (Buffer.byteLength(text, 'utf8') > max) {
		throw new Error(`file too large to save (over the ${Math.round(max / (1024 * 1024))} MB limit)`);
	}
	writeFileSync(abs, text, 'utf8');
}

// ---- File-management operations (sidebar file explorer) -------------------
// Every op below resolves through resolveInWorkspace (path-guarded) so it can
// never touch anything outside the workspace, and refuses to mutate the
// workspace root itself. Paths returned are workspace-relative (forward-slash),
// matching the tree/git keys, so the caller can refresh + reveal.

/** A single-path result from a file op that has no distinct "from". */
export interface FsOpPathResult {
	path: string;
}

/** A result from a file op that moved/renamed/copied something. */
export interface FsOpFromResult {
	from: string;
	path: string;
}

/** Normalize an absolute path back to a workspace-relative, forward-slash key. */
function toRel(abs: string): string {
	const root = resolve(workspaceRoot());
	return relative(root, abs).split(sep).join('/');
}

/** Guard: resolve a path that must stay strictly *inside* the workspace root. */
function resolveInside(relPath: string): string {
	const root = resolve(workspaceRoot());
	const abs = resolveInWorkspace(relPath);
	if (abs === root) throw new Error('cannot operate on the workspace root');
	return abs;
}

/** Reject names that would traverse or nest (a single path segment only), or that are hidden (`.`-prefixed, which the explorer never lists). */
function assertSimpleName(name: string | null | undefined): string {
	const n = (name ?? '').trim();
	if (!n) throw new Error('name required');
	if (n === '.' || n === '..' || n.includes('/') || n.includes('\\') || n.includes('\0')) {
		throw new Error('invalid name');
	}
	if (n.startsWith('.')) throw new Error('hidden files are not shown in the explorer');
	return n;
}

/**
 * Given a desired absolute destination, return a non-colliding variant by
 * appending " copy", " copy 2", … before the extension (VS Code-style). Used on
 * paste so a move/copy into an occupied name never clobbers the existing entry.
 * The naming rule itself is `$lib/filePaste`'s `freeName`, shared with the tests.
 */
function dedupeDest(destAbs: string): string {
	const dir = dirname(destAbs);
	return join(dir, freeName(basename(destAbs), (name) => existsSync(join(dir, name))));
}

/**
 * Create a file (or an empty folder) inside a workspace directory. A file starts
 * empty unless the caller says otherwise - see `initialContents`.
 */
export function createEntry(
	parentRel: string,
	name: string,
	kind: 'file' | 'dir',
	/**
	 * The bytes a brand-new FILE starts as, chosen from the name that will really
	 * land on disk. A plain file starts empty (the default); a `.ipynb` must start
	 * as a VALID notebook, which is why this is a FUNCTION OF THE NORMALISED NAME
	 * rather than a plain string: `assertSimpleName` trims, so a caller deciding
	 * from its own raw input would answer about `"notes.ipynb "` while the file
	 * created is `notes.ipynb`, and mint exactly the blank notebook this exists to
	 * prevent. `fstree` itself stays notebook-agnostic - the path/name guards and
	 * the collision check stay the one copy here, and WHAT a kind of file starts as
	 * is the caller's (see `POST /api/fs/op`, where a file op's notebook
	 * consequences already live).
	 */
	initialContents: (cleanName: string) => string = () => ''
): FsOpPathResult {
	const cleanName = assertSimpleName(name);
	// Resolve the parent (may be '' for the workspace root) and the target.
	const parentAbs = resolveInWorkspace(parentRel);
	const st = statSync(parentAbs);
	if (!st.isDirectory()) throw new Error('parent is not a folder');
	const abs = resolveInWorkspace(join(parentRel ?? '', cleanName));
	if (existsSync(abs)) throw new Error('already exists');
	if (kind === 'dir') {
		mkdirSync(abs);
	} else {
		writeFileSync(abs, initialContents(cleanName), 'utf8');
	}
	return { path: toRel(abs) };
}

/** Rename a file/folder in place (same parent, new base name). */
export function renameEntry(relPath: string, newName: string): FsOpPathResult | FsOpFromResult {
	const cleanName = assertSimpleName(newName);
	const abs = resolveInside(relPath);
	if (!existsSync(abs)) throw new Error('not found');
	const destAbs = resolveInWorkspace(join(dirname(relPath), cleanName));
	if (destAbs === abs) return { path: toRel(abs) }; // no-op rename
	if (existsSync(destAbs)) throw new Error('already exists');
	renameSync(abs, destAbs);
	return { from: toRel(abs), path: toRel(destAbs) };
}

/** Delete a file, or a folder recursively. */
export function deleteEntry(relPath: string): FsOpPathResult {
	const abs = resolveInside(relPath);
	if (!existsSync(abs)) throw new Error('not found');
	rmSync(abs, { recursive: true, force: true });
	return { path: toRel(abs) };
}

/**
 * Move a file/folder into a destination folder (cut → paste). Auto-suffixes on
 * a name collision. Rejects moving a folder into itself or a descendant.
 */
export function moveEntry(fromRel: string, destDirRel: string): FsOpFromResult {
	const fromAbs = resolveInside(fromRel);
	if (!existsSync(fromAbs)) throw new Error('not found');
	const destDirAbs = resolveInWorkspace(destDirRel);
	if (!statSync(destDirAbs).isDirectory()) throw new Error('destination is not a folder');
	if (destDirAbs === fromAbs || destDirAbs.startsWith(fromAbs + sep)) {
		throw new Error('cannot move a folder into itself');
	}
	if (dirname(fromAbs) === destDirAbs) return { from: toRel(fromAbs), path: toRel(fromAbs) };
	const destAbs = dedupeDest(join(destDirAbs, basename(fromAbs)));
	renameSync(fromAbs, destAbs);
	return { from: toRel(fromAbs), path: toRel(destAbs) };
}

/**
 * Copy a file, or a folder recursively, into a destination folder (copy →
 * paste). Auto-suffixes on a name collision. Rejects copying a folder into
 * itself or a descendant.
 */
export function copyEntry(fromRel: string, destDirRel: string): FsOpFromResult {
	const fromAbs = resolveInside(fromRel);
	if (!existsSync(fromAbs)) throw new Error('not found');
	const destDirAbs = resolveInWorkspace(destDirRel);
	if (!statSync(destDirAbs).isDirectory()) throw new Error('destination is not a folder');
	if (destDirAbs === fromAbs || destDirAbs.startsWith(fromAbs + sep)) {
		throw new Error('cannot copy a folder into itself');
	}
	const destAbs = dedupeDest(join(destDirAbs, basename(fromAbs)));
	cpSync(fromAbs, destAbs, { recursive: true });
	return { from: toRel(fromAbs), path: toRel(destAbs) };
}

// ---- Paste from the system clipboard (chunked upload) ---------------------
// A file pasted into the explorer from Finder or another app arrives in the
// browser as bytes, and adapter-node caps every request body (see
// `$lib/saveLimit.ts`). So the browser sends it in chunks: each one appends to
// a part file, and the last one places it in the destination folder under a
// free name. The part file is staged in the OS temp dir, never in the project
// folder, so an interrupted paste leaves nothing for `git status` to find.

const UPLOAD_ID = /^[a-z0-9]{8,64}$/;

/** How many names (`x`, `x copy`, `x copy 2`, ...) a paste tries before it gives up. */
const MAX_UPLOAD_NAME_TRIES = 1000;

/** This workspace's own staging folder for part files, under the OS temp dir. */
export function uploadStagingDir(): string {
	const key = createHash('sha256').update(resolve(workspaceRoot())).digest('hex').slice(0, 16);
	return join(tmpdir(), 'cellar-uploads', key);
}

/**
 * Drop every part file staged for this workspace. Runs at server start: one
 * server owns a workspace, so any part file found then belongs to a paste that
 * a reload, a closed tab or a restart cut short.
 */
export function sweepStagedUploads(): void {
	rmSync(uploadStagingDir(), { recursive: true, force: true });
}

function uploadPartPath(id: string): string {
	if (!UPLOAD_ID.test(id ?? '')) throw new Error('invalid upload id');
	return join(uploadStagingDir(), `${id}.part`);
}

function uploadDir(dirRel: string): string {
	const dirAbs = resolveInWorkspace(dirRel);
	if (toRel(dirAbs).split('/').some((segment) => segment.startsWith('.'))) {
		throw new Error('hidden folders are not shown in the explorer');
	}
	if (!existsSync(dirAbs) || !statSync(dirAbs).isDirectory()) throw new Error('destination is not a folder');
	return dirAbs;
}

/** Whether a name is taken. A broken symlink counts, which `existsSync` misses. */
function entryExists(abs: string): boolean {
	return lstatSync(abs, { throwIfNoEntry: false }) !== undefined;
}

/**
 * Put the staged file at `dest` without ever replacing an entry there. A hard
 * link is one step on one filesystem. Where the staging folder is on another
 * filesystem, or hard links are unsupported, an exclusive copy does the same.
 * Both throw EEXIST when `dest` is taken.
 */
function placeUpload(part: string, dest: string): void {
	try {
		linkSync(part, dest);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code;
		if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'ENOSYS') throw err;
		copyFileSync(part, dest, constants.COPYFILE_EXCL);
	}
}

/**
 * Append one chunk of a pasted file. `offset` must equal the bytes already
 * received, so a lost or repeated chunk is refused rather than corrupting the
 * file. On the `last` chunk the file is flushed to disk and placed in the
 * folder under `name`, or the next free ` copy` name. Placing never replaces an
 * existing entry, so a file created in the meantime cannot be clobbered.
 */
export function writeUploadChunk(opts: {
	dir: string;
	name: string;
	id: string;
	offset: number;
	bytes: Uint8Array;
	last: boolean;
}): FsOpPathResult | { received: number } {
	const cleanName = assertSimpleName(opts.name);
	const dirAbs = uploadDir(opts.dir);
	const part = uploadPartPath(opts.id);
	const offset = Number(opts.offset);
	if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('invalid upload offset');
	if (offset + opts.bytes.length > MAX_UPLOAD_BYTES) {
		rmSync(part, { force: true });
		throw new Error(`file too large to paste (over the ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB limit)`);
	}
	if (offset === 0) {
		mkdirSync(dirname(part), { recursive: true, mode: 0o700 });
		writeFileSync(part, opts.bytes, { flag: 'wx', mode: 0o600 });
	} else {
		const have = existsSync(part) ? statSync(part).size : -1;
		if (have !== offset) throw new Error('upload chunk out of order');
		appendFileSync(part, opts.bytes);
	}
	const received = offset + opts.bytes.length;
	if (!opts.last) return { received };
	const fd = openSync(part, 'r+');
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	for (let n = 0; n < MAX_UPLOAD_NAME_TRIES; n++) {
		const dest = join(dirAbs, n === 0 ? cleanName : copyName(cleanName, n));
		if (entryExists(dest)) continue;
		try {
			placeUpload(part, dest);
		} catch (err) {
			if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') continue;
			throw err;
		}
		rmSync(part, { force: true });
		return { path: toRel(dest) };
	}
	throw new Error(`no free name for ${cleanName} in this folder (tried ${MAX_UPLOAD_NAME_TRIES})`);
}

/** Drop the part file of an upload the browser gave up on. */
export function abortUpload(id: string): void {
	rmSync(uploadPartPath(id), { force: true });
}
