/**
 * Cellar — .ipynb (de)serialization.
 *
 * Bridges Cellar's canonical in-memory document (cells with string `source`)
 * and a real nbformat 4.5 notebook on disk. Serialization is deterministic
 * (fixed key order, stable formatting) and runs the clean-on-save policy, so
 * an identical re-run produces a byte-identical file (no git diff).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { cleanNotebook } from './clean.js';

const NBFORMAT = 4;
const NBFORMAT_MINOR = 5;

/** Split a source string into nbformat multiline form (lines keep their \n). */
function toLines(src) {
	if (!src) return [];
	const parts = src.split('\n');
	const lines = [];
	for (let i = 0; i < parts.length; i++) {
		if (i < parts.length - 1) lines.push(parts[i] + '\n');
		else if (parts[i] !== '') lines.push(parts[i]);
	}
	return lines;
}

/** Join nbformat multiline (string | string[]) back into a single string. */
function fromLines(src) {
	return Array.isArray(src) ? src.join('') : (src ?? '');
}

/** Default kernelspec for a fresh notebook. */
function defaultMetadata() {
	return { kernelspec: { name: 'python3', display_name: 'python3', language: 'python' } };
}

/**
 * Build a cleaned nbformat notebook object from the canonical document.
 * @param {{cells: Array, metadata?: object}} doc
 */
export function serialize(doc) {
	const nb = {
		cells: doc.cells.map((c) => ({
			cell_type: c.cell_type,
			id: c.id,
			metadata: c.metadata ?? {},
			source: toLines(c.source),
			outputs: c.cell_type === 'code' ? (c.outputs ?? []) : undefined,
			execution_count: c.cell_type === 'code' ? null : undefined
		})).map((c) => {
			// Drop undefined keys (markdown cells have no outputs/execution_count).
			if (c.outputs === undefined) delete c.outputs;
			if (c.execution_count === undefined) delete c.execution_count;
			return c;
		}),
		metadata: doc.metadata ?? defaultMetadata(),
		nbformat: NBFORMAT,
		nbformat_minor: NBFORMAT_MINOR
	};
	return cleanNotebook(nb);
}

/**
 * Cell metadata as loaded from disk, minus the runtime-only `cellar.lastRun`.
 *
 * That stamp records the kernel-session epoch a cell executed in, and it is the
 * sole evidence that a cell ran against the namespace that is live *now*. It
 * must therefore only ever originate from an in-process run: a hand-edited or
 * externally-authored `.ipynb` could otherwise carry a `session` matching the
 * live epoch (they are small monotonic integers) and forge `ok_session` /
 * `ran_this_session: true` for a cell that never executed. `clean.js` strips it
 * on write; this is the matching strip on read. An emptied `cellar` namespace is
 * dropped too, mirroring clean.js so a foreign cell stays byte-identical.
 */
function loadCellMetadata(metadata) {
	const md = { ...(metadata ?? {}) };
	if (md.cellar) {
		const { lastRun, ...rest } = md.cellar;
		if (Object.keys(rest).length) md.cellar = rest;
		else delete md.cellar;
	}
	return md;
}

/** Parse an nbformat notebook object into canonical cells. */
export function deserialize(nb) {
	const cells = (nb.cells || []).map((c) => ({
		id: c.id,
		cell_type: c.cell_type || 'code',
		source: fromLines(c.source),
		outputs: c.outputs ?? [],
		metadata: loadCellMetadata(c.metadata)
	}));
	return { cells, metadata: nb.metadata ?? defaultMetadata() };
}

/** Deterministic JSON text for an nbformat object (1-space indent, trailing \n). */
export function stringify(nb) {
	return JSON.stringify(nb, null, 1) + '\n';
}

export function readNotebook(path) {
	if (!existsSync(path)) return null;
	return JSON.parse(readFileSync(path, 'utf8'));
}

/** Clean, serialize deterministically, and write to disk. */
export function writeNotebook(path, doc) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, stringify(serialize(doc)));
}
