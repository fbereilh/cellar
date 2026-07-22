/**
 * Cellar in-notebook search engine (P1 - the find-in-page foundation).
 *
 * A pure, allocation-frugal match engine over the client model
 * `LiveNotebook.cells` (never the DOM), so search stays complete and correct
 * even once cells are windowed out of the DOM by virtualization. It returns
 * EVERY match in document order (not one-per-cell), which is what lets a caller
 * show a real `i / total` count and step match-by-match.
 *
 * ## Phasing (see `firstmate/data/cellar-search-findgrade-s4/report.md` §6)
 * This is **P1: source-only substring, case-insensitive by default**. The shape
 * is deliberately built so later phases slot in without a rewrite:
 *  - P2 (`scope: 'all'`): output + rendered-markdown fields - the per-cell loop
 *    already dispatches per `field`, and {@link SearchCache} entries reserve
 *    `markdownLC` / `outputLC` slots.
 *  - later (`opts.regex`, `caseSensitive`, `wholeWord`): the options exist on
 *    {@link SearchOpts} today; only substring / case / word are honored now.
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
 */

/** Search options. Only substring + case + whole-word are honored in P1. */
export interface SearchOpts {
	/** Match case exactly. Default false (case-insensitive). */
	caseSensitive: boolean;
	/** Require word boundaries around each match. */
	wholeWord: boolean;
	/** Treat the query as a regular expression. Reserved for a later phase - not honored in P1. */
	regex: boolean;
	/** `'source'` = code/markdown source only (P1). `'all'` = + outputs + rendered markdown (P2). */
	scope: 'source' | 'all';
}

/** A single match, in document order. `start`/`end` are offsets into the matched field's text. */
export interface Match {
	cellId: string;
	/** Which field of the cell the match is in. P1 only ever produces `'source'`. */
	field: 'source' | 'markdown' | 'output';
	/** Index into a cell's `outputs` when `field === 'output'` (P2). */
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

/** The default P1 options: source-only, substring, case-insensitive. */
export const DEFAULT_SEARCH_OPTS: SearchOpts = {
	caseSensitive: false,
	wholeWord: false,
	regex: false,
	scope: 'source'
};

/** Max snippet length, matching the legacy sidebar behavior. */
const SNIPPET_CAP = 80;

/** One cached, pre-lowercased view of a cell, invalidated by its content signature. */
interface CacheEntry {
	/** Content signature the lowercased buffers were built from (see {@link contentSignature}). */
	sig: number;
	/** `source.toLowerCase()`, computed once per content change. */
	sourceLC: string;
	/** Reserved for P2 (`scope: 'all'`): lowercased rendered-markdown / output text. */
	markdownLC?: string;
	outputLC?: string;
}

/**
 * Per-cell searchable-text cache, keyed by cell id. Caller-owned and passed into
 * {@link searchNotebook} so it survives across keystrokes; entries self-invalidate
 * on content change via their signature, so no explicit lifecycle wiring is needed.
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
}

/** Get (or rebuild, on a content change) the cached lowercased view of a cell. */
function entryFor(cache: SearchCache, cell: SearchableCell): CacheEntry {
	const sig = contentSignature(cell.source);
	const hit = cache.get(cell.id);
	if (hit && hit.sig === sig) return hit;
	// Miss (new cell or content changed): lowercase once, store a fresh entry.
	const entry: CacheEntry = { sig, sourceLC: cell.source.toLowerCase() };
	cache.set(cell.id, entry);
	return entry;
}

/** Is `ch` a word character (for whole-word matching)? ASCII + digits + underscore + any letter. */
function isWordChar(ch: string): boolean {
	return /[\p{L}\p{N}_]/u.test(ch);
}

/** Extract the trimmed, capped line of `source` containing offset `idx`. */
function snippetAt(source: string, idx: number): string {
	let start = source.lastIndexOf('\n', idx - 1) + 1; // 0 when no preceding newline
	let end = source.indexOf('\n', idx);
	if (end === -1) end = source.length;
	return source.slice(start, end).trim().slice(0, SNIPPET_CAP);
}

/**
 * Search every cell's source for `query`, returning all matches in document order.
 *
 * Pure: no side effects beyond populating the caller-owned `cache`. Returns `[]`
 * for an empty query. P1 honors `caseSensitive` and `wholeWord`; `scope` is always
 * treated as `'source'` and `regex` is ignored (reserved for later phases).
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

	const matches: Match[] = [];
	for (const cell of cells) {
		const source = cell.source || '';
		if (!source) continue;
		// The haystack: cached lowercased buffer (case-insensitive, the default) or
		// the original source (case-sensitive). Only the LC path touches the cache;
		// case-folding preserves length for realistic scripts, so offsets into the
		// haystack map back onto `source` 1:1 for the snippet + line lookups.
		const hay = opts.caseSensitive ? source : entryFor(cache, cell).sourceLC;

		let from = 0;
		let scanned = 0; // index up to which we've counted newlines
		let line = 1;
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
			// Advance the running line counter over the gap since the last match.
			for (let i = scanned; i < idx; i++) if (hay.charCodeAt(i) === 10) line++;
			scanned = idx;
			matches.push({
				cellId: cell.id,
				field: 'source',
				start: idx,
				end,
				line,
				snippet: snippetAt(source, idx)
			});
			from = end > idx ? end : idx + 1;
		}
	}
	return matches;
}

/** One cell's search summary: the first match's snippet + its total match count, in document order. */
export interface CellMatchGroup {
	cellId: string;
	cellType: string;
	count: number;
	snippet: string;
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
			g = { cellId: m.cellId, cellType: cellTypeOf(m.cellId), count: 0, snippet: m.snippet };
			groups.set(m.cellId, g);
		}
		g.count++;
	}
	return [...groups.values()];
}
