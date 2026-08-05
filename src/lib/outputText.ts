// The small primitives every "what does this output say, as text?" reader shares.
//
// Pure and browser-safe (no DOM, no `$lib/server`), because every consumer reads
// the cell MODEL (`cell.outputs`) rather than a rendered node - that is what keeps
// them complete under windowing, where most of a large notebook has no DOM at all.
//
// Two consumers today - `$lib/search.ts` (what an output contributes to
// find-in-page) and `$lib/copyCell.ts` (what "copy output" puts on the clipboard).
// They share these primitives and deliberately DIVERGE on PRIORITY, in exactly two
// places today:
//
//   1. A PICTURE / chart / live widget. Search returns matplotlib's
//      `<Figure … with N Axes>` `text/plain` placeholder, because a user searching
//      for "Figure" should still land on that cell; copy returns NOTHING,
//      precisely so an image-only cell's copy button is honestly disabled instead
//      of pasting a placeholder.
//   2. A SAVED DataFrame. Clean-on-save strips the structured
//      `application/vnd.cellar.dataframe+json` MIME, leaving only pandas'
//      `text/html` repr - which copy parses back into the full grid table (via
//      `$lib/dataframeHtml`), while search never looks at html at all and falls
//      through to the elided `text/plain` repr. So a value that the grid shows but
//      the repr elided is copyable yet NOT findable by Ctrl+F. The search side
//      here is PRE-EXISTING and unchanged - this is a known gap, not a regression
//      and not something already fixed; closing it would put a DOMParser parse on
//      the search hot path, which is its own piece of work.
//
// So a change to "what counts as an output's text" may well belong in only one of
// them - but check BOTH before deciding, and keep these shared helpers here so the
// mechanical half (joining nbformat's line arrays, stripping ANSI) can never drift.

/** nbformat text fields are `string | string[]`; join a multiline array. */
export function asText(v: unknown): string {
	if (Array.isArray(v)) return v.join('');
	return typeof v === 'string' ? v : v == null ? '' : String(v);
}

/** ANSI SGR color codes (ESC[…m) - Jupyter puts them in tracebacks. */
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

/** Strip ANSI SGR color codes, so a copied/searched traceback is plain text. */
export const stripAnsi = (s: string): string => s.replace(ANSI, '');

/**
 * Cellar's structured DataFrame payload (kernel.js
 * `application/vnd.cellar.dataframe+json`), read loosely: every field is optional
 * and untyped because it arrives over the wire. `$lib/dataframeHtml`'s parsed
 * payload (the same shape, fully populated) is assignable to it.
 */
export interface DataFramePayload {
	columns?: unknown[];
	index?: unknown[];
	index_name?: unknown;
	data?: unknown[][];
	/**
	 * The completeness half: both sources populate it (the kernel formatter caps at
	 * 500 rows x 100 cols; `$lib/dataframeHtml` recovers the totals from pandas'
	 * own `N rows x M columns` footer). Untyped like the rest - a hand-edited
	 * `.ipynb` can carry anything here, so a reader must validate before printing.
	 */
	total_rows?: unknown;
	total_cols?: unknown;
	truncated_rows?: unknown;
	truncated_cols?: unknown;
}
