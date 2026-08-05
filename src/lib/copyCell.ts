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
//                                          falls through to step 6.
//   6. any OTHER `text/html`            -> tag-stripped text, table cells
//                                          tab-separated. Raw markup is never
//                                          pasted. Every row keeps its column
//                                          count whether the markup is written
//                                          compactly or pretty-printed one cell
//                                          per line, which is how a Styler's jinja
//                                          template really emits it. This OUTRANKS
//                                          `text/plain`, because html is what
//                                          renderOutput SHOWS (in a sandboxed
//                                          iframe) - and IPython attaches a
//                                          placeholder `text/plain` repr to almost
//                                          every rich object, so preferring the
//                                          repr pasted `<folium.folium.Map>` for a
//                                          map the cell renders in full. An
//                                          all-script bundle strips to nothing, so
//                                          such a cell's button ends up DISABLED -
//                                          the same honest outcome as steps 1, 3
//                                          and 4, never a placeholder.
//   7. `text/plain`                     -> that text (Jupyter's canonical plain
//                                          form). The answer for an output with no
//                                          `text/html` at all.
//   8. anything else                    -> ''
//
// Steps 2-4 sit in `renderOutput`'s own order (it prefers the structured payload
// over plotly/image); the two can only differ for a bundle carrying both, and
// matching what is on screen is the rule.
//
// ONE BOUND on step 5/6: an oversized `text/html` payload is not copyable at all
// (see {@link MAX_HTML_COPY_CHARS}).
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
// copy returns nothing, and search never looks at `text/html` AT ALL - it falls
// through to `text/plain` - where copy reads it in both of the ways above (a
// SAVED DataFrame back into the full grid table at step 5, any other rich html
// tag-stripped at step 6). So a value the grid shows but the elided repr hid is
// copyable yet not findable, and a folium map is findable by its placeholder repr
// yet not copyable. Decide for both before changing either.

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

/**
 * The size of an nbformat text field, WITHOUT materializing the joined string:
 * the field is a line ARRAY, so summing the parts is what lets the bound below be
 * checked before a multi-MB payload is ever copied into one buffer. Doubles as
 * the "is there anything here" test (`> 0`).
 *
 * Counts UTF-16 code units rather than UTF-8 bytes; output HTML is
 * ASCII-dominant, so the two agree closely enough for a size bound and a byte
 * count would need its own scan of the very payload this avoids touching.
 */
function mimeChars(v: unknown): number {
	if (typeof v === 'string') return v.length;
	if (!Array.isArray(v)) return 0;
	let n = 0;
	for (const p of v) if (typeof p === 'string') n += p.length;
	return n;
}

/**
 * Above this, a `text/html` output is treated as having no copyable text at all -
 * neither joined, nor parsed, nor converted.
 *
 * This is load-bearing, not an optimization. `hasCopyableOutput` runs inside a
 * Svelte `$derived` re-evaluated on every outputs change of every mounted cell,
 * SYNCHRONOUSLY on the cell-mount path (a jank frame while scrolling under
 * windowing) and again during SSR of the notebook page - on the single Node
 * process that also carries the kernel websockets and the SSE fan-out. Since html
 * now outranks `text/plain` (step 6 above), every rich bundle reaches this path,
 * including the ones that used to go straight to an iframe `srcdoc` unscanned.
 * The memo below bounds it to once per output object but does nothing for that
 * first hit.
 *
 * 512 KiB separates the two populations cleanly. A genuine Styler or a
 * hand-written `display(HTML(...))` table is tens of KiB, and pandas' own
 * `_repr_html_` is bounded by its display options (60 rows x 20 columns by
 * default) to about 25 KiB - three orders of magnitude of headroom. What actually
 * exceeds it is an INLINE JS BUNDLE: Bokeh's `output_notebook()` with
 * `INLINE` resources, or plotly's `include_plotlyjs=True`, both megabytes. Those
 * are all `<script>`, so they strip to nothing and would disable the button
 * anyway - the bound reaches the same verdict without the work. Same spirit as
 * the `/dataframe/i` pre-check in `$lib/dataframeHtml`: refuse cheaply, on a
 * signal that cannot be wrong about the common case.
 */
const MAX_HTML_COPY_CHARS = 512 * 1024;

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
			// NUL is refused, not merely useless in copied text: it is the marker the
			// `<pre>` placeholder below is keyed on, so decoding `&#0;` here would let
			// a payload forge a placeholder slot.
			if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
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

/** A `<pre>` body, up to its close tag (or the end of a truncated payload). */
const PRE_BLOCK = /<pre\b[^>]*>([\s\S]*?)(?:<\/pre\s*>|$)/gi;

/**
 * The sentinel a lifted `<pre>` body is parked behind while the rest of the
 * markup goes through the per-line tidy. NUL, because real output HTML never
 * carries one - and the two places that could introduce one (the raw payload,
 * and `decodeEntities` resolving `&#0;`) both refuse it, so no payload can forge
 * a slot and have someone else's `<pre>` substituted into it.
 */
const PRE_MARK = '\u0000';
const PRE_MARK_RE = /\u0000/g;
const PRE_SLOT_RE = /\u0000(\d+)\u0000/g;

/**
 * The text of a `<pre>` body: tags out, entities decoded, and NOTHING else.
 *
 * The per-line tidy in {@link htmlToPlainText} is deliberately skipped here,
 * because inside a `<pre>` whitespace is the CONTENT: collapsing space runs and
 * stripping leading indentation destroys the alignment of exactly the outputs
 * this path exists for - pygments-highlighted code (which pandas, IPython and
 * every syntax-highlighting repr emit as `<div class="highlight"><pre>`), an
 * aligned ASCII table, a `<pre>`-wrapped `to_string()`. Elsewhere HTML
 * whitespace really is insignificant, so the tidy stays as it was.
 */
function preformattedText(body: string): string {
	// A single newline straight after `<pre>` is layout, not content: the HTML
	// parser drops it, so the cell never shows it either.
	return decodeEntities(body.replace(/^\r?\n/, '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ''));
}

/**
 * A readable plain-text rendering of an output's `text/html`.
 *
 * Table cells become tab-separated and rows newline-separated, so a pandas
 * Styler pastes as a table - for pretty-printed markup as much as for markup
 * written with no whitespace between its tags (see {@link TABLE_LAYOUT_WS}).
 * `<script>`/`<style>` bodies are dropped whole (they are machinery, not
 * output), `<pre>` bodies keep their own whitespace (see
 * {@link preformattedText}), remaining tags are removed, and entities decoded.
 * Returns `''` for markup that carries no text (an html-wrapped image, a Bokeh
 * bundle that is all script, a folium map that is all script) - the caller then
 * treats it as nothing to copy, so its button is honestly disabled.
 */
export function htmlToPlainText(html: string): string {
	// NUL is the `<pre>` placeholder marker below. Real output HTML carries none,
	// and dropping any up front (with `decodeEntities` refusing to mint one) means
	// no payload can forge a placeholder slot.
	let s = html.replace(PRE_MARK_RE, '');
	// Drop non-text bodies wholesale (an unclosed tag swallows the rest, which is
	// the right answer for a truncated bundle: the tail is machinery too).
	s = s.replace(/<(script|style)\b[^>]*>[\s\S]*?(<\/\1\s*>|$)/gi, ' ');
	s = s.replace(/<!--[\s\S]*?(-->|$)/g, ' ');
	// Lift preformatted bodies out BEFORE the tidy, and put them back after it.
	// The placeholder carries the SAME trailing newline the `</pre>` it replaces
	// would have emitted below, and no leading one - so block boundaries around a
	// `<pre>` come out exactly as they did before it was lifted, with no blank line
	// opened after the paragraph in front of it.
	const pre: string[] = [];
	s = s.replace(PRE_BLOCK, (_whole, body: string) => `${PRE_MARK}${pre.push(preformattedText(body)) - 1}${PRE_MARK}\n`);
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
	// Put the preformatted bodies back, now that the tidy cannot reach their
	// whitespace. Substituted text is never re-scanned, so a `<pre>` that itself
	// looks like a slot cannot pull in another one.
	const restored = pre.length === 0 ? joined : joined.replace(PRE_SLOT_RE, (whole, i: string) => pre[Number(i)] ?? whole);
	// Drop leading blank LINES only. Not `.trim()` and not `/^\s+/`: either would
	// eat a leading TAB, and the first line of a pandas Styler starts with exactly
	// that - the separator of the blank index heading, a real (empty) first column,
	// whose loss left the header one column short of every row below it. The
	// symmetric trailing case is `trimCopyText`'s.
	return trimCopyText(restored.replace(/^\n+/, ''));
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
			// html OUTRANKS text/plain (steps 5-7 in the header): it is what the cell
			// SHOWS, and the text/plain beside it is usually IPython's placeholder repr.
			// Measured before joining, so an oversized bundle is refused without ever
			// being materialized into one buffer.
			const htmlChars = mimeChars(d['text/html']);
			if (htmlChars > 0) {
				if (htmlChars > MAX_HTML_COPY_CHARS) return '';
				// Joined ONCE, above both branches: an nbformat `text/html` is a line ARRAY,
				// so a bundle that does not parse as a DataFrame would otherwise allocate
				// the whole joined string twice on this path.
				const html = asText(d['text/html']);
				// A SAVED DataFrame: clean-on-save stripped the structured MIME, so this
				// pandas repr is what renderOutput itself re-parses back into the grid.
				// Same parser, same table - never a second one.
				const parsed = parsePandasDataFrameHtml(html);
				if (parsed) return dataframeTable(parsed);
				return htmlToPlainText(html);
			}
			if (mimeChars(d['text/plain']) > 0) return asText(d['text/plain']);
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
