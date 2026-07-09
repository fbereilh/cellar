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
	cpSync
} from 'node:fs';
import { join, resolve, relative, sep, basename, dirname, extname } from 'node:path';

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
const MAX_FILE_BYTES = 2 * 1024 * 1024; // don't stream giant files into a tab

export function workspaceRoot() {
	return process.env.CELLAR_WORKSPACE || process.cwd();
}

/**
 * Resolve a workspace-relative path to an absolute one, guaranteeing it stays
 * inside the workspace. Throws on traversal (`..`) or absolute escapes.
 */
export function resolveInWorkspace(relPath) {
	const root = resolve(workspaceRoot());
	const abs = resolve(root, relPath ?? '');
	if (abs !== root && !abs.startsWith(root + sep)) {
		throw new Error('path escapes workspace');
	}
	return abs;
}

/** Build a nested {name, path, type, children?} tree of the workspace. */
export function buildTree() {
	const root = resolve(workspaceRoot());
	function walk(absDir, depth) {
		let entries;
		try {
			entries = readdirSync(absDir, { withFileTypes: true });
		} catch {
			return [];
		}
		const nodes = [];
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

/** Read a workspace file's text content. Throws on escape / too-large / binary. */
export function readWorkspaceFile(relPath) {
	const abs = resolveInWorkspace(relPath);
	const st = statSync(abs);
	if (!st.isFile()) throw new Error('not a file');
	if (st.size > MAX_FILE_BYTES) throw new Error('file too large to open');
	const buf = readFileSync(abs);
	// Cheap binary sniff: a NUL byte in the first 4KB → treat as binary.
	const slice = buf.subarray(0, Math.min(buf.length, 4096));
	if (slice.includes(0)) throw new Error('binary file');
	return buf.toString('utf8');
}

/** Write text content to a workspace file (used by editor-tab save). */
export function writeWorkspaceFile(relPath, content) {
	const abs = resolveInWorkspace(relPath);
	writeFileSync(abs, content ?? '', 'utf8');
}

// ---- File-management operations (sidebar file explorer) -------------------
// Every op below resolves through resolveInWorkspace (path-guarded) so it can
// never touch anything outside the workspace, and refuses to mutate the
// workspace root itself. Paths returned are workspace-relative (forward-slash),
// matching the tree/git keys, so the caller can refresh + reveal.

/** Normalize an absolute path back to a workspace-relative, forward-slash key. */
function toRel(abs) {
	const root = resolve(workspaceRoot());
	return relative(root, abs).split(sep).join('/');
}

/** Guard: resolve a path that must stay strictly *inside* the workspace root. */
function resolveInside(relPath) {
	const root = resolve(workspaceRoot());
	const abs = resolveInWorkspace(relPath);
	if (abs === root) throw new Error('cannot operate on the workspace root');
	return abs;
}

/** Reject names that would traverse or nest (a single path segment only), or that are hidden (`.`-prefixed, which the explorer never lists). */
function assertSimpleName(name) {
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
 */
function dedupeDest(destAbs) {
	if (!existsSync(destAbs)) return destAbs;
	const dir = dirname(destAbs);
	const base = basename(destAbs);
	const ext = extname(base);
	const stem = ext ? base.slice(0, -ext.length) : base;
	for (let i = 1; ; i++) {
		const suffix = i === 1 ? ' copy' : ` copy ${i}`;
		const candidate = join(dir, `${stem}${suffix}${ext}`);
		if (!existsSync(candidate)) return candidate;
	}
}

/** Create an empty file (or an empty folder) inside a workspace directory. */
export function createEntry(parentRel, name, kind) {
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
		writeFileSync(abs, '', 'utf8');
	}
	return { path: toRel(abs) };
}

/** Rename a file/folder in place (same parent, new base name). */
export function renameEntry(relPath, newName) {
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
export function deleteEntry(relPath) {
	const abs = resolveInside(relPath);
	if (!existsSync(abs)) throw new Error('not found');
	rmSync(abs, { recursive: true, force: true });
	return { path: toRel(abs) };
}

/**
 * Move a file/folder into a destination folder (cut → paste). Auto-suffixes on
 * a name collision. Rejects moving a folder into itself or a descendant.
 */
export function moveEntry(fromRel, destDirRel) {
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
export function copyEntry(fromRel, destDirRel) {
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
