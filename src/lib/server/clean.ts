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

/** Scrub `<... at 0x…>`-style memory addresses from a string or list of strings. */
export function scrubAddresses<T>(text: T): T {
	if (Array.isArray(text)) return text.map((t) => scrubAddresses(t)) as T;
	if (typeof text !== 'string') return text;
	return text.replace(ADDRESS_RE, '$1') as T;
}

function pick(obj: Record<string, unknown> | null | undefined, allowed: readonly string[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (!obj) return out;
	for (const k of allowed) if (k in obj) out[k] = obj[k];
	return out;
}

// nbformat output objects arrive from JSON and are mutated in place; model them
// as an open record so the field probes below type-check without over-narrowing.
type RawOutput = Record<string, unknown> & { data?: Record<string, unknown> };

function cleanOutput(output: RawOutput): RawOutput {
	if ('execution_count' in output) output.execution_count = null;

	// stream text
	if (output.output_type === 'stream' && 'text' in output) {
		output.text = scrubAddresses(output.text);
	}
	// text/plain reprs inside execute_result / display_data
	if (output.data && 'text/plain' in output.data) {
		output.data['text/plain'] = scrubAddresses(output.data['text/plain']);
	}
	// Drop the live-only DataFrame grid payload — a render of the output, never
	// persisted (keeps the .ipynb git-clean; pandas' own reprs stay as fallback).
	if (output.data && DATAFRAME_MIME in output.data) {
		delete output.data[DATAFRAME_MIME];
	}
	return output;
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
	if (cell.cell_type === 'code') {
		cell.execution_count = null;
		if (Array.isArray(cell.outputs)) cell.outputs = cell.outputs.map(cleanOutput);
	}
	// deny-by-default metadata allowlist (keeps the `cellar` namespace intact)
	cell.metadata = stripRuntimeMeta(pick(cell.metadata, ALLOWED_CELL_METADATA) as CellMetadata);
	return cell;
}

// nbformat notebook object as it arrives (from JSON or the serialize builder).
type RawNotebook = Record<string, unknown> & {
	metadata?: Record<string, unknown>;
	cells?: RawCell[];
};

/**
 * Return a cleaned deep copy of an nbformat notebook object. Pure + idempotent.
 */
export function cleanNotebook<T extends RawNotebook>(nb: T): T {
	const out = structuredClone(nb);

	const metadata = pick(out.metadata, ALLOWED_NB_METADATA);
	out.metadata = metadata;
	const kernelspec = metadata.kernelspec as { name?: string; display_name?: string } | undefined;
	if (kernelspec) {
		// display_name varies per machine; normalize it to the stable name.
		kernelspec.display_name = kernelspec.name;
	}

	out.cells = (out.cells || []).map(cleanCell);
	return out;
}
