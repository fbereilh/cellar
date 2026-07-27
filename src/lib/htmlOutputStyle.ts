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
 * The one non-obvious rule is the last one. `white-space:nowrap` is what keeps a
 * numeric table from wrapping raggedly (paired with the table's own
 * `overflow-x`, so a wide one scrolls itself rather than spilling into a
 * document-level horizontal scroll), but the same iframe also renders arbitrary
 * `IPython.display.HTML`, where a `<table>` is sometimes a two-column *layout*.
 * There, nowrap + right-align collapses each prose cell onto one scrolled-away
 * line - measurably worse than the browser default. A cell holding block-level
 * content is a container, not a datum (a pandas cell only ever holds text), so
 * `:has()` hands those cells back normal wrapping and start alignment. It stays
 * at element specificity: `:has()` takes the specificity of its most specific
 * argument, and every argument here is a type selector.
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

table{display:block;overflow-x:auto;max-width:100%;border-collapse:collapse;border:0;font-variant-numeric:tabular-nums;}
caption{display:block;text-align:left;font-weight:600;color:#111827;padding:0 0 6px;}
th,td{padding:7px 20px;white-space:nowrap;text-align:right;border:0;border-bottom:1px solid #eef1f4;}
th{font-weight:600;color:#111827;}
thead th{border-bottom:1px solid #cbd5e1;vertical-align:bottom;}
tbody th{text-align:left;}
td:has(p,div,ul,ol,pre,table,h1,h2,h3,h4,h5,h6),th:has(p,div,ul,ol,pre,table,h1,h2,h3,h4,h5,h6){white-space:normal;text-align:left;}
`.trim();

/**
 * The selectors of every rule in a hand-written CSS block, in source order.
 *
 * Deliberately a scanner over *this* block rather than a CSS parser: the input
 * is the string above (one rule per line, no at-rules, no nesting, no strings or
 * comments inside selectors), and its only consumer is the specificity guard.
 * A comma-separated selector list yields one entry per selector.
 */
export function cssSelectors(css: string): string[] {
	const out: string[] = [];
	for (const [, prelude] of css.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
		for (const sel of prelude.split(',')) {
			const s = sel.trim();
			if (s) out.push(s);
		}
	}
	return out;
}
