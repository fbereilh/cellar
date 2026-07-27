/**
 * The `<style>` block cellar injects into the sandboxed `text/html` output
 * iframe (see `HtmlOutput.svelte`'s `buildSrcdoc`).
 *
 * The iframe has no `allow-same-origin`, so the app's `app.css` cannot reach
 * inside it - whatever styling a rich HTML output gets, cellar has to inject
 * here. Without it a bare pandas Styler / `_repr_html_` table renders with the
 * browser's default 1px cell padding: technically correct, painful to scan, and
 * the reason users hand-roll a `set_table_styles` helper on every table.
 *
 * TWO RULES GOVERN THIS BLOCK, and both are load-bearing:
 *
 * 1. **Every selector stays at element-level specificity (0-0-1 / 0-0-2).**
 *    These are *defaults*, not opinions - a pandas Styler emits its own
 *    `#T_xxxx td { … }` rules (0-1-0-0, id-scoped) and `set_properties` emits
 *    per-cell `#T_xxxx_row0_col0`, so anything the user states explicitly wins
 *    the cascade with room to spare. That reproduces the mental model of the
 *    helper this replaces, which passed `overwrite=False`. Adding a class or id
 *    to a selector here would start silently beating user styling, so
 *    `tests/unit/html-output-style.test.ts` fails the build on one.
 *
 * 2. **The canvas stays a light document.** Rich HTML outputs (Styler, folium,
 *    bokeh, sklearn's estimator repr) are authored assuming a white background,
 *    so this is deliberately NOT theme-adaptive - same convention as classic
 *    Jupyter / nbconvert. See the header comment in `HtmlOutput.svelte`.
 *
 * Two consequences of rule 1 are subtle enough that an edit would undo them by
 * accident:
 *
 * **`text-align:right` sits on `table`, not on `th,td`, precisely so a user's
 * table-level rule wins.** An inherited value is only used when no declaration
 * applies to the element itself, so a cell rule would outrank ANY value the user
 * sets on an ancestor - and `df.style.set_table_styles([{'selector': '', …}])`,
 * the standard Styler idiom for aligning a whole table, emits exactly that
 * (`#T_xxxx{text-align:left}` on the table element). Declared on `table`, the two
 * meet on the same element and the id wins, then inherits down. Right stays the
 * default: it is the pandas numeric convention. Do not move it onto the cells.
 *
 * **The table stays a real table, and carries no `max-width`.** No
 * `display:block`, because that wraps the rows in an anonymous table box of
 * `width:auto` - a user's `<table width="100%">` or
 * `#T_xxxx{width:100%;table-layout:fixed}` would still apply and simply stop
 * having an effect. And no `max-width:100%` on `table`, which looks like an
 * obvious safety net and is the one declaration a user could not override: their
 * `width:1500px` is a DIFFERENT property, so no amount of id specificity beats
 * cellar's `max-width` and their columns are silently squeezed. It also buys
 * nothing - auto table layout already sizes an auto-width table as
 * `max(min-content, min(max-content, available))`, so it fits its container
 * unaided; it cannot prevent min-content overflow anyway; and a genuinely wide
 * table overflowing is the accepted design here. (The `img,svg,canvas` rule keeps
 * its own `max-width` - unrelated, and it predates this block.) Cells therefore
 * wrap normally (the pandas/Jupyter default), so a long text column reads instead
 * of scrolling; a genuinely wide table - many numeric columns, which cannot wrap
 * - overflows and scrolls the output iframe's own document. The app page never
 * scrolls sideways either way: the iframe is fixed-width and clips.
 *
 * The one non-obvious rule is the last one. The same iframe also renders
 * arbitrary `IPython.display.HTML`, where a `<table>` is sometimes a two-column
 * *layout*; there the table's right-align would inherit into each prose cell and
 * ragged-right a paragraph. A cell holding block-level content is a container,
 * not a datum (a pandas cell only ever holds text), so `:has()` hands those cells
 * back start alignment - deliberately a DIRECT rule, since it exists to beat the
 * table-level default it would otherwise inherit. It stays at element
 * specificity: `:has()` takes the specificity of its most specific argument, and
 * every argument here is a type selector.
 *
 * KNOWN LIMIT, accepted deliberately: that escape keys off BLOCK-level content
 * only, so a label/value layout table whose cells hold bare inline text (the
 * shape some libraries' `_repr_html_` emits - dask's array summary, pint,
 * awkward) takes no escape and reads right-aligned. Widening the signal with a
 * content-length heuristic was considered and REJECTED: it misfires in both
 * directions (a long id or numeric value wrongly left-aligned, a short label
 * still right-aligned). Right-align is the pandas numeric convention and the
 * intended default, and any library can style its own table - which rule 1
 * guarantees will win. Do not add a heuristic here.
 *
 * Scope note: this block only reaches *rich `text/html`* outputs. A plain
 * DataFrame renders through the native `DataFrameGrid` (structured
 * `application/vnd.cellar.dataframe+json` mime, or `dataframeHtml.ts`'s parse of
 * a saved `_repr_html_`), and markdown-cell tables are styled by `.cellar-md
 * table` in `app.css` - both are separate surfaces, untouched by this.
 */
export const OUTPUT_HTML_CSS = `
html,body{margin:0;padding:8px;background:#ffffff;color:#1f2937;font-family:system-ui,-apple-system,sans-serif;font-size:14px;}
img,svg,canvas{max-width:100%;}

table{border-collapse:collapse;border:0;text-align:right;font-variant-numeric:tabular-nums;}
caption{text-align:left;font-weight:600;color:#111827;padding:0 0 6px;}
th,td{padding:7px 20px;border:0;border-bottom:1px solid #eef1f4;}
th{font-weight:600;color:#111827;}
thead th{border-bottom:1px solid #cbd5e1;vertical-align:bottom;}
tbody th{text-align:left;}
td:has(p,div,ul,ol,pre,table,h1,h2,h3,h4,h5,h6),th:has(p,div,ul,ol,pre,table,h1,h2,h3,h4,h5,h6){text-align:left;}
`.trim();

/**
 * The selectors of every rule in a hand-written CSS block, in source order.
 *
 * Deliberately a scanner over *this* block rather than a CSS parser: the input
 * is the string above (one rule per line, no at-rules, no nesting, no strings or
 * comments inside selectors), and its only consumer is the specificity guard.
 * A comma-separated selector list yields one entry per selector.
 *
 * The split tracks paren depth, which is load-bearing rather than tidy: a
 * functional pseudo-class takes its own comma-separated argument list, so a flat
 * `split(',')` shreds `td:has(p,div,…)` into a dozen fragments with no closing
 * paren - and the guard that checks what `:has()` may contain then matches
 * nothing and silently asserts nothing at all.
 */
export function cssSelectors(css: string): string[] {
	const out: string[] = [];
	for (const [, prelude] of css.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
		let depth = 0;
		let start = 0;
		const push = (end: number) => {
			const s = prelude.slice(start, end).trim();
			if (s) out.push(s);
		};
		for (let i = 0; i < prelude.length; i++) {
			const c = prelude[i];
			if (c === '(') depth++;
			else if (c === ')') depth = Math.max(0, depth - 1);
			else if (c === ',' && depth === 0) {
				push(i);
				start = i + 1;
			}
		}
		push(prelude.length);
	}
	return out;
}
