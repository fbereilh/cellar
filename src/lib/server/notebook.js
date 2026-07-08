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
import { join, resolve, isAbsolute, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readNotebook, deserialize, writeNotebook } from './ipynb.js';

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

/** Move a cell to an absolute index (clamped). */
export function moveCellTo(id, index, nb) {
	const doc = docFor(nb);
	const from = doc.cells.findIndex((c) => c.id === id);
	if (from < 0) return false;
	const [cell] = doc.cells.splice(from, 1);
	const to = Math.max(0, Math.min(index, doc.cells.length));
	doc.cells.splice(to, 0, cell);
	persist(doc);
	return true;
}

export function addCell(afterId, cellType = 'code', nb) {
	const doc = docFor(nb);
	const cell = newCell(cellType);
	const idx = afterId ? doc.cells.findIndex((c) => c.id === afterId) : -1;
	if (idx >= 0) doc.cells.splice(idx + 1, 0, cell);
	else doc.cells.push(cell);
	persist(doc);
	return cell;
}

/** Switch a cell between 'code' and 'markdown'. Markdown cells carry no outputs. */
export function setCellType(id, cellType, nb) {
	const doc = docFor(nb);
	const cell = find(doc, id);
	if (!cell) return;
	cell.cell_type = cellType === 'markdown' ? 'markdown' : 'code';
	if (cell.cell_type === 'markdown') cell.outputs = [];
	persist(doc);
}

export function deleteCell(id, nb) {
	const doc = docFor(nb);
	doc.cells = doc.cells.filter((c) => c.id !== id);
	persist(doc);
}

export function setSource(id, source, nb) {
	const doc = docFor(nb);
	const cell = find(doc, id);
	if (cell) {
		cell.source = source;
		persist(doc);
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

export function clearOutputs(id, nb) {
	const doc = docFor(nb);
	const cell = find(doc, id);
	if (cell) {
		cell.outputs = [];
		persist(doc);
	}
}

export function moveCell(id, dir, nb) {
	const doc = docFor(nb);
	const i = doc.cells.findIndex((c) => c.id === id);
	if (i < 0) return;
	const j = dir === 'up' ? i - 1 : i + 1;
	if (j < 0 || j >= doc.cells.length) return;
	[doc.cells[i], doc.cells[j]] = [doc.cells[j], doc.cells[i]];
	persist(doc);
}
