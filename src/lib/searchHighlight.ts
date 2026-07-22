/**
 * Search highlight mapping (Search P4) - the pure half.
 *
 * The find-bar (P3) produces a flat, document-ordered list of {@link Match}es and
 * an "active" index the user is stepping through. P4 turns those into the visual
 * layer: every match highlighted *where it appears* in a mounted cell, and the
 * active one emphasized + scrolled into view.
 *
 * This module holds only the PURE, DOM-free pieces so they can be unit-tested:
 *  - {@link buildCellHighlights} maps the flat match list onto a per-cell payload
 *    (does this cell have matches, and - if the active match lands here - which
 *    surface + which occurrence within it).
 *  - {@link findOccurrences} is the single substring/whole-word scanner the DOM
 *    highlighters (static code, rendered markdown, output) reuse to locate the
 *    query inside a mounted surface's text. It mirrors the engine's own matching
 *    ({@link module:$lib/search} `scanField`) so the highlighted spans line up with
 *    the count the find-bar shows.
 *
 * The DOM/editor mechanics live in `domHighlight.ts` (CSS Custom Highlight API) and
 * `cmSearchHighlight.ts` (a CodeMirror decoration plugin); this file never touches
 * the DOM, the model, or the kernel. Highlighting is a pure view overlay - it must
 * never mutate `cells` (mirrors the virtualization "render-only" invariant).
 */

import type { Match } from '$lib/search';

/** Which surface of a cell the query character-class treats as a word boundary. */
function isWordChar(ch: string): boolean {
	return /[\p{L}\p{N}_]/u.test(ch);
}

/** Options that affect where a literal query matches (shared with the engine). */
export interface OccurrenceOpts {
	caseSensitive: boolean;
	wholeWord: boolean;
}

/** A half-open `[start, end)` character range within some text. */
export interface Occurrence {
	start: number;
	end: number;
}

/**
 * Every occurrence of `needle` in `hay`, in order, honoring case-sensitivity and
 * whole-word. This is the literal-substring scan the three DOM highlighters share
 * to locate the query in a mounted surface's concatenated text; it matches the
 * engine's `scanField` semantics (`$lib/search`) so the highlighted spans and the
 * find-bar's count agree. Pure and allocation-frugal (case folds `hay` once).
 *
 * The find-bar deliberately does NOT re-run the notebook engine per surface - the
 * engine already told us WHICH cells/fields have matches (that drives the count and
 * navigation). This only re-locates the same literal query inside one already-
 * matched, mounted surface's visible text, which is the rendering step the model
 * offsets cannot express (rendered markdown / ANSI-stripped output text differ from
 * their model source).
 */
export function findOccurrences(hay: string, needle: string, opts: OccurrenceOpts): Occurrence[] {
	if (!needle || !hay) return [];
	const h = opts.caseSensitive ? hay : hay.toLowerCase();
	const n = opts.caseSensitive ? needle : needle.toLowerCase();
	const nLen = n.length;
	const out: Occurrence[] = [];
	let from = 0;
	let idx: number;
	while ((idx = h.indexOf(n, from)) !== -1) {
		const end = idx + nLen;
		if (opts.wholeWord) {
			const before = idx > 0 ? h[idx - 1] : '';
			const after = end < h.length ? h[end] : '';
			if ((before && isWordChar(before)) || (after && isWordChar(after))) {
				from = idx + 1;
				continue;
			}
		}
		out.push({ start: idx, end });
		from = end > idx ? end : idx + 1;
	}
	return out;
}

/** The three highlightable surfaces of a cell (matches {@link Match} `field`). */
export type HighlightField = Match['field'];

/**
 * The active match, when it lands in a given cell. `field` says which surface to
 * emphasize; `ordinal` is the 0-based position of the active match AMONG that
 * cell's matches of the same field - so a highlighter that re-locates the query in
 * that surface (in document order) can pick the same occurrence to emphasize.
 */
export interface ActiveMatch {
	field: HighlightField;
	/** Present when `field === 'output'` (the output's index in the cell). */
	outputIndex?: number;
	/** 0-based index of this match among the cell's matches of the same `field`. */
	ordinal: number;
}

/** What one cell needs to paint its highlights: presence (it has ≥1 match) + the active one. */
export interface CellHighlight {
	/** The active match if it is in THIS cell, else null. */
	active: ActiveMatch | null;
}

/**
 * The shell's shared find-in-page highlight state. The find-bar (the sole owner of
 * the search) publishes into it; each mounted `LiveNotebook` reads it and paints
 * only when it is the searched notebook (`notebookPath === path`). A single object
 * so the bar's match set is computed once and reused by the notebook it searches.
 */
export interface SearchHighlightState {
	/** The find bar is open. */
	open: boolean;
	/** Absolute-or-relative path (matched against `LiveNotebook.path`) being searched. */
	notebookPath: string | null;
	/** The settled (debounced) query. */
	query: string;
	caseSensitive: boolean;
	wholeWord: boolean;
	/** The deduped, document-ordered display matches (same list the count/nav use). */
	matches: Match[];
	/** Index into `matches` of the active (emphasized) match. */
	activeIndex: number;
}

/**
 * Map the flat, deduped display match list + the active index onto a per-cell
 * payload. A cell appears in the map iff it has ≥1 match (so a mounted cell with no
 * match does zero highlight work), and exactly one cell carries a non-null `active`.
 *
 * `ordinal` counts the active match's position among prior matches in the SAME cell
 * with the SAME field-group (`source` / `markdown` / `output`) - the ordinal a
 * document-order DOM re-scan of that surface will land on. Pure; input order (the
 * engine's document order) is preserved.
 */
export function buildCellHighlights(
	matches: readonly Match[],
	activeIndex: number
): Map<string, CellHighlight> {
	const map = new Map<string, CellHighlight>();
	for (const m of matches) if (!map.has(m.cellId)) map.set(m.cellId, { active: null });

	const am = matches[activeIndex];
	if (am) {
		let ordinal = 0;
		for (let i = 0; i < activeIndex; i++) {
			const m = matches[i];
			if (m.cellId === am.cellId && m.field === am.field) ordinal++;
		}
		const entry = map.get(am.cellId);
		if (entry)
			entry.active = {
				field: am.field,
				...(am.outputIndex !== undefined ? { outputIndex: am.outputIndex } : {}),
				ordinal
			};
	}
	return map;
}
