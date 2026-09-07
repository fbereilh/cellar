// @vitest-environment jsdom
//
// A link Cellar RENDERS from notebook content must open in a NEW TAB, because
// the tab it is rendered in holds the live session: the kernel, the running
// notebook and every unsaved editor buffer. Navigating it away loses all three.
//
// The rule lives at `src/lib/sanitizeHtml.ts` - the app's ONE browser-side
// sanitize boundary - so every rendered surface inherits it rather than
// remembering it: the three markdown renderers (`$lib/markdown`) funnel through
// it, and so do the two widget surfaces that sanitize raw `text/html`.
//
// jsdom rather than the suite's default `node` environment, for the reason
// `markdown-math.test.ts` states at length: DOMPurify is half of this and needs
// a real DOM, and the assertions here are about what the sanitizer ACTUALLY
// emits, not about the shape of a config. (Keep jsdom pinned as that file
// documents - bumping it past Node 20 breaks CI without failing honestly.)
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { renderMarkdown, renderOutputMarkdown, renderChatReply } from '../../src/lib/markdown';
import { sanitizeHtml, opensInNewTab, applyLinkPolicy, NEW_TAB_REL } from '../../src/lib/sanitizeHtml';

/** SVG 1.1's link spelling, which browsers still follow and DOMPurify still keeps. */
const XLINK_NS = 'http://www.w3.org/1999/xlink';

/** Parse rendered HTML so assertions read the DOM, not a string. */
function dom(html: string): HTMLElement {
	const host = document.createElement('div');
	host.innerHTML = html;
	return host;
}

function anchor(html: string): HTMLAnchorElement {
	const a = dom(html).querySelector('a');
	if (!a) throw new Error(`no <a> in rendered output: ${html}`);
	return a as HTMLAnchorElement;
}

describe('opensInNewTab - the one same-document rule', () => {
	it('leaves a same-document fragment in place', () => {
		expect(opensInNewTab('#section')).toBe(false);
		expect(opensInNewTab('#')).toBe(false);
		// Leading whitespace is still a fragment; the browser trims it too.
		expect(opensInNewTab('  #section')).toBe(false);
	});

	it('opens anything that leaves the document', () => {
		expect(opensInNewTab('https://example.com')).toBe(true);
		expect(opensInNewTab('http://example.com/a#frag')).toBe(true);
		expect(opensInNewTab('mailto:a@b.c')).toBe(true);
		// A RELATIVE href unloads the Cellar tab exactly like an absolute one, so
		// this is deliberately not a cross-origin test.
		expect(opensInNewTab('./data.csv')).toBe(true);
		expect(opensInNewTab('/notebook.ipynb')).toBe(true);
		expect(opensInNewTab('?q=1')).toBe(true);
	});

	it('does nothing for an ABSENT href - there is nothing to follow', () => {
		// This is the shape DOMPurify leaves behind when it REFUSES an href (a
		// `javascript:` URL): it removes the attribute rather than blanking it, so
		// a click goes nowhere and a target would be meaningless.
		expect(opensInNewTab(null)).toBe(false);
		expect(opensInNewTab(undefined)).toBe(false);
	});

	it('opens an EMPTY href out - it resolves to the current document', () => {
		// Absent and empty are different cases. An empty `href` is PRESENT, and it
		// resolves to the current URL, so clicking it RELOADS the Cellar tab and
		// destroys the live session - exactly the harm this rule exists to prevent.
		expect(opensInNewTab('')).toBe(true);
		expect(opensInNewTab('   ')).toBe(true);
	});
});

describe('applyLinkPolicy', () => {
	it('strips a target off a link that must stay in place', () => {
		// The attribute cannot have come from Cellar, so honoring one from
		// untrusted content on exactly the links this rule protects would be the
		// bug with the sign flipped.
		const el = document.createElement('a');
		el.setAttribute('href', '#section');
		el.setAttribute('target', '_blank');
		applyLinkPolicy(el);
		expect(el.hasAttribute('target')).toBe(false);
	});

	it('ignores an element that does not navigate', () => {
		const el = document.createElement('span');
		applyLinkPolicy(el);
		expect(el.attributes.length).toBe(0);
	});

	it('covers <area>, which navigates like <a>', () => {
		const el = document.createElement('area');
		el.setAttribute('href', 'https://example.com');
		applyLinkPolicy(el);
		expect(el.getAttribute('target')).toBe('_blank');
		expect(el.getAttribute('rel')).toBe(NEW_TAB_REL);
	});

	it('matches the element by localName, so a namespaced <a> is covered', () => {
		// Only an HTML-namespaced element uppercases its `tagName`; an SVG one
		// reports `'a'`, so an uppercase comparison silently skipped it.
		const el = document.createElementNS('http://www.w3.org/2000/svg', 'a');
		expect(el.tagName).toBe('a');
		el.setAttribute('href', 'https://example.com');
		applyLinkPolicy(el);
		expect(el.getAttribute('target')).toBe('_blank');
		expect(el.getAttribute('rel')).toBe(NEW_TAB_REL);
	});

	it("reads SVG's xlink:href, which navigates just like href", () => {
		const el = document.createElementNS('http://www.w3.org/2000/svg', 'a');
		el.setAttributeNS(XLINK_NS, 'xlink:href', 'https://example.com');
		applyLinkPolicy(el);
		expect(el.getAttribute('target')).toBe('_blank');
		expect(el.getAttribute('rel')).toBe(NEW_TAB_REL);
	});

	it('leaves an xlink:href fragment in place and strips its target', () => {
		const el = document.createElementNS('http://www.w3.org/2000/svg', 'a');
		el.setAttributeNS(XLINK_NS, 'xlink:href', '#setup');
		el.setAttribute('target', '_blank');
		applyLinkPolicy(el);
		expect(el.hasAttribute('target')).toBe(false);
	});

	it('prefers href over xlink:href, as SVG 2 does', () => {
		const el = document.createElementNS('http://www.w3.org/2000/svg', 'a');
		el.setAttribute('href', '#setup');
		el.setAttributeNS(XLINK_NS, 'xlink:href', 'https://example.com');
		applyLinkPolicy(el);
		expect(el.hasAttribute('target')).toBe(false);
	});
});

describe('every rendered markdown surface opens its links out', () => {
	// All three renderers, because each one renders content that can carry a link
	// the user did not write: an authored cell (a pasted notebook), a kernel's
	// `display(Markdown(...))`, and a model's reply.
	const renderers: Array<[string, (s: string) => string]> = [
		['renderMarkdown (markdown cells, .md preview)', renderMarkdown],
		['renderOutputMarkdown (kernel output)', renderOutputMarkdown],
		['renderChatReply (model reply)', renderChatReply]
	];

	for (const [name, render] of renderers) {
		it(`${name}: an external link gets target=_blank and rel`, () => {
			const a = anchor(render('[docs](https://example.com/docs)'));
			expect(a.getAttribute('href')).toBe('https://example.com/docs');
			expect(a.getAttribute('target')).toBe('_blank');
			// Not optional: without noopener the opened page holds a handle on the
			// window running the notebook.
			expect(a.getAttribute('rel')).toBe(NEW_TAB_REL);
		});

		it(`${name}: a linkified bare URL is covered too`, () => {
			const a = anchor(render('see https://example.com/x for more'));
			expect(a.getAttribute('target')).toBe('_blank');
			expect(a.getAttribute('rel')).toBe(NEW_TAB_REL);
		});

		it(`${name}: a same-document anchor stays in place`, () => {
			const a = anchor(render('[jump](#setup)'));
			expect(a.getAttribute('href')).toBe('#setup');
			expect(a.hasAttribute('target')).toBe(false);
		});
	}

	it('is applied by the sanitizer, not by markdown-it', () => {
		// DOMPurify's default attribute allowlist does not include `target`, so a
		// `target` written before sanitizing is stripped and the feature is
		// silently inert. This pins the measurement the design rests on.
		// `<form>` survives sanitizing but its `target` does not - the same
		// allowlist that would have eaten a markdown-it-written one off an `<a>`.
		const stripped = dom(sanitizeHtml('<form action="/x" target="_blank"></form>'));
		expect(stripped.querySelector('form')?.hasAttribute('target')).toBe(false);
		const link = dom(sanitizeHtml('<a href="https://example.com">x</a>'));
		// ...and yet the policy's own target survives, because it is set after the
		// attribute filter has run.
		expect(link.querySelector('a')?.getAttribute('target')).toBe('_blank');
	});

	it('does not resurrect a link DOMPurify refused', () => {
		const a = anchor(sanitizeHtml('<a href="javascript:alert(1)">x</a>'));
		expect(a.hasAttribute('href')).toBe(false);
		expect(a.hasAttribute('target')).toBe(false);
	});

	it('an empty link from markdown-it opens out rather than reloading the tab', () => {
		// `[x]()` is ordinary content and markdown-it renders it as `<a href="">`,
		// which DOMPurify keeps. Left in place it would reload the tab holding the
		// kernel, the running notebook and every unsaved editor buffer.
		const a = anchor(renderMarkdown('[x]()'));
		expect(a.getAttribute('href')).toBe('');
		expect(a.getAttribute('target')).toBe('_blank');
		expect(a.getAttribute('rel')).toBe(NEW_TAB_REL);
	});

	it('an SVG anchor sanitized through the boundary is covered', () => {
		// Reachable: neither sanitize config restricts `ALLOWED_TAGS`, so
		// DOMPurify's default profile keeps SVG, and the widget surfaces hand a
		// kernel's raw `text/html` straight to `sanitizeHtml`.
		for (const spelling of ['href', 'xlink:href']) {
			const a = anchor(
				sanitizeHtml(`<svg><a ${spelling}="https://example.com"><text>go</text></a></svg>`)
			);
			expect(a.namespaceURI).toBe('http://www.w3.org/2000/svg');
			expect(a.getAttribute('target')).toBe('_blank');
			expect(a.getAttribute('rel')).toBe(NEW_TAB_REL);
		}
	});

	it('an SVG same-document anchor still stays in place', () => {
		const a = anchor(sanitizeHtml('<svg><a href="#setup"><text>go</text></a></svg>'));
		expect(a.getAttribute('href')).toBe('#setup');
		expect(a.hasAttribute('target')).toBe(false);
	});

	it('raw text/html output (the widget surfaces) is covered', () => {
		// `WidgetOutput.svelte` / `WidgetOutputArea.svelte` sanitize a kernel's
		// `text/html` directly - no markdown-it in sight - which is why the policy
		// lives at the sanitize boundary rather than in a renderer rule.
		const a = anchor(sanitizeHtml('<p><a href="https://example.com">go</a></p>'));
		expect(a.getAttribute('target')).toBe('_blank');
		expect(a.getAttribute('rel')).toBe(NEW_TAB_REL);
	});
});

describe('source guard: the boundary cannot be bypassed', () => {
	// The policy is inheritable only while every sanitize goes through
	// `sanitizeHtml`. A surface that reaches for DOMPurify directly opts out
	// silently, which is exactly the "a future rendered link is forgotten" failure
	// this design exists to prevent.
	function walk(dir: string, out: string[] = []): string[] {
		for (const name of readdirSync(dir)) {
			const p = join(dir, name);
			if (statSync(p).isDirectory()) walk(p, out);
			else if (/\.(ts|svelte|js)$/.test(name)) out.push(p);
		}
		return out;
	}

	// Matching the literal `DOMPurify.sanitize(` spelling would have been trivially
	// bypassed - an aliased binding, `import { sanitize } from 'dompurify'`, a
	// re-exported wrapper - so the invariant is stated one level up instead: NO
	// file but `sanitizeHtml.ts` may import `dompurify` FOR A VALUE at all. A
	// type-only import (`markdown.ts` still needs `Config`) reaches no runtime
	// binding, so it is allowed.
	const SPEC = String.raw`['"]dompurify['"]`;
	const VALUE_IMPORTS: RegExp[] = [
		// `import ... from 'dompurify'` / `export ... from 'dompurify'`, minus the
		// type-only forms, which are subtracted by `isTypeOnly` below. The clause
		// may span lines (a braced import often does) but may contain neither a
		// quote nor a `;`, so it cannot run past the end of an EARLIER statement
		// and mistake a preceding unrelated import for part of this one.
		new RegExp(String.raw`\b(?:import|export)\s+([^;'"]*?)\s+from\s*${SPEC}`, 'g'),
		// A bare side-effect import, and the two dynamic spellings.
		new RegExp(String.raw`\bimport\s*${SPEC}`, 'g'),
		new RegExp(String.raw`\b(?:require|import)\s*\(\s*${SPEC}`, 'g')
	];

	/** `import type X` / `import { type X, type Y }` - no runtime binding. */
	function isTypeOnly(clause: string | undefined): boolean {
		if (clause === undefined) return false;
		const c = clause.trim();
		if (/^type\b/.test(c)) return true;
		const braced = /^\{([\s\S]*)\}$/.exec(c);
		if (!braced) return false;
		const specifiers = braced[1]
			.split(',')
			.map((x) => x.trim())
			.filter(Boolean);
		return specifiers.length > 0 && specifiers.every((x) => /^type\b/.test(x));
	}

	function importsDompurifyForValue(source: string): boolean {
		for (const re of VALUE_IMPORTS) {
			re.lastIndex = 0;
			for (let m = re.exec(source); m; m = re.exec(source)) {
				if (!isTypeOnly(m[1])) return true;
			}
		}
		return false;
	}

	it('recognizes every way a file could reach for the module', () => {
		// The guard is only worth its cost if it really answers about the bypasses
		// it claims to close, so exercise the predicate itself.
		expect(importsDompurifyForValue(`import DOMPurify from 'dompurify';`)).toBe(true);
		expect(importsDompurifyForValue(`import { sanitize } from 'dompurify';`)).toBe(true);
		expect(importsDompurifyForValue(`import * as dp from "dompurify";`)).toBe(true);
		expect(importsDompurifyForValue(`export { sanitize } from 'dompurify';`)).toBe(true);
		expect(importsDompurifyForValue(`const dp = require('dompurify');`)).toBe(true);
		expect(importsDompurifyForValue(`const dp = await import('dompurify');`)).toBe(true);
		expect(importsDompurifyForValue(`import 'dompurify';`)).toBe(true);
		// ...and does not flag a type-only import, which reaches no runtime value.
		expect(importsDompurifyForValue(`import type { Config } from 'dompurify';`)).toBe(false);
		expect(importsDompurifyForValue(`import { type Config } from 'dompurify';`)).toBe(false);
		expect(importsDompurifyForValue(`import MarkdownIt from 'markdown-it';`)).toBe(false);
		// A preceding unrelated import must not be swept into the clause - that is
		// what made the guard flag `markdown.ts`, whose dompurify import is
		// type-only, when the clause was allowed to run across statements.
		expect(
			importsDompurifyForValue(
				`import MarkdownIt from 'markdown-it';\nimport type { Config } from 'dompurify';`
			)
		).toBe(false);
		expect(
			importsDompurifyForValue(
				`import MarkdownIt from 'markdown-it';\nimport DOMPurify from 'dompurify';`
			)
		).toBe(true);
		// A multi-line braced import is still one clause.
		expect(
			importsDompurifyForValue(`import {\n\tsanitize,\n\taddHook\n} from 'dompurify';`)
		).toBe(true);
	});

	it('only sanitizeHtml.ts imports dompurify for a value', () => {
		const offenders = walk('src')
			.filter((p) => !p.endsWith(join('lib', 'sanitizeHtml.ts')))
			.filter((p) => importsDompurifyForValue(readFileSync(p, 'utf8')));
		expect(offenders).toEqual([]);
	});
});
