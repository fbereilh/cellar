// @vitest-environment jsdom
//
// Find-in-page over a markdown cell that contains TeX math: the MODEL match
// sequence (`searchNotebook` -> `dedupeMatchesForDisplay` -> `buildCellHighlights`,
// counted from the cell SOURCE) and the DOM occurrence sequence
// (`buildTextRanges`, walked over the RENDERED markdown) must stay in 1:1
// correspondence, so the active ordinal emphasizes the occurrence the find bar is
// actually on.
//
// The hazard this pins: KaTeX writes each expression's text into the container
// THREE times - the clipped, screen-reader-only `.katex-mathml` MathML branch, that
// branch's `<annotation>` carrying the raw TeX, and the visible `.katex-html`
// glyphs. A plain text walk counts all three, so a model ordinal slid onto an
// invisible node and the painted highlight count diverged from the reported one.
// Asserting merely that "some highlight exists" would not have caught it, hence the
// per-ordinal assertions below.
import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '$lib/markdown';
import {
	searchNotebook,
	dedupeMatchesForDisplay,
	createSearchCache,
	DEFAULT_SEARCH_OPTS
} from '$lib/search';
import { buildCellHighlights, findOccurrences } from '$lib/searchHighlight';
import { buildTextRanges } from '$lib/domHighlight';

const OPTS = { caseSensitive: false, wholeWord: false, regex: false };

/** Run the whole model→DOM pipeline for one markdown cell, exactly as `Cell.svelte` does. */
function pipeline(source: string, query: string) {
	const cells = [{ id: 'c1', cell_type: 'markdown', source }];
	const matches = dedupeMatchesForDisplay(
		searchNotebook(cells, query, { ...DEFAULT_SEARCH_OPTS }, createSearchCache())
	);
	const host = document.createElement('div');
	host.innerHTML = renderMarkdown(source);
	const ranges = buildTextRanges(host, query, OPTS, findOccurrences);
	/** The range the find bar would emphasize for match `i` (null = nothing paintable). */
	const activeRange = (i: number) => {
		const active = buildCellHighlights(matches, i).get('c1')?.active;
		if (!active) return undefined;
		return { field: active.field, range: ranges[active.ordinal] };
	};
	return { matches, host, ranges, activeRange };
}

/** The rendered text from a range's start to the end of the text node holding it -
 *  enough to say WHICH occurrence was picked (math splits the prose into nodes). */
const contextFrom = (r: Range) => (r.startContainer as Text).data.slice(r.startOffset);

describe('active-match highlighting in a markdown cell containing math', () => {
	const SRC = 'x marks the spot, $x^2$ is the value, and x ends it.';

	it('counts each expression ONCE, so every ordinal lands on its own occurrence', () => {
		const { matches, ranges, activeRange } = pipeline(SRC, 'x');

		// Three occurrences of the query in the model's rendered-markdown text: before
		// the math, inside it, after it. The DOM walk must produce exactly three
		// entries - not the five a naive text walk sees (mathml + annotation + glyphs).
		expect(matches.map((m) => m.field)).toEqual(['markdown', 'markdown', 'markdown']);
		expect(ranges).toHaveLength(3);

		// First occurrence: the leading "x marks".
		const first = activeRange(0)!;
		expect(first.field).toBe('markdown');
		expect(first.range).not.toBeNull();
		expect(first.range!.toString()).toBe('x');
		expect(contextFrom(first.range!)).toBe('x marks the spot, ');

		// Second occurrence is inside the math: the model counted it (it is in the
		// source), the rendered glyphs are a different string, so there is nothing
		// honest to paint - a positional hole, NOT a dropped entry.
		expect(activeRange(1)!.range).toBeNull();

		// Third occurrence: the trailing "x ends it." - the regression was this
		// ordinal landing on the invisible `<annotation>` copy of the math instead.
		const third = activeRange(2)!;
		expect(third.range).not.toBeNull();
		expect(third.range!.toString()).toBe('x');
		expect(contextFrom(third.range!)).toBe('x ends it.');
	});

	it('never emphasizes a clipped MathML node', () => {
		const { host, ranges } = pipeline(SRC, 'x');
		const mathml = host.querySelector('.katex-mathml');
		expect(mathml).not.toBeNull();
		for (const r of ranges) {
			if (!r) continue;
			expect(mathml!.contains(r.startContainer)).toBe(false);
		}
	});

	it('keeps prose ordinals aligned when the query is not in the math at all', () => {
		const { matches, ranges, activeRange } = pipeline(
			'the value $\\alpha^2$ is the second value, the last value.',
			'value'
		);
		expect(matches).toHaveLength(3);
		expect(ranges.filter((r) => r !== null)).toHaveLength(3);
		expect(contextFrom(activeRange(2)!.range!)).toBe('value.');
	});

	it('counts a display block once too', () => {
		const { matches, ranges, activeRange } = pipeline(
			'x above\n\n$$x^2 + 1$$\n\nx below',
			'x'
		);
		expect(matches).toHaveLength(3);
		expect(ranges).toHaveLength(3);
		expect(activeRange(1)!.range).toBeNull();
		expect(contextFrom(activeRange(2)!.range!)).toBe('x below');
	});

	it('counts an unparseable expression once (its error text is not a second copy)', () => {
		// KaTeX's error node renders a long message; the model still holds only the
		// source, so the walk must contribute the source, never the message.
		const { matches, ranges, activeRange } = pipeline('x one $\\frac{1}{$ x two', 'x');
		expect(ranges).toHaveLength(matches.length);
		expect(contextFrom(activeRange(matches.length - 1)!.range!)).toBe('x two');
	});
});

// The SECOND error-node shape. `throwOnError:false` suppresses only `ParseError`, so
// any other throw - a `RangeError` from deeply nested input is the reachable one -
// propagates out of KaTeX and is caught by the markdown-it plugin instead. Its node
// is the INVERSE of KaTeX's: the latex lives in `title` and the visible text is the
// error message, so a walk that reads either place unconditionally contributes the
// wrong string for one of them and slides every later ordinal.
describe('the markdown-it plugin error node (the non-ParseError catch path)', () => {
	/** Nested deeply enough to overflow the parser's stack, whatever the runtime. */
	const DEPTH = 20000;
	const NESTED = '{'.repeat(DEPTH) + '}'.repeat(DEPTH);

	it('is really the plugin`s node, not KaTeX`s (inverted: latex in title, message in text)', () => {
		const { host } = pipeline(`one $${NESTED}$ two`, 'zzz-no-match');
		const err = host.querySelector('.katex-error')!;
		expect(err).not.toBeNull();
		expect(err.tagName).toBe('SPAN');
		// KaTeX's own node would carry the error color; the plugin's sets no style.
		expect(err.hasAttribute('style')).toBe(false);
		expect(err.textContent).toContain('RangeError');
		expect(err.getAttribute('title')).toHaveLength(NESTED.length);
	});

	it('contributes the SOURCE TeX, so the region has the model`s own match count', () => {
		// A length assertion with teeth: every one of the source's braces must be in
		// the reconstructed region. Reading the visible text instead yields the error
		// message, which has none of them.
		const { matches, ranges } = pipeline(`one $${NESTED}$ two`, '{');
		expect(matches).toHaveLength(DEPTH);
		expect(ranges).toHaveLength(DEPTH);
	});

	it('keeps later prose ordinals aligned (inline form)', () => {
		// "error" appears twice in the source but a THIRD time in the message the
		// buggy walk contributed ("RangeError: …"), which pushed the trailing prose
		// occurrence onto an unpaintable hole.
		const { matches, ranges, activeRange } = pipeline(`error one $${NESTED}$ error two`, 'error');
		expect(matches).toHaveLength(2);
		expect(ranges).toHaveLength(2);
		expect(contextFrom(activeRange(1)!.range!)).toBe('error two');
	});

	it('keeps later prose ordinals aligned (block form, a `<p class="katex-block katex-error">`)', () => {
		const { matches, ranges, activeRange } = pipeline(
			`error above\n\n$$\n${NESTED}\n$$\n\nerror below`,
			'error'
		);
		expect(matches).toHaveLength(2);
		expect(ranges).toHaveLength(2);
		expect(contextFrom(activeRange(1)!.range!)).toBe('error below');
	});
});

// The delimiter has to come from what the SOURCE wrote, never from what KaTeX chose
// to render.
describe('delimiter reconstruction', () => {
	it('keeps ONE `$` for inline math the plugin promoted to display mode', () => {
		// `\begin{align}` makes the plugin render inline math in displayMode, so
		// `.katex-display` appears over a single-`$` source; rebuilding `$$…$$` from it
		// invents two delimiters per side and shifts every later `$` ordinal.
		const { matches, ranges, activeRange } = pipeline(
			'a $\\begin{align} x &= 1 \\end{align}$ b costs $5 total',
			'$'
		);
		expect(matches).toHaveLength(3); // the two delimiters + the literal price
		expect(ranges).toHaveLength(3);
		expect(activeRange(0)!.range).toBeNull(); // opening delimiter: inside the math
		expect(activeRange(1)!.range).toBeNull(); // closing delimiter
		expect(contextFrom(activeRange(2)!.range!)).toBe('$5 total'); // the prose price
	});

	it('drops the backticks of the ``$`x`$`` form, because the model drops them too', () => {
		// `strippedMarkdown` strips code-span backticks, so the model's text for this
		// source is `$a+b$` - reconstructing them here would ADD occurrences the model
		// never counted.
		const SRC = 'before $`a+b`$ after';
		const backtick = pipeline(SRC, '`');
		// Nothing to paint on the RENDERED surface: the model's rendered-markdown text
		// has no backtick, so neither may the walk (the raw-source matches that remain
		// belong to the editor surface, a different field-group entirely).
		expect(backtick.matches.filter((m) => m.field === 'markdown')).toHaveLength(0);
		expect(backtick.ranges).toHaveLength(0);
		const { matches, ranges, activeRange } = pipeline(SRC, 'a');
		expect(matches).toHaveLength(2);
		expect(ranges).toHaveLength(2);
		expect(activeRange(0)!.range).toBeNull(); // the `a` inside the math
		expect(contextFrom(activeRange(1)!.range!)).toBe('after');
	});
});
