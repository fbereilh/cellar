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
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve, relative, sep, basename } from 'node:path';

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
