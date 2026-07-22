import { describe, it, expect } from 'vitest';
import { findOccurrences, buildCellHighlights } from '$lib/searchHighlight';
import type { Match } from '$lib/search';

function m(cellId: string, field: Match['field'], start: number, extra: Partial<Match> = {}): Match {
	return {
		cellId,
		field,
		start,
		end: start + 1,
		line: 1,
		snippet: '',
		...extra
	};
}

describe('findOccurrences', () => {
	it('finds every occurrence in order (case-insensitive default)', () => {
		expect(findOccurrences('abcABCabc', 'abc', { caseSensitive: false, wholeWord: false })).toEqual([
			{ start: 0, end: 3 },
			{ start: 3, end: 6 },
			{ start: 6, end: 9 }
		]);
	});

	it('honors case-sensitivity', () => {
		expect(findOccurrences('abcABC', 'ABC', { caseSensitive: true, wholeWord: false })).toEqual([
			{ start: 3, end: 6 }
		]);
		expect(findOccurrences('abcABC', 'abc', { caseSensitive: true, wholeWord: false })).toEqual([
			{ start: 0, end: 3 }
		]);
	});

	it('honors whole-word', () => {
		// "cat" inside "category" is rejected; the standalone word is kept.
		const hay = 'a cat in the category';
		expect(findOccurrences(hay, 'cat', { caseSensitive: false, wholeWord: true })).toEqual([
			{ start: 2, end: 5 }
		]);
	});

	it('returns nothing for an empty query or empty text', () => {
		expect(findOccurrences('abc', '', { caseSensitive: false, wholeWord: false })).toEqual([]);
		expect(findOccurrences('', 'abc', { caseSensitive: false, wholeWord: false })).toEqual([]);
	});

	it('advances past overlapping starts without infinite looping', () => {
		// A 1-char needle in a run of the same char.
		expect(findOccurrences('aaa', 'a', { caseSensitive: false, wholeWord: false })).toEqual([
			{ start: 0, end: 1 },
			{ start: 1, end: 2 },
			{ start: 2, end: 3 }
		]);
	});
});

describe('buildCellHighlights', () => {
	it('lists every cell that has ≥1 match, exactly once', () => {
		const matches = [m('a', 'source', 0), m('a', 'source', 5), m('b', 'output', 0, { outputIndex: 1 })];
		const map = buildCellHighlights(matches, 0);
		expect([...map.keys()].sort()).toEqual(['a', 'b']);
	});

	it('marks the active cell + surface + ordinal', () => {
		const matches = [
			m('a', 'source', 0), // idx 0
			m('a', 'source', 5), // idx 1 - second source match in 'a'
			m('b', 'output', 0, { outputIndex: 2 }) // idx 2
		];
		const map = buildCellHighlights(matches, 1);
		expect(map.get('a')!.active).toEqual({ field: 'source', ordinal: 1 });
		expect(map.get('b')!.active).toBeNull();
	});

	it('counts the ordinal within the same field only', () => {
		// Active match is the first OUTPUT match in cell 'a', even though a source
		// match precedes it in document order.
		const matches = [
			m('a', 'source', 0), // idx 0 (source)
			m('a', 'output', 0, { outputIndex: 0 }), // idx 1 (output, ordinal 0)
			m('a', 'output', 3, { outputIndex: 0 }) // idx 2 (output, ordinal 1)
		];
		const map = buildCellHighlights(matches, 2);
		expect(map.get('a')!.active).toEqual({ field: 'output', outputIndex: 0, ordinal: 1 });
	});

	it('handles an out-of-range active index gracefully (no active)', () => {
		const matches = [m('a', 'source', 0)];
		const map = buildCellHighlights(matches, 5);
		expect(map.get('a')!.active).toBeNull();
	});

	it('returns an empty map for no matches', () => {
		expect(buildCellHighlights([], 0).size).toBe(0);
	});
});
