// @vitest-environment jsdom
//
// RENDERED CONTENT MAY NEVER UNLOAD THE LIVE CELLAR SESSION - the tab it is
// rendered in holds the kernel, the running notebook and every unsaved editor
// buffer, and navigating it away loses all three. So a link Cellar renders from
// notebook content opens in a NEW TAB, and so does a `<form>`, whose submit is
// the same same-tab navigation by another name.
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
import {
	sanitizeHtml,
	opensInNewTab,
	applyNavigationPolicy,
	NEW_TAB_REL
} from '../../src/lib/sanitizeHtml';

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

describe('applyNavigationPolicy', () => {
	it('strips a target off a link that must stay in place', () => {
		// The attribute cannot have come from Cellar, so honoring one from
		// untrusted content on exactly the links this rule protects would be the
		// bug with the sign flipped.
		const el = document.createElement('a');
		el.setAttribute('href', '#section');
		el.setAttribute('target', '_blank');
		applyNavigationPolicy(el);
		expect(el.hasAttribute('target')).toBe(false);
	});

	it('ignores an element that does not navigate', () => {
		const el = document.createElement('span');
		applyNavigationPolicy(el);
		expect(el.attributes.length).toBe(0);
	});

	it('covers <area>, which navigates like <a>', () => {
		const el = document.createElement('area');
		el.setAttribute('href', 'https://example.com');
		applyNavigationPolicy(el);
		expect(el.getAttribute('target')).toBe('_blank');
		expect(el.getAttribute('rel')).toBe(NEW_TAB_REL);
	});

	it('matches the element by localName, so a namespaced <a> is covered', () => {
		// Only an HTML-namespaced element uppercases its `tagName`; an SVG one
		// reports `'a'`, so an uppercase comparison silently skipped it.
		const el = document.createElementNS('http://www.w3.org/2000/svg', 'a');
		expect(el.tagName).toBe('a');
		el.setAttribute('href', 'https://example.com');
		applyNavigationPolicy(el);
		expect(el.getAttribute('target')).toBe('_blank');
		expect(el.getAttribute('rel')).toBe(NEW_TAB_REL);
	});

	it("reads SVG's xlink:href, which navigates just like href", () => {
		const el = document.createElementNS('http://www.w3.org/2000/svg', 'a');
		el.setAttributeNS(XLINK_NS, 'xlink:href', 'https://example.com');
		applyNavigationPolicy(el);
		expect(el.getAttribute('target')).toBe('_blank');
		expect(el.getAttribute('rel')).toBe(NEW_TAB_REL);
	});

	it('leaves an xlink:href fragment in place and strips its target', () => {
		const el = document.createElementNS('http://www.w3.org/2000/svg', 'a');
		el.setAttributeNS(XLINK_NS, 'xlink:href', '#setup');
		el.setAttribute('target', '_blank');
		applyNavigationPolicy(el);
		expect(el.hasAttribute('target')).toBe(false);
	});

	it('prefers href over xlink:href, as SVG 2 does', () => {
		const el = document.createElementNS('http://www.w3.org/2000/svg', 'a');
		el.setAttribute('href', '#setup');
		el.setAttributeNS(XLINK_NS, 'xlink:href', 'https://example.com');
		applyNavigationPolicy(el);
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
		//
		// The witness is an element the POLICY never touches: that allowlist is FLAT
		// (one set for every element), so `target`'s absence from it is an
		// element-independent fact, and all three elements that legitimately take
		// `target` are now policy-covered (`<base>` is dropped outright).
		const witness = dom(sanitizeHtml('<div target="_blank" title="kept">x</div>')).querySelector(
			'div'
		);
		expect(witness?.hasAttribute('target')).toBe(false);
		// ...and not merely because the element loses its attributes wholesale.
		expect(witness?.getAttribute('title')).toBe('kept');
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

describe('a rendered form cannot unload the session either', () => {
	// A submit is a same-tab navigation, so it is the same harm at the same
	// boundary. Every case here is UNCONDITIONAL, unlike the link rule: a form has
	// no in-place case to preserve.
	function form(html: string): HTMLFormElement {
		const f = dom(sanitizeHtml(html)).querySelector('form');
		if (!f) throw new Error(`no <form> in sanitized output: ${html}`);
		return f as HTMLFormElement;
	}

	it('an action that leaves the document opens out', () => {
		const f = form('<form action="/submit" method="post"><input type="submit"></form>');
		expect(f.getAttribute('action')).toBe('/submit');
		expect(f.getAttribute('target')).toBe('_blank');
		expect(f.getAttribute('rel')).toBe(NEW_TAB_REL);
	});

	it('an ABSENT action opens out - it submits to the current document', () => {
		// The mirror image of an absent `href`, which gets nothing: a form with no
		// action submits to the document's own URL, so this is the destructive case
		// rather than the inert one. It is also what DOMPurify leaves behind when it
		// REFUSES an action, so that shape must not fall through untargeted either.
		expect(form('<form><input type="submit"></form>').getAttribute('target')).toBe('_blank');
		const refused = form('<form action="javascript:alert(1)"><input type="submit"></form>');
		expect(refused.hasAttribute('action')).toBe(false);
		expect(refused.getAttribute('target')).toBe('_blank');
	});

	it('an EMPTY action opens out', () => {
		const f = form('<form action=""><input type="submit"></form>');
		expect(f.getAttribute('action')).toBe('');
		expect(f.getAttribute('target')).toBe('_blank');
	});

	it('a FRAGMENT action opens out, unlike the same value on a link', () => {
		// Submitting to `#x` is a navigation (a GET replaces the query with the
		// serialized form data), not the in-place scroll `<a href="#x">` performs -
		// so the link rule must not be reused here.
		expect(form('<form action="#setup"><input type="submit"></form>').getAttribute('target')).toBe(
			'_blank'
		);
		const link = anchor(sanitizeHtml('<a href="#setup">x</a>'));
		expect(link.hasAttribute('target')).toBe(false);
	});

	it('the submit-control overrides that would beat it do not survive', () => {
		// This is the measurement the unconditional form rule rests on: a
		// `<button formaction=... formtarget=_self>` would defeat a target set on
		// the form, so if any of these survived, covering the form alone would not
		// close the vector.
		const html = sanitizeHtml(
			'<form action="/x">' +
				'<button type="submit" formaction="/y" formtarget="_self" formmethod="get" formenctype="text/plain" formnovalidate>go</button>' +
				'<input type="submit" formaction="/y" formtarget="_self">' +
				'<input type="image" src="/i.png" formaction="/y" formtarget="_top">' +
				'</form>'
		);
		for (const attr of [
			'formaction',
			'formtarget',
			'formmethod',
			'formenctype',
			'formnovalidate'
		]) {
			expect(html).not.toContain(attr);
		}
		// ...and a submit control cannot be re-associated with a form outside the
		// sanitized tree either, which would sidestep the target the same way.
		const owner = dom(
			sanitizeHtml('<form id="f" action="/x"></form><button form="f" type="submit">go</button>')
		);
		expect(owner.querySelector('button')?.hasAttribute('form')).toBe(false);
	});

	it('no markdown renderer can emit a form at all', () => {
		// The stated scope: `html:false` escapes raw HTML, so only the two raw
		// `text/html` widget surfaces can reach the form half of the policy. If this
		// ever fails, the markdown configs have been widened and the scope note in
		// `sanitizeHtml.ts` is no longer true.
		const src = '<form action="/x"><button type="submit">go</button></form>';
		for (const render of [renderMarkdown, renderOutputMarkdown, renderChatReply]) {
			const html = render(src);
			expect(dom(html).querySelector('form')).toBeNull();
			expect(html).toContain('&lt;form');
		}
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
