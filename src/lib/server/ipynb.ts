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
import { cleanNotebook, stripRuntimeMeta } from './clean.js';
import type { Cell, NotebookDoc, NotebookMetadata, NbNotebook } from './types.js';

const NBFORMAT = 4;
const NBFORMAT_MINOR = 5;

/** Split a source string into nbformat multiline form (lines keep their \n). */
function toLines(src: string): string[] {
	if (!src) return [];
	const parts = src.split('\n');
	const lines: string[] = [];
	for (let i = 0; i < parts.length; i++) {
		if (i < parts.length - 1) lines.push(parts[i] + '\n');
		else if (parts[i] !== '') lines.push(parts[i]);
	}
	return lines;
}

/** Join nbformat multiline (string | string[]) back into a single string. */
function fromLines(src: string | string[] | undefined | null): string {
	return Array.isArray(src) ? src.join('') : (src ?? '');
}

/** Default kernelspec for a fresh notebook. */
function defaultMetadata(): NotebookMetadata {
	return { kernelspec: { name: 'python3', display_name: 'python3', language: 'python' } };
}

/**
 * Build a cleaned nbformat notebook object from the canonical document.
 */
export function serialize(doc: { cells: Cell[]; metadata?: NotebookMetadata }): NbNotebook {
	// nbformat cells built here carry optional outputs/execution_count that are
	// deleted for markdown cells before cleaning.
	type BuiltCell = {
		cell_type: string;
		id: string;
		metadata: Record<string, unknown>;
		source: string[];
		outputs?: unknown[];
		execution_count?: number | null;
	};
	const nb = {
		cells: doc.cells.map((c): BuiltCell => ({
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
	return cleanNotebook(nb) as unknown as NbNotebook;
}

/**
 * Parse an nbformat notebook object into canonical cells.
 *
 * `stripRuntimeMeta` is the read-side half of the run-stamp forgery guard: a
 * `cellar.lastRun` (or `.editedAt`) read off disk must never reach the document,
 * or an externally-authored `.ipynb` could claim a cell ran in the live kernel
 * session. Only an in-process run/edit may originate those stamps. See clean.js.
 */
export function deserialize(nb: {
	cells?: Array<{ id?: string; cell_type?: string; source?: string | string[]; outputs?: unknown; metadata?: import('./types.js').CellMetadata }>;
	metadata?: NotebookMetadata;
}): { cells: Cell[]; metadata: NotebookMetadata } {
	const cells: Cell[] = (nb.cells || []).map((c) => ({
		id: c.id ?? '',
		// Pass the nbformat cell_type through unchanged (Cellar only authors
		// code/markdown, but a foreign notebook's type must round-trip verbatim).
		cell_type: (c.cell_type || 'code') as Cell['cell_type'],
		source: fromLines(c.source),
		outputs: (c.outputs as Cell['outputs']) ?? [],
		metadata: stripRuntimeMeta(c.metadata)
	}));
	return { cells, metadata: nb.metadata ?? defaultMetadata() };
}

/** Deterministic JSON text for an nbformat object (1-space indent, trailing \n). */
export function stringify(nb: unknown): string {
	return JSON.stringify(nb, null, 1) + '\n';
}

export function readNotebook(path: string): NbNotebook | null {
	if (!existsSync(path)) return null;
	return JSON.parse(readFileSync(path, 'utf8')) as NbNotebook;
}

/** Clean, serialize deterministically, and write to disk. */
export function writeNotebook(path: string, doc: NotebookDoc): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, stringify(serialize(doc)));
}
