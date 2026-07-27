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
