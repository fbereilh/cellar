/**
 * Cellar — canonical notebook document (server-owned).
 *
 * Cellar owns the live document in memory and reconstitutes it from the
 * committed `.ipynb` on load (spec §4). One notebook per workspace folder.
 *
 * Cellar owns cell-ID generation and enforces uniqueness on every load/save —
 * it does NOT rely on nbformat's lenient auto-rename (spec §3, nbdev report §2).
 * IDs are readable slugs (`cell-N`) from a monotonic counter, never reused and
 * never regenerated on edit/run/reorder.
 */
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readNotebook, deserialize, writeNotebook } from './ipynb.js';

const FILENAME = 'notebook.ipynb';

let doc = null; // { path, cells, metadata }

function workspace() {
	return process.env.CELLAR_WORKSPACE || process.cwd();
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

function persist() {
	writeNotebook(doc.path, doc);
}

/** Lazily load the notebook from disk (or create a default one). */
function ensure() {
	if (doc) return doc;
	const path = join(workspace(), FILENAME);
	const raw = readNotebook(path);
	if (raw) {
		const parsed = deserialize(raw);
		enforceUniqueIds(parsed.cells);
		doc = { path, cells: parsed.cells, metadata: parsed.metadata };
		// Re-persist so a foreign/edited-outside file is normalized + cleaned.
		persist();
	} else {
		doc = { path, cells: [starterCell()], metadata: undefined };
		persist();
	}
	return doc;
}

/** Serializable view of the notebook for the browser. */
export function getNotebook() {
	ensure();
	return {
		workspace: workspace(),
		path: doc.path,
		cells: doc.cells.map((c) => ({
			id: c.id,
			cell_type: c.cell_type,
			source: c.source,
			outputs: c.outputs
		}))
	};
}

function find(id) {
	return doc.cells.find((c) => c.id === id);
}

// --- richer read/write surface (used by the MCP agent interface) -----------

/** Full cell views including metadata, in document order. */
export function listCells() {
	ensure();
	return doc.cells.map((c) => ({
		id: c.id,
		cell_type: c.cell_type,
		source: c.source,
		outputs: c.outputs ?? [],
		metadata: c.metadata ?? {}
	}));
}

/** A single full cell view (or null). */
export function getCell(id) {
	ensure();
	const c = find(id);
	if (!c) return null;
	return { id: c.id, cell_type: c.cell_type, source: c.source, outputs: c.outputs ?? [], metadata: c.metadata ?? {} };
}

/** Set the agent-visibility flag in the allowlisted `cellar` namespace. */
export function setVisibility(id, hidden) {
	ensure();
	const cell = find(id);
	if (!cell) return false;
	cell.metadata = cell.metadata ?? {};
	cell.metadata.cellar = cell.metadata.cellar ?? {};
	cell.metadata.cellar.hidden_from_agent = !!hidden;
	persist();
	return true;
}

/** Move a cell to an absolute index (clamped). */
export function moveCellTo(id, index) {
	ensure();
	const from = doc.cells.findIndex((c) => c.id === id);
	if (from < 0) return false;
	const [cell] = doc.cells.splice(from, 1);
	const to = Math.max(0, Math.min(index, doc.cells.length));
	doc.cells.splice(to, 0, cell);
	persist();
	return true;
}

export function addCell(afterId, cellType = 'code') {
	ensure();
	const cell = newCell(cellType);
	const idx = afterId ? doc.cells.findIndex((c) => c.id === afterId) : -1;
	if (idx >= 0) doc.cells.splice(idx + 1, 0, cell);
	else doc.cells.push(cell);
	persist();
	return cell;
}

/** Switch a cell between 'code' and 'markdown'. Markdown cells carry no outputs. */
export function setCellType(id, cellType) {
	ensure();
	const cell = find(id);
	if (!cell) return;
	cell.cell_type = cellType === 'markdown' ? 'markdown' : 'code';
	if (cell.cell_type === 'markdown') cell.outputs = [];
	persist();
}

export function deleteCell(id) {
	ensure();
	doc.cells = doc.cells.filter((c) => c.id !== id);
	persist();
}

export function setSource(id, source) {
	ensure();
	const cell = find(id);
	if (cell) {
		cell.source = source;
		persist();
	}
}

export function setOutputs(id, outputs) {
	ensure();
	const cell = find(id);
	if (cell) {
		cell.outputs = outputs;
		persist();
	}
}

export function clearOutputs(id) {
	ensure();
	const cell = find(id);
	if (cell) {
		cell.outputs = [];
		persist();
	}
}

export function moveCell(id, dir) {
	ensure();
	const i = doc.cells.findIndex((c) => c.id === id);
	if (i < 0) return;
	const j = dir === 'up' ? i - 1 : i + 1;
	if (j < 0 || j >= doc.cells.length) return;
	[doc.cells[i], doc.cells[j]] = [doc.cells[j], doc.cells[i]];
	persist();
}
