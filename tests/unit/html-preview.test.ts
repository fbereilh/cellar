/**
 * HTML file tabs — the path identity + the relative-asset detection behind the
 * sandboxed preview's one-line limitation notice, plus a source-level guard on
 * the sandbox itself.
 *
 * The sandbox guard is deliberately a text assertion over `HtmlPreview.svelte`:
 * the isolation is one HTML attribute, an untrusted workspace file is what
 * renders inside it, and `allow-same-origin` next to `allow-scripts` would hand
 * that file the app's origin — silently, with nothing else failing. A test that
 * fails on the edit is the cheapest way to keep that from being a one-word
 * regression.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isHtmlPath, hasRelativeAssetRefs } from '../../src/lib/htmlPreview';
import { iconKind } from '../../src/lib/fileIcons';

const REPO = join(fileURLToPath(import.meta.url), '../../..');

describe('isHtmlPath', () => {
	it('accepts .html/.htm, case-insensitively, at any depth', () => {
		for (const p of ['a.html', 'a.htm', 'A.HTML', 'x.Htm', 'dir/sub/report.html']) {
			expect(isHtmlPath(p)).toBe(true);
		}
	});

	it('rejects everything else, including look-alikes', () => {
		for (const p of ['a.py', 'a.md', 'notes.txt', 'x.ipynb', 'index.html.j2', 'html', '.html', 'a.xhtml']) {
			expect(isHtmlPath(p)).toBe(false);
		}
	});
});

describe('hasRelativeAssetRefs', () => {
	it('is false for a self-contained export (everything inline)', () => {
		const html = `<!doctype html><html><head><style>body{color:red}</style></head>
<body><div id="plot"></div><script>window.x=1</script></body></html>`;
		expect(hasRelativeAssetRefs(html)).toBe(false);
	});

	it('is false for absolute, protocol-relative, data and fragment refs', () => {
		for (const url of [
			'https://cdn.plot.ly/plotly-2.min.js',
			'http://example.com/a.js',
			'//cdn.example.com/a.js',
			'data:text/javascript;base64,YWxlcnQoMSk=',
			'blob:https://example.com/abc',
			'#section'
		]) {
			expect(hasRelativeAssetRefs(`<script src="${url}"></script>`)).toBe(false);
			expect(hasRelativeAssetRefs(`<img src="${url}">`)).toBe(false);
		}
	});

	it('detects a folder-relative subresource (the nbconvert/plotly-directory case)', () => {
		expect(hasRelativeAssetRefs('<script src="report_files/plotly.min.js"></script>')).toBe(true);
		expect(hasRelativeAssetRefs('<script src="./main.js"></script>')).toBe(true);
		expect(hasRelativeAssetRefs('<script src="../lib/main.js"></script>')).toBe(true);
		expect(hasRelativeAssetRefs('<link rel="stylesheet" href="style.css">')).toBe(true);
		expect(hasRelativeAssetRefs('<img src="figures/fig1.png">')).toBe(true);
		expect(hasRelativeAssetRefs('<object data="chart.svg"></object>')).toBe(true);
	});

	it('detects a root-relative ref (the app serves no such path either)', () => {
		expect(hasRelativeAssetRefs('<script src="/assets/app.js"></script>')).toBe(true);
	});

	it('handles single-quoted and unquoted attribute values', () => {
		expect(hasRelativeAssetRefs("<img src='figures/a.png'>")).toBe(true);
		expect(hasRelativeAssetRefs('<img src=figures/a.png>')).toBe(true);
		expect(hasRelativeAssetRefs("<img src='https://x/a.png'>")).toBe(false);
	});

	it('ignores a plain <a href> — a link is a navigation, not a broken render', () => {
		expect(hasRelativeAssetRefs('<a href="other.html">next</a>')).toBe(false);
	});

	it('ignores an empty ref and is unfazed by odd whitespace/casing', () => {
		expect(hasRelativeAssetRefs('<img src="">')).toBe(false);
		expect(hasRelativeAssetRefs('<SCRIPT   SRC = "app.js" ></SCRIPT>')).toBe(true);
	});

	// A self-contained plotly/bokeh export inlines a minified bundle whose string
	// literals build `<img …>` markup. Reporting that as an unresolvable asset
	// would put the notice on exactly the file the preview targets.
	it('ignores markup-shaped text inside a <script> body', () => {
		expect(
			hasRelativeAssetRefs('<html><script>var t="<img src=\\""+u+"\\">";</script></html>')
		).toBe(false);
		expect(hasRelativeAssetRefs('<script>var s = \'<link href="a/b.css">\';</script>')).toBe(false);
		// The script tag's OWN attributes are still scanned.
		expect(hasRelativeAssetRefs('<script src="app/main.js">var t="<img src=\'x\'>";</script>')).toBe(
			true
		);
		// …and so is markup after the body closes.
		expect(hasRelativeAssetRefs('<script>var t="<b>";</script><img src="figures/a.png">')).toBe(
			true
		);
	});

	it('ignores markup-shaped text inside a <style> body', () => {
		expect(hasRelativeAssetRefs('<style>/* <img src="a/b.png"> */ body{color:red}</style>')).toBe(
			false
		);
		expect(hasRelativeAssetRefs('<style>body{color:red}</style><script src="a/b.js"></script>')).toBe(
			true
		);
	});

	// Same class as <script>/<style>: text a browser displays, never parses.
	it('ignores markup-shaped text inside <textarea>/<title>', () => {
		expect(hasRelativeAssetRefs('<textarea><img src="figures/a.png"></textarea>')).toBe(false);
		expect(hasRelativeAssetRefs('<title>How to &lt;img src="a/b.png"&gt;</title>')).toBe(false);
		expect(hasRelativeAssetRefs('<textarea>x</textarea><img src="figures/a.png">')).toBe(true);
	});

	it('ignores markup inside an HTML comment', () => {
		expect(
			hasRelativeAssetRefs('<!-- <script src="old/app.js"></script> --><body>hi</body>')
		).toBe(false);
		expect(hasRelativeAssetRefs('<!-- old --><img src="figures/a.png">')).toBe(true);
	});

	// `\b(?:src|href)` matches inside `data-src=`, so a lazy-loading page whose
	// real refs are absolute or inline would be misreported.
	it('does not match data-* attributes that merely end in a URL attribute name', () => {
		expect(hasRelativeAssetRefs('<img data-src="figures/a.png" src="https://x/y.png">')).toBe(false);
		expect(hasRelativeAssetRefs('<link data-href="a/b.css" href="https://x/y.css">')).toBe(false);
		expect(hasRelativeAssetRefs('<object data-data="a/b.svg" data="https://x/y.svg"></object>')).toBe(
			false
		);
		// The real attribute right beside it is still seen.
		expect(hasRelativeAssetRefs('<img data-src="https://x/y.png" src="figures/a.png">')).toBe(true);
	});

	// A tag ends at the first `>` OUTSIDE a quoted value. An inline
	// `data:image/svg+xml` URI carries a whole `<svg …></svg>`, so truncating
	// there would read the remainder as bare attributes and put the notice on
	// exactly the self-contained export this preview targets.
	it('respects quoted attribute values containing ">"', () => {
		expect(
			hasRelativeAssetRefs(
				`<img src="data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'></svg>" alt=x>`
			)
		).toBe(false);
		// A `>`-bearing attribute must not mis-anchor the <script> raw-text skip either.
		expect(hasRelativeAssetRefs(`<script data-x="a>b">var t="<img src='q/r.png'>";</script>`)).toBe(
			false
		);
		// A real relative ref beside one is still seen.
		expect(hasRelativeAssetRefs('<img alt="a>b" src="figures/a.png">')).toBe(true);
		expect(
			hasRelativeAssetRefs(
				'<img src="data:image/svg+xml;utf8,<svg></svg>"><script src="x/y.js"></script>'
			)
		).toBe(true);
	});

	// Only attribute NAMES are matched, so markup-shaped prose inside some other
	// attribute's value is not a reference.
	it('does not match a URL attribute name appearing inside another attribute value', () => {
		expect(hasRelativeAssetRefs('<img alt="pass src=foo/bar.png to it" src="https://cdn/x.png">')).toBe(
			false
		);
		expect(hasRelativeAssetRefs('<img title=\'use href="a/b.css"\' src="https://x/y.png">')).toBe(false);
	});

	// Under-reporting is the safe direction: these render broken with no notice,
	// which is documented at the seam rather than chased.
	it('misses srcset/poster/CSS url() by design (documented limits)', () => {
		expect(hasRelativeAssetRefs('<img srcset="images/a.png 1x">')).toBe(false);
		expect(hasRelativeAssetRefs('<video poster="thumbs/a.jpg"></video>')).toBe(false);
		expect(hasRelativeAssetRefs('<style>body{background:url(fonts/bg.png)}</style>')).toBe(false);
	});

	it('is stateless across calls (no scanner state survives a call)', () => {
		const relative = '<img src="a/b.png">';
		for (let i = 0; i < 5; i++) expect(hasRelativeAssetRefs(relative)).toBe(true);
		const absolute = '<img src="https://x/y.png">';
		for (let i = 0; i < 5; i++) expect(hasRelativeAssetRefs(absolute)).toBe(false);
	});
});

describe('HtmlPreview sandbox (security invariant)', () => {
	const src = readFileSync(join(REPO, 'src/lib/HtmlPreview.svelte'), 'utf8');
	const iframeTag = src.slice(src.indexOf('<iframe'), src.indexOf('></iframe>'));

	it('renders the file in an iframe sandboxed away from the app', () => {
		expect(iframeTag).toContain('sandbox="allow-scripts allow-popups"');
	});

	// Scoped to the tag, not the file: the module comment names `allow-same-origin`
	// precisely to warn the next reader off it.
	it('never grants allow-same-origin (that would hand the file the app origin)', () => {
		expect(iframeTag).not.toContain('allow-same-origin');
	});

	it('renders through srcdoc, so the app never serves workspace HTML from its origin', () => {
		expect(iframeTag).toContain('srcdoc={source}');
		expect(iframeTag).not.toMatch(/\bsrc=/);
	});
});

describe('file icons', () => {
	it('gives .html/.htm their own icon kind', () => {
		expect(iconKind('report.html')).toBe('html');
		expect(iconKind('index.HTM')).toBe('html');
		expect(iconKind('notes.md')).toBe('markdown');
		expect(iconKind('mystery.bin')).toBe('file');
	});
});
