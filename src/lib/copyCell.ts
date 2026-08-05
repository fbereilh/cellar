// The text a cell's "copy output" button puts on the clipboard.
//
// Pure and browser-safe (no DOM, no `$lib/server`), so it reads the cell MODEL -
// `cell.outputs` - never a rendered node. That is what makes the copy buttons
// windowing-safe: most of a large notebook has no DOM at all (see the cell
// virtualization entry in CLAUDE.md), so a DOM-scraping copy would silently
// return nothing for a cell that is merely scrolled away.
//
// THE RULE: copy gives you, as text, what the cell SHOWS. So the mime priority
// mirrors `renderOutput` in Cell.svelte, and each rendered form maps to its text
// equivalent - or to NOTHING when the thing on screen is not text at all:
//
//   1. an ipywidgets view (a tqdm bar)  -> ''  (live widget state, not text)
//   2. the structured DataFrame payload -> a tab-separated table. The grid is
//                                          what the cell SHOWS (up to 500 rows),
//                                          so it outranks pandas' own elided
//                                          `text/plain` repr. A TRUNCATED frame
//                                          keeps pandas' `[N rows x M columns]`
//                                          footer, the completeness signal the
//                                          grid's truncation banner gives and the
//                                          elided repr used to carry.
//   3. a plotly figure                  -> ''  (an interactive chart)
//   4. an image (matplotlib, svg)       -> ''  (a picture; deliberately NOT its
//                                              `<Figure … with N Axes>` repr,
//                                              which is a placeholder, not the
//                                              output - so an image-only cell
//                                              offers no copy-output at all)
//   5. `text/html` that PARSES as a     -> the same tab-separated table, via the
//      pandas DataFrame repr               ONE parser `$lib/dataframeHtml`. A
//                                          SAVED notebook lost the structured
//                                          MIME to clean-on-save and carries only
//                                          this repr, which is exactly how
//                                          renderOutput still shows it as a grid -
//                                          so a live and a re-opened DataFrame
//                                          copy the same shape. Browser-only
//                                          (DOMParser); outside a DOM it simply
//                                          falls through to `text/plain`.
//   6. `text/plain`                     -> that text (Jupyter's canonical plain
//                                          form). Only html that parses as a
//                                          DataFrame outranks it; for any OTHER
//                                          rich html it still wins.
//   7. `text/html`                      -> tag-stripped text, table cells
//                                          tab-separated (the pandas *Styler*
//                                          case: it emits no text/plain). Raw
//                                          markup is never pasted. Every row keeps
//                                          its column count whether the markup is
//                                          written compactly or pretty-printed one
//                                          cell per line, which is how a Styler's
//                                          jinja template really emits it.
//   8. anything else                    -> ''
//
// Steps 2-4 sit in `renderOutput`'s own order (it prefers the structured payload
// over plotly/image); the two can only differ for a bundle carrying both, and
// matching what is on screen is the rule.
//
// ONE STATED EXCEPTION to "copy gives you what the cell SHOWS": a MISSING value
// copies as a BLANK cell, where the grid draws an italic "NaN"
// (`DataFrameGrid.svelte`). Both payload sources reach it as `null` - the kernel
// formatter emits NaN -> null, and `$lib/dataframeHtml`'s `coerceCell` maps
// pandas' `NaN`/`None`/`NaT`/`<NA>` tokens to null - and `cellStr` renders that
// null as ''. Deliberate: a blank pastes into a spreadsheet as a real empty/NA
// cell, whereas the literal string "NaN" pastes as TEXT, so paste fidelity is
// worth more here than literal visual parity. Do not "fix" it back into a literal
// "NaN". Accepted cost: a missing value and a genuinely empty-string cell (which
// `coerceCell` returns as '') copy identically. The live-vs-saved parity is
// UNAFFECTED - both sources feed their nulls through this same path, so the two
// still copy the same string; only the shows-what-you-see rule has this exception.
//
// stream output copies its text; an error copies its traceback with the ANSI SGR
// colors stripped, exactly as the cell renders it.
//
// `asText` / `stripAnsi` / `DataFramePayload` are shared with `$lib/search.ts`
// (see `$lib/outputText`), whose PRIORITY deliberately differs in TWO places:
// search returns matplotlib's `<Figure …>` placeholder as searchable text where
// copy returns nothing, and for a SAVED DataFrame copy parses the pandas
// `text/html` repr back into the full grid table (step 5) where search never
// touches html and falls through to the elided `text/plain` repr. Decide for both
// before changing either.

import type { CellOutput } from '$lib/server/types';
import { asText, stripAnsi, type DataFramePayload } from '$lib/outputText';
import { parsePandasDataFrameHtml } from '$lib/dataframeHtml';

/**
 * Trailing whitespace goes, EXCEPT a trailing tab: that tab is the separator of a
 * real (empty) last column, so eating it pastes that row one column short of its
 * siblings. Text that is nothing but whitespace is nothing to copy at all, which
 * is what makes a bare `print()` (stream text `"\n"`) disable the button.
 */
function trimCopyText(s: string): string {
	if (!/\S/.test(s)) return '';
	return s.replace(/[^\S\t]+$/, '');
}

/** Cheap "is there anything here" test that does NOT materialize the joined text. */
function nonEmpty(v: unknown): boolean {
	if (Array.isArray(v)) return v.some((p) => typeof p === 'string' && p.length > 0);
	return typeof v === 'string' && v.length > 0;
}

const cellStr = (v: unknown): string => (v == null ? '' : String(v));

/**
 * A total from the payload, or the count actually present when the payload does
 * not carry a usable one. `total_rows`/`total_cols` arrive over the wire and can
 * be missing or non-numeric on a hand-edited `.ipynb`, so a value that is not a
 * finite count at least as large as what we hold is not trusted - the shown count
 * is then the honest number, never `undefined`.
 */
function totalOr(total: unknown, shown: number): number {
	return typeof total === 'number' && Number.isFinite(total) && total >= shown ? total : shown;
}

/**
 * Flatten a structured DataFrame payload to a tab-separated table (index column
 * first).
 *
 * A TRUNCATED frame gains pandas' own `[N rows x M columns]` footer line, the
 * completeness signal the on-screen grid gives as a truncation banner. It is what
 * the elided `text/plain` repr used to carry for free, before the payload started
 * outranking it - without it a 1M-row frame pastes 500 rows saying nothing. Built
 * here, in the ONE place that renders a payload, so the live kernel payload and a
 * SAVED one recovered by `$lib/dataframeHtml` copy identically. A non-truncated
 * frame gets no footer: the common case stays noise-free.
 */
function dataframeTable(df: DataFramePayload): string {
	const cols = Array.isArray(df.columns) ? df.columns.map(cellStr) : [];
	const index = Array.isArray(df.index) ? df.index : [];
	const rows = Array.isArray(df.data) ? df.data : [];
	const lines: string[] = [];
	lines.push([cellStr(df.index_name), ...cols].join('\t'));
	for (let i = 0; i < rows.length; i++) {
		const row = Array.isArray(rows[i]) ? rows[i] : [];
		lines.push([cellStr(index[i]), ...row.map(cellStr)].join('\t'));
	}
	if (df.truncated_rows || df.truncated_cols) {
		lines.push(`[${totalOr(df.total_rows, rows.length)} rows x ${totalOr(df.total_cols, cols.length)} columns]`);
	}
	return lines.join('\n');
}

// ---- HTML -> text ---------------------------------------------------------
// Deliberately a string pass, not a DOM parse: this module stays usable outside
// a browser (and in the unit suite's default node environment). It is a
// best-effort READABILITY conversion of output the app renders in a sandboxed
// iframe, never a sanitizer - nothing it produces is inserted into the page.

/** Numeric + the handful of named entities that actually show up in output HTML. */
const NAMED_ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' ',
	// pandas writes these in DataFrame reprs and Styler captions.
	times: '×',
	hellip: '…',
	mdash: '—',
	ndash: '–'
};

function decodeEntities(s: string): string {
	return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
		if (body[0] === '#') {
			const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
			if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
			try {
				return String.fromCodePoint(code);
			} catch {
				return whole;
			}
		}
		const named = NAMED_ENTITIES[body.toLowerCase()];
		return named === undefined ? whole : named;
	});
}

/**
 * Whitespace touching a TABLE-STRUCTURE tag is layout, not content: a jinja
 * templated pandas Styler (and any pretty-printed table) puts a newline plus an
 * indent between every cell, and those newlines survive the tag strip below - so
 * without this every cell landed on its own line and the "tab-separated table"
 * this function promises pasted as a single vertical column.
 *
 * Scoped to the table tags on purpose, NOT a blanket inter-tag collapse: a
 * newline between two `<span>`s IS the line break in pygments-highlighted code,
 * so collapsing those would join lines that the source really did separate.
 */
const TABLE_LAYOUT_WS = /\s*<(\/?)(table|thead|tbody|tfoot|tr|th|td|caption|colgroup|col)((?:\s[^>]*)?)>\s*/gi;

/**
 * A readable plain-text rendering of an output's `text/html`.
 *
 * Table cells become tab-separated and rows newline-separated, so a pandas
 * Styler pastes as a table - for pretty-printed markup as much as for markup
 * written with no whitespace between its tags (see {@link TABLE_LAYOUT_WS}).
 * `<script>`/`<style>` bodies are dropped whole (they are machinery, not
 * output), remaining tags are removed, and entities decoded. Returns `''` for
 * markup that carries no text (an html-wrapped image, a Bokeh bundle that is all
 * script) - the caller then treats it as nothing to copy.
 */
export function htmlToPlainText(html: string): string {
	let s = html;
	// Drop non-text bodies wholesale (an unclosed tag swallows the rest, which is
	// the right answer for a truncated bundle: the tail is machinery too).
	s = s.replace(/<(script|style)\b[^>]*>[\s\S]*?(<\/\1\s*>|$)/gi, ' ');
	s = s.replace(/<!--[\s\S]*?(-->|$)/g, ' ');
	s = s.replace(TABLE_LAYOUT_WS, '<$1$2$3>');
	// Cell boundaries become tabs, block boundaries newlines, BEFORE tags go.
	s = s.replace(/<\/(td|th)\s*>/gi, '\t');
	s = s.replace(/<br\s*\/?>/gi, '\n');
	// Deliberately NOT thead/tbody/tfoot: each row already ended with `</tr>`, so
	// a section boundary would open a blank line in the middle of every table.
	s = s.replace(/<\/(tr|p|div|li|h[1-6]|caption|table|pre|blockquote)\s*>/gi, '\n');
	s = s.replace(/<[^>]*>/g, '');
	s = decodeEntities(s);
	// Tidy: collapse runs of spaces (HTML whitespace is not significant), drop
	// EXACTLY ONE trailing cell separator per line, and squeeze blank-line runs.
	// One, not a greedy run: a row whose last cells are empty ends in several tabs
	// and every one of them but the last is a real column, so trimming them all
	// pastes that row into a spreadsheet with fewer columns than its siblings.
	const joined = s
		.split('\n')
		.map((line) => line.replace(/[^\S\t\n]+/g, ' ').replace(/ *\t? *$/, '').replace(/^[ ]+/, ''))
		.join('\n')
		.replace(/\n{3,}/g, '\n\n');
	// Drop leading blank LINES only. Not `.trim()` and not `/^\s+/`: either would
	// eat a leading TAB, and the first line of a pandas Styler starts with exactly
	// that - the separator of the blank index heading, a real (empty) first column,
	// whose loss left the header one column short of every row below it. The
	// symmetric trailing case is `trimCopyText`'s.
	return trimCopyText(joined.replace(/^\n+/, ''));
}

// ---- Per-output text ------------------------------------------------------

/** The `application/vnd.jupyter.widget-view+json` mime (a live ipywidgets model). */
const WIDGET_MIME = 'application/vnd.jupyter.widget-view+json';
const PLOTLY_MIME = 'application/vnd.plotly.v1+json';
const DATAFRAME_MIME = 'application/vnd.cellar.dataframe+json';

/**
 * The clipboard text of ONE output, per the rule in this module's header.
 * Returns `''` for an output that has no text form (image, plotly, widget).
 */
export function outputCopyText(o: CellOutput): string {
	switch (o.output_type) {
		case 'stream':
			return asText(o.text);
		case 'error':
			return stripAnsi(
				(o.traceback && o.traceback.length ? o.traceback : [`${o.ename}: ${o.evalue}`]).join('\n')
			);
		case 'execute_result':
		case 'display_data': {
			const d = o.data || {};
			if (d[WIDGET_MIME]) return '';
			const df = d[DATAFRAME_MIME] as DataFramePayload | undefined;
			if (df) return dataframeTable(df);
			if (d[PLOTLY_MIME]) return '';
			if (Object.keys(d).some((k) => k.startsWith('image/'))) return '';
			// Joined ONCE, above both branches: an nbformat `text/html` is a line ARRAY,
			// so a multi-MB Bokeh/Altair bundle that does not parse as a DataFrame would
			// otherwise allocate the whole joined string twice on this path.
			const html = nonEmpty(d['text/html']) ? asText(d['text/html']) : null;
			if (html !== null) {
				// A SAVED DataFrame: clean-on-save stripped the structured MIME, so this
				// pandas repr is what renderOutput itself re-parses back into the grid.
				// Same parser, same table - never a second one.
				const parsed = parsePandasDataFrameHtml(html);
				if (parsed) return dataframeTable(parsed);
			}
			if (nonEmpty(d['text/plain'])) return asText(d['text/plain']);
			if (html !== null) return htmlToPlainText(html);
			return '';
		}
		default:
			return '';
	}
}

/**
 * One output's contribution to the clipboard: its text through
 * {@link trimCopyText}, so a `print()` that emitted only `"\n"` reads as the
 * nothing it is while a table row ending in an empty column keeps its separator.
 *
 * MEMOIZED on the output OBJECT (a WeakMap, exactly like `renderCache` in
 * Cell.svelte and the outputs cache in `$lib/search.ts`): the enabled state below
 * is a Svelte `$derived` re-evaluated on every outputs change of every mounted
 * cell, and a streaming cell flushes ~every 40ms, so an uncached pass would re-run
 * several full-string regex passes - and a DOMParser parse - over a possibly
 * multi-MB html bundle on each one. Element identity is the right key because
 * LiveNotebook REPLACES the element object at an index rather than mutating it
 * (see `applyOutput` / `applyOutputAppend`), so a changed output misses the cache
 * and every unchanged one hits it.
 */
const partCache = new WeakMap<CellOutput, string>();
function copyPart(o: CellOutput): string {
	let part = partCache.get(o);
	if (part === undefined) {
		part = trimCopyText(outputCopyText(o));
		partCache.set(o, part);
	}
	return part;
}

/**
 * True when "copy output" has something to offer. False for no outputs at all,
 * for a cell whose every output is a picture / chart / live widget, and for one
 * whose text reduces to nothing (a bare `print()` emitting `"\n"`, a Bokeh/Altair
 * bundle that is all `<script>`), so the button is disabled rather than a silent
 * no-op.
 *
 * Decided on the CONVERTED text, which is what makes
 * `hasCopyableOutput(outs) === (copyOutputText(outs) !== '')` true by
 * construction: both read the same memoized {@link copyPart}, so the button's
 * enabled state and the click can never disagree. It stops at the first part with
 * text and never joins, so the hit path allocates nothing.
 */
export function hasCopyableOutput(outputs: readonly CellOutput[] | null | undefined): boolean {
	if (!outputs) return false;
	for (const o of outputs) if (copyPart(o) !== '') return true;
	return false;
}

/**
 * The clipboard text for a whole cell's outputs, in document order. Outputs with
 * no text form are skipped (an image beside a `print()` copies the print), and
 * the rest are joined by a blank-line-free single newline - stream output already
 * ends in `\n`, so joining raw would open a gap between every pair.
 */
export function copyOutputText(outputs: readonly CellOutput[] | null | undefined): string {
	if (!outputs) return '';
	const parts: string[] = [];
	for (const o of outputs) {
		const text = copyPart(o);
		if (text.length > 0) parts.push(text);
	}
	return parts.join('\n');
}
