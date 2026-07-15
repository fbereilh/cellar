/**
 * Cellar — clean-on-save field policy.
 *
 * A direct port of nbdev v2's `clean_nb` field policy (see
 * data/nbdev-study-n8/report.md §1 and spec §3), implemented in Cellar's own
 * save pipeline (Cellar sits in nbdev's Jupyter-save-hook seat). The goal is a
 * git-friendly `.ipynb`: identical re-runs produce no diff.
 *
 * Rules (KEEPS outputs by default):
 *  - null every `execution_count` (cell level + inside each output)
 *  - strip all cell metadata except the allowlisted `cellar` namespace
 *  - drop runtime-only `cellar` run metadata (`lastRun`, `editedAt`)
 *  - strip all notebook metadata except `kernelspec` (+ `cellar` if present);
 *    this drops `language_info` and the volatile `widgets` state
 *  - normalize `kernelspec.display_name` → `kernelspec.name`
 *  - scrub memory-address reprs (`<foo at 0x…>` → `<foo>`) in text/stream output
 *
 * MUST be idempotent: cleaning an already-clean notebook yields zero change.
 *
 * Performance (a save runs on every keystroke-triggered autosave): clean does
 * NOT deep-clone the notebook. It builds a shallow copy of the notebook and of
 * each cell wrapper, and reuses every output object BY REFERENCE unless clean
 * actually rewrites that output (copy-on-write in `cleanOutput`). So a save
 * never duplicates the (potentially multi-MB) output blobs it does not touch,
 * and it never mutates the live document the UI is bound to. On top of that, a
 * cell's cleaned outputs are memoized by the identity of its raw outputs array:
 * a source-only edit leaves that array reference untouched (a run replaces it),
 * so a source-only autosave reuses the previously-cleaned outputs verbatim
 * without re-scanning them, while a run-end / clear save (new array) recomputes.
 */

import type { CellMetadata } from './types';

/** Cell-metadata keys preserved through a clean. Everything else is dropped. */
export const ALLOWED_CELL_METADATA = ['cellar'];
/** Notebook-metadata keys preserved through a clean. */
export const ALLOWED_NB_METADATA = ['kernelspec', 'cellar'];

const ADDRESS_RE = /(<[^<>]*?) at 0x[0-9a-fA-F]+(?=[>\s])/g;

/**
 * Cellar's live-only DataFrame grid payload (see kernel.js). It is a render of
 * the output, not part of it: kept in the in-memory doc so open tabs show the
 * grid, but stripped here so it never bloats the persisted `.ipynb` or dirties
 * git. pandas' text/plain + text/html reprs remain as the on-disk fallback.
 */
const DATAFRAME_MIME = 'application/vnd.cellar.dataframe+json';

/**
 * ipywidgets view output (tqdm progress bars). It references a live widget model
 * by id whose state lives only in the running kernel session (never persisted),
 * and the id is a fresh UUID every run — so persisting it would both fail to
 * render on reopen AND churn a git diff on every run. Like the DataFrame grid,
 * it is stripped on save; any real fallback (e.g. a `text/plain` repr) is kept,
 * and an output left with an empty bundle is dropped entirely.
 */
const WIDGET_VIEW_MIME = 'application/vnd.jupyter.widget-view+json';

/** Scrub `<... at 0x…>`-style memory addresses from a string or list of strings. */
export function scrubAddresses<T>(text: T): T {
	if (Array.isArray(text)) return text.map((t) => scrubAddresses(t)) as T;
	if (typeof text !== 'string') return text;
	return text.replace(ADDRESS_RE, '$1') as T;
}

/**
 * Scrub addresses but report whether anything changed, reusing the input by
 * reference when it did not — the copy-on-write signal callers use to avoid
 * copying an output that clean leaves byte-identical. For a string, `!==` is a
 * value comparison, so an unchanged string is reported unchanged; for a list we
 * scrub each element and keep the original array whenever no element changed.
 */
function scrubChanged(value: unknown): { value: unknown; changed: boolean } {
	if (Array.isArray(value)) {
		let changed = false;
		const mapped = value.map((v) => {
			const r = scrubAddresses(v);
			if (r !== v) changed = true;
			return r;
		});
		return changed ? { value: mapped, changed: true } : { value, changed: false };
	}
	if (typeof value === 'string') {
		const r = scrubAddresses(value);
		return { value: r, changed: r !== value };
	}
	return { value, changed: false };
}

function pick(obj: Record<string, unknown> | null | undefined, allowed: readonly string[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (!obj) return out;
	for (const k of allowed) if (k in obj) out[k] = obj[k];
	return out;
}

// nbformat output objects arrive from JSON; clean treats them as READ-ONLY (they
// alias the live document) and copies on write. Model them as an open record so
// the field probes below type-check without over-narrowing.
type RawOutput = Record<string, unknown> & { data?: Record<string, unknown> };

/**
 * Observability counters for the save/clean hot path (per-save work). Purely
 * diagnostic — reading or resetting them never changes clean's output. Used by
 * the unit tests to prove a source-only save reuses cleaned outputs (a cache
 * hit, zero object copies) and by the E2E smoke test to show the dropped work.
 */
export const cleanMetrics = {
	/** Outputs arrays freshly cleaned (a run-end / clear / first save — cache miss). */
	outputArraysCleaned: 0,
	/** Outputs arrays served from the memo (a source-only save — cache hit). */
	outputArrayCacheHits: 0,
	/** Individual output objects shallow-copied by copy-on-write (never the live one). */
	outputsCopied: 0
};

/** Reset the clean metrics (test/diagnostic helper). */
export function resetCleanMetrics(): void {
	cleanMetrics.outputArraysCleaned = 0;
	cleanMetrics.outputArrayCacheHits = 0;
	cleanMetrics.outputsCopied = 0;
}

/**
 * Copy-on-write clean of a single output. Returns the input BY REFERENCE when
 * clean rewrites nothing (the common case — an image, an error, an already-clean
 * repr), so the output blob is never duplicated and the live object is never
 * touched. Only when a field must change do we shallow-copy the output wrapper
 * (and, if needed, its `data` bundle), leaving the large mime payloads shared.
 */
function cleanOutput(output: RawOutput): RawOutput {
	let result = output;
	const srcData = output.data;
	let data = srcData;

	const ensureOutputCopy = () => {
		if (result === output) {
			result = { ...output };
			cleanMetrics.outputsCopied += 1;
		}
	};
	const ensureDataCopy = () => {
		if (data === srcData && srcData) {
			ensureOutputCopy();
			data = { ...srcData };
			result.data = data;
		}
	};

	// null execution_count (only when it is present and not already null — an
	// already-null count needs no copy and stays byte-identical).
	if ('execution_count' in output && output.execution_count !== null) {
		ensureOutputCopy();
		result.execution_count = null;
	}

	// stream text
	if (output.output_type === 'stream' && 'text' in output) {
		const s = scrubChanged(output.text);
		if (s.changed) {
			ensureOutputCopy();
			result.text = s.value;
		}
	}

	if (srcData) {
		// text/plain reprs inside execute_result / display_data
		if ('text/plain' in srcData) {
			const s = scrubChanged(srcData['text/plain']);
			if (s.changed) {
				ensureDataCopy();
				data!['text/plain'] = s.value;
			}
		}
		// Drop the live-only DataFrame grid payload — a render of the output, never
		// persisted (keeps the .ipynb git-clean; pandas' own reprs stay as fallback).
		if (DATAFRAME_MIME in srcData) {
			ensureDataCopy();
			delete data![DATAFRAME_MIME];
		}
		// Drop the volatile ipywidgets view mime (tqdm bars); a fallback repr is kept.
		if (WIDGET_VIEW_MIME in srcData) {
			ensureDataCopy();
			delete data![WIDGET_VIEW_MIME];
		}
	}

	return result;
}

/**
 * Cleaned-outputs memo, keyed by the identity of a cell's RAW outputs array.
 * Cellar only ever REPLACES a cell's outputs wholesale (a run installs a fresh
 * array via `setOutputs`); a source edit leaves the array reference untouched.
 * So the array identity is an exact "did the outputs change since last save"
 * key: a source-only autosave hits and reuses the prior cleaned array verbatim,
 * a run-end / clear save misses and recomputes. A WeakMap keeps this leak-free —
 * an entry is collected when its raw array is dropped. Referentially transparent:
 * same array ⇒ same cleaned result a fresh clean would produce (byte-identical),
 * so idempotency/zero-diff is preserved.
 */
const cleanedOutputsCache = new WeakMap<object, RawOutput[]>();

/**
 * Clean a cell's outputs, reusing a memoized result on a source-only save. On a
 * miss we map each output through the copy-on-write `cleanOutput` and drop any
 * now-empty display output; when nothing changed we return the input array
 * itself (maximal reference reuse). The result is cached against the raw array.
 */
function cleanOutputs(outputs: RawOutput[]): RawOutput[] {
	const cached = cleanedOutputsCache.get(outputs);
	if (cached) {
		cleanMetrics.outputArrayCacheHits += 1;
		return cached;
	}
	cleanMetrics.outputArraysCleaned += 1;
	let changed = false;
	const mapped = outputs.map((o) => {
		const c = cleanOutput(o);
		if (c !== o) changed = true;
		return c;
	});
	const needFilter = mapped.some(isEmptyDisplayOutput);
	const result =
		!changed && !needFilter ? outputs : needFilter ? mapped.filter((o) => !isEmptyDisplayOutput(o)) : mapped;
	cleanedOutputsCache.set(outputs, result);
	return result;
}

/**
 * A display output whose MIME bundle is now empty carries nothing to render on
 * disk — it only existed for a live-only mime we just stripped (a widget view
 * with no fallback). Drop it so the `.ipynb` stays clean, matching Jupyter,
 * which persists no output for a bare widget display.
 */
function isEmptyDisplayOutput(output: RawOutput): boolean {
	return (
		(output.output_type === 'display_data' || output.output_type === 'execute_result') &&
		!!output.data &&
		Object.keys(output.data).length === 0
	);
}

/** Runtime-only `cellar` keys — never persisted, stripped symmetrically on read + write. */
const RUNTIME_CELLAR_KEYS = ['lastRun', 'editedAt'];

/**
 * Return a copy of cell metadata without the runtime-only `cellar` records:
 *  - `lastRun` — the run stamp (volatile at/durationMs, plus the kernel-session
 *    epoch that is the sole evidence a cell ran against the live namespace).
 *  - `editedAt` — the wall-clock time the source last changed, which feeds the
 *    staleness rule ($lib/staleness.js) and, like the epoch, would churn a git
 *    diff on every keystroke if persisted.
 *
 * This is one half of a two-sided forgery/zero-diff guard, and the two halves
 * must stay in lockstep, so they share this helper: `cleanCell` strips it on the
 * way to disk (so a run or an edit never dirties the .ipynb), and ipynb.js's
 * `deserialize` strips it on the way back in (so a hand-edited notebook cannot
 * forge `ok_session`: epochs are small monotonic integers and would otherwise be
 * trivial to guess).
 *
 * An emptied `cellar` namespace is dropped so a foreign cell that never had one
 * stays byte-identical, preserving zero-diff-on-re-run and idempotency.
 */
export function stripRuntimeMeta(metadata: CellMetadata | undefined | null): CellMetadata {
	const md: CellMetadata = { ...(metadata ?? {}) };
	if (md.cellar) {
		const rest: Record<string, unknown> = { ...md.cellar };
		for (const k of RUNTIME_CELLAR_KEYS) delete rest[k];
		if (Object.keys(rest).length) md.cellar = rest;
		else delete md.cellar;
	}
	return md;
}

// nbformat cell object mutated in place during a clean.
type RawCell = Record<string, unknown> & {
	cell_type?: string;
	outputs?: unknown;
	metadata?: CellMetadata;
};

function cleanCell(cell: RawCell): RawCell {
	// Shallow-copy the cell wrapper so clean never mutates its input (the wrapper
	// aliases the live document via `outputs`/`metadata`). This copies only the
	// small wrapper — the outputs array and its blobs stay shared by reference.
	const out: RawCell = { ...cell };
	if (out.cell_type === 'code') {
		out.execution_count = null;
		if (Array.isArray(out.outputs)) {
			out.outputs = cleanOutputs(out.outputs as RawOutput[]);
		}
	}
	// deny-by-default metadata allowlist (keeps the `cellar` namespace intact)
	out.metadata = stripRuntimeMeta(pick(cell.metadata, ALLOWED_CELL_METADATA) as CellMetadata);
	return out;
}

// nbformat notebook object as it arrives (from JSON or the serialize builder).
type RawNotebook = Record<string, unknown> & {
	metadata?: Record<string, unknown>;
	cells?: RawCell[];
};

/**
 * Return a cleaned copy of an nbformat notebook object. Pure + idempotent, and
 * SURGICAL: it shallow-copies the notebook, its metadata, its kernelspec, and
 * each cell wrapper, but reuses the (potentially large) output blobs by
 * reference wherever clean does not rewrite them — so a save never duplicates
 * every output in memory, and the live document is never mutated.
 */
export function cleanNotebook<T extends RawNotebook>(nb: T): T {
	const metadata = pick(nb.metadata, ALLOWED_NB_METADATA);
	const kernelspec = metadata.kernelspec as { name?: string; display_name?: string } | undefined;
	if (kernelspec) {
		// display_name varies per machine; normalize it to the stable name. Copy the
		// kernelspec first so the live document's kernelspec object is left untouched.
		metadata.kernelspec = { ...kernelspec, display_name: kernelspec.name };
	}

	const cells = (nb.cells || []).map(cleanCell);
	return { ...nb, metadata, cells } as T;
}
