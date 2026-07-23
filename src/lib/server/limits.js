/**
 * Cellar — the size ceilings a workspace file must clear to be OPENED in a tab
 * and SAVED back again, in ONE place so the two can never drift apart.
 *
 * They are a pair, not two independent knobs: the reader and the writer enforce
 * the SAME per-path ceiling, so a save can never land bytes the reader would
 * later refuse to reopen.
 *
 * The third limit in that story - how big a save REQUEST BODY may be - is
 * adapter-node's app-wide `BODY_SIZE_LIMIT` and deliberately does NOT live here:
 * Cellar does not raise it (see `$lib/saveLimit.ts`), it makes an over-threshold
 * document read-only instead.
 *
 * Server-only, and reached exclusively through `$lib/server` (`fstree.ts`), so it
 * rides the normal bundle into `build/` — the launcher does not import it.
 */

/** Ordinary text file ceiling: don't stream a giant file into a CodeMirror tab. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * The one deliberate exception to `MAX_FILE_BYTES`, scoped to `.html`/`.htm`.
 *
 * An HTML tab's whole point is the rendered preview of a SELF-CONTAINED export,
 * and self-contained is exactly what makes those files big: plotly's
 * `write_html(include_plotlyjs=True)` inlines the full bundle (~3.5 MB), bokeh
 * with `INLINE` resources and an nbconvert report with base64 figures clear 2 MB
 * routinely, and Cellar's own `export_html` inlines its images as data URIs. At
 * the ordinary cap the feature refuses precisely the files it exists to open. The
 * ceiling is raised, not removed — a `srcdoc` of unbounded size is still a
 * browser tab full of string.
 */
export const MAX_HTML_FILE_BYTES = 15 * 1024 * 1024;
