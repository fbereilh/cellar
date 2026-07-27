// @vitest-environment jsdom
//
// TeX math in the ONE markdown pipeline (`src/lib/markdown.ts`), which exposes two
// renderers over a single markdown-it + a single sanitize call site, split by
// CONTENT CLASS: `renderMarkdown` (authored prose — notebook markdown cells and
// `.md` file previews) typesets math, `renderOutputMarkdown` (the
// markdown-table-in-KERNEL-OUTPUT path) deliberately does NOT. Kernel output is
// arbitrary data and a printed price column ("$5", "$1,200") is the everyday case,
// so $-scanning it would false-typeset the user's own data — which is why routing
// `renderTable` back onto `renderMarkdown` would be a regression, not a
// simplification. Everything else about the two is identical, and the
// `kernel output is rendered WITHOUT math` block below pins both halves of that.
//
// It runs under jsdom rather than the suite's default `node` environment on
// purpose: DOMPurify is the security half of this feature and needs a real DOM,
// and asserting the sanitizer's actual behavior (rather than the shape of its
// config) is the only test that can catch a KaTeX allowlist extension having
// quietly let script through.
//
// `jsdom` is therefore pinned to a major whose own `engines.node` is `>=18`, and
// bumping it past that REQUIRES bumping CI's Node first. jsdom 30 needs Node
// `^22.22.2 || ^24.15.0 || >=26`, and on anything older it fails at IMPORT (its
// `api.js` pulls `undici`, whose `CacheStorage` calls `webidl.util.markAsUncloneable`).
// That failure is easy to miss locally on a new Node and lands as a red CI on
// Node 20 (`.github/workflows/ci.yml`, pinned to LTS; `package.json` `engines`
// says `>=18`) - and it does NOT fail the suite honestly: the two jsdom files
// simply never load, so vitest reports every OTHER file passing next to an
// unhandled error, which reads as green at a glance.
import { describe, it, expect } from 'vitest';
import {
	renderMarkdown,
	renderOutputMarkdown,
	MARKDOWN_SANITIZE_CONFIG
} from '../../src/lib/markdown';

/** Parse rendered HTML so assertions read the DOM, not a string. */
function dom(html: string): HTMLElement {
	const host = document.createElement('div');
	host.innerHTML = html;
	return host;
}

/** Every attribute name present anywhere in a rendered fragment. */
function attrNames(host: HTMLElement): string[] {
	const names: string[] = [];
	host.querySelectorAll('*').forEach((el) => {
		for (const a of Array.from(el.attributes)) names.push(a.name.toLowerCase());
	});
	return names;
}

/**
 * The invariant every hostile input must satisfy: no executable node, no event
 * handler, no script-bearing URL survives the sanitizer.
 */
function expectInert(html: string) {
	const host = dom(html);
	expect(host.querySelector('script')).toBeNull();
	expect(host.querySelector('iframe')).toBeNull();
	expect(attrNames(host).filter((n) => n.startsWith('on'))).toEqual([]);
	for (const el of Array.from(host.querySelectorAll('*'))) {
		for (const a of Array.from(el.attributes)) {
			expect(a.value.replace(/\s+/g, '').toLowerCase()).not.toContain('javascript:');
		}
	}
}

describe('math rendering', () => {
	it('typesets inline $…$ math', () => {
		const host = dom(renderMarkdown('Euler: $e^{i\\pi}+1=0$ holds.'));
		const katex = host.querySelector('.katex');
		expect(katex).not.toBeNull();
		// The visible layer is KaTeX's span tree; the MathML branch is the
		// screen-reader one. Both must survive the sanitizer.
		expect(host.querySelector('.katex-html')).not.toBeNull();
		expect(host.querySelector('math')).not.toBeNull();
		// Prose either side of the math is untouched.
		expect(host.textContent).toContain('Euler:');
		expect(host.textContent).toContain('holds.');
	});

	it('typesets display $$…$$ math as a block', () => {
		const host = dom(renderMarkdown('$$\\int_0^\\infty e^{-x}\\,dx = 1$$'));
		expect(host.querySelector('.katex-display')).not.toBeNull();
		expect(host.querySelector('p.katex-block')).not.toBeNull();
		expect(host.querySelector('math')?.getAttribute('display')).toBe('block');
	});

	it('keeps the MathML semantics/annotation pair carrying the source TeX', () => {
		// The one thing DOMPurify's defaults strip from KaTeX's output. Without the
		// allowlist extension the annotation is UNWRAPPED, not dropped — so the raw
		// TeX leaks into the MathML as bare text a screen reader reads aloud, while
		// the visible math still looks right. Assert the elements, not just the text.
		const host = dom(renderMarkdown('$a^2+b^2=c^2$'));
		const annotation = host.querySelector('annotation');
		expect(host.querySelector('semantics')).not.toBeNull();
		expect(annotation).not.toBeNull();
		expect(annotation?.getAttribute('encoding')).toBe('application/x-tex');
		expect(annotation?.textContent).toBe('a^2+b^2=c^2');
	});

	it('renders the same math identically wherever PROSE is rendered', () => {
		// Cells and `.md` previews call this one function, so a single engine is
		// provable by construction; pin that it is deterministic. (Kernel output is
		// the other content class and gets the math-free renderer — see the header.)
		const src = 'x $\\frac{1}{2}$ y';
		expect(renderMarkdown(src)).toBe(renderMarkdown(src));
	});
});

describe('math delimiters do not eat prose', () => {
	it('leaves currency alone', () => {
		const host = dom(renderMarkdown('it cost $5 and $10 total'));
		expect(host.querySelector('.katex')).toBeNull();
		expect(host.textContent?.trim()).toBe('it cost $5 and $10 total');
	});

	it('leaves thousands-separated currency alone', () => {
		const host = dom(renderMarkdown('Plans are $1,000 and $2,000 per seat.'));
		expect(host.querySelector('.katex')).toBeNull();
		expect(host.textContent?.trim()).toBe('Plans are $1,000 and $2,000 per seat.');
	});

	it('leaves an escaped \\$ alone', () => {
		const host = dom(renderMarkdown('a \\$x\\$ b'));
		expect(host.querySelector('.katex')).toBeNull();
	});

	it('exempts code spans and fenced blocks, so a shell prompt is safe there', () => {
		// The documented workaround for the shell-prompt limitation below: math is not
		// parsed inside code, which is where shell commands belong anyway.
		const span = dom(renderMarkdown('run `$ npm install` then `$ npm run build`'));
		expect(span.querySelector('.katex')).toBeNull();
		expect(span.querySelectorAll('code')[0]?.textContent).toBe('$ npm install');
		expect(span.textContent).toContain('$ npm run build');

		const fenced = dom(renderMarkdown('```sh\n$ npm install\n$ npm run build\n```\n'));
		expect(fenced.querySelector('.katex')).toBeNull();
		expect(fenced.querySelector('pre code')?.textContent).toContain('$ npm install');
	});

	it('documents the accepted limitation: an UNFENCED shell prompt does typeset', () => {
		// Not a desired outcome - a KNOWN, accepted one, pinned so a future change to
		// it is a deliberate decision. The plugin rejects a closing `$` followed by a
		// word character but not one preceded by whitespace, so the span between two
		// prompt `$`s parses as inline math. Jupyter behaves identically; it is
		// inherent to the `$` delimiter set this feature is required to use. See the
		// delimiter doc block in `src/lib/markdown.ts`.
		const host = dom(renderMarkdown('$ npm install\n$ npm run build'));
		expect(host.querySelector('.katex')).not.toBeNull();
	});
});

describe('rendering errors are contained', () => {
	it('renders an unparseable formula as an inline error, never a throw', () => {
		let html = '';
		expect(() => {
			html = renderMarkdown('before $\\frac{1}{$ after');
		}).not.toThrow();
		const host = dom(html);
		expect(host.querySelector('.katex-error')).not.toBeNull();
		// The rest of the document still renders — one bad formula cannot blank a
		// cell or a file preview.
		expect(host.textContent).toContain('before');
		expect(host.textContent).toContain('after');
	});

	it('renders an unknown macro in KaTeX error color rather than failing', () => {
		const html = renderMarkdown('$\\thisisnotacommand{x}$');
		expect(html).toContain('#cc0000');
		expectInert(html);
	});

	it('bounds a hostile oversize expression instead of blowing out the layout', () => {
		// `\rule`/`\hspace` sizes are NOT gated by `trust:false`, and a downloaded
		// notebook is untrusted input: at KaTeX's default `maxSize: Infinity` this
		// renders a multi-thousand-em node that wrecks the cell around it. It must
		// still RENDER (the expression is valid TeX) - just capped.
		const html = renderMarkdown('$\\rule{1em}{9999em}$ and $\\hspace{5000em}$ tail');
		const host = dom(html);
		expect(host.querySelector('.katex')).not.toBeNull();
		expect(host.textContent).toContain('tail');
		// Every em-valued LAYOUT dimension KaTeX emitted (inline styles + the MathML
		// width/height attrs). The `<annotation>`'s TeX still says 9999em - it is the
		// source, not a size, and must be left verbatim.
		const sizes: number[] = [];
		for (const el of Array.from(host.querySelectorAll('*'))) {
			for (const name of ['style', 'width', 'height'] as const) {
				const v = el.getAttribute(name);
				if (v) for (const m of v.matchAll(/([\d.]+)em/g)) sizes.push(Number(m[1]));
			}
		}
		expect(sizes.length).toBeGreaterThan(0);
		expect(Math.max(...sizes)).toBeLessThanOrEqual(10);
		expect(host.querySelector('annotation')?.textContent).toContain('9999em');
	});
});

describe('sanitization is not weakened by the KaTeX allowlist', () => {
	it('extends the allowlist by exactly the two KaTeX MathML tags', () => {
		// A guard on the extension's WIDTH: this config is the only thing standing
		// between KaTeX support and a broader relaxation, so growing it must be a
		// deliberate edit that fails this test first.
		expect(MARKDOWN_SANITIZE_CONFIG).toEqual({ ADD_TAGS: ['semantics', 'annotation'] });
		expect(MARKDOWN_SANITIZE_CONFIG.ADD_TAGS).not.toContain('annotation-xml');
	});

	it.each([
		['a script tag', '<script>alert(1)</script>'],
		['an img error handler', '<img src=x onerror=alert(1)>'],
		['an svg load handler', '<svg onload=alert(1)></svg>'],
		['an iframe', '<iframe src="javascript:alert(1)"></iframe>'],
		['a javascript: link', '[click me](javascript:alert(1))'],
		['a handler beside math', '<img src=x onerror=alert(1)> and $x^2$'],
		['markup inside \\text', '$\\text{</span><img src=x onerror=alert(1)>}$'],
		['a math-tree breakout', '$$x</annotation></semantics></math><script>alert(1)</script>$$'],
		['an annotation breakout', '$$</math><img src=x onerror=alert(1)>$$']
	])('strips %s', (_label, src) => {
		expectInert(renderMarkdown(src));
	});

	it('neutralizes TeX commands that could emit HTML or URLs', () => {
		// KaTeX `trust: false` refuses these outright — they must never become an
		// anchor, an image, or a class the page styles.
		for (const src of [
			'$\\href{javascript:alert(1)}{click}$',
			'$\\href{https://example.com}{click}$',
			'$\\url{javascript:alert(1)}$',
			'$\\includegraphics[width=1em]{x.png}$',
			'$\\htmlClass{danger}{x}$'
		]) {
			const html = renderMarkdown(src);
			const host = dom(html);
			expect(host.querySelector('a')).toBeNull();
			expect(host.querySelector('img')).toBeNull();
			expectInert(html);
		}
	});
});

describe('kernel output is rendered WITHOUT math', () => {
	// Deliberate split by CONTENT CLASS, not renderer drift: authored prose may
	// contain math, arbitrary kernel output may not be $-scanned - a printed price
	// column is the everyday case, and typesetting it would eat the user's DATA.
	// Everything else (markdown-it config, sanitizer config, sanitize call site) is
	// shared, which is what keeps the two from diverging in any other respect.
	it('leaves a $…$ span in output as literal text', () => {
		const host = dom(renderOutputMarkdown('| item | price |\n|---|---|\n| a | $x^2$ |\n'));
		expect(host.querySelector('.katex')).toBeNull();
		expect(host.textContent).toContain('$x^2$');
		// …while the authored-prose renderer typesets the same source.
		expect(dom(renderMarkdown('$x^2$')).querySelector('.katex')).not.toBeNull();
	});

	it('leaves a printed price column exactly as the kernel printed it', () => {
		const host = dom(
			renderOutputMarkdown('| sku | low | high |\n|---|---|---|\n| a | $5 | $1,200 |\n')
		);
		expect(host.querySelector('.katex')).toBeNull();
		const cells = Array.from(host.querySelectorAll('tbody td')).map((c) => c.textContent);
		expect(cells).toEqual(['a', '$5', '$1,200']);
	});

	it('renders the same tables and sanitizes the same way as the prose renderer', () => {
		const table = '| a | b |\n|---|---|\n| 1 | 2 |\n';
		expect(renderOutputMarkdown(table)).toBe(renderMarkdown(table));
		expectInert(renderOutputMarkdown('<img src=x onerror=alert(1)> <script>alert(1)</script>'));
		expect(dom(renderOutputMarkdown('[click](javascript:alert(1))')).querySelector('a')?.getAttribute('href') ?? '').not.toContain('javascript:');
	});
});

describe('ordinary markdown is unchanged', () => {
	it('renders headings, lists, code, links and tables as before', () => {
		const host = dom(
			renderMarkdown(
				'# Title\n\n- one\n- two\n\n`inline code`\n\n```py\nx = 1\n```\n\n[link](https://example.com)\n\n| a | b |\n|---|---|\n| 1 | 2 |\n'
			)
		);
		expect(host.querySelector('h1')?.textContent).toBe('Title');
		expect(host.querySelectorAll('li').length).toBe(2);
		expect(host.querySelector('code')?.textContent).toBe('inline code');
		expect(host.querySelector('pre code')?.textContent?.trim()).toBe('x = 1');
		expect(host.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
		expect(host.querySelectorAll('table tbody td').length).toBe(2);
		expect(host.querySelector('.katex')).toBeNull();
	});

	it('leaves a lone dollar and a code-fenced dollar as text', () => {
		expect(dom(renderMarkdown('costs $ per unit')).querySelector('.katex')).toBeNull();
		const fenced = dom(renderMarkdown('```\n$x^2$\n```\n'));
		expect(fenced.querySelector('.katex')).toBeNull();
		expect(fenced.querySelector('pre code')?.textContent?.trim()).toBe('$x^2$');
	});
});
