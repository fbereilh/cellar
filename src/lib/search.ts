/**
 * Cellar in-notebook search engine (P1 source + P2 coverage).
 *
 * A pure, allocation-frugal match engine over the client model
 * `LiveNotebook.cells` (never the DOM), so search stays complete and correct
 * even once cells are windowed out of the DOM by virtualization. It returns
 * EVERY match in document order (not one-per-cell), which is what lets a caller
 * show a real `i / total` count and step match-by-match.
 *
 * ## Phasing (see `firstmate/data/cellar-search-findgrade-s4/report.md` §6)
 *  - **P1** (`scope: 'source'`): source-only substring, case-insensitive default.
 *  - **P2** (`scope: 'all'`, the default): additionally search **output text**
 *    (per-cell scan cap, {@link SEARCH_SCAN_CAP}) and **rendered-markdown text**
 *    (md syntax lightly stripped from source so a heading's *visible* words
 *    match). Model-based, so complete under virtualization. Each {@link Match}
 *    carries which `field` matched (`source` / `markdown` / `output`) so later
 *    phases can highlight the right surface.
 *  - later (`opts.regex`): the option exists on {@link SearchOpts} today; only
 *    substring / case / word / scope are honored now.
 *
 * ## The cache (the perf primitive)
 * Every keystroke used to re-`toLowerCase()` every cell's source - a fresh
 * string allocation per cell, per keystroke. Instead we key a per-cell
 * lowercased-text cache by a **cheap content signature** ({@link contentSignature}
 * = an FNV-1a hash folded with length; an integer pass, no allocation). On a
 * cache hit we reuse the already-lowercased buffer and never re-fold case; the
 * entry is rebuilt ONLY when a cell's content changes (its signature changes),
 * i.e. on edit or run. The cache is caller-owned (it lives with the notebook's
 * cell lifecycle) and passed in, so it persists across keystrokes.
 *
 * P2 extends the same discipline to the new fields: rendered-markdown is derived
 * once per source change (same signature as `sourceLC`), and output text is
 * extracted + lowercased once per outputs change (detected by the `outputs`
 * array identity - Cellar reassigns the array on run/refetch), then bounded by
 * the per-cell cap so one query can never serialize megabytes of output.
 */

import type { CellOutput } from '$lib/server/types';

/** Search options. `regex` is reserved for a later phase - not honored yet. */
export interface SearchOpts {
	/** Match case exactly. Default false (case-insensitive). */
	caseSensitive: boolean;
	/** Require word boundaries around each match. */
	wholeWord: boolean;
	/** Treat the query as a regular expression. Reserved for a later phase - not honored yet. */
	regex: boolean;
	/** `'source'` = code/markdown source only (P1). `'all'` = + outputs + rendered markdown (P2). */
	scope: 'source' | 'all';
}

/** A single match, in document order. `start`/`end` are offsets into the matched field's text. */
export interface Match {
	cellId: string;
	/** Which field of the cell the match is in. `source` (raw), `markdown` (rendered), `output`. */
	field: 'source' | 'markdown' | 'output';
	/** Index into a cell's `outputs` when `field === 'output'`. */
	outputIndex?: number;
	/** Start offset of the match within the field text. */
	start: number;
	/** End offset (exclusive) of the match within the field text. */
	end: number;
	/** 1-based line number of the match start within the field text. */
	line: number;
	/** The trimmed line containing the match, capped for display. */
	snippet: string;
}

/**
 * The default options: **`scope: 'all'`** (source + outputs + rendered markdown),
 * substring, case-insensitive. `'all'` is the captain's Q1 decision - Search
 * covers what a user actually sees on the page, with a Source/All toggle to
 * narrow back to raw source.
 */
export const DEFAULT_SEARCH_OPTS: SearchOpts = {
	caseSensitive: false,
	wholeWord: false,
	regex: false,
	scope: 'all'
};

/** Max snippet length, matching the legacy sidebar behavior. */
const SNIPPET_CAP = 80;

/**
 * Upper bound on how much of ONE cell's concatenated output text a query scans,
 * mirroring the MCP `search_cells` path (`src/lib/server/mcp/service.ts`
 * `SEARCH_SCAN_CAP`). Without it a single query over an output-heavy notebook
 * could serialize (and lowercase) megabytes per cell. A match sitting past the
 * cap inside one giant output is missed - the accepted trade - but WHICH cells
 * are scanned is unchanged, and the cap is generous enough that ordinary outputs
 * are scanned whole. Not imported from the server module (that would pull
 * server-only code into the browser bundle); kept in lockstep by value.
 */
export const SEARCH_SCAN_CAP = 100_000;

/** One extracted+lowercased output, tagged with its index in the cell's `outputs`. */
interface OutputText {
	index: number;
	text: string;
	textLC: string;
}

/** One cached, pre-lowercased view of a cell. Fields self-invalidate independently. */
interface CacheEntry {
	/** Content signature the source-derived buffers were built from (see {@link contentSignature}). */
	sig: number;
	/** `source.toLowerCase()`, computed once per content change. */
	sourceLC: string;
	/** Rendered-markdown text (md syntax stripped from source), built lazily; tied to `sig`. */
	markdown?: string;
	markdownLC?: string;
	/** True once `markdown`/`markdownLC` were computed for the current `sig`. */
	markdownBuilt: boolean;
	/** Identity of the `outputs` array the `outputs` cache was built from (invalidation key). */
	outputsRef?: readonly CellOutput[] | null;
	/** Per-output extracted+lowercased text, capped across the cell at {@link SEARCH_SCAN_CAP}. */
	outputs?: OutputText[];
}

/**
 * Per-cell searchable-text cache, keyed by cell id. Caller-owned and passed into
 * {@link searchNotebook} so it survives across keystrokes; entries self-invalidate
 * on content change (source via signature, outputs via array identity), so no
 * explicit lifecycle wiring is needed.
 */
export type SearchCache = Map<string, CacheEntry>;

/** Create an empty {@link SearchCache}. */
export function createSearchCache(): SearchCache {
	return new Map();
}

/**
 * Cheap content signature of a string: an FNV-1a 32-bit hash folded with length.
 * A single integer pass with **no allocation** - unlike `toLowerCase()`, which
 * allocates a fresh copy and does Unicode case mapping. This is what lets a
 * keystroke detect "did this cell's content change" without paying to re-lowercase it.
 */
export function contentSignature(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	// Fold length in so two different-length strings that happen to hash alike still differ.
	h ^= s.length;
	h = Math.imul(h, 0x01000193);
	return h >>> 0;
}

/** The minimal cell shape the engine reads (a subset of the UI cell / server Cell). */
interface SearchableCell {
	id: string;
	cell_type: string;
	source: string;
	/** nbformat outputs, scanned under `scope: 'all'` (code cells; markdown cells carry none). */
	outputs?: readonly CellOutput[];
}

/** Get (or refresh, on a source-content change) the cached source view of a cell. */
function entryFor(cache: SearchCache, cell: SearchableCell): CacheEntry {
	const sig = contentSignature(cell.source);
	const hit = cache.get(cell.id);
	if (hit && hit.sig === sig) return hit;
	if (hit) {
		// Source changed: refresh the source-derived fields, but leave the outputs
		// cache alone (it has its own identity-based lifecycle) - editing source
		// must not force a re-extraction of unchanged outputs.
		hit.sig = sig;
		hit.sourceLC = cell.source.toLowerCase();
		hit.markdown = undefined;
		hit.markdownLC = undefined;
		hit.markdownBuilt = false;
		return hit;
	}
	// Miss (new cell): lowercase once, store a fresh entry.
	const entry: CacheEntry = { sig, sourceLC: cell.source.toLowerCase(), markdownBuilt: false };
	cache.set(cell.id, entry);
	return entry;
}

// ---- Output text extraction (browser-safe, mirrors Cell.svelte's renderOutput) --

/** nbformat text fields are string | string[]; join a multiline array. */
function asText(v: unknown): string {
	if (Array.isArray(v)) return v.join('');
	return typeof v === 'string' ? v : v == null ? '' : String(v);
}

/** Strip ANSI SGR color codes (ESC[…m) that Jupyter puts in tracebacks. */
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(ANSI, '');

/** Cellar's structured DataFrame payload (kernel.js `application/vnd.cellar.dataframe+json`). */
interface DataFramePayload {
	columns?: unknown[];
	index?: unknown[];
	index_name?: unknown;
	data?: unknown[][];
}

/** Flatten a structured DataFrame payload to searchable text (headers + index + cell values). */
function dataframeText(df: DataFramePayload): string {
	const parts: string[] = [];
	if (Array.isArray(df.columns)) parts.push(df.columns.map(String).join(' '));
	if (df.index_name != null && df.index_name !== '') parts.push(String(df.index_name));
	if (Array.isArray(df.index)) parts.push(df.index.map(String).join(' '));
	if (Array.isArray(df.data))
		for (const row of df.data) parts.push(row.map((v) => (v == null ? '' : String(v))).join(' '));
	return parts.join('\n');
}

/**
 * The searchable text of one output, mirroring what {@link renderOutput} in
 * Cell.svelte shows as text. Rich, non-text renderings (images, plotly, raw
 * HTML with no text/plain fallback) contribute nothing searchable and return `''`.
 * A live DataFrame's structured payload is flattened so its cell values match; a
 * saved one keeps pandas' `text/plain` repr, which is also scanned.
 */
function outputSearchText(o: CellOutput): string {
	switch (o.output_type) {
		case 'stream':
			return asText(o.text);
		case 'error':
			return stripAnsi(
				(o.traceback && o.traceback.length ? o.traceback : [o.ename + ': ' + o.evalue]).join('\n')
			);
		case 'execute_result':
		case 'display_data': {
			const d = o.data || {};
			const df = d['application/vnd.cellar.dataframe+json'] as DataFramePayload | undefined;
			if (df) return dataframeText(df);
			if (d['text/plain']) return asText(d['text/plain']);
			// No text/plain fallback => a genuinely rich payload (image, iframe html,
			// widget); not text-searchable.
			return '';
		}
		default:
			return '';
	}
}

/** Build the per-cell output cache: extract + lowercase, bounded by the per-cell cap. */
function buildOutputCache(outputs: readonly CellOutput[] | null | undefined): OutputText[] {
	const out: OutputText[] = [];
	if (!outputs) return out;
	let used = 0;
	for (let i = 0; i < outputs.length; i++) {
		if (used >= SEARCH_SCAN_CAP) break;
		let text = outputSearchText(outputs[i]);
		if (!text) continue;
		const room = SEARCH_SCAN_CAP - used;
		if (text.length > room) text = text.slice(0, room);
		used += text.length;
		out.push({ index: i, text, textLC: text.toLowerCase() });
	}
	return out;
}

/** Ensure the entry's outputs cache matches the cell's current `outputs` (identity-keyed). */
function ensureOutputs(entry: CacheEntry, cell: SearchableCell): OutputText[] {
	const ref = cell.outputs ?? null;
	if (entry.outputsRef === ref && entry.outputs) return entry.outputs;
	entry.outputsRef = ref;
	entry.outputs = buildOutputCache(ref);
	return entry.outputs;
}

// ---- Rendered-markdown text (light md-syntax strip, model-based) ----------------

/**
 * Derive the *rendered* text of a markdown cell from its source by lightly
 * stripping the common md syntax, so a heading's / link's / emphasized word's
 * VISIBLE text matches (e.g. `## Setup` -> `Setup`, `[docs](url)` -> `docs`).
 * Model-based and DOM-independent by design (§5.1) - never parses/renders HTML.
 * Best-effort: it targets the syntax that hides visible words, not a full
 * CommonMark rencoding.
 */
export function strippedMarkdown(source: string): string {
	return (
		source
			// Fenced code fences: drop the ``` / ~~~ lines, keep the code text (it renders).
			.replace(/^[ \t]*(`{3,}|~{3,}).*$/gm, '')
			// Images: ![alt](url) -> alt
			.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
			// Links: [text](url) -> text
			.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
			// Reference links: [text][ref] -> text
			.replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
			// ATX headings: leading #'s (and trailing closing #'s)
			.replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
			.replace(/[ \t]+#+[ \t]*$/gm, '')
			// Blockquote markers
			.replace(/^[ \t]*>[ \t]?/gm, '')
			// Unordered list markers
			.replace(/^[ \t]*[-*+][ \t]+/gm, '')
			// Ordered list markers
			.replace(/^[ \t]*\d+\.[ \t]+/gm, '')
			// Inline code: `code` -> code
			.replace(/`([^`]*)`/g, '$1')
			// Bold/italic: **x** __x__ *x* _x_ ~~x~~ -> x
			.replace(/(\*\*|__|~~)(.*?)\1/g, '$2')
			.replace(/(\*|_)(.*?)\1/g, '$2')
	);
}

/** Ensure the entry's rendered-markdown text is built for the current source signature. */
function ensureMarkdown(entry: CacheEntry, cell: SearchableCell): void {
	if (entry.markdownBuilt) return;
	entry.markdown = strippedMarkdown(cell.source);
	entry.markdownLC = entry.markdown.toLowerCase();
	entry.markdownBuilt = true;
}

// ---- Matching ------------------------------------------------------------------

/** Is `ch` a word character (for whole-word matching)? ASCII + digits + underscore + any letter. */
function isWordChar(ch: string): boolean {
	return /[\p{L}\p{N}_]/u.test(ch);
}

/**
 * The trimmed, capped snippet for a match, given the start of its line
 * (`lineStart`, tracked by {@link scanField} in O(1)).
 *
 * Bounded: it reads at most `SNIPPET_CAP + a little` characters from `lineStart`,
 * so a pathologically long single line (e.g. a 100k-char output on one line with
 * thousands of matches) never costs O(lineLength) per match. Within that window
 * it stops at the first newline, then trims and caps - identical output to a
 * whole-line read for any realistic line, at O(SNIPPET_CAP) per match.
 */
function snippetFrom(source: string, lineStart: number): string {
	const hardEnd = Math.min(source.length, lineStart + SNIPPET_CAP + 64);
	const win = source.slice(lineStart, hardEnd);
	const nl = win.indexOf('\n');
	return (nl === -1 ? win : win.slice(0, nl)).trim().slice(0, SNIPPET_CAP);
}

/**
 * Scan one field's text for every occurrence of `needle`, appending `Match`es
 * (with the caller's `cellId`/`field`/`outputIndex`) to `out`.
 *
 * `hay` is the haystack to search (lowercased for the case-insensitive default,
 * else the original); `orig` is the original text for snippet + line extraction.
 * Case-folding preserves length for realistic scripts, so offsets into `hay` map
 * onto `orig` 1:1.
 */
function scanField(
	hay: string,
	orig: string,
	needle: string,
	needleLen: number,
	opts: SearchOpts,
	cellId: string,
	field: Match['field'],
	outputIndex: number | undefined,
	out: Match[]
): void {
	let from = 0;
	let scanned = 0; // index up to which we've counted newlines
	let line = 1;
	let lineStart = 0; // start offset of the current line (tracked with the newline count)
	let idx: number;
	while ((idx = hay.indexOf(needle, from)) !== -1) {
		const end = idx + needleLen;
		if (opts.wholeWord) {
			const before = idx > 0 ? hay[idx - 1] : '';
			const after = end < hay.length ? hay[end] : '';
			if ((before && isWordChar(before)) || (after && isWordChar(after))) {
				from = idx + 1;
				continue;
			}
		}
		// Advance the running line counter (and line-start offset) over the gap since
		// the last match - so the snippet needs no O(lineLength) backward scan.
		for (let i = scanned; i < idx; i++)
			if (hay.charCodeAt(i) === 10) {
				line++;
				lineStart = i + 1;
			}
		scanned = idx;
		out.push({
			cellId,
			field,
			...(outputIndex !== undefined ? { outputIndex } : {}),
			start: idx,
			end,
			line,
			snippet: snippetFrom(orig, lineStart)
		});
		from = end > idx ? end : idx + 1;
	}
}

/**
 * Search every cell for `query`, returning all matches in document order.
 *
 * Pure: no side effects beyond populating the caller-owned `cache`. Returns `[]`
 * for an empty query. Honors `caseSensitive`, `wholeWord`, and `scope`; `regex`
 * is reserved for a later phase. Under `scope: 'all'` (the default) a cell's
 * source, its rendered markdown (markdown cells), and its output text (bounded
 * by {@link SEARCH_SCAN_CAP} per cell) are all scanned, and each `Match` carries
 * the `field` it came from.
 *
 * @param cells document-order cells (the authoritative model, not the DOM)
 * @param query the raw query (callers trim/​debounce as a UI concern)
 * @param opts  search options (see {@link SearchOpts})
 * @param cache caller-owned {@link SearchCache}, persisted across calls
 */
export function searchNotebook(
	cells: readonly SearchableCell[],
	query: string,
	opts: SearchOpts = DEFAULT_SEARCH_OPTS,
	cache: SearchCache = createSearchCache()
): Match[] {
	if (!query) return [];
	const needle = opts.caseSensitive ? query : query.toLowerCase();
	if (!needle) return [];
	const needleLen = needle.length;
	const all = opts.scope === 'all';

	const matches: Match[] = [];
	for (const cell of cells) {
		const source = cell.source || '';
		// Only the LC path touches the cache; the source view is refreshed here so
		// the markdown/outputs helpers below share the same up-to-date entry.
		const entry = source || all ? entryFor(cache, cell) : null;

		// --- source (both scopes) ---
		if (source) {
			const hay = opts.caseSensitive ? source : entry!.sourceLC;
			scanField(hay, source, needle, needleLen, opts, cell.id, 'source', undefined, matches);
		}

		if (!all) continue;

		// --- rendered markdown (markdown cells) ---
		if (cell.cell_type === 'markdown') {
			ensureMarkdown(entry!, cell);
			const orig = entry!.markdown!;
			if (orig) {
				const hay = opts.caseSensitive ? orig : entry!.markdownLC!;
				scanField(hay, orig, needle, needleLen, opts, cell.id, 'markdown', undefined, matches);
			}
		}

		// --- output text (capped per cell) ---
		if (cell.outputs && cell.outputs.length) {
			const outs = ensureOutputs(entry!, cell);
			for (const o of outs) {
				const hay = opts.caseSensitive ? o.text : o.textLC;
				scanField(hay, o.text, needle, needleLen, opts, cell.id, 'output', o.index, matches);
			}
		}
	}
	return matches;
}

/**
 * Collapse the per-visible-occurrence double-count that {@link searchNotebook}
 * emits for markdown cells, for USER-FACING counts only (sidebar total + per-cell
 * badges). A markdown cell is scanned in BOTH its raw `source` and its rendered
 * `markdown` text (kept that way for later per-surface highlighting), so plain
 * prose - where the rendered text equals the source - matches every occurrence
 * twice. To a user that is one visible occurrence, so this drops the coinciding
 * `source` match and keeps the `markdown` one.
 *
 * Coincidence is by occurrence ORDINAL within each field: the k-th `source` match
 * pairs with the k-th `markdown` match (the matched text is the query for every
 * match, so the ordinal is the only distinguishing key). Dropping those paired
 * `source` matches leaves `max(sourceCount, markdownCount)` per cell - exactly the
 * visible-occurrence count plus any `source`-only extra (a query hidden in a link
 * URL that the rendered text strips away, which stays counted). The rendered text
 * only ever REMOVES characters from source, so a rendered occurrence with no
 * source counterpart (e.g. `a*b*c` -> `abc`) survives via the leftover, unpaired
 * `markdown` matches. Code cells (no `markdown` field) are returned untouched, so
 * source + output counts are unaffected. Pure; preserves document order.
 */
export function dedupeMatchesForDisplay(matches: readonly Match[]): Match[] {
	let anyMarkdown = false;
	const markdownCountByCell = new Map<string, number>();
	for (const m of matches)
		if (m.field === 'markdown') {
			anyMarkdown = true;
			markdownCountByCell.set(m.cellId, (markdownCountByCell.get(m.cellId) ?? 0) + 1);
		}
	if (!anyMarkdown) return matches.slice();

	const sourceSeen = new Map<string, number>();
	const out: Match[] = [];
	for (const m of matches) {
		if (m.field === 'source') {
			const md = markdownCountByCell.get(m.cellId) ?? 0;
			if (md > 0) {
				const k = sourceSeen.get(m.cellId) ?? 0;
				sourceSeen.set(m.cellId, k + 1);
				if (k < md) continue; // pairs with the k-th markdown match: one visible occurrence
			}
		}
		out.push(m);
	}
	return out;
}

/** One cell's search summary: the first match's snippet + its total match count, in document order. */
export interface CellMatchGroup {
	cellId: string;
	cellType: string;
	count: number;
	snippet: string;
	/** The field the first match came from (for a per-row surface hint). */
	field: Match['field'];
}

/**
 * Group flat {@link Match}es by cell, preserving document order (a cell first
 * appears at its first match). Powers the sidebar's list-of-cells view with a
 * per-cell match count. `cellTypeOf` supplies each cell's type for the badge.
 */
export function groupByCell(
	matches: readonly Match[],
	cellTypeOf: (cellId: string) => string
): CellMatchGroup[] {
	const groups = new Map<string, CellMatchGroup>();
	for (const m of matches) {
		let g = groups.get(m.cellId);
		if (!g) {
			g = {
				cellId: m.cellId,
				cellType: cellTypeOf(m.cellId),
				count: 0,
				snippet: m.snippet,
				field: m.field
			};
			groups.set(m.cellId, g);
		}
		g.count++;
	}
	return [...groups.values()];
}
