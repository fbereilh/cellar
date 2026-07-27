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
 *     and nothing else would fail. `!important` is the same regression by
 *     another route, so it is guarded beside the selectors.
 *
 *   • **The sandbox.** The iframe renders untrusted kernel output with
 *     `allow-scripts`; `allow-same-origin` next to it would hand that output the
 *     app's origin. Mirrors the identical guard `html-preview.test.ts` keeps
 *     over `HtmlPreview.svelte`.
 *
 * The rendered result (comfortable padding, aligned columns, a wide table
 * overflowing into the output document's own scroll, a Styler still overriding)
 * is proven in the real browser by `tests/e2e/output-table-styling.spec.ts`; this
 * file guards the invariants that a browser test would not fail loudly on.
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

	// The sibling of the selector guard, and it belongs here rather than with the
	// contents: `!important` beats every user rule whatever its specificity, so it
	// defeats the same user-always-wins contract with every selector still at
	// element level and every other assertion in this file passing.
	it('declares nothing !important - that would beat user styling regardless of specificity', () => {
		expect(OUTPUT_HTML_CSS).not.toMatch(/!\s*important/i);
	});
});

describe('injected output stylesheet: contents', () => {
	it('gives table cells comfortable padding - the whole point of the block', () => {
		expect(OUTPUT_HTML_CSS).toMatch(/\bth,td\{[^}]*padding:7px 20px/);
		// Row/index headings read as labels, not data.
		expect(OUTPUT_HTML_CSS).toMatch(/\btbody th\{[^}]*text-align:left/);
	});

	// An inherited value is only used where no declaration applies to the element
	// itself, so a `th,td` rule would outrank a user's table-level
	// `#T_xxxx{text-align:left}` (what `set_table_styles([{'selector': ''}])`
	// emits). Declared on `table` the two meet on one element and the id wins.
	it('declares the right-align default on `table`, never on the cells', () => {
		expect(OUTPUT_HTML_CSS).toMatch(/\btable\{[^}]*text-align:right/);
		const cellRule = OUTPUT_HTML_CSS.match(/\bth,td\{([^}]*)\}/);
		expect(cellRule, 'the `th,td` rule must exist').not.toBeNull();
		expect((cellRule as RegExpMatchArray)[1]).not.toContain('text-align');
	});

	// `display:block` wraps the rows in an anonymous table box of `width:auto`, so
	// a user's `<table width="100%">` / `table-layout:fixed` would stop having an
	// effect; and cells wrap like pandas/Jupyter, so a long text column reads
	// instead of scrolling. A genuinely wide table overflows the output document.
	it('keeps the table a real table and lets cells wrap', () => {
		expect(OUTPUT_HTML_CSS).not.toMatch(/\btable\{[^}]*display:block/);
		expect(OUTPUT_HTML_CSS).not.toMatch(/white-space/);
	});

	// `display:block` here would be worse than pointless: a caption is already
	// `display:table-caption` above the table, and forcing block on a child of a
	// `display:table` element gets it wrapped in an anonymous cell - i.e. a row.
	it('renders a set_caption caption as a title above the table', () => {
		expect(OUTPUT_HTML_CSS).toMatch(/\bcaption\{[^}]*font-weight:600/);
		expect(OUTPUT_HTML_CSS).toMatch(/\bcaption\{[^}]*text-align:left/);
		expect(OUTPUT_HTML_CSS).not.toMatch(/\bcaption\{[^}]*display:/);
	});

	// A cell holding block-level content is a layout cell, not a datum: the
	// table's right-align would ragged-right its prose. Deliberately a DIRECT
	// rule - it exists to beat the table-level default it would inherit.
	it('hands a cell containing block content back start alignment', () => {
		const escape = cssSelectors(OUTPUT_HTML_CSS).filter((s) => s.includes(':has('));
		expect(escape.length).toBeGreaterThan(0);
		expect(OUTPUT_HTML_CSS).toMatch(/:has\([^)]*\)[^{]*\{[^}]*text-align:left/);
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
