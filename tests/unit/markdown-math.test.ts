// @vitest-environment jsdom
//
// TeX math in the ONE markdown pipeline (`src/lib/markdown.ts`), which feeds
// notebook markdown cells, `.md` file previews and the markdown-table-in-output
// path alike — so what this file pins holds on every rendered surface.
//
// It runs under jsdom rather than the suite's default `node` environment on
// purpose: DOMPurify is the security half of this feature and needs a real DOM,
// and asserting the sanitizer's actual behavior (rather than the shape of its
// config) is the only test that can catch a KaTeX allowlist extension having
// quietly let script through.
import { describe, it, expect } from 'vitest';
import { renderMarkdown, MARKDOWN_SANITIZE_CONFIG } from '../../src/lib/markdown';

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

	it('renders the same math identically wherever markdown is rendered', () => {
		// Cells, `.md` previews and output tables all call this one function, so a
		// single engine is provable by construction; pin that it is deterministic.
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
