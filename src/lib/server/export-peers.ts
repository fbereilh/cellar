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
 * and the parse is cached on the file's size and mtime, without the cells'
 * outputs: an export reads only source and metadata. An entry is dropped once
 * the walk no longer lists its file. A file whose text names no module
 * (`NAMES_A_MODULE`) can neither own nor feed one, so it is not parsed at all,
 * only checked to be whole (`looksWhole`). A file that cannot be read or parsed,
 * or is not whole, gives no document. It is reported as unread
 * (`ExportPeers.unread`), so an export refuses to rebuild a module it feeds.
 *
 * The scan is asynchronous (`refreshExportPeers`), so it never blocks the process
 * that carries the kernel sockets. `exportPeers` answers from the last finished
 * scan. An export action awaits a fresh scan first; a persist or a load does not.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { IGNORE_DIRS, MAX_DEPTH, workspaceRoot } from './fstree';
import { deserialize, isIpynbPath } from './ipynb';
import type { NotebookDoc } from './types';

/** The parse of one notebook file, kept while its size and mtime hold. */
const parsed = new Map<string, { size: number; mtimeMs: number; doc: NotebookDoc | null; unread?: Unread }>();

/** The notebook paths the last finished scan listed, sorted. Null before the first one. */
let walked: string[] | null = null;

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
	/**
	 * The other notebooks the scan reached but could not read or parse. What they
	 * feed is not known, so a module one of them sends cells to is never rebuilt
	 * without it.
	 */
	unread: UnreadNotebook[];
}

/** Why a notebook file gave no document, and the modules its raw text names. */
interface Unread {
	reason: string;
	/** The module of each valued `#| export <module>` line found in the raw text. */
	modules: string[];
}

export interface UnreadNotebook extends Unread {
	path: string;
}

/**
 * The notebooks one export of `self` reads, and whether `self` is among the
 * notebooks every other export reads. Answered from the last finished scan
 * (`refreshExportPeers`) and never from the disk, so it is safe on a persist or
 * a load. Null while no scan has finished: nothing is known yet.
 */
export function exportPeers(self: string, live: (abs: string) => NotebookDoc | undefined): ExportPeers | null {
	if (!walked) return null;
	const peers: NotebookDoc[] = [];
	const unread: UnreadNotebook[] = [];
	let reached = false;
	for (const abs of walked) {
		if (abs === self) {
			reached = true;
			continue;
		}
		const hit = parsed.get(abs);
		const doc = live(abs) ?? hit?.doc;
		if (doc) peers.push(doc);
		else if (hit?.unread) unread.push({ path: abs, ...hit.unread });
	}
	return { peers, excluded: reached ? null : skipReason(self), unread };
}

let running: Promise<boolean> | null = null;
let queued: Promise<boolean> | null = null;

/**
 * Scan the workspace again, without blocking: the folders are listed afresh, so
 * a notebook created a moment ago is seen as an owner. Resolves to whether what
 * `exportPeers` answers may have changed. A call made while a scan runs waits
 * for one that starts after it, so the caller never gets a scan older than its
 * own request.
 */
export function refreshExportPeers(): Promise<boolean> {
	if (!running) {
		running = scan().finally(() => {
			running = null;
		});
		return running;
	}
	const next = () => {
		queued = null;
		return refreshExportPeers();
	};
	queued ??= running.then(next, next);
	return queued;
}

async function scan(): Promise<boolean> {
	const paths = await notebookPaths();
	let changed = walked === null || walked.length !== paths.length || paths.some((p, i) => p !== walked![i]);
	const listed = new Set(paths);
	for (const abs of parsed.keys()) {
		if (listed.has(abs)) continue;
		if (parsed.get(abs)?.doc) changed = true;
		parsed.delete(abs);
	}
	for (const abs of paths) if (await readPeer(abs)) changed = true;
	walked = paths;
	return changed;
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

async function notebookPaths(): Promise<string[]> {
	const root = resolve(workspaceRoot());
	const paths: string[] = [];
	const walk = async (dir: string, depth: number): Promise<void> => {
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (e.name.startsWith('.') || e.name.startsWith('_')) continue;
			const abs = join(dir, e.name);
			if (e.isDirectory()) {
				if (!IGNORE_DIRS.has(e.name) && depth < MAX_DEPTH) await walk(abs, depth + 1);
			} else if (e.isFile() && isIpynbPath(e.name)) paths.push(abs);
		}
	};
	await walk(root, 0);
	return paths.sort();
}

/**
 * Can a notebook with this raw text own or feed a module? It must hold a valued
 * `#| export <module>` line, a `#|default_exp` line or an `export_target` key.
 * Tested on the file's JSON text before any parse, so a notebook that only says
 * `export` in its code or outputs is never parsed. It errs toward parsing.
 */
const NAMES_A_MODULE = /#(?: |\\t)*\|(?: |\\t)*export(?: |\\t|:)+[^ :"\\]|default_exp|"export_target"/;

/** Each valued `#| export <module>` line in a file's raw JSON text, capturing the module. */
const VALUED_EXPORT = /#(?: |\\t)*\|(?: |\\t)*export(?: |\\t|:)+([^ :"\\]+)/g;

/** Refresh one file's cached parse. True when its document appeared, went or changed. */
async function readPeer(abs: string): Promise<boolean> {
	let st;
	try {
		st = await stat(abs);
	} catch {
		const had = !!parsed.get(abs)?.doc;
		parsed.delete(abs);
		return had;
	}
	const hit = parsed.get(abs);
	if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return false;
	let doc: NotebookDoc | null = null;
	let unread: Unread | undefined;
	let text: string | null = null;
	try {
		text = await readFile(abs, 'utf8');
	} catch {
		unread = { reason: 'could not be read', modules: [] };
	}
	if (text !== null && NAMES_A_MODULE.test(text)) {
		try {
			const nb = deserialize(JSON.parse(text));
			doc = { path: abs, cells: nb.cells.map(({ outputs: _outputs, ...cell }) => cell), metadata: nb.metadata };
		} catch {
			unread = {
				reason: 'could not be parsed as a notebook',
				modules: [...text.matchAll(VALUED_EXPORT)].map((m) => m[1])
			};
		}
	} else if (text !== null && !looksWhole(text)) {
		unread = { reason: 'could not be parsed as a notebook', modules: [] };
	}
	parsed.set(abs, { size: st.size, mtimeMs: st.mtimeMs, doc, ...(unread ? { unread } : {}) });
	return doc !== null || !!hit?.doc || !!unread || !!hit?.unread;
}

/**
 * Could this text, which names no module, be a whole notebook? It is not parsed,
 * so this is a structural check only: a JSON object with no git conflict marker.
 * An empty, truncated or conflicted file fails it and is reported unread, so a
 * module whose header lists it is never rebuilt without its cells.
 */
function looksWhole(text: string): boolean {
	const t = text.trim();
	return t.startsWith('{') && t.endsWith('}') && !/^(?:<{7}|={7}|>{7})(?: |$)/m.test(t);
}
