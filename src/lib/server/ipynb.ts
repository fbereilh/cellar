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
 * Compare two strings the way Python's `sorted()` does: by CODE POINT.
 *
 * JS's default `Array.prototype.sort` compares UTF-16 CODE UNITS, which disagrees
 * with code-point order for anything above the BMP (a surrogate pair, 0xD800-0xDFFF,
 * encodes U+10000+ but sorts BEFORE U+E000-U+FFFF by unit value). Remapping the
 * surrogate block above the rest of the BMP restores Python's order, so the
 * byte-identity claim below holds for ANY key, not only ASCII ones.
 */
function codePointRank(unit: number): number {
	if (unit >= 0xd800 && unit < 0xe000) return unit + 0x2000; // surrogates sort last
	if (unit >= 0xe000) return unit - 0x800;
	return unit;
}

function compareCodePoints(a: string, b: string): number {
	if (a === b) return 0;
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) {
		const x = a.charCodeAt(i);
		const y = b.charCodeAt(i);
		if (x !== y) return codePointRank(x) - codePointRank(y);
	}
	return a.length - b.length;
}

/**
 * Emit `value` as JSON text with keys SORTED and Python's `indent=1` layout,
 * appending the pieces to `out`. Returns false when the value is not
 * serializable at all (`undefined`, a function, a symbol) so the caller can drop
 * the key / substitute `null`, exactly as `JSON.stringify` does.
 *
 * WHY A HAND-ROLLED EMITTER RATHER THAN A `JSON.stringify` REPLACER. A replacer
 * can only hand back an OBJECT, and the JS spec fixes the property order of any
 * object: canonical array-index keys ("0", "2", "10") come FIRST, in ascending
 * NUMERIC order, whatever order they were inserted in. So a replacer that
 * carefully inserts keys sorted as strings still serialized `{"10":…,"2":…,"a":…}`
 * as `2, 10, a` where Python writes `10, 2, a` - and integer-like keys reach a
 * notebook through any ordinary output payload (`display(JSON({"2020": …}))`, a
 * `to_dict()` over an integer index). That residual divergence defeats the whole
 * point of sorting, which is that a notebook touched by both Cellar and Jupyter
 * must not churn. Writing the text directly is the only way to control the order.
 *
 * Primitives are delegated to `JSON.stringify`, so string escaping is byte-for-byte
 * the native rule (short escapes for `\b\f\n\r\t`, lowercase `\u00xx` for the
 * other control characters, every non-ASCII character literal) - which is also
 * Python's `ensure_ascii=False` rule, and is what the multi-MB payloads a notebook
 * carries (base64 rasters, stream text) go through, still natively and still once.
 *
 * COST, measured and accepted: ~2x the replacer it replaced (15ms vs 8ms on a 4 MB,
 * 200-cell notebook), because the per-NODE walk is JS rather than native. It is
 * paid on a save that already does a synchronous fsync + rename, and the overhead
 * scales with node COUNT rather than payload SIZE - the big strings never leave the
 * native path.
 */
function emitJson(value: unknown, depth: number, out: string[]): boolean {
	let v = value;
	if (v !== null && typeof v === 'object') {
		const toJson = (v as { toJSON?: unknown }).toJSON;
		if (typeof toJson === 'function') v = (toJson as (key?: string) => unknown).call(v);
	}
	if (v === undefined || typeof v === 'function' || typeof v === 'symbol') return false;
	if (v === null || typeof v !== 'object') {
		out.push(JSON.stringify(v) as string);
		return true;
	}
	const pad = '\n' + ' '.repeat(depth + 1);
	const closePad = '\n' + ' '.repeat(depth);
	if (Array.isArray(v)) {
		if (!v.length) {
			out.push('[]');
			return true;
		}
		out.push('[');
		for (let i = 0; i < v.length; i++) {
			if (i) out.push(',');
			out.push(pad);
			// A hole / undefined / function element serializes as null, as it does natively.
			if (!emitJson(v[i], depth + 1, out)) out.push('null');
		}
		out.push(closePad, ']');
		return true;
	}
	const src = v as Record<string, unknown>;
	const open = out.length;
	out.push('{');
	let written = 0;
	for (const key of Object.keys(src).sort(compareCodePoints)) {
		const mark = out.length;
		if (written) out.push(',');
		out.push(pad, JSON.stringify(key), ': ');
		if (!emitJson(src[key], depth + 1, out)) {
			out.length = mark; // an unserializable value drops its key entirely
			continue;
		}
		written++;
	}
	if (!written) {
		out.length = open;
		out.push('{}');
		return true;
	}
	out.push(closePad, '}');
	return true;
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
 * WHAT IS AND IS NOT BYTE-IDENTICAL TO PYTHON, stated exactly, because the whole
 * point of this change is that a notebook touched by both writers stops churning
 * and a wider claim would send the next person hunting a regression that is not
 * here. KEY ORDER - the property that was churning 100% of the lines - matches
 * unconditionally and recursively, an object keyed by numeric strings included,
 * which is why this writes the text itself instead of leaning on a
 * `JSON.stringify` replacer (see `emitJson`). So do string escaping and unicode
 * (`ensure_ascii=False`'s literal characters), the 1-space indent, the trailing
 * newline, array order, and empty containers.
 *
 * NUMBER FORMATTING is the one stated residual: primitives go through
 * `JSON.stringify`, so numbers are spelled by ECMAScript's rule, not Python's
 * `repr`. Measured divergences, and whether an alternating Cellar/Jupyter save
 * settles them:
 *   - CONVERGES after Cellar's first save (Python re-reads Cellar's spelling and
 *     keeps it, so this folds into the one-time reformat below): an integral float
 *     `1.0` -> `1`, a negative zero `-0.0` -> `0`, a value written in exponent form
 *     that is integral `1e16` -> `10000000000000000`.
 *   - ALTERNATES forever, one line per such number: a float the two writers spell
 *     with different notation, because JS goes exponential below `1e-6` while
 *     Python does so below `1e-4` (`1e-5` -> JS `0.00001`, Python `1e-05`), or with
 *     a differently padded exponent, Python zero-padding a single digit (`1e-7` ->
 *     JS `1e-7`, Python `1e-07`; two digits and longer already agree).
 * This is NOT fixable here and is deliberately not chased: `JSON.parse` erases the
 * source lexeme (`1.0` is already the number 1 by the time this sees it), so
 * matching Python would mean reimplementing its float `repr` - a large, risky
 * change for a cosmetic one, both spellings being valid JSON. Cellar's OWN
 * determinism and idempotence are unaffected: this emitter is a pure function of
 * the value it is handed. Separately and upstream of this function, `JSON.parse`
 * also rounds an integer past 2^53 (pre-existing, true of every read/write cycle
 * Cellar has ever done, and not a property of the emitter).
 *
 * ONE-TIME COST: this reformats every existing notebook on its next save - a pure
 * key reordering with no semantic change, moving the file toward the ecosystem
 * norm rather than away from it.
 */
export function stringify(nb: unknown): string {
	const out: string[] = [];
	if (!emitJson(nb, 0, out)) return 'null\n'; // matches JSON.stringify(undefined) usage
	return out.join('') + '\n';
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
