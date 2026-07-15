/**
 * Cellar — self-contained HTML export.
 *
 * Renders a notebook document (cells + persisted outputs from the `.ipynb`) to
 * ONE portable HTML file: rendered markdown, syntax-highlighted code, and every
 * saved output (text, markdown tables, and images inlined as data URIs). The
 * result opens in any browser with no Cellar server and no network — all CSS and
 * assets are inlined. It is read-only: no run controls, no editor, nothing
 * agent-facing.
 *
 * This is a deliberate, faithful re-render of the notebook MODEL rather than a
 * DOM serialization, so it mirrors exactly what `Cell.svelte` shows: the same
 * markdown-it config, the same output priority (a rich image beats the
 * `text/plain` repr), the same markdown-table-in-text detection, the same ANSI
 * scrub on tracebacks. It intentionally does NOT invent renderings Cellar lacks
 * (e.g. `text/html` DataFrames) — "looks like the notebook does in Cellar" is
 * the contract, so a DataFrame exports as its text repr, exactly as in the app.
 *
 * The exported palette reuses Cellar's #37 theme tokens verbatim (the pygments
 * "default" light scheme and One Dark), resolved per-scheme with `light-dark()`
 * and a light/dark toggle baked into the page. No external fonts, scripts, or
 * styles — a strict, offline-safe, single-file artifact.
 */
// markdown-it ships no type declarations (no @types/markdown-it); import it
// untyped and constrain the one instance we build to the single method we call.
// @ts-ignore - no declaration file for 'markdown-it'
import MarkdownIt from 'markdown-it';
import type { CellView, CellOutput } from './types';
import { listCells, getHideAllCode, resolveNotebookPath } from './notebook';

/** The minimal markdown-it surface this module uses. */
interface MarkdownRenderer {
	render(src: string): string;
}

// markdown-it in the same safe configuration Cell.svelte uses: `html:false`
// escapes any raw HTML in the source into text, so notebook content cannot
// inject markup into the exported file. That escaping is why this server-side
// path needs no DOMPurify (which would require a DOM Cellar's backend lacks).
const md: MarkdownRenderer = new MarkdownIt({ html: false, linkify: true, breaks: false });

// Payloads arrive from nbformat MIME bundles (Record<string, unknown>), so the
// coercion at this boundary is deliberate: a bundle value is normally a string
// or string[], and anything else is stringified by `?? ''` exactly as before.
const asText = (s: unknown): string =>
	Array.isArray(s) ? s.join('') : ((s ?? '') as string);

/** HTML-escape a plain-text string for safe insertion into the document. */
function esc(s: unknown): string {
	return String(s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

// Strip ANSI SGR color codes (ESC[…m) that Jupyter puts in tracebacks — same as
// Cell.svelte's `stripAnsi`.
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
const stripAnsi = (s: string): string => s.replace(ANSI, '');

// ---- Markdown tables inside plain-text output (ports Cell.svelte) -----------
const TABLE_SEP = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;
const isTableRow = (l: string): boolean => l.includes('|') && l.trim() !== '';

/** A slice of output text: either verbatim text or a rendered markdown table. */
type OutputSegment = { type: 'text'; text: string } | { type: 'table'; html: string };

function renderTable(src: string): string {
	// markdown-it emits a plain <table>; give it the same look the app applies via
	// its daisyUI table classes by styling `.export-table table` in the stylesheet.
	return md.render(src);
}

/**
 * Split output text into segments: a contiguous markdown table (header row +
 * `|---|` separator + body rows) becomes a rendered table, everything else stays
 * plain text. Mirrors Cell.svelte's `textSegments` so a printed table renders as
 * a real table and ordinary pipe-containing text is left untouched.
 */
function textSegments(text: string): OutputSegment[] {
	const lines = text.split('\n');
	const segs: OutputSegment[] = [];
	let buf: string[] = [];
	const flush = () => {
		if (buf.length) segs.push({ type: 'text', text: buf.join('\n') });
		buf = [];
	};
	for (let i = 0; i < lines.length; i++) {
		if (isTableRow(lines[i]) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('|')) {
			let j = i + 2;
			while (j < lines.length && isTableRow(lines[j])) j++;
			flush();
			segs.push({ type: 'table', html: renderTable(lines.slice(i, j).join('\n')) });
			i = j - 1;
		} else {
			buf.push(lines[i]);
		}
	}
	flush();
	return segs;
}

/** Build a data: URL for an nbformat image bundle (ports Cell.svelte). */
function imageDataUrl(mime: string, payload: unknown): string {
	const data = asText(payload);
	if (mime === 'image/svg+xml') return `data:image/svg+xml;utf8,${encodeURIComponent(data)}`;
	return `data:${mime};base64,${data.replace(/\s+/g, '')}`;
}

// ---- Python syntax highlighting ---------------------------------------------
// A compact, self-contained Python tokenizer. Code cells are always Python here,
// and reaching for CodeMirror (browser-only) or a new dependency would be the
// wrong trade for a static export. It fails safe: any character it does not
// classify is emitted as escaped plain text, so at worst a token loses its color
// — the code is always shown verbatim.

const PY_KEYWORDS = new Set([
	'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif',
	'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda',
	'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield', 'match', 'case'
]);
const PY_ATOMS = new Set(['True', 'False', 'None', 'Ellipsis', 'NotImplemented', '__debug__']);
const PY_BUILTINS = new Set([
	'abs', 'aiter', 'all', 'anext', 'any', 'ascii', 'bin', 'bool', 'breakpoint', 'bytearray', 'bytes',
	'callable', 'chr', 'classmethod', 'compile', 'complex', 'delattr', 'dict', 'dir', 'divmod',
	'enumerate', 'eval', 'exec', 'filter', 'float', 'format', 'frozenset', 'getattr', 'globals',
	'hasattr', 'hash', 'help', 'hex', 'id', 'input', 'int', 'isinstance', 'issubclass', 'iter', 'len',
	'list', 'locals', 'map', 'max', 'memoryview', 'min', 'next', 'object', 'oct', 'open', 'ord', 'pow',
	'print', 'property', 'range', 'repr', 'reversed', 'round', 'set', 'setattr', 'slice', 'sorted',
	'staticmethod', 'str', 'sum', 'super', 'tuple', 'type', 'vars', 'zip'
]);
const PY_SELF = new Set(['self', 'cls']);

const isIdentStart = (ch: string): boolean => /[A-Za-z_]/.test(ch) || ch.charCodeAt(0) > 127;
const isIdentPart = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch) || ch.charCodeAt(0) > 127;
const isDigit = (ch: string): boolean => ch >= '0' && ch <= '9';

/**
 * Tokenize a Python source string into highlighted HTML. Char-by-char scan
 * (like `imports.js`'s tokenizer) so strings and comments swallow anything that
 * would otherwise look like a keyword, and multi-line triple-quoted strings are
 * one token.
 */
function highlightPython(src: string): string {
	let out = '';
	let i = 0;
	const n = src.length;
	// Track the previous significant word so `def f`/`class C` colour the name.
	let prevWord: string | null = null;
	const span = (cls: string, text: string): string => `<span class="${cls}">${esc(text)}</span>`;

	while (i < n) {
		const ch = src[i];

		// Comment: # to end of line.
		if (ch === '#') {
			let j = i + 1;
			while (j < n && src[j] !== '\n') j++;
			out += span('tok-comment', src.slice(i, j));
			i = j;
			continue;
		}

		// String, optionally with a prefix (r, b, f, u and combinations).
		const prefixMatch = /^[rbfuRBFU]{0,3}(['"])/.exec(src.slice(i, i + 4));
		if (prefixMatch && (ch === "'" || ch === '"' || /[rbfuRBFU]/.test(ch))) {
			const quote = prefixMatch[1];
			const prefixLen = prefixMatch[0].length - 1;
			const quoteStart = i + prefixLen;
			const triple = src.slice(quoteStart, quoteStart + 3) === quote.repeat(3);
			const closer = triple ? quote.repeat(3) : quote;
			let j = quoteStart + closer.length;
			while (j < n) {
				if (src[j] === '\\' && !prefixLower(src, i, prefixLen).includes('r')) {
					j += 2;
					continue;
				}
				if (src.slice(j, j + closer.length) === closer) {
					j += closer.length;
					break;
				}
				// A single-quoted (non-triple) string never crosses a newline.
				if (!triple && src[j] === '\n') break;
				j++;
			}
			out += span('tok-string', src.slice(i, j));
			i = j;
			prevWord = null;
			continue;
		}

		// Number: int / float / hex / oct / bin / complex, with underscores.
		if (isDigit(ch) || (ch === '.' && isDigit(src[i + 1] || ''))) {
			let j = i + 1;
			while (j < n && /[0-9a-fA-FxXoObB_.eEjJ+\-]/.test(src[j])) {
				// Stop a trailing sign unless it is exponent notation (e/E just before).
				if ((src[j] === '+' || src[j] === '-') && !/[eE]/.test(src[j - 1])) break;
				j++;
			}
			out += span('tok-number', src.slice(i, j));
			i = j;
			prevWord = null;
			continue;
		}

		// Decorator: @name at a line's logical start.
		if (ch === '@' && isIdentStart(src[i + 1] || '')) {
			let j = i + 1;
			while (j < n && isIdentPart(src[j])) j++;
			out += span('tok-meta', src.slice(i, j));
			i = j;
			prevWord = null;
			continue;
		}

		// Identifier / keyword.
		if (isIdentStart(ch)) {
			let j = i + 1;
			while (j < n && isIdentPart(src[j])) j++;
			const word = src.slice(i, j);
			let cls: string;
			if (PY_KEYWORDS.has(word)) cls = 'tok-keyword';
			else if (PY_ATOMS.has(word)) cls = 'tok-atom';
			else if (prevWord === 'def') cls = 'tok-function';
			else if (prevWord === 'class') cls = 'tok-type';
			else if (PY_SELF.has(word)) cls = 'tok-self';
			else if (PY_BUILTINS.has(word)) cls = 'tok-builtin';
			else cls = 'tok-name';
			out += span(cls, word);
			prevWord = word;
			i = j;
			continue;
		}

		// Operators / punctuation.
		if (/[+\-*/%=<>!&|^~@]/.test(ch)) {
			let j = i + 1;
			while (j < n && /[+\-*/%=<>!&|^~@]/.test(src[j])) j++;
			out += span('tok-operator', src.slice(i, j));
			i = j;
			prevWord = null;
			continue;
		}

		// Whitespace keeps `prevWord` (so `def   f` still colours f); other
		// punctuation clears it. Either way the char is emitted verbatim.
		if (!/\s/.test(ch)) prevWord = null;
		out += esc(ch);
		i++;
	}
	return out;
}

/** Lowercased string prefix (for the raw-string escape check). */
function prefixLower(src: string, start: number, len: number): string {
	return src.slice(start, start + len).toLowerCase();
}

// ---- Output rendering (ports Cell.svelte's renderOutput) --------------------

function renderOutputText(tone: string, text: string): string {
	const segs = textSegments(text);
	if (segs.some((s) => s.type === 'table')) {
		let html = '';
		for (const seg of segs) {
			if (seg.type === 'table') html += `<div class="export-table">${seg.html}</div>`;
			else if (seg.text.trim()) html += `<pre class="output-text tone-${tone}">${esc(seg.text)}</pre>`;
		}
		return html;
	}
	return `<pre class="output-text tone-${tone}">${esc(text)}</pre>`;
}

function renderOutput(o: CellOutput): string {
	switch (o.output_type) {
		case 'stream': {
			const tone = o.name === 'stderr' ? 'stderr' : 'stdout';
			return renderOutputText(tone, asText(o.text));
		}
		case 'execute_result':
		case 'display_data': {
			const d = o.data || {};
			const imgMime = Object.keys(d).find((k) => k.startsWith('image/'));
			if (imgMime) {
				return `<img class="output-image" src="${esc(imageDataUrl(imgMime, d[imgMime]))}" alt="cell image output" />`;
			}
			if (d['text/plain']) return renderOutputText('result', asText(d['text/plain']));
			return `<pre class="output-text tone-result">[rich output]</pre>`;
		}
		case 'error':
			return `<pre class="output-text tone-error">${esc(stripAnsi((o.traceback || [o.ename + ': ' + o.evalue]).join('\n')))}</pre>`;
		default:
			return '';
	}
}

// ---- Cell rendering ----------------------------------------------------------

function renderMarkdownCell(cell: CellView): string {
	if (!cell.source.trim()) return '';
	// html:false makes markdown-it's output safe to inject directly.
	const html = md.render(cell.source);
	return `<section class="cell md-cell"><div class="cellar-md">${html}</div></section>`;
}

function renderCodeCell(cell: CellView, hidden: boolean): string {
	const outs = (cell.outputs || []).map(renderOutput).filter(Boolean);
	const output = outs.length ? `<div class="cell-output">${outs.join('')}</div>` : '';
	if (hidden) {
		// Report view: the code input is dropped, only the output survives. A code
		// cell with no output (an import cell, a `df = load()` with no repr)
		// contributes nothing to the report and is filtered out entirely - so a
		// hidden-code export reads as pure markdown + results.
		return output ? `<section class="cell code-cell code-hidden">${output}</section>` : '';
	}
	const code = `<div class="cell-input"><pre class="code"><code>${highlightPython(cell.source)}</code></pre></div>`;
	return `<section class="cell code-cell">${code}${output}</section>`;
}

/**
 * Whether a code cell's input is hidden in the export. Mirrors Cell.svelte's
 * `codeHidden` rule EXACTLY so the export reads like the app's report view: the
 * explicit per-cell `cellar.hide_input` wins; when unset the cell follows the
 * notebook-wide `hideAllCode` default. Markdown cells never hide.
 */
function codeIsHidden(cell: CellView, hideAllCode: boolean): boolean {
	if (cell.cell_type === 'markdown') return false;
	return cell.metadata?.cellar?.hide_input ?? hideAllCode;
}

function renderCell(cell: CellView, hideAllCode: boolean): string {
	return cell.cell_type === 'markdown'
		? renderMarkdownCell(cell)
		: renderCodeCell(cell, codeIsHidden(cell, hideAllCode));
}

/**
 * Render a notebook to a complete, self-contained HTML document.
 *
 * `hideAllCode` is the notebook-wide "hide all code inputs" (report view)
 * default: when on, every code cell renders output-only unless a cell opts back
 * in via `cellar.hide_input = false` (and any cell can force-hide via
 * `hide_input = true` regardless). This is the export coupling - a notebook read
 * as a report in Cellar exports as a clean report (markdown + outputs, no code).
 */
export function renderNotebookHtml({
	cells,
	title = 'Notebook',
	hideAllCode = false
}: {
	cells: CellView[];
	title?: string;
	hideAllCode?: boolean;
}): string {
	const body = cells.map((c) => renderCell(c, hideAllCode)).filter(Boolean).join('\n');
	const safeTitle = esc(title);
	return `<!doctype html>
<html lang="en" data-theme-mode="light">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="generator" content="Cellar" />
<title>${safeTitle}</title>
<style>${STYLES}</style>
</head>
<body>
<header class="doc-header">
	<div class="doc-title">
		<span class="doc-mark">🍷</span>
		<h1>${safeTitle}</h1>
	</div>
	<button type="button" class="theme-toggle" id="themeToggle" aria-label="Toggle light / dark">
		<span class="tt-light">☀︎ Light</span><span class="tt-dark">☾ Dark</span>
	</button>
</header>
<main class="notebook">
${body || '<p class="empty">This notebook has no cells.</p>'}
</main>
<footer class="doc-footer">Exported from Cellar · read-only snapshot of the notebook's last-run outputs</footer>
<script>${TOGGLE_SCRIPT}</script>
</body>
</html>
`;
}

/** Build a safe download filename (`<name>.html`) from a notebook path. */
export function exportFilename(nbPath?: string | null): string {
	const base = String(nbPath || 'notebook').split(/[/\\]/).pop() || 'notebook';
	return base.replace(/\.(ipynb|py)$/i, '') + '.html';
}

/** Result of {@link buildNotebookHtml}: the rendered document + its metadata. */
export interface BuiltNotebookHtml {
	/** The complete, self-contained HTML document. */
	html: string;
	/** The download filename (`<notebook-name>.html`). */
	filename: string;
	/** The report-view flag that was actually applied (the effective hide-code). */
	hideAllCode: boolean;
}

/**
 * The one render orchestration shared by BOTH the HTTP export route and the MCP
 * `export_html` tool: resolve the notebook, read its cells + persisted outputs
 * (never touching the kernel), decide report-style, and render a self-contained
 * HTML document. Keeping this single implementation is what guarantees the tool
 * and the download produce byte-identical files for the same inputs.
 *
 * `hideCode` is the report-style override: `undefined` follows the notebook's
 * saved `hide_all_code` setting (the route's default), `true`/`false` force it
 * on/off. The returned `hideAllCode` is whichever was effectively applied.
 */
export function buildNotebookHtml({
	nb,
	hideCode
}: {
	nb?: string | null;
	hideCode?: boolean;
}): BuiltNotebookHtml {
	const abs = resolveNotebookPath(nb ?? undefined);
	const cells = listCells(nb ?? undefined);
	const hideAllCode = hideCode == null ? getHideAllCode(nb ?? undefined) : hideCode;
	const filename = exportFilename(abs);
	const html = renderNotebookHtml({ cells, title: filename.replace(/\.html$/i, ''), hideAllCode });
	return { html, filename, hideAllCode };
}

// The theme toggle: default light, honour the OS scheme on first load, remember
// the visitor's choice. Tiny and inline so the file stays single-file.
const TOGGLE_SCRIPT = `(function(){
	var root=document.documentElement, btn=document.getElementById('themeToggle');
	var stored=null; try{stored=localStorage.getItem('cellar-export-theme');}catch(e){}
	var initial=stored||(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');
	root.setAttribute('data-theme-mode',initial);
	btn.addEventListener('click',function(){
		var next=root.getAttribute('data-theme-mode')==='dark'?'light':'dark';
		root.setAttribute('data-theme-mode',next);
		try{localStorage.setItem('cellar-export-theme',next);}catch(e){}
	});
})();`;

// The inlined stylesheet. The `light-dark()` tokens are the #37 palette verbatim;
// `color-scheme` is driven by `data-theme-mode` so the toggle is a plain repaint,
// exactly as in the app. Every color the export uses resolves from these tokens.
const STYLES = `
:root[data-theme-mode='light']{ color-scheme: light; }
:root[data-theme-mode='dark']{ color-scheme: dark; }
:root{
	--page: light-dark(#e7e9ee, #23272e);
	--cell: light-dark(#ffffff, #282c34);
	--output: light-dark(#ffffff, #282c34);
	--fg: light-dark(#1a1a1a, #abb2bf);
	--muted: light-dark(#5b6068, #8a919e);
	--border: light-dark(#d5d8df, #3a3f4b);
	--code-bg: light-dark(#f1f2f5, #282c34);
	--link: light-dark(#0000ff, #61afef);
	--stderr: light-dark(#8a5b00, #e5c07b);
	--result: light-dark(#1a7f37, #98c379);
	--error-fg: light-dark(#cf222e, #e06c75);
	--error-bg: light-dark(#cf222e14, #e06c7514);

	/* Syntax tokens — the #37 pygments-light / One-Dark palette, verbatim. */
	--tok-comment: light-dark(#408080, #7d8799);
	--tok-comment-style: normal;
	--tok-keyword: light-dark(#008000, #c678dd);
	--tok-keyword-weight: normal;
	--tok-string: light-dark(#ba2121, #98c379);
	--tok-number: light-dark(#666666, #e5c07b);
	--tok-atom: light-dark(#008000, #d19a66);
	--tok-atom-weight: normal;
	--tok-name: light-dark(#1a1a1a, #e06c75);
	--tok-function: light-dark(#0000ff, #61afef);
	--tok-type: light-dark(#0000ff, #e5c07b);
	--tok-type-weight: normal;
	--tok-builtin: light-dark(#008000, #d19a66);
	--tok-self: light-dark(#008000, #e5c07b);
	--tok-operator: light-dark(#666666, #56b6c2);
	--tok-meta: light-dark(#aa22ff, #e5c07b);
}
/* pygments (light) emphasises keywords / builtins / types in bold and comments
   in italic — the same non-color divergence the app keys off its scheme. */
:root[data-theme-mode='light']{
	--tok-comment-style: italic;
	--tok-keyword-weight: bold;
	--tok-atom-weight: bold;
	--tok-type-weight: bold;
}

*{ box-sizing: border-box; }
html,body{ margin:0; padding:0; }
body{
	background: var(--page);
	color: var(--fg);
	font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
	font-size: 14px;
	line-height: 1.5;
	-webkit-font-smoothing: antialiased;
}
.doc-header{
	position: sticky; top: 0; z-index: 5;
	display: flex; align-items: center; justify-content: space-between;
	gap: 1rem; padding: 0.75rem clamp(1rem, 4vw, 2.5rem);
	background: var(--cell); border-bottom: 1px solid var(--border);
}
.doc-title{ display:flex; align-items:center; gap:0.6rem; min-width:0; }
.doc-mark{ font-size:1.1rem; }
.doc-header h1{ font-size: 1.05rem; font-weight: 600; margin:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.theme-toggle{
	flex-shrink:0; cursor:pointer; font: inherit; font-size:0.8rem;
	padding:0.35rem 0.7rem; border-radius:0.5rem;
	border:1px solid var(--border); background: var(--page); color: var(--fg);
}
.theme-toggle:hover{ border-color: var(--muted); }
:root[data-theme-mode='light'] .tt-dark{ display:none; }
:root[data-theme-mode='dark'] .tt-light{ display:none; }

.notebook{
	max-width: clamp(48rem, 92%, 60rem);
	margin: 1.5rem auto; padding: 0 clamp(0.75rem, 4vw, 1.5rem);
	display: flex; flex-direction: column; gap: 0.75rem;
}
.empty{ color: var(--muted); text-align:center; padding: 3rem 0; }

.cell{
	background: var(--cell); border: 1px solid var(--border);
	border-radius: 0.6rem; overflow: hidden;
}
.md-cell{ padding: 0.5rem 1.15rem; }

.cell-input{ background: var(--code-bg); overflow-x: auto; }
pre.code{
	margin: 0; padding: 0.7rem 1rem;
	font-family: ui-monospace, 'SF Mono', Menlo, Monaco, monospace;
	font-size: 13px; line-height: 1.5; tab-size: 4;
	white-space: pre; color: var(--fg);
}
pre.code code{ font: inherit; }

.cell-output{ border-top: 1px solid var(--border); background: var(--output); padding: 0.35rem 0; }
/* Report view: an output-only (code-hidden) cell has no input above its output,
   so drop the divider that would otherwise sit at the top of the card. */
.code-hidden .cell-output{ border-top: none; }
.output-text{
	margin: 0; padding: 0.25rem 1rem 0.25rem 0.85rem;
	border-left: 2px solid transparent;
	font-family: ui-monospace, 'SF Mono', Menlo, Monaco, monospace;
	font-size: 13px; line-height: 1.45;
	white-space: pre-wrap; word-break: break-word; overflow-x: auto;
}
.output-text.tone-stderr{ color: var(--stderr); border-left-color: color-mix(in oklab, var(--stderr) 40%, transparent); }
.output-text.tone-result{ color: var(--result); font-weight: 600; border-left-color: color-mix(in oklab, var(--result) 40%, transparent); }
.output-text.tone-error{ color: var(--error-fg); background: var(--error-bg); border-left-color: var(--error-fg); }
.output-image{ display:block; max-width:100%; height:auto; padding: 0.4rem 1rem; }

.export-table{ overflow-x:auto; padding: 0.4rem 1rem; }
.export-table table{ border-collapse: collapse; font-size: 12.5px; }
.export-table th, .export-table td{ border: 1px solid var(--border); padding: 0.25em 0.6em; text-align: left; }
.export-table tbody tr:nth-child(odd){ background: color-mix(in oklab, var(--fg) 4%, transparent); }

/* Syntax token classes (produced by highlightPython). */
.tok-comment{ color: var(--tok-comment); font-style: var(--tok-comment-style); }
.tok-keyword{ color: var(--tok-keyword); font-weight: var(--tok-keyword-weight); }
.tok-string{ color: var(--tok-string); }
.tok-number{ color: var(--tok-number); }
.tok-atom{ color: var(--tok-atom); font-weight: var(--tok-atom-weight); }
.tok-name{ color: var(--tok-name); }
.tok-function{ color: var(--tok-function); }
.tok-type{ color: var(--tok-type); font-weight: var(--tok-type-weight); }
.tok-builtin{ color: var(--tok-builtin); }
.tok-self{ color: var(--tok-self); }
.tok-operator{ color: var(--tok-operator); }
.tok-meta{ color: var(--tok-meta); }

/* Rendered markdown — ports Cell.svelte's .cellar-md rules so a markdown cell
   reads identically in the export. */
.cellar-md > *:first-child{ margin-top: 0; }
.cellar-md > *:last-child{ margin-bottom: 0; }
.cellar-md :is(h1,h2,h3,h4,h5,h6){ margin: 0.5em 0 0.3em; line-height: 1.25; }
.cellar-md h1{ font-size: 1.5em; font-weight: 700; }
.cellar-md h2{ font-size: 1.3em; font-weight: 700; }
.cellar-md h3{ font-size: 1.1em; font-weight: 600; }
.cellar-md :is(h4,h5,h6){ font-size: 1em; font-weight: 600; }
.cellar-md p{ margin: 0.5em 0; }
.cellar-md ul{ list-style: disc; padding-left: 1.5em; margin: 0.5em 0; }
.cellar-md ol{ list-style: decimal; padding-left: 1.5em; margin: 0.5em 0; }
.cellar-md li{ margin: 0.2em 0; }
.cellar-md a{ color: var(--link); text-decoration: underline; }
.cellar-md code{
	font-family: ui-monospace, Menlo, monospace; font-size: 0.9em;
	background: rgba(127,127,127,0.2); padding: 0.1em 0.35em; border-radius: 0.25em;
}
.cellar-md pre{
	background: var(--code-bg); padding: 0.75em 1em; border-radius: 0.4em;
	overflow-x: auto; margin: 0.6em 0;
}
.cellar-md pre code{ background: none; padding: 0; }
.cellar-md blockquote{
	border-left: 3px solid var(--border); padding-left: 1em;
	color: var(--muted); margin: 0.6em 0;
}
.cellar-md table{ border-collapse: collapse; margin: 0.6em 0; }
.cellar-md :is(th,td){ border: 1px solid var(--border); padding: 0.3em 0.6em; }
.cellar-md img{ max-width: 100%; height: auto; }

.doc-footer{
	max-width: clamp(48rem, 92%, 60rem);
	margin: 1rem auto 2.5rem; padding: 0 clamp(0.75rem, 4vw, 1.5rem);
	color: var(--muted); font-size: 0.78rem; text-align: center;
}
`;
