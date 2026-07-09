/**
 * Cellar — notebook documents (server-owned).
 *
 * Cellar owns the live document(s) in memory and reconstitutes them from the
 * committed `.ipynb` on load (spec §4). The workspace has a default notebook
 * (`notebook.ipynb`), but any `.ipynb` under the workspace can also be opened
 * as a live, kernel-attached document — each keyed by its absolute path in
 * `docs`. One shared kernel backs them all; each doc persists to its own file.
 *
 * `activePath` tracks which notebook the agent-facing tools (MCP) operate on by
 * default: it starts as the default notebook and follows whichever notebook the
 * UI focuses. The browser addresses cell operations by explicit notebook path,
 * so it never races the active pointer.
 *
 * Cellar owns cell-ID generation and enforces uniqueness on every load/save —
 * it does NOT rely on nbformat's lenient auto-rename (spec §3, nbdev report §2).
 * IDs are readable slugs from a monotonic counter, never reused and never
 * regenerated on edit/run/reorder. Cell ids only need to be unique within a
 * single document (two open notebooks may legitimately share an id).
 */
import { join, resolve, isAbsolute, relative, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { readNotebook, deserialize, writeNotebook } from './ipynb.js';
import { publish } from './events.js';

const FILENAME = 'notebook.ipynb';

const docs = new Map(); // absPath -> { path, cells, metadata }
let activePath = null; // absolute path of the notebook agent tools default to

function workspace() {
	return process.env.CELLAR_WORKSPACE || process.cwd();
}

function canonicalPath() {
	return join(workspace(), FILENAME);
}

/**
 * Resolve a notebook path argument to an absolute path inside the workspace.
 * `undefined`/`null` → the active notebook (or the default when none is set).
 * Relative paths resolve against the workspace root; the result must stay
 * within the workspace (mirrors the fs-route path guard).
 */
function resolveAbs(nb) {
	if (!nb) return activePath || canonicalPath();
	const abs = isAbsolute(nb) ? resolve(nb) : resolve(workspace(), nb);
	const rel = relative(workspace(), abs);
	if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
		// The workspace root itself is not a notebook; anything above it escapes.
		if (abs !== canonicalPath()) throw new Error('path escapes workspace');
	}
	return abs;
}

/**
 * Mint a fresh, unique cell id. UUIDs satisfy the nbformat id pattern
 * (`^[a-zA-Z0-9-_]+$`, ≤64 chars); Cellar still owns generation + uniqueness.
 */
function mintId() {
	return randomUUID();
}

/** Ensure every cell has a unique id; re-key missing/duplicate ones. */
function enforceUniqueIds(cells) {
	const seen = new Set();
	for (const c of cells) {
		if (!c.id || seen.has(c.id)) {
			c.id = mintId();
		}
		seen.add(c.id);
	}
}

function starterCell() {
	return {
		id: mintId(),
		cell_type: 'code',
		source: "print('hello')\n6 * 7",
		outputs: [],
		// Reserve the `cellar` metadata namespace (future extract/visibility
		// flags). The placeholder proves the allowlist preserves it on clean.
		metadata: { cellar: { extract: false, visible: true } }
	};
}

function newCell(cellType = 'code') {
	return {
		id: mintId(),
		cell_type: cellType === 'markdown' ? 'markdown' : 'code',
		source: '',
		outputs: [],
		metadata: { cellar: { extract: false, visible: true } }
	};
}

function persist(doc) {
	writeNotebook(doc.path, doc);
}

/**
 * Load (or lazily create) the document for an absolute path. The default
 * notebook is created if missing and re-persisted on load so a foreign/edited
 * file is normalized + cleaned. An arbitrary opened `.ipynb` must exist and is
 * NOT rewritten on mere open — only actual mutations persist it, so opening a
 * file never produces a surprise git diff.
 */
function loadDoc(abs) {
	let doc = docs.get(abs);
	if (doc) return doc;
	const raw = readNotebook(abs);
	if (raw) {
		const parsed = deserialize(raw);
		enforceUniqueIds(parsed.cells);
		doc = { path: abs, cells: parsed.cells, metadata: parsed.metadata };
		docs.set(abs, doc);
		if (abs === canonicalPath()) persist(doc);
	} else if (abs === canonicalPath()) {
		doc = { path: abs, cells: [starterCell()], metadata: undefined };
		docs.set(abs, doc);
		persist(doc);
	} else {
		throw new Error('notebook not found: ' + abs);
	}
	return doc;
}

/** The document a request targets: explicit `nb` path, else the active one. */
function docFor(nb) {
	const abs = resolveAbs(nb);
	const doc = loadDoc(abs);
	if (!activePath) activePath = abs; // first-ever load seeds the active pointer
	return doc;
}

const cellView = (c) => ({ id: c.id, cell_type: c.cell_type, source: c.source, outputs: c.outputs, metadata: c.metadata ?? {} });

/**
 * Broadcast a structural document change over the event bus so every open tab
 * reflects an agent-driven (or other-tab) mutation with no reload. This is the
 * single chokepoint: all mutations flow through the exported ops below, so a
 * `publish()` here reaches the browser regardless of whether the caller was the
 * UI REST routes or the in-process MCP tools.
 *
 * Events are tagged with the document's canonical absolute path (`doc.path`) —
 * the same id the browser filters on — and carry the caller's `originId` when
 * one was threaded through (a UI action); the initiating tab drops its own echo
 * so a user's own structural action never double-applies. Agent (MCP) calls
 * pass no `originId`, so every tab renders them.
 */
function emit(doc, type, extra, originId) {
	publish({ type, nb: doc.path, ...extra, originId });
}

/** Serializable view of a notebook for the browser. */
export function getNotebook(nb) {
	const doc = docFor(nb);
	return {
		workspace: workspace(),
		path: doc.path,
		cells: doc.cells.map(cellView)
	};
}

/**
 * Serializable view of the canonical default notebook (`notebook.ipynb`),
 * regardless of the current active pointer. SSR seeds the shell (notebook tab,
 * path/name) from this, so it must never follow `activePath`.
 */
export function getDefaultNotebook() {
	return getNotebook(canonicalPath());
}

/**
 * Make `nb` the active notebook the agent-facing tools default to (loading it
 * if needed) and return its view. The UI calls this when a notebook tab is
 * focused so the MCP interface follows the human's attention.
 */
export function setActiveNotebook(nb) {
	const abs = resolveAbs(nb);
	loadDoc(abs);
	activePath = abs;
	return getNotebook(abs);
}

/** Absolute path of the active notebook (defaults to the workspace notebook). */
export function getActiveNotebookPath() {
	return activePath || canonicalPath();
}

/**
 * Make `abs` the active notebook and broadcast `notebook:opened` so an
 * already-open shell surfaces/focuses it in a tab with no reload. Shared by
 * `createNotebook` and `openNotebook` so both take the exact same UI path.
 */
function activateAndBroadcast(abs, originId) {
	activePath = abs;
	publish({
		type: 'notebook:opened',
		nb: abs,
		relPath: relative(workspace(), abs),
		name: abs.split(/[/\\]/).pop(),
		originId
	});
	return getNotebook(abs);
}

/** True if `nb` resolves to a live doc or an on-disk `.ipynb` in the workspace. */
export function notebookExists(nb) {
	const abs = resolveAbs(nb);
	return docs.has(abs) || existsSync(abs);
}

/**
 * Create a new workspace notebook (or open an existing one at that path), make
 * it the active notebook, and broadcast `notebook:opened` so an already-open
 * shell surfaces it in a tab with no reload. `nb` is a workspace-relative path
 * (a `.ipynb` name); if a file already exists there it is opened rather than
 * overwritten (never clobbers a user's notebook). New notebooks seed with one
 * empty code cell so the kernel-attached view is immediately usable.
 */
export function createNotebook(nb, originId) {
	const abs = resolveAbs(nb);
	let doc = docs.get(abs);
	if (!doc) {
		if (existsSync(abs)) {
			doc = loadDoc(abs);
		} else {
			doc = { path: abs, cells: [newCell('code')], metadata: undefined };
			docs.set(abs, doc);
			persist(doc);
		}
	}
	return activateAndBroadcast(abs, originId);
}

/**
 * Open an EXISTING workspace notebook, make it active, and broadcast
 * `notebook:opened` (same UI path as `createNotebook`). `nb` is a
 * workspace-relative `.ipynb` path. Throws `notebook not found` when no live
 * doc and no on-disk file exist — opening never creates (use `createNotebook`).
 */
export function openNotebook(nb, originId) {
	const abs = resolveAbs(nb);
	if (!docs.has(abs) && !existsSync(abs)) {
		throw new Error('notebook not found: ' + relative(workspace(), abs));
	}
	loadDoc(abs);
	return activateAndBroadcast(abs, originId);
}

/**
 * A sidebar file-management op deleted a workspace path. Drop every live doc at
 * that path (or, when a folder was deleted, any doc nested under it) from the
 * `docs` Map so a later UI/MCP persist can't `writeFileSync`-resurrect a file
 * the user just removed. When the active pointer referenced a dropped doc it is
 * reset to null, so it falls back to the default notebook. A no-op when no live
 * doc matches (non-notebook files, closed notebooks).
 */
export function dropDocs(nb) {
	const abs = resolveAbs(nb);
	const prefix = abs + sep;
	for (const key of [...docs.keys()]) {
		if (key !== abs && !key.startsWith(prefix)) continue;
		docs.delete(key);
		if (activePath === key) activePath = null;
	}
}

/**
 * A sidebar file-management op renamed/moved a workspace path. Rekey every live
 * doc from its old absolute path to the new one (folder renames/moves rekey any
 * nested notebook docs too) so edits keep landing in the live doc and the old
 * path isn't recreated on the next persist. Updates the active pointer when it
 * referenced a rekeyed doc. A no-op when no live doc matches.
 */
export function rekeyDocs(fromNb, toNb) {
	const fromAbs = resolveAbs(fromNb);
	const toAbs = resolveAbs(toNb);
	if (fromAbs === toAbs) return;
	const prefix = fromAbs + sep;
	for (const key of [...docs.keys()]) {
		let newKey = null;
		if (key === fromAbs) newKey = toAbs;
		else if (key.startsWith(prefix)) newKey = toAbs + key.slice(fromAbs.length);
		if (newKey == null) continue;
		const doc = docs.get(key);
		docs.delete(key);
		doc.path = newKey;
		docs.set(newKey, doc);
		if (activePath === key) activePath = newKey;
	}
}

/**
 * Resolve a notebook path argument (workspace-relative or absolute, or nullish
 * for the active notebook) to its canonical absolute id — the same key the
 * `docs` Map uses and that `getNotebook().path` reports. Callers publishing live
 * events use this so the `nb` tag matches the id the browser filters on.
 */
export function resolveNotebookPath(nb) {
	return resolveAbs(nb);
}

function find(doc, id) {
	return doc.cells.find((c) => c.id === id);
}

// --- richer read/write surface (used by the MCP agent interface) -----------

/** Full cell views including metadata, in document order. */
export function listCells(nb) {
	const doc = docFor(nb);
	return doc.cells.map((c) => ({
		id: c.id,
		cell_type: c.cell_type,
		source: c.source,
		outputs: c.outputs ?? [],
		metadata: c.metadata ?? {}
	}));
}

/** A single full cell view (or null). */
export function getCell(id, nb) {
	const doc = docFor(nb);
	const c = find(doc, id);
	if (!c) return null;
	return { id: c.id, cell_type: c.cell_type, source: c.source, outputs: c.outputs ?? [], metadata: c.metadata ?? {} };
}

/** Set the agent-visibility flag in the allowlisted `cellar` namespace. */
export function setVisibility(id, hidden, nb) {
	const doc = docFor(nb);
	const cell = find(doc, id);
	if (!cell) return false;
	cell.metadata = cell.metadata ?? {};
	cell.metadata.cellar = cell.metadata.cellar ?? {};
	cell.metadata.cellar.hidden_from_agent = !!hidden;
	persist(doc);
	return true;
}

/**
 * Persist a cell's "scroll outputs" choice in the allowlisted `cellar`
 * namespace so it round-trips through clean-on-save. `null`/`undefined` clears
 * the explicit choice (falls back to the UI's auto height heuristic).
 */
export function setOutputScrolled(id, scrolled, nb) {
	const doc = docFor(nb);
	const cell = find(doc, id);
	if (!cell) return false;
	cell.metadata = cell.metadata ?? {};
	cell.metadata.cellar = cell.metadata.cellar ?? {};
	if (scrolled === null || scrolled === undefined) delete cell.metadata.cellar.output_scrolled;
	else cell.metadata.cellar.output_scrolled = !!scrolled;
	persist(doc);
	return true;
}

/**
 * Stamp runtime-only run metadata on a cell in the allowlisted `cellar`
 * namespace: `lastRun = { at, durationMs, actor }`. Both run entry points (the
 * UI `/run` route → `actor:'user'`, the MCP run tools → `actor:'agent'`) call
 * this so the badge in `Cell.svelte` shows who last ran the cell, when, and how
 * long it took.
 *
 * NOT persisted: `at`/`durationMs` change every run, so writing them would make
 * the `.ipynb` byte-different on each run (a git diff), violating Cellar's
 * zero-diff-on-re-run rule. It lives only in the in-memory doc and is surfaced
 * to the browser via `cellView` (load/refetch) + the `run:end` SSE event, and
 * `clean.js` strips it before any disk write (report §4.2). Resets on
 * kernel/server restart — "last run this session", which is correct.
 */
export function setLastRun(id, lastRun, nb) {
	const doc = docFor(nb);
	const cell = find(doc, id);
	if (!cell) return false;
	cell.metadata = cell.metadata ?? {};
	cell.metadata.cellar = cell.metadata.cellar ?? {};
	cell.metadata.cellar.lastRun = lastRun;
	return true;
}

/** Move a cell to an absolute index (clamped). */
export function moveCellTo(id, index, nb, originId) {
	const doc = docFor(nb);
	const from = doc.cells.findIndex((c) => c.id === id);
	if (from < 0) return false;
	const [cell] = doc.cells.splice(from, 1);
	const to = Math.max(0, Math.min(index, doc.cells.length));
	doc.cells.splice(to, 0, cell);
	persist(doc);
	emit(doc, 'cell:moved', { cellId: id, toIndex: to }, originId);
	return true;
}

export function addCell(afterId, cellType = 'code', nb, originId) {
	const doc = docFor(nb);
	const cell = newCell(cellType);
	const idx = afterId ? doc.cells.findIndex((c) => c.id === afterId) : -1;
	if (idx >= 0) doc.cells.splice(idx + 1, 0, cell);
	else doc.cells.push(cell);
	persist(doc);
	emit(doc, 'cell:added', { cell: cellView(cell), afterId: idx >= 0 ? afterId : null }, originId);
	return cell;
}

/** Switch a cell between 'code' and 'markdown'. Markdown cells carry no outputs. */
export function setCellType(id, cellType, nb, originId) {
	const doc = docFor(nb);
	const cell = find(doc, id);
	if (!cell) return;
	cell.cell_type = cellType === 'markdown' ? 'markdown' : 'code';
	if (cell.cell_type === 'markdown') cell.outputs = [];
	persist(doc);
	emit(doc, 'cell:type', { cellId: id, cell_type: cell.cell_type }, originId);
}

export function deleteCell(id, nb, originId) {
	const doc = docFor(nb);
	const existed = doc.cells.some((c) => c.id === id);
	doc.cells = doc.cells.filter((c) => c.id !== id);
	persist(doc);
	if (existed) emit(doc, 'cell:deleted', { cellId: id }, originId);
}

export function setSource(id, source, nb, originId) {
	const doc = docFor(nb);
	const cell = find(doc, id);
	if (cell && cell.source !== source) {
		cell.source = source;
		persist(doc);
		emit(doc, 'cell:edited', { cellId: id, source }, originId);
	}
}

export function setOutputs(id, outputs, nb) {
	const doc = docFor(nb);
	const cell = find(doc, id);
	if (cell) {
		cell.outputs = outputs;
		persist(doc);
	}
}

export function clearOutputs(id, nb, originId) {
	const doc = docFor(nb);
	const cell = find(doc, id);
	if (cell) {
		cell.outputs = [];
		persist(doc);
		emit(doc, 'cell:cleared', { cellId: id }, originId);
	}
}

export function moveCell(id, dir, nb, originId) {
	const doc = docFor(nb);
	const i = doc.cells.findIndex((c) => c.id === id);
	if (i < 0) return;
	const j = dir === 'up' ? i - 1 : i + 1;
	if (j < 0 || j >= doc.cells.length) return;
	[doc.cells[i], doc.cells[j]] = [doc.cells[j], doc.cells[i]];
	persist(doc);
	emit(doc, 'cell:moved', { cellId: id, toIndex: j }, originId);
}
