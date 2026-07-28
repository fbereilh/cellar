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
 * SCOPE, stated as it really is: these are comfortable DEFAULTS for EVERY
 * `<table>` in a rich `text/html` output, not for pandas-shaped tables alone.
 * The reach was measured, not overlooked - a third-party `_repr_html_`
 * (statsmodels' `summary()` -> `<table class="simpletable">`, dask's array
 * summary, a folium/bokeh legend table) gets the same 7px/20px cell padding, the
 * same hairline row separators and header rule, and the same inherited
 * right-align wherever a cell holds bare inline text and so takes no `:has()`
 * escape (see the KNOWN LIMIT below). The padding is a universal scannability
 * win, and dropping the default border is precisely what declutters a bare
 * table; both are fully overridable, which is what rule 1 below exists to
 * guarantee.
 * `table{border:0}` and `th,td{border:0}` also outrank the deprecated `border=`
 * presentational attribute (author CSS always beats a presentational hint), so a
 * hand-written `display(HTML('<table border="1">…'))` loses that grid - restore
 * it with explicit CSS (a `style` attribute, or a stylesheet rule the output
 * carries), which beats this block. An author who wants a specific grid should
 * reach for explicit CSS or a pandas Styler, never the `border=` attribute.
 *
 * Two narrowings were considered and are REJECTED, so do not reintroduce them:
 * carving `border:0` back to preserve the `border=` attribute buys one legacy
 * case for a permanently more complicated rule; and scoping the block to
 * pandas-shaped tables needs a class or an id selector, which reintroduces the
 * exact specificity problem rule 1 below exists to close.
 *
 * TWO RULES GOVERN THIS BLOCK, and both are load-bearing:
 *
 * 1. **Every selector stays at element-level specificity (0-0-1 / 0-0-2).**
 *    These are *defaults*, not opinions - a pandas Styler emits its own
 *    `#T_xxxx td { … }` rules (0-1-0-0, id-scoped) and `set_properties` emits
 *    per-cell `#T_xxxx_row0_col0`, so anything the user states explicitly on the
 *    SAME element wins the cascade with room to spare (the one qualifier is the
 *    direct-declaration list below, which an id-scoped rule still beats). That
 *    reproduces the mental model of the helper this replaces, which passed
 *    `overwrite=False`. Adding a class or id to a selector here would start
 *    silently beating user styling, so
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
 * That is the rule for the DATA alignment, and it generalizes: ONE mechanism
 * bounds it, so state the mechanism once rather than re-deriving it per property.
 * A DIRECT declaration of an INHERITED property always beats an inherited value,
 * whatever the specificity - so every such declaration below on a NON-`table`
 * element sits outside the reach of the whole-table Styler idiom
 * (`set_table_styles([{'selector': '', 'props': …}])`, i.e. `#T_xxxx{…}`), which
 * moves the data cells but not these. The complete list, and why each is
 * deliberate: `tbody th{text-align:left}` (the index column reads as a label, the
 * pandas convention); `caption{text-align:left}` (a caption reads as a title - and
 * an INHERITED caption would pick up the table's numeric right-align, which is
 * worse than the thing this costs); `caption{font-weight:600}` for the same
 * title-not-datum reason; and `th{color}` / `caption{color}`, the darker ink that
 * separates a heading from its data. Every one stays overridable through the
 * id-scoped escape hatch (`#T_xxxx th{color:…}`, `#T_xxxx caption`, `#T_xxxx th`),
 * so rule 1's user-always-wins contract holds literally, not merely nearly: these
 * are documented exceptions to ONE idiom, never unbeatable rules. Keep them
 * direct; the last direct `text-align` is the `:has()` escape below, for the same
 * beat-the-inherited-default reason.
 *
 * Two of those are NOT reach cellar took away, so a future reader does not re-raise
 * them as regressions: the UA sheet already declares `th{font-weight:bold}` and
 * `caption{text-align:center}` DIRECTLY, so a table-level rule never reached either
 * property in the first place. Cellar's `th{font-weight:600}` and
 * `caption{text-align:left}` change what they look like, not what can override
 * them. The genuinely new ones are `th{color}`, `caption{color}` and
 * `caption{font-weight}`.
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
 * KNOWN LIMIT, accepted deliberately: the escape is a HARDCODED ALLOWLIST of
 * block tags (`p,div,ul,ol,pre,table,h1..h6`), not a general test for block-level
 * content, so it misfires in BOTH directions:
 *
 *   • UNDER-reach: a layout table whose prose cells use a block element that is
 *     NOT on that list (`blockquote`, `section`, `figure`, `article`, `dl`) takes
 *     no escape and reads ragged-right - and so does a label/value layout table
 *     whose cells hold bare inline text at all (the shape some libraries'
 *     `_repr_html_` emits - statsmodels' `summary()`, dask's array summary, pint,
 *     awkward). That second case is the alignment half of the scope note above.
 *
 *   • OVER-reach: a genuine DATA cell that wraps its value in a `<div>` or
 *     `<pre>` - the shape some nested HTML reprs emit, xarray/dask style - takes
 *     the escape and silently loses the numeric right-align this block exists to
 *     supply.
 *
 * Both are cosmetic and both are fully overridable (rule 1 guarantees an explicit
 * user or library rule wins), which is why the allowlist is deliberately left
 * exactly as it is rather than grown: adding the missing block tags would only
 * widen the under-reach half and would leave the over-reach half untouched.
 * Widening the signal with a content-length heuristic was considered and
 * REJECTED for the same reason, more sharply: it misfires in both directions too
 * (a long id or numeric value wrongly left-aligned, a short label still
 * right-aligned). Right-align is the pandas numeric convention and the intended
 * default, and any library can style its own table - which rule 1 guarantees will
 * win. Do not add a heuristic here.
 *
 * Surface note: this block only reaches *rich `text/html`* outputs. A plain
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
