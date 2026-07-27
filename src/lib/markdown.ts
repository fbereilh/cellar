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

// The one markdown engine Cellar uses. Shared by notebook markdown cells
// (`Cell.svelte`), the file-preview view (`MarkdownView.svelte`) and the
// markdown-table-in-output path — so every rendered surface parses identically
// and there is never a second engine to drift from. Safe mode: `html:false`
// escapes raw HTML, then DOMPurify (client-only, needs a DOM) sanitizes what
// markdown-it emits, so notebook / file content can't inject script.
export const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

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
 */
const MATH_OPTIONS: MarkdownKatexOptions & KatexOptions = {
	throwOnError: false,
	trust: false,
	strict: false
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

export function renderMarkdown(src: string | null | undefined): string {
	return DOMPurify.sanitize(md.render(src || ''), MARKDOWN_SANITIZE_CONFIG);
}
