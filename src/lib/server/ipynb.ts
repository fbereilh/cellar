/**
 * Cellar — .ipynb (de)serialization.
 *
 * Bridges Cellar's canonical in-memory document (cells with string `source`)
 * and a real nbformat 4.5 notebook on disk. Serialization is deterministic
 * (fixed key order, stable formatting) and runs the clean-on-save policy, so
 * an identical re-run produces a byte-identical file (no git diff).
 */
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { cleanNotebook, stripRuntimeMeta } from './clean';
import { atomicWriteFileSync } from './atomic-write';
import { serializeWriteSync } from './write-lock';
import { invalidateGitStatusCache } from './git';
import type { Cell, NotebookDoc, NotebookMetadata, NbNotebook } from './types';

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
 * `cellar.lastRun` (or `.editedAt`, or `.importBindings`) read off disk must never
 * reach the document, or an externally-authored `.ipynb` could claim a cell ran in
 * the live kernel session - or, with a forged import-binding baseline, that a
 * binding it rewrote is unchanged. Only an in-process run/edit may originate those
 * stamps. See clean.js.
 */
export function deserialize(nb: {
	cells?: Array<{ id?: string; cell_type?: string; source?: string | string[]; outputs?: unknown; metadata?: import('./types').CellMetadata }>;
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

/**
 * `JSON.stringify` replacer that emits every object's keys in sorted order.
 *
 * Returning a fresh object whose keys were inserted in sorted order is what makes
 * this recursive for free: `JSON.stringify` serializes the REPLACEMENT in its own
 * insertion order and then calls the replacer again for each of ITS values, so a
 * nested object is sorted by the same rule without this function recursing.
 *
 * Cost is one small wrapper object plus an O(k log k) key sort per OBJECT node.
 * The multi-MB payloads a notebook carries (base64 image data, stream text) are
 * strings, which the replacer returns by reference and never copies - so this
 * does not undo `clean.ts`'s no-deep-clone rule, and `JSON.stringify` was already
 * walking every node.
 */
function sortedKeysReplacer(_key: string, value: unknown): unknown {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
	const src = value as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const k of Object.keys(src).sort()) out[k] = src[k];
	return out;
}

/**
 * Deterministic JSON text for an nbformat object: keys SORTED, 1-space indent,
 * trailing `\n`.
 *
 * Sorted keys are the ECOSYSTEM's convention, not an nbdev concession: `nbformat`
 * - the reference writer behind JupyterLab, Jupyter Notebook, nbconvert and
 * papermill - writes `sort_keys=True, indent=1`, and fastcore/nbdev's own writer
 * (`fastcore/nbio.py`) writes `sort_keys=True, indent=1, ensure_ascii=False` plus a
 * trailing newline. Emitting insertion order instead made Cellar the odd one out:
 * ANY notebook touched by both Cellar and Jupyter churned 100% of its lines,
 * because Cellar wrote `cell_type, id, metadata, source, outputs, execution_count`
 * where everything else writes them alphabetically.
 *
 * `JSON.stringify` already agrees with Python's `ensure_ascii=False` on unicode
 * (both emit literal characters), so `sort_keys` was the entire remaining
 * difference. Key order is by UTF-16 code unit vs Python's code point; those
 * differ only above the BMP, and notebook/metadata keys are ASCII.
 *
 * ONE-TIME COST: this reformats every existing notebook on its next save - a pure
 * key reordering with no semantic change, moving the file toward the ecosystem
 * norm rather than away from it.
 */
export function stringify(nb: unknown): string {
	return JSON.stringify(nb, sortedKeysReplacer, 1) + '\n';
}

export function readNotebook(path: string): NbNotebook | null {
	if (!existsSync(path)) return null;
	return JSON.parse(readFileSync(path, 'utf8')) as NbNotebook;
}

/**
 * Clean, serialize deterministically, and write to disk — atomically, and
 * serialized against any concurrent write to the same notebook.
 *
 * The document is snapshotted to text SYNCHRONOUSLY (before any queuing), so a
 * queued write persists the state as of when it was requested. The disk write
 * is temp-file + fsync + rename (`atomicWriteFileSync`), so a crash mid-write
 * never truncates the user's notebook, and it goes through the per-path lock so
 * an autosave and a run-end persist to the same file cannot interleave.
 */
export function writeNotebook(path: string, doc: NotebookDoc): void {
	mkdirSync(dirname(path), { recursive: true });
	const data = stringify(serialize(doc));
	serializeWriteSync(resolve(path), () => atomicWriteFileSync(path, data));
	// A save changes the working tree (so `git status` differs) without touching
	// the git index, so drop the workspace status cache to keep the file-tree
	// decorations instant. The notebook's own blame/HEAD caches self-invalidate on
	// its new mtime.
	invalidateGitStatusCache();
}
