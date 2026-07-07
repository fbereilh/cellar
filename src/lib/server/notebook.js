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
import { readNotebook, deserialize, writeNotebook } from './ipynb.js';

const FILENAME = 'notebook.ipynb';

let doc = null; // { path, cells, metadata, counter }

function workspace() {
	return process.env.CELLAR_WORKSPACE || process.cwd();
}

/** Mint a fresh, unique, readable cell id. */
function mintId() {
	return `cell-${++doc.counter}`;
}

/** Ensure every cell has a unique id; re-key missing/duplicate ones. */
function enforceUniqueIds(cells) {
	const seen = new Set();
	let maxN = 0;
	for (const c of cells) {
		const m = /^cell-(\d+)$/.exec(c.id || '');
		if (m) maxN = Math.max(maxN, Number(m[1]));
	}
	let counter = maxN;
	for (const c of cells) {
		if (!c.id || seen.has(c.id)) {
			c.id = `cell-${++counter}`;
		}
		seen.add(c.id);
	}
	return counter;
}

function starterCell(counter) {
	return {
		id: `cell-${counter}`,
		cell_type: 'code',
		source: "print('hello')\n6 * 7",
		outputs: [],
		// Reserve the `cellar` metadata namespace (future extract/visibility
		// flags). The placeholder proves the allowlist preserves it on clean.
		metadata: { cellar: { extract: false, visible: true } }
	};
}

function newCell() {
	return {
		id: mintId(),
		cell_type: 'code',
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
		const counter = enforceUniqueIds(parsed.cells);
		doc = { path, cells: parsed.cells, metadata: parsed.metadata, counter };
		// Re-persist so a foreign/edited-outside file is normalized + cleaned.
		persist();
	} else {
		doc = { path, cells: [starterCell(1)], metadata: undefined, counter: 1 };
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

export function addCell(afterId) {
	ensure();
	const cell = newCell();
	const idx = afterId ? doc.cells.findIndex((c) => c.id === afterId) : -1;
	if (idx >= 0) doc.cells.splice(idx + 1, 0, cell);
	else doc.cells.push(cell);
	persist();
	return cell;
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
