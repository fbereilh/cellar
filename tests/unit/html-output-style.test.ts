/**
 * The stylesheet cellar injects into the sandboxed rich-`text/html` output iframe
 * (`htmlOutputStyle.ts` → `HtmlOutput.svelte`'s `buildSrcdoc`).
 *
 * Two things here are one-character regressions with no other symptom, so both
 * get a source-level guard:
 *
 *   • **Specificity.** The table rules are DEFAULTS. A pandas Styler emits
 *     `#T_xxxx td { … }` and `set_properties` emits per-cell
 *     `#T_xxxx_row0_col0`, so the user's explicit styling has to keep winning
 *     the cascade - that is the whole contract this replaces (their helper
 *     passed `overwrite=False`). One `.dataframe` or `#T_` added to a selector
 *     here would silently start overriding user styling on tables that had it,
 *     and nothing else would fail.
 *
 *   • **The sandbox.** The iframe renders untrusted kernel output with
 *     `allow-scripts`; `allow-same-origin` next to it would hand that output the
 *     app's origin. Mirrors the identical guard `html-preview.test.ts` keeps
 *     over `HtmlPreview.svelte`.
 *
 * The rendered result (comfortable padding, aligned columns, a wide table
 * scrolling itself, a Styler still overriding) is proven in the real browser by
 * `tests/e2e/output-table-styling.spec.ts`; this file guards the invariants that
 * a browser test would not fail loudly on.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OUTPUT_HTML_CSS, cssSelectors } from '../../src/lib/htmlOutputStyle';

const REPO = join(fileURLToPath(import.meta.url), '../../..');
const COMPONENT = readFileSync(join(REPO, 'src/lib/HtmlOutput.svelte'), 'utf8');

describe('cssSelectors', () => {
	it('yields one entry per selector, splitting comma-separated lists', () => {
		expect(cssSelectors('a{x:1}\nb , c{y:2}')).toEqual(['a', 'b', 'c']);
	});

	it('is empty for a block with no rules', () => {
		expect(cssSelectors('')).toEqual([]);
	});
});

describe('injected output stylesheet: specificity', () => {
	const selectors = cssSelectors(OUTPUT_HTML_CSS);

	it('has rules to check (guards against a silently emptied block)', () => {
		expect(selectors.length).toBeGreaterThan(5);
	});

	// An id or a class is precisely what would outrank a Styler's own
	// `#T_xxxx td` / `.dataframe td` rules, so neither may appear anywhere.
	it('uses no id, class, or attribute selector - every rule stays at element level', () => {
		for (const sel of selectors) {
			expect(sel, `selector \`${sel}\` must not use an id (it would beat user styling)`).not.toContain('#');
			expect(sel, `selector \`${sel}\` must not use a class (it would beat user styling)`).not.toContain('.');
			expect(sel, `selector \`${sel}\` must not use an attribute selector`).not.toContain('[');
		}
	});

	// `:has()` takes the specificity of its most specific argument, so it is only
	// element-level while every argument is a bare type selector.
	it('uses :has() only over type selectors, keeping it at element specificity', () => {
		for (const sel of selectors) {
			for (const [, args] of sel.matchAll(/:has\(([^)]*)\)/g)) {
				expect(args, `\`:has(${args})\` must contain only type selectors`).toMatch(/^[a-z0-9,\s]+$/);
			}
		}
		// The only pseudo-class in the block is `:has()`.
		for (const sel of selectors) {
			expect(sel.replace(/:has\(/g, ''), `selector \`${sel}\` uses an unexpected pseudo-class`).not.toContain(':');
		}
	});
});

describe('injected output stylesheet: contents', () => {
	it('gives table cells comfortable padding and the pandas alignment convention', () => {
		expect(OUTPUT_HTML_CSS).toMatch(/\bth,td\{[^}]*padding:7px 20px/);
		expect(OUTPUT_HTML_CSS).toMatch(/\bth,td\{[^}]*text-align:right/);
		// Row/index headings read as labels, not data.
		expect(OUTPUT_HTML_CSS).toMatch(/\btbody th\{[^}]*text-align:left/);
	});

	// nowrap without a scroll container is how a wide numeric table spills into a
	// document-level horizontal scroll; they ship as a pair or not at all.
	it('pairs nowrap cells with a table that scrolls itself', () => {
		expect(OUTPUT_HTML_CSS).toMatch(/\bth,td\{[^}]*white-space:nowrap/);
		expect(OUTPUT_HTML_CSS).toMatch(/\btable\{[^}]*overflow-x:auto/);
		expect(OUTPUT_HTML_CSS).toMatch(/\btable\{[^}]*display:block/);
	});

	it('renders a set_caption caption as a title above the table', () => {
		expect(OUTPUT_HTML_CSS).toMatch(/\bcaption\{[^}]*font-weight:600/);
		expect(OUTPUT_HTML_CSS).toMatch(/\bcaption\{[^}]*text-align:left/);
	});

	// A cell holding block-level content is a layout cell, not a datum: nowrap +
	// right-align collapses its prose onto one scrolled-away line.
	it('hands a cell containing block content back normal wrapping', () => {
		const escape = cssSelectors(OUTPUT_HTML_CSS).filter((s) => s.includes(':has('));
		expect(escape.length).toBeGreaterThan(0);
		expect(OUTPUT_HTML_CSS).toMatch(/:has\([^)]*\)[^{]*\{[^}]*white-space:normal/);
	});

	// The iframe is deliberately a light document in BOTH app themes - rich HTML
	// reprs are authored assuming white. See `HtmlOutput.svelte`'s header.
	it('keeps the canvas an explicit light document', () => {
		expect(OUTPUT_HTML_CSS).toMatch(/\bhtml,body\{[^}]*background:#ffffff/);
		expect(OUTPUT_HTML_CSS).toMatch(/\bhtml,body\{[^}]*color:#1f2937/);
	});
});

describe('HtmlOutput.svelte', () => {
	it('injects the shared stylesheet rather than carrying its own copy', () => {
		expect(COMPONENT).toContain("import { OUTPUT_HTML_CSS } from '$lib/htmlOutputStyle'");
		expect(COMPONENT).toContain('${OUTPUT_HTML_CSS}');
	});

	it('sandboxes the iframe without granting it the app origin', () => {
		const attr = COMPONENT.match(/sandbox="([^"]*)"/);
		expect(attr, 'HtmlOutput.svelte must sandbox its iframe').not.toBeNull();
		const tokens = (attr as RegExpMatchArray)[1].split(/\s+/).filter(Boolean);
		expect(tokens).toContain('allow-scripts');
		expect(tokens).not.toContain('allow-same-origin');
	});
});
