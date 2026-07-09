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
 *  - drop runtime-only `cellar.lastRun` run metadata (volatile at/durationMs)
 *  - strip all notebook metadata except `kernelspec` (+ `cellar` if present);
 *    this drops `language_info` and the volatile `widgets` state
 *  - normalize `kernelspec.display_name` → `kernelspec.name`
 *  - scrub memory-address reprs (`<foo at 0x…>` → `<foo>`) in text/stream output
 *
 * MUST be idempotent: cleaning an already-clean notebook yields zero change.
 */

/** Cell-metadata keys preserved through a clean. Everything else is dropped. */
export const ALLOWED_CELL_METADATA = ['cellar'];
/** Notebook-metadata keys preserved through a clean. */
export const ALLOWED_NB_METADATA = ['kernelspec', 'cellar'];

const ADDRESS_RE = /(<[^<>]*?) at 0x[0-9a-fA-F]+(?=[>\s])/g;

/** Scrub `<... at 0x…>`-style memory addresses from a string or list of strings. */
export function scrubAddresses(text) {
	if (Array.isArray(text)) return text.map(scrubAddresses);
	if (typeof text !== 'string') return text;
	return text.replace(ADDRESS_RE, '$1');
}

function pick(obj, allowed) {
	const out = {};
	if (!obj) return out;
	for (const k of allowed) if (k in obj) out[k] = obj[k];
	return out;
}

function cleanOutput(output) {
	if ('execution_count' in output) output.execution_count = null;

	// stream text
	if (output.output_type === 'stream' && 'text' in output) {
		output.text = scrubAddresses(output.text);
	}
	// text/plain reprs inside execute_result / display_data
	if (output.data && 'text/plain' in output.data) {
		output.data['text/plain'] = scrubAddresses(output.data['text/plain']);
	}
	return output;
}

/**
 * Return a copy of cell metadata without the runtime-only `cellar.lastRun` run
 * record (volatile at/durationMs, plus the kernel-session epoch that is the sole
 * evidence a cell ran against the live namespace).
 *
 * This is one half of a two-sided forgery guard, and the two halves must stay in
 * lockstep, so they share this helper: `cleanCell` strips it on the way to disk
 * (so a run never dirties the .ipynb), and ipynb.js's `deserialize` strips it on
 * the way back in (so a hand-edited notebook cannot forge `ok_session`: epochs
 * are small monotonic integers and would otherwise be trivial to guess).
 *
 * An emptied `cellar` namespace is dropped so a foreign cell that never had one
 * stays byte-identical, preserving zero-diff-on-re-run and idempotency.
 */
export function stripLastRun(metadata) {
	const md = { ...(metadata ?? {}) };
	if (md.cellar) {
		const { lastRun, ...rest } = md.cellar;
		if (Object.keys(rest).length) md.cellar = rest;
		else delete md.cellar;
	}
	return md;
}

function cleanCell(cell) {
	if (cell.cell_type === 'code') {
		cell.execution_count = null;
		if (Array.isArray(cell.outputs)) cell.outputs = cell.outputs.map(cleanOutput);
	}
	// deny-by-default metadata allowlist (keeps the `cellar` namespace intact)
	cell.metadata = stripLastRun(pick(cell.metadata, ALLOWED_CELL_METADATA));
	return cell;
}

/**
 * Return a cleaned deep copy of an nbformat notebook object. Pure + idempotent.
 */
export function cleanNotebook(nb) {
	const out = structuredClone(nb);

	out.metadata = pick(out.metadata, ALLOWED_NB_METADATA);
	if (out.metadata.kernelspec) {
		// display_name varies per machine; normalize it to the stable name.
		out.metadata.kernelspec.display_name = out.metadata.kernelspec.name;
	}

	out.cells = (out.cells || []).map(cleanCell);
	return out;
}
