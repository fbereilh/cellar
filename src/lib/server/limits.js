/**
 * Cellar — the size ceilings a workspace file must clear to be OPENED in a tab
 * and SAVED back again, in ONE place so the two can never drift apart.
 *
 * They are a pair, not two independent knobs: a file the read cap admits into an
 * editable Source view must also fit through the request body the save PUTs back,
 * or the tab offers an edit it can never persist. That is why the transport limit
 * is DERIVED from the file cap here rather than typed as a literal in the
 * launcher (see `MAX_REQUEST_BODY_BYTES`).
 *
 * Node builtins only — in fact no imports at all — so this is importable both by
 * the launcher (`../src/lib/server/limits.js`, plain node, no bundler) and by the
 * SvelteKit server (`$lib/server/limits.js`), the same rule `venv.js` follows.
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

/**
 * Ceiling for a request body, handed to adapter-node as `BODY_SIZE_LIMIT` (whose
 * own default, 512 K, rejects a save of anything past a fraction of the caps
 * above — before the route handler ever runs).
 *
 * Derived from the largest openable file with headroom, because the save PUTs
 * `JSON.stringify({path, content})`: string escaping expands the content (every
 * `"`, `\` and newline becomes two bytes — HTML is full of all three), and the
 * `path` field plus framing ride along. 2× covers that realistic worst case; a
 * limit set to the file cap exactly would refuse a file that only just fits it,
 * recreating the very defect this pairing exists to close.
 */
export const MAX_REQUEST_BODY_BYTES = MAX_HTML_FILE_BYTES * 2 + 64 * 1024;
