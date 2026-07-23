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
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isHtmlPath, hasRelativeAssetRefs } from '../../src/lib/htmlPreview';
import {
	saveBodyBytes,
	saveFitsTransport,
	parseBodySizeLimit,
	effectiveBodyLimit,
	resolveBodyLimit,
	DEFAULT_BODY_SIZE_LIMIT,
	UNLIMITED_BODY_LIMIT
} from '../../src/lib/saveLimit';
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

	// A <link>'s href is only a subresource for the relations the browser fetches
	// to RENDER the page. `canonical`/`alternate` are never fetched, and a missing
	// favicon is not a broken render — reporting them would be the over-report the
	// module's contract singles out as the one to avoid.
	it('scans a <link> href only for the relations that fetch to render', () => {
		expect(hasRelativeAssetRefs('<link rel="stylesheet" href="assets/style.css">')).toBe(true);
		expect(hasRelativeAssetRefs('<link rel="preload" as="font" href="fonts/a.woff2">')).toBe(true);
		expect(hasRelativeAssetRefs('<link rel="modulepreload" href="./app.js">')).toBe(true);
		// Order-independent (attributes are read in one pass) and multi-token rels count.
		expect(hasRelativeAssetRefs('<link href="assets/style.css" rel="stylesheet">')).toBe(true);
		expect(hasRelativeAssetRefs('<link rel="  preload  stylesheet " href="a/b.css">')).toBe(true);
		expect(hasRelativeAssetRefs('<link REL=Stylesheet HREF=a/b.css>')).toBe(true);

		for (const rel of ['canonical', 'alternate', 'icon', 'shortcut icon', 'manifest', 'author']) {
			expect(hasRelativeAssetRefs(`<link rel="${rel}" href="index.html">`)).toBe(false);
		}
		// No rel at all is unrecognized too, so it does not convict.
		expect(hasRelativeAssetRefs('<link href="index.html">')).toBe(false);
		// A non-fetching <link> never masks a real ref elsewhere.
		expect(
			hasRelativeAssetRefs('<link rel="canonical" href="index.html"><img src="figures/a.png">')
		).toBe(true);
	});

	// <template> content is parsed as markup but into an inert fragment: nothing
	// is fetched until a script clones it.
	it('ignores refs inside a <template> body', () => {
		expect(hasRelativeAssetRefs('<template><img src="figures/a.png"></template>')).toBe(false);
		expect(hasRelativeAssetRefs('<template><x></template><img src="figures/a.png">')).toBe(true);
	});

	// Under-reporting is the safe direction: these render broken with no notice,
	// which is documented at the seam rather than chased.
	it('misses srcset/poster/CSS url() by design (documented limits)', () => {
		expect(hasRelativeAssetRefs('<img srcset="images/a.png 1x">')).toBe(false);
		expect(hasRelativeAssetRefs('<video poster="thumbs/a.jpg"></video>')).toBe(false);
		expect(hasRelativeAssetRefs('<style>body{background:url(fonts/bg.png)}</style>')).toBe(false);
	});

	// An absolute <base href> rebases every relative ref, so they DO resolve inside
	// the sandbox — reporting them would be the over-report the contract rules out.
	it('is false when an absolute <base href> rebases the document', () => {
		const withBase =
			'<html><head><base href="https://cdn.example.com/report/"></head><body><img src="figures/a.png"></body></html>';
		expect(hasRelativeAssetRefs(withBase)).toBe(false);
		// The very same document without the <base> still reports.
		expect(hasRelativeAssetRefs(withBase.replace(/<base[^>]*>/, ''))).toBe(true);

		// Quoting, casing and protocol-relative forms all count as absolute.
		expect(hasRelativeAssetRefs("<base href='http://x/y/'><script src=app.js></script>")).toBe(false);
		expect(hasRelativeAssetRefs('<BASE HREF=//cdn/x/><img src="a/b.png">')).toBe(false);
		// A <base> declared AFTER the refs it rebases still suppresses (it is a
		// whole-document pre-scan, not a positional rule).
		expect(hasRelativeAssetRefs('<img src="a/b.png"><base href="https://cdn/x/">')).toBe(false);
	});

	it('still reports when a <base href> cannot rebase the refs', () => {
		// Root-relative: the app serves no such path either, so it stays a broken ref.
		expect(hasRelativeAssetRefs('<base href="/reports/"><img src="figures/a.png">')).toBe(true);
		// Folder-relative, and a <base> with no href at all.
		expect(hasRelativeAssetRefs('<base href="sub/"><img src="figures/a.png">')).toBe(true);
		expect(hasRelativeAssetRefs('<base target="_blank"><img src="figures/a.png">')).toBe(true);
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

	// `allow-downloads` is the one token this diverges from `HtmlOutput.svelte`
	// by: it grants no origin access, and without it the browser blocks plotly's
	// modebar "Download plot as PNG" on exactly the exports this preview targets.
	it('renders the file in an iframe sandboxed away from the app', () => {
		expect(iframeTag).toContain('sandbox="allow-scripts allow-popups allow-downloads"');
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

/**
 * The HTML tab's raised size ceiling. Both directions matter: the feature is
 * useless if it refuses the multi-MB self-contained exports it exists to open,
 * and the raise is worthless if it leaks into the ordinary text-file cap.
 */
describe('readWorkspaceFile size caps', () => {
	const MB = 1024 * 1024;
	let dir: string;
	let priorWorkspace: string | undefined;
	let readWorkspaceFile: (relPath: string) => string;
	let writeWorkspaceFile: (relPath: string, content: string) => void;

	const fill = (name: string, bytes: number) =>
		writeFileSync(join(dir, name), Buffer.alloc(bytes, 0x61));

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), 'cellar-fsize-'));
		priorWorkspace = process.env.CELLAR_WORKSPACE;
		process.env.CELLAR_WORKSPACE = dir;
		({ readWorkspaceFile, writeWorkspaceFile } = await import('../../src/lib/server/fstree'));
		fill('small.html', 1 * MB);
		fill('report.html', 5 * MB); // a plotly write_html(include_plotlyjs=True)
		fill('huge.html', 16 * MB);
		fill('big.txt', 3 * MB);
		fill('small.txt', 1 * MB);
	});

	afterAll(() => {
		if (priorWorkspace === undefined) delete process.env.CELLAR_WORKSPACE;
		else process.env.CELLAR_WORKSPACE = priorWorkspace;
		rmSync(dir, { recursive: true, force: true });
	});

	it('opens an HTML file between the two caps', () => {
		expect(readWorkspaceFile('report.html').length).toBe(5 * MB);
		expect(readWorkspaceFile('small.html').length).toBe(1 * MB);
	});

	it('still refuses an HTML file above the HTML cap', () => {
		expect(() => readWorkspaceFile('huge.html')).toThrow(/too large/);
	});

	// The regression that would mean the scoping failed.
	it('still refuses a non-HTML text file above the ordinary cap', () => {
		expect(() => readWorkspaceFile('big.txt')).toThrow(/too large/);
		expect(readWorkspaceFile('small.txt').length).toBe(1 * MB);
	});

	/**
	 * The write cap is the third member of the pair, and it is the SAME per-path
	 * limit: a save the reader will not reopen strands the file the moment its tab
	 * closes. The transport limit is larger than either cap on purpose, so an
	 * oversize body reaches the server and has to be refused there.
	 */
	describe('the save path mirrors it, per path kind', () => {
		it('saves what the reader will reopen', () => {
			writeWorkspaceFile('saved.html', 'a'.repeat(3 * MB));
			expect(readWorkspaceFile('saved.html').length).toBe(3 * MB);
			writeWorkspaceFile('saved.txt', 'a'.repeat(1 * MB));
			expect(readWorkspaceFile('saved.txt').length).toBe(1 * MB);
		});

		it('refuses a save past the cap, naming the limit and leaving the file alone', () => {
			writeWorkspaceFile('keep.txt', 'original');
			expect(() => writeWorkspaceFile('keep.txt', 'a'.repeat(3 * MB))).toThrow(
				/too large to save \(over the 2 MB limit\)/
			);
			// Refused BEFORE the write — a truncated file would be worse than the refusal.
			expect(readWorkspaceFile('keep.txt')).toBe('original');

			writeWorkspaceFile('keep.html', 'original');
			expect(() => writeWorkspaceFile('keep.html', 'a'.repeat(16 * MB))).toThrow(
				/too large to save \(over the 15 MB limit\)/
			);
			expect(readWorkspaceFile('keep.html')).toBe('original');
		});

		// Bytes, not characters: the ceiling the reader enforces is a file size.
		it('measures UTF-8 bytes, not string length', () => {
			expect(() => writeWorkspaceFile('multibyte.txt', '€'.repeat(MB))).toThrow(/too large to save/);
		});
	});
});

/**
 * The read cap admits far more than a save request body may carry, and that body
 * limit (adapter-node's `BODY_SIZE_LIMIT`) is app-wide - read once at module
 * load and applied upstream of every route, so it cannot be relaxed for the save
 * endpoint alone. Cellar therefore does NOT raise it: an over-threshold document
 * opens read-only and says so, and the 413 surfacing stays as the backstop for a
 * document edited past the line after it loaded.
 */
describe('save transport limit', () => {
	it('keeps the HTML read cap above the ordinary one - reading is untouched', async () => {
		const { MAX_FILE_BYTES, MAX_HTML_FILE_BYTES } = await import(
			'../../src/lib/server/limits.js'
		);
		expect(MAX_HTML_FILE_BYTES).toBeGreaterThan(MAX_FILE_BYTES);
	});

	// Source-level, like the sandbox guard: raising an app-wide body ceiling is
	// exactly the kind of change that reads as innocuous in a diff.
	it('the launcher never raises the app-wide body limit', () => {
		const src = readFileSync(join(REPO, 'bin/cellar.js'), 'utf8');
		expect(src).not.toMatch(/BODY_SIZE_LIMIT\s*:/);
		expect(src).not.toContain('MAX_REQUEST_BODY_BYTES');
	});

	// The exactness is the point: a raw-length guess would either refuse files
	// that fit or admit files the front-end 413s - and admitting one is the
	// silent failure this replaced.
	it('measures the real serialized body, byte for byte', () => {
		const cases = [
			'',
			'<h1>hi</h1>\n',
			'a "quoted" \\ backslash\r\n\tand a tab',
			' control chars',
			'ünïcödé — ✓ 中文',
			'emoji 😀 pair',
			'lone \ud800 surrogate'
		];
		for (const content of cases) {
			const body = JSON.stringify({ path: 'sub dir/report.html', content });
			expect(saveBodyBytes('sub dir/report.html', content)).toBe(
				new TextEncoder().encode(body).length
			);
		}
	});

	it('admits a document that fits the transport and refuses one that does not', () => {
		// adapter-node refuses on `content_length > limit`, so an exact fit passes.
		const frame = saveBodyBytes('a.html', '');
		const exact = 'x'.repeat(DEFAULT_BODY_SIZE_LIMIT - frame);
		expect(saveFitsTransport('a.html', exact)).toBe(true);
		expect(saveFitsTransport('a.html', exact + 'x')).toBe(false);
		// Escaping counts: a document of quotes is twice its raw length on the wire.
		const halfRaw = '"'.repeat(Math.floor((DEFAULT_BODY_SIZE_LIMIT - frame) * 0.75));
		expect(halfRaw.length).toBeLessThan(DEFAULT_BODY_SIZE_LIMIT);
		expect(saveFitsTransport('a.html', halfRaw)).toBe(false);
	});

	it('is well below the HTML read cap - a 15 MB export opens, view-only', async () => {
		const { MAX_HTML_FILE_BYTES } = await import('../../src/lib/server/limits.js');
		expect(DEFAULT_BODY_SIZE_LIMIT).toBeLessThan(MAX_HTML_FILE_BYTES);
		expect(saveFitsTransport('big.html', 'x'.repeat(3 * 1024 * 1024))).toBe(false);
		// …while an ordinary source file stays fully editable.
		expect(saveFitsTransport('src/app.ts', 'x'.repeat(64 * 1024))).toBe(true);
	});

	/**
	 * The ceiling compared against has to be the one the RUNNING server enforces.
	 * Assuming adapter-node's default was wrong in both directions: `cellar --dev`
	 * runs Vite, whose handler calls `getRequest()` with no `bodySizeLimit` at all
	 * (so nothing may be view-only there), and an operator who raises
	 * `BODY_SIZE_LIMIT` gained nothing user-visible from a value the client never
	 * saw.
	 */
	describe('effective limit', () => {
		it('parses BODY_SIZE_LIMIT exactly as adapter-node does', () => {
			expect(parseBodySizeLimit('512K')).toBe(512 * 1024);
			expect(parseBodySizeLimit('2M')).toBe(2 * 1024 * 1024);
			expect(parseBodySizeLimit('1g')).toBe(1024 * 1024 * 1024);
			expect(parseBodySizeLimit('1048576')).toBe(1048576);
			expect(parseBodySizeLimit('Infinity')).toBe(Infinity);
			// Unreadable ⇒ no opinion; adapter-node itself refuses to boot on these.
			expect(parseBodySizeLimit('lots')).toBe(null);
			expect(parseBodySizeLimit('')).toBe(null);
			expect(parseBodySizeLimit(undefined)).toBe(null);
		});

		it('reports no cap under the dev server, whatever the environment says', () => {
			expect(effectiveBodyLimit(undefined, true)).toBe(UNLIMITED_BODY_LIMIT);
			expect(effectiveBodyLimit('512K', true)).toBe(UNLIMITED_BODY_LIMIT);
		});

		it('reports the operator value in production, else the safe default', () => {
			expect(effectiveBodyLimit(undefined, false)).toBe(DEFAULT_BODY_SIZE_LIMIT);
			expect(effectiveBodyLimit('4M', false)).toBe(4 * 1024 * 1024);
			expect(effectiveBodyLimit('Infinity', false)).toBe(UNLIMITED_BODY_LIMIT);
			// A value we cannot read falls to the conservative side, never to "no cap".
			expect(effectiveBodyLimit('lots', false)).toBe(DEFAULT_BODY_SIZE_LIMIT);
		});

		it('resolves the wire value, defaulting conservatively on anything odd', () => {
			expect(resolveBodyLimit(UNLIMITED_BODY_LIMIT)).toBe(Infinity);
			expect(resolveBodyLimit(4 * 1024 * 1024)).toBe(4 * 1024 * 1024);
			// A field an older server never sent must not read as "unlimited".
			expect(resolveBodyLimit(undefined)).toBe(DEFAULT_BODY_SIZE_LIMIT);
			expect(resolveBodyLimit(null)).toBe(DEFAULT_BODY_SIZE_LIMIT);
			expect(resolveBodyLimit('4M')).toBe(DEFAULT_BODY_SIZE_LIMIT);
			expect(resolveBodyLimit(-1)).toBe(DEFAULT_BODY_SIZE_LIMIT);
		});

		it('a mid-size text file stays editable wherever the transport allows it', () => {
			// 600 KB of markdown: over adapter-node's default, but the dev server has
			// no cap and an operator can raise the production one.
			const md = '# heading\n\n'.repeat(Math.ceil((600 * 1024) / 11));
			expect(saveFitsTransport('notes.md', md, DEFAULT_BODY_SIZE_LIMIT)).toBe(false);
			expect(saveFitsTransport('notes.md', md, resolveBodyLimit(effectiveBodyLimit(undefined, true)))).toBe(
				true
			);
			expect(saveFitsTransport('notes.md', md, resolveBodyLimit(effectiveBodyLimit('4M', false)))).toBe(
				true
			);
			// The operator's ceiling still binds - it widens the range, it does not remove it.
			expect(
				saveFitsTransport('big.html', 'x'.repeat(8 * 1024 * 1024), resolveBodyLimit(effectiveBodyLimit('4M', false)))
			).toBe(false);
		});

		// Source-level: only the server can know this, so the value has to travel.
		it('the file GET carries the in-force limit to the tab', () => {
			const src = readFileSync(join(REPO, 'src/routes/api/fs/file/+server.js'), 'utf8');
			expect(src).toContain("import { dev } from '$app/environment'");
			expect(src).toContain('effectiveBodyLimit(process.env.BODY_SIZE_LIMIT, dev)');
			expect(src).toMatch(/bodyLimit:/);
		});
	});

	// The tab is where the decision is applied: read-only editor, no Save button,
	// a chip saying why - and the preview left alone.
	it('the file tab opens an over-transport document read-only, with an affordance', () => {
		const src = readFileSync(join(REPO, 'src/lib/FileTab.svelte'), 'utf8');
		expect(src).toContain("from '$lib/saveLimit'");
		// …against the limit the SERVER reports, never a client-side guess.
		expect(src).toMatch(
			/saveTooLarge = !saveFitsTransport\(path, content, resolveBodyLimit\(body\.bodyLimit\)\)/
		);
		expect(src).toContain('EditorState.readOnly.of(true)');
		expect(src).toContain('data-testid="file-view-only"');
		// Save is not merely disabled - it is absent, and the handler refuses too.
		expect(src).toMatch(/if \(saving \|\| !view \|\| saveTooLarge\) return;/);
		// The rendered preview never depends on it.
		expect(src).not.toMatch(/showPreview[^\n]*saveTooLarge/);
	});

	// A save that fails must not be silent (it used to write into a variable the
	// template only rendered for a LOAD error) and must not turn an open document
	// into an error view either.
	it('the file tab surfaces a save failure in its header, apart from load errors', () => {
		const src = readFileSync(join(REPO, 'src/lib/FileTab.svelte'), 'utf8');
		// Its own state, rendered in the header.
		expect(src).toMatch(/let saveError = \$state\(''\)/);
		expect(src).toContain('data-testid="file-save-error"');
		// The catch writes the save error, never `errorMsg`/`status` (the load view).
		const saveFn = src.slice(src.indexOf('async function save()'), src.indexOf('// ---- Git change bars'));
		expect(saveFn).toContain('saveError = String');
		expect(saveFn).not.toContain('errorMsg =');
		expect(saveFn).not.toMatch(/(^|[^.\w])status\s*=\s*['"]/);
		// Oversize is keyed off the status code, not off parsing a body that a 413
		// from the server front-end does not carry.
		expect(saveFn).toContain('res.status === 413');
		expect(saveFn).toContain('file too large to save');
		// …and it stops asserting itself once the document it described changed.
		const listener = src.slice(src.indexOf('EditorView.updateListener.of'));
		expect(listener.slice(0, listener.indexOf('})'))).toMatch(/if \(saveError\) saveError = ''/);
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
