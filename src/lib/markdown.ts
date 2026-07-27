import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';
import type { Config } from 'dompurify';
import katexPlugin from '@vscode/markdown-it-katex';
import type { MarkdownKatexOptions } from '@vscode/markdown-it-katex';
import type { KatexOptions } from 'katex';
// KaTeX's stylesheet, bundled (never a CDN): Vite emits it into the app CSS and
// rewrites its `url(fonts/KaTeX_*)` references to hashed assets it copies into
// the build, so the packaged `cellar` serves the fonts itself and math renders
// with no network access. Importing it HERE — beside the one engine that emits
// KaTeX markup — is what keeps "add a markdown surface" from also meaning
// "remember to add the math stylesheet".
import 'katex/dist/katex.min.css';

/** markdown-it in Cellar's one safe mode: `html:false` escapes raw HTML, and every
 *  render is then handed to DOMPurify by {@link sanitize} (never bypassed), so
 *  notebook / file / kernel content can't inject script. */
const newEngine = () => new MarkdownIt({ html: false, linkify: true, breaks: false });

// The markdown engine for AUTHORED PROSE: notebook markdown cells (`Cell.svelte`)
// and the `.md` file preview (`MarkdownView.svelte`). Math-enabled (see below).
// Deliberately NOT exported - every caller goes through `renderMarkdown`, so no
// surface can reach `md.render` and skip the sanitizer.
const md = newEngine();

// The engine for KERNEL OUTPUT (the markdown-table-in-output path in
// `Cell.svelte`'s `renderTable`). Same markdown-it config, same sanitizer config,
// same sanitize call site - the ONE difference is that the math plugin is not
// installed on it, and that split is by CONTENT CLASS, not renderer drift:
// kernel output is arbitrary data, and a printed DataFrame with a price column
// ("$5", "$1,200") would have its own data false-typeset as math by any $-scanner.
// Math therefore stays strictly on the authored-prose surfaces. Rendering real
// `text/latex` output is a separate feature keyed on the output's MIME type - not
// $-scanning arbitrary cells - and is deliberately not this path.
const mdOutput = newEngine();

/**
 * TeX math options, KaTeX via `@vscode/markdown-it-katex` (the plugin VS Code's
 * own markdown preview uses — maintained, markdown-it v14 compatible). KaTeX,
 * not MathJax, because it typesets at PARSE time into a static HTML+MathML tree:
 * no runtime script, which is what lets the output survive DOMPurify and Cellar's
 * script-free rendering contract.
 *
 * Delimiters are Jupyter's: `$…$` inline, `$$…$$` display. The plugin's own
 * delimiter rules are what keep currency out of math: an opening `$` may not sit
 * directly after a word character (nor after a backslash), and a CLOSING `$` may
 * not be directly followed by one. So in "it cost $5 and $10 total" the second
 * `$` cannot close — a digit follows it — and the whole line stays prose.
 * `\(…\)` / `\[…\]` are NOT supported by this plugin; `$`/`$$` is the required
 * (and Jupyter-native) set.
 *
 * KNOWN, ACCEPTED LIMITATION - a shell prompt typesets. Those rules reject a
 * closing `$` followed by a word character, but not one PRECEDED by whitespace,
 * so an unfenced paragraph of prompt lines
 *     $ npm install
 *     $ npm run build
 * parses the span between the two `$` as inline math. Jupyter behaves identically:
 * this is inherent to the `$` delimiter set, not a bug in the wiring, so it is
 * documented rather than worked around (changing the delimiters would break the
 * Jupyter-native contract this feature exists to honor). The workaround is the one
 * a user reaches for anyway, and it is pinned by test: math is NOT parsed inside an
 * inline code span (`` `$ npm install` ``) or a fenced code block, which is where
 * shell commands belong.
 *
 * The options object is spread into `katex.renderToString`, so KaTeX's own knobs
 * ride along with the plugin's:
 *  - `throwOnError:false` — an invalid formula renders KaTeX's inline red error
 *    node instead of throwing, so one bad expression can never blank a whole cell
 *    or file preview (the plugin's try/catch is a second net around that).
 *  - `trust:false` (KaTeX's default, stated explicitly because it is load-bearing)
 *    — refuses the commands that can emit raw HTML or URLs (`\href`, `\url`,
 *    `\includegraphics`, `\html*`); they render as error nodes rather than markup.
 *  - `strict:false` — a questionable-but-parseable construct renders instead of
 *    warning to the console; a notebook is not a TeX linter.
 *  - `maxSize:MATH_MAX_SIZE_EM` - caps every user-specified size (`\rule`,
 *    `\hspace`, `\genfrac`), which `trust:false` does NOT gate. A downloaded
 *    notebook (or `.md`) is untrusted input, exactly the threat model the rest of
 *    this config is written against, and `$\rule{1em}{9999em}$` at KaTeX's default
 *    of `Infinity` renders a multi-thousand-pixel node that blows out the cell or
 *    preview around it. Capped, that expression still renders - just bounded.
 *    `maxExpand` is deliberately LEFT ALONE: its default is 1000 (NOT `Infinity`),
 *    so macro-expansion DoS is already bounded; do not set it to `Infinity`.
 */
const MATH_MAX_SIZE_EM = 10;

const MATH_OPTIONS: MarkdownKatexOptions & KatexOptions = {
	throwOnError: false,
	trust: false,
	strict: false,
	maxSize: MATH_MAX_SIZE_EM
};

// `@vscode/markdown-it-katex` is CommonJS, and the two builds interop with it
// differently: Vite BUNDLES it for the browser and hands back the `.default`
// function, while SvelteKit leaves it EXTERNAL in the server build, where Node's
// own CJS interop hands back the whole `module.exports` (`{ default: fn }`).
// Taking that object as the plugin throws `plugin.apply is not a function` at
// module load, so every SSR page 500s and the app never boots — a failure the
// unit suite (Vite-bundled, like the browser) cannot see, which is why
// `tests/e2e/markdown-math.spec.ts` boots the real packaged launcher.
type KatexPlugin = typeof katexPlugin;
const mathPlugin: KatexPlugin =
	(katexPlugin as unknown as { default?: KatexPlugin }).default ?? katexPlugin;

md.use(mathPlugin, MATH_OPTIONS);

/**
 * The one sanitizer extension, and it is deliberately two tag names wide.
 *
 * KaTeX emits a `<span class="katex">` tree (already fully allowed by DOMPurify's
 * defaults, `class`/`style`/`aria-hidden` included) plus a screen-reader-only
 * MathML branch. DOMPurify's default MathML allowlist covers every element and
 * attribute KaTeX uses EXCEPT `<semantics>` and `<annotation>` — the pair that
 * carries the original TeX source alongside the presentation markup. Without
 * them DOMPurify unwraps the annotation and the raw TeX leaks into the MathML as
 * text a screen reader would read out.
 *
 * Nothing else is relaxed: no `ALLOW_UNKNOWN_PROTOCOLS`, no `ADD_ATTR`, and
 * emphatically not `annotation-xml` (an HTML integration point, and the seam
 * behind DOMPurify's known MathML mXSS vectors — KaTeX never emits it). Raw HTML
 * in the markdown source is still escaped to text upstream by `html:false`, so
 * this only ever permits KaTeX's own output tree.
 *
 * Known, accepted narrowing: DOMPurify's namespace guard drops a MathML element
 * the HTML parser re-namespaces to HTML, which happens for the `<mo><mrow>…`
 * KaTeX emits for `\mathop{\rm lim}`-style constructs. It costs that construct
 * its screen-reader text only — the visible rendering and the `<annotation>` TeX
 * are untouched, and ordinary `\lim`/`\operatorname` are unaffected. Widening the
 * allowlist to recover it would disable exactly the mXSS guard that matters.
 */
export const MARKDOWN_SANITIZE_CONFIG: Config = {
	ADD_TAGS: ['semantics', 'annotation']
};

/** The ONE sanitize call site: every renderer below funnels through it, so the
 *  config above is the whole security surface for every markdown surface. */
function sanitize(html: string): string {
	return DOMPurify.sanitize(html, MARKDOWN_SANITIZE_CONFIG);
}

/** Render AUTHORED markdown (notebook markdown cells, `.md` previews): math included. */
export function renderMarkdown(src: string | null | undefined): string {
	return sanitize(md.render(src || ''));
}

/**
 * Render markdown found in KERNEL OUTPUT (the markdown-table-in-output path) -
 * identical to {@link renderMarkdown} except that math is NOT parsed, so a `$` in
 * the user's data stays their data. See `mdOutput` above for why the split is by
 * content class rather than a second, drifting renderer.
 */
export function renderOutputMarkdown(src: string | null | undefined): string {
	return sanitize(mdOutput.render(src || ''));
}
