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
//                                          `text/plain` repr.
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
//                                          markup is never pasted.
//   8. anything else                    -> ''
//
// Steps 2-4 sit in `renderOutput`'s own order (it prefers the structured payload
// over plotly/image); the two can only differ for a bundle carrying both, and
// matching what is on screen is the rule.
//
// stream output copies its text; an error copies its traceback with the ANSI SGR
// colors stripped, exactly as the cell renders it.
//
// `asText` / `stripAnsi` / `DataFramePayload` are shared with `$lib/search.ts`
// (see `$lib/outputText`), whose PRIORITY deliberately differs: search returns
// matplotlib's `<Figure …>` placeholder as searchable text where copy returns
// nothing. Decide for both before changing either.

import type { CellOutput } from '$lib/server/types';
import { asText, stripAnsi, type DataFramePayload } from '$lib/outputText';
import { parsePandasDataFrameHtml } from '$lib/dataframeHtml';

/** Cheap "is there anything here" test that does NOT materialize the joined text. */
function nonEmpty(v: unknown): boolean {
	if (Array.isArray(v)) return v.some((p) => typeof p === 'string' && p.length > 0);
	return typeof v === 'string' && v.length > 0;
}

const cellStr = (v: unknown): string => (v == null ? '' : String(v));

/** Flatten a structured DataFrame payload to a tab-separated table (index column first). */
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
 * A readable plain-text rendering of an output's `text/html`.
 *
 * Table cells become tab-separated and rows newline-separated, so a pandas
 * Styler pastes as a table. `<script>`/`<style>` bodies are dropped whole (they
 * are machinery, not output), remaining tags are removed, and entities decoded.
 * Returns `''` for markup that carries no text (an html-wrapped image, a Bokeh
 * bundle that is all script) - the caller then treats it as nothing to copy.
 */
export function htmlToPlainText(html: string): string {
	let s = html;
	// Drop non-text bodies wholesale (an unclosed tag swallows the rest, which is
	// the right answer for a truncated bundle: the tail is machinery too).
	s = s.replace(/<(script|style)\b[^>]*>[\s\S]*?(<\/\1\s*>|$)/gi, ' ');
	s = s.replace(/<!--[\s\S]*?(-->|$)/g, ' ');
	// Cell boundaries become tabs, block boundaries newlines, BEFORE tags go.
	s = s.replace(/<\/(td|th)\s*>/gi, '\t');
	s = s.replace(/<br\s*\/?>/gi, '\n');
	// Deliberately NOT thead/tbody/tfoot: each row already ended with `</tr>`, so
	// a section boundary would open a blank line in the middle of every table.
	s = s.replace(/<\/(tr|p|div|li|h[1-6]|caption|table|pre|blockquote)\s*>/gi, '\n');
	s = s.replace(/<[^>]*>/g, '');
	s = decodeEntities(s);
	// Tidy: collapse runs of spaces (HTML whitespace is not significant), drop a
	// trailing cell separator per line, and squeeze blank-line runs.
	return s
		.split('\n')
		.map((line) => line.replace(/[^\S\t\n]+/g, ' ').replace(/[ \t]+$/, '').replace(/^[ ]+/, ''))
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
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
			if (nonEmpty(d['text/html'])) {
				// A SAVED DataFrame: clean-on-save stripped the structured MIME, so this
				// pandas repr is what renderOutput itself re-parses back into the grid.
				// Same parser, same table - never a second one.
				const parsed = parsePandasDataFrameHtml(asText(d['text/html']));
				if (parsed) return dataframeTable(parsed);
			}
			if (nonEmpty(d['text/plain'])) return asText(d['text/plain']);
			if (nonEmpty(d['text/html'])) return htmlToPlainText(asText(d['text/html']));
			return '';
		}
		default:
			return '';
	}
}

/**
 * One output's contribution to the clipboard: its text with trailing whitespace
 * trimmed, so a `print()` that emitted only `"\n"` reads as the nothing it is.
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
		part = outputCopyText(o).replace(/\s+$/, '');
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
