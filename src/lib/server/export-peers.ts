/**
 * Cellar - the other notebooks one export reads.
 *
 * nbdev's `#| export <module>` lets a cell in one notebook go into a module
 * another notebook owns (`export-py.ts`'s `composeModule`). So building a module
 * means knowing every notebook in the workspace that owns or feeds it. This module
 * finds them: every `.ipynb` under the workspace root, as a document. A notebook
 * the walk skips takes no part, and that holds for the exporting notebook too.
 *
 * The walk follows nbdev's own `nbglob` skip rule: a folder or file whose name
 * starts with `.` or `_` is skipped. It also skips the file tree's noise folders
 * (`node_modules`, virtualenvs, build output), and it stops at the file tree's
 * depth bound.
 *
 * A notebook that is open is read from its live document. Persist is
 * synchronous, so that is what is on disk. Any other notebook is read from disk,
 * and the parse is cached on the file's size and mtime. A file whose text says
 * neither `export` nor `default_exp` can neither own nor feed a module, so it is
 * not parsed at all. A file that cannot be read or parsed takes no part: nothing
 * about it is known.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { IGNORE_DIRS, MAX_DEPTH, workspaceRoot } from './fstree';
import { deserialize, isIpynbPath } from './ipynb';
import type { NotebookDoc } from './types';

/** The parse of one notebook file, kept while its size and mtime hold. */
const parsed = new Map<string, { size: number; mtimeMs: number; doc: NotebookDoc | null }>();

/** What one export reads of the workspace around its notebook. */
export interface ExportPeers {
	/** Every OTHER notebook the walk reaches, as a document. */
	peers: NotebookDoc[];
	/**
	 * Why the walk does not reach the notebook itself, or null when it does. No
	 * other notebook's export sees such a notebook, so it may neither feed another
	 * module nor take fed cells: a module's bytes would otherwise depend on which
	 * notebook exported.
	 */
	excluded: string | null;
}

/**
 * The notebooks one export of `self` reads, and whether `self` is among the
 * notebooks every other export reads.
 *
 * The folders are listed afresh on every call, so a notebook created a moment
 * ago is seen as an owner at once. Only a notebook carrying a `#| export
 * <module>` cell, or an export, pays for the walk.
 */
export function exportPeers(self: string, live: (abs: string) => NotebookDoc | undefined): ExportPeers {
	const peers: NotebookDoc[] = [];
	let reached = false;
	for (const abs of notebookPaths()) {
		if (abs === self) {
			reached = true;
			continue;
		}
		const doc = live(abs) ?? readPeer(abs);
		if (doc) peers.push(doc);
	}
	return { peers, excluded: reached ? null : skipReason(self) };
}

/** Why the walk left this notebook out, worded from its path. */
function skipReason(abs: string): string {
	const parts = relative(resolve(workspaceRoot()), abs).split(sep);
	const named = parts.find((n) => n !== '..' && (n.startsWith('.') || n.startsWith('_')));
	if (named) return `"${named}" starts with "${named[0]}", and nbdev skips a notebook or folder named that way`;
	const ignored = parts.slice(0, -1).find((n) => IGNORE_DIRS.has(n));
	if (ignored) return `it sits in "${ignored}", a folder Cellar does not scan for notebooks`;
	if (parts.length - 1 > MAX_DEPTH) return `it sits more than ${MAX_DEPTH} folders below the workspace root`;
	return 'the scan of the workspace for notebooks did not reach it';
}

function notebookPaths(): string[] {
	const root = resolve(workspaceRoot());
	const paths: string[] = [];
	const walk = (dir: string, depth: number) => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (e.name.startsWith('.') || e.name.startsWith('_')) continue;
			const abs = join(dir, e.name);
			if (e.isDirectory()) {
				if (!IGNORE_DIRS.has(e.name) && depth < MAX_DEPTH) walk(abs, depth + 1);
			} else if (e.isFile() && isIpynbPath(e.name)) paths.push(abs);
		}
	};
	walk(root, 0);
	return paths;
}

function readPeer(abs: string): NotebookDoc | null {
	let st;
	try {
		st = statSync(abs);
	} catch {
		parsed.delete(abs);
		return null;
	}
	const hit = parsed.get(abs);
	if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.doc;
	let doc: NotebookDoc | null = null;
	try {
		const text = readFileSync(abs, 'utf8');
		// `export_target` and every `#| export` line contain `export`; `default_exp` does not.
		if (text.includes('export') || text.includes('default_exp')) {
			const nb = deserialize(JSON.parse(text));
			doc = { path: abs, cells: nb.cells, metadata: nb.metadata };
		}
	} catch {
		doc = null;
	}
	parsed.set(abs, { size: st.size, mtimeMs: st.mtimeMs, doc });
	return doc;
}
