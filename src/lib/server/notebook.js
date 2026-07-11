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
import { isPyPath, readPyNotebook, writePyNotebook } from './jupytext.js';
import { publish } from './events.js';
import { cancelRun } from './run-queue.js';
import { IMPORTS_ROLE, isImportsCell, clampMoveIndex } from '../importsRole.js';
import { SQL_LANGUAGE } from '../cellLanguage.js';

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

function newCell(cellType = 'code', source = '') {
	// 'sql' is a LOGICAL type: an nbformat `code` cell tagged cellar.language='sql'
	// (see $lib/cellLanguage.js). markdown/code map to their nbformat cell_type.
	const isSql = cellType === 'sql';
	return {
		id: mintId(),
		cell_type: cellType === 'markdown' ? 'markdown' : 'code',
		source: typeof source === 'string' ? source : '',
		outputs: [],
		metadata: { cellar: { extract: false, visible: true, ...(isSql ? { language: SQL_LANGUAGE } : {}) } }
	};
}

/**
 * Write a doc back to its file in its native format: a `.py` notebook round-trips
 * through jupytext / the Databricks converter in the format it was opened in (no
 * outputs — text notebooks carry none), everything else through nbformat. A doc
 * whose `.py` format could not be determined on load (`jpFormat` unset) is never
 * silently rewritten as `.ipynb`.
 */
function persist(doc) {
	if (doc.jpFormat) writePyNotebook(doc.path, doc.cells, doc.jpFormat);
	else writeNotebook(doc.path, doc);
}

/**
 * Load (or lazily create) the document for an absolute path. Loading NEVER
 * writes to disk — a `.ipynb` is persisted only on a genuine mutation (create /
 * add / edit / run / …), so opening Cellar in a folder drops no uninvited file
 * and opening an existing notebook produces no surprise git diff. Normalization
 * (clean-on-save) therefore happens on the first real mutation, not on open.
 *
 * The default notebook (`notebook.ipynb`) is materialized in memory if missing
 * so callers always get a valid document shape (SSR seeds the shell from it),
 * but that in-memory doc is not written until the user actually creates it or
 * mutates a cell. An arbitrary opened `.ipynb` must already exist on disk.
 */
function loadDoc(abs) {
	let doc = docs.get(abs);
	if (doc) return doc;
	if (isPyPath(abs)) {
		// A `.py` notebook (jupytext percent/light or Databricks source). `jpFormat`
		// records which format to write it back in; the cells carry no outputs.
		if (!existsSync(abs)) throw new Error('notebook not found: ' + abs);
		const parsed = readPyNotebook(abs);
		enforceUniqueIds(parsed.cells);
		doc = { path: abs, cells: parsed.cells, metadata: undefined, jpFormat: parsed.format };
		docs.set(abs, doc);
		return doc;
	}
	const raw = readNotebook(abs);
	if (raw) {
		const parsed = deserialize(raw);
		enforceUniqueIds(parsed.cells);
		doc = { path: abs, cells: parsed.cells, metadata: parsed.metadata };
		docs.set(abs, doc);
	} else if (abs === canonicalPath()) {
		doc = { path: abs, cells: [starterCell()], metadata: undefined };
		docs.set(abs, doc);
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
 *
 * Creating is a genuine "make this notebook exist" action, so it materializes
 * the file on disk — including the default notebook, which may exist only in
 * memory from a bare load (loadDoc no longer persists on open).
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
		}
	}
	// Write the file if it isn't on disk yet (fresh create, or a default doc that
	// only existed in memory — loadDoc no longer persists on open). An existing
	// file is left untouched.
	if (!existsSync(abs)) persist(doc);
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

/**
 * Workspace-relative path for an absolute notebook path — the id the browser
 * uses to address tabs (e.g. the default notebook is `notebook.ipynb`). Inverse
 * of `resolveAbs` for the common in-workspace case.
 */
export function workspaceRelative(abs) {
	return relative(workspace(), abs);
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
 * namespace: `lastRun = { at, durationMs, actor, status, session }`.
 * Both run entry points (the UI `/run` route → `actor:'user'`, the MCP run tools
 * → `actor:'agent'`) call this so the badge in `Cell.svelte` shows who last ran
 * the cell, when, and how long it took.
 *
 * `session` is the kernel-session epoch the run STARTED in (see kernel.js). It
 * is the only record of whether a cell executed against the namespace that is
 * live right now: a cell's saved `outputs` survive kernel restarts and process
 * restarts, so outputs alone can never answer that. The MCP layer compares it
 * with `currentSessionId()` to report `ran_this_session` — never infer "ran"
 * from `outputs.length`.
 *
 * NOT persisted: `at`/`durationMs` change every run, so writing them would make
 * the `.ipynb` byte-different on each run (a git diff), violating Cellar's
 * zero-diff-on-re-run rule. It lives only in the in-memory doc and is surfaced
 * to the browser via `cellView` (load/refetch) + the `run:end` SSE event, and
 * `clean.js` strips it before any disk write (report §4.2). Cleared on a server
 * restart; a kernel restart leaves it in place but bumps the epoch, so the stamp
 * then correctly reads as "did not run this session".
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

/** The notebook's designated imports cell, or null. */
export function getImportsCell(nb) {
	const doc = docFor(nb);
	const cell = doc.cells.find(isImportsCell);
	return cell ? cellView(cell) : null;
}

/**
 * Designate (or un-designate) a cell as the notebook's imports cell, in the
 * allowlisted `cellar` namespace so it round-trips through clean-on-save. Only
 * one cell may hold the role, so designating a cell strips it from any other.
 */
export function setCellRole(id, role, nb, originId) {
	const doc = docFor(nb);
	const cell = find(doc, id);
	if (!cell) return false;
	for (const c of doc.cells) {
		if (c !== cell && c.metadata?.cellar?.role) {
			delete c.metadata.cellar.role;
			emit(doc, 'cell:role', { cellId: c.id, role: null }, originId);
		}
	}
	cell.metadata = cell.metadata ?? {};
	cell.metadata.cellar = cell.metadata.cellar ?? {};
	if (role) cell.metadata.cellar.role = role;
	else delete cell.metadata.cellar.role;
	persist(doc);
	emit(doc, 'cell:role', { cellId: id, role: role ?? null }, originId);
	return true;
}

/**
 * Insert a cell at an absolute index. `addCell` can only insert AFTER a known id,
 * which cannot express "at the very top" — the one position the imports cell must
 * occupy. The `cell:added` event therefore carries an explicit `index` so the
 * browser inserts where the server did rather than appending.
 */
export function addCellAt(index, cellType = 'code', nb, originId, source = '', role) {
	const doc = docFor(nb);
	const cell = newCell(cellType, source);
	if (role) cell.metadata.cellar.role = role;
	const at = Math.max(0, Math.min(index, doc.cells.length));
	doc.cells.splice(at, 0, cell);
	persist(doc);
	emit(doc, 'cell:added', { cell: cellView(cell), afterId: doc.cells[at - 1]?.id ?? null, index: at }, originId);
	return cell;
}

/**
 * Move a cell to an absolute index (clamped). `index` addresses the array with
 * the moved cell already removed.
 *
 * The imports cell is PINNED at the top: it never moves, and nothing may be
 * inserted above it (`clampMoveIndex`). The browser applies the identical rule
 * optimistically, so the two never disagree about where a dragged cell landed.
 */
export function moveCellTo(id, index, nb, originId) {
	const doc = docFor(nb);
	const from = doc.cells.findIndex((c) => c.id === id);
	if (from < 0) return false;
	const allowed = clampMoveIndex(doc.cells, from, index);
	if (allowed < 0) return false;
	const [cell] = doc.cells.splice(from, 1);
	const to = Math.max(0, Math.min(allowed, doc.cells.length));
	doc.cells.splice(to, 0, cell);
	persist(doc);
	emit(doc, 'cell:moved', { cellId: id, toIndex: to }, originId);
	return true;
}

/**
 * Add a cell after `afterId` (appended when it is absent or unknown).
 * `source` seeds the new cell, so a paste / split / undo-delete lands as ONE
 * persist and ONE `cell:added` event carrying the real text - rather than an
 * empty cell that a follow-up edit fills in.
 */
export function addCell(afterId, cellType = 'code', nb, originId, source = '') {
	const doc = docFor(nb);
	const cell = newCell(cellType, source);
	const idx = afterId ? doc.cells.findIndex((c) => c.id === afterId) : -1;
	if (idx >= 0) doc.cells.splice(idx + 1, 0, cell);
	else doc.cells.push(cell);
	persist(doc);
	emit(doc, 'cell:added', { cell: cellView(cell), afterId: idx >= 0 ? afterId : null }, originId);
	return cell;
}

/**
 * Switch a cell's LOGICAL type between 'code', 'sql', and 'markdown'. 'sql' is a
 * code cell tagged `cellar.language = 'sql'` ($lib/cellLanguage.js), so it shares
 * the nbformat `code` type on disk; 'code' clears that tag back to Python.
 *
 * Markdown cells carry no outputs - nor the imports role: a markdown cell cannot
 * run, so leaving the designation on one would strand every future routed import
 * in a cell the kernel never sees. A SQL cell likewise can't hold Python imports,
 * so converting to SQL drops the imports role too.
 *
 * The `cell:type` event carries the new `language` so live sync updates the
 * editor's syntax highlighting (SQL ↔ Python) without a reload.
 */
export function setCellType(id, cellType, nb, originId) {
	const doc = docFor(nb);
	const cell = find(doc, id);
	if (!cell) return;
	const isSql = cellType === 'sql';
	cell.cell_type = cellType === 'markdown' ? 'markdown' : 'code';
	cell.metadata = cell.metadata ?? {};
	cell.metadata.cellar = cell.metadata.cellar ?? {};
	if (isSql) cell.metadata.cellar.language = SQL_LANGUAGE;
	else delete cell.metadata.cellar.language;
	if (cell.cell_type === 'markdown') cell.outputs = [];
	// SQL and markdown cells cannot be the Python imports cell.
	if ((cell.cell_type === 'markdown' || isSql) && cell.metadata.cellar.role === IMPORTS_ROLE) {
		delete cell.metadata.cellar.role;
	}
	persist(doc);
	emit(doc, 'cell:type', { cellId: id, cell_type: cell.cell_type, language: isSql ? SQL_LANGUAGE : null }, originId);
}

export function deleteCell(id, nb, originId) {
	const doc = docFor(nb);
	const existed = doc.cells.some((c) => c.id === id);
	doc.cells = doc.cells.filter((c) => c.id !== id);
	persist(doc);
	// A deleted cell must not later dequeue and run: drop any pending run for it.
	cancelRun(doc.path, id);
	if (existed) emit(doc, 'cell:deleted', { cellId: id }, originId);
}

export function setSource(id, source, nb, originId) {
	const doc = docFor(nb);
	const cell = find(doc, id);
	if (cell && cell.source !== source) {
		cell.source = source;
		// Runtime-only edit stamp for the staleness rule ($lib/staleness.js): a cell
		// (and everything downstream of it) is stale once its source changes after it
		// last ran. Stripped from disk by clean.js like `lastRun`, so an edit never
		// dirties the .ipynb. Set BEFORE persist so it rides the same in-memory doc.
		cell.metadata = cell.metadata ?? {};
		cell.metadata.cellar = cell.metadata.cellar ?? {};
		cell.metadata.cellar.editedAt = Date.now();
		persist(doc);
		emit(doc, 'cell:edited', { cellId: id, source }, originId);
	}
}

export function setOutputs(id, outputs, nb) {
	const doc = docFor(nb);
	const cell = find(doc, id);
	if (cell) {
		cell.outputs = outputs;
		// A `.py` notebook stores no outputs on disk (text has none), so a run only
		// updates the in-memory doc for live display — writing would re-run the whole
		// jupytext conversion to produce a byte-identical file. Persist only formats
		// that actually carry outputs.
		if (!doc.jpFormat) persist(doc);
	}
}

/**
 * Clear a cell's outputs in the LIVE in-memory doc only — no persist, no event.
 * Called at execution start (`run.js`) so the authoritative model reads empty the
 * moment a re-run begins: a tab that loads mid-run then gets no output and appends
 * the fresh stream, instead of concatenating it onto the prior run's result. Disk
 * is untouched (persist happens once, at run:end via `setOutputs`), so there is no
 * transient empty-output `.ipynb` write.
 */
export function clearOutputsLive(id, nb) {
	const cell = find(docFor(nb), id);
	if (cell) cell.outputs = [];
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

/** Swap a cell with its neighbour. Honors the imports cell's pin (`clampMoveIndex`). */
export function moveCell(id, dir, nb, originId) {
	const doc = docFor(nb);
	const i = doc.cells.findIndex((c) => c.id === id);
	if (i < 0) return;
	const j = dir === 'up' ? i - 1 : i + 1;
	if (j < 0 || j >= doc.cells.length) return;
	if (clampMoveIndex(doc.cells, i, j) !== j) return; // the pinned top cell, or a move above it
	[doc.cells[i], doc.cells[j]] = [doc.cells[j], doc.cells[i]];
	persist(doc);
	emit(doc, 'cell:moved', { cellId: id, toIndex: j }, originId);
}
