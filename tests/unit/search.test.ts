/**
 * In-notebook search engine (P1 - source-only substring, cached).
 *
 * Covers the contract the sidebar Search (and later the find-bar) depend on:
 * every match in document order with correct positions/counts, case-insensitive
 * default + unicode, whole-word, and - the perf primitive - a per-cell cache
 * that lowercases each cell's text ONCE per content change, not per keystroke.
 */
import { describe, it, expect, vi } from 'vitest';
import {
	searchNotebook,
	groupByCell,
	createSearchCache,
	contentSignature,
	DEFAULT_SEARCH_OPTS,
	type SearchOpts
} from '../../src/lib/search';

interface TCell {
	id: string;
	cell_type: string;
	source: string;
}
const cell = (id: string, source: string, cell_type = 'code'): TCell => ({ id, cell_type, source });
const opts = (o: Partial<SearchOpts> = {}): SearchOpts => ({ ...DEFAULT_SEARCH_OPTS, ...o });

describe('searchNotebook - basics', () => {
	it('returns [] for an empty query', () => {
		const cells = [cell('a', 'import pandas as pd')];
		expect(searchNotebook(cells, '')).toEqual([]);
		expect(searchNotebook(cells, '', DEFAULT_SEARCH_OPTS, createSearchCache())).toEqual([]);
	});

	it('finds a substring, case-insensitive by default', () => {
		const cells = [cell('a', 'import Pandas as PD')];
		const m = searchNotebook(cells, 'pandas');
		expect(m).toHaveLength(1);
		expect(m[0]).toMatchObject({ cellId: 'a', field: 'source', start: 7, end: 13, line: 1 });
	});

	it('returns EVERY match, not one per cell', () => {
		const cells = [cell('a', 'foo foo foo')];
		const m = searchNotebook(cells, 'foo');
		expect(m).toHaveLength(3);
		expect(m.map((x) => x.start)).toEqual([0, 4, 8]);
	});

	it('reports matches in document order across cells', () => {
		const cells = [cell('a', 'x = 1'), cell('b', 'y = x + 1'), cell('c', 'x = x')];
		const m = searchNotebook(cells, 'x');
		expect(m.map((x) => x.cellId)).toEqual(['a', 'b', 'c', 'c']);
		// within c: two matches at offsets 0 and 4
		const cMatches = m.filter((x) => x.cellId === 'c');
		expect(cMatches.map((x) => x.start)).toEqual([0, 4]);
	});

	it('computes correct 1-based line numbers', () => {
		const cells = [cell('a', 'line one\nline two target\nthree target')];
		const m = searchNotebook(cells, 'target');
		expect(m).toHaveLength(2);
		expect(m[0].line).toBe(2);
		expect(m[1].line).toBe(3);
	});

	it('snippets the matching line, trimmed and capped at 80', () => {
		const long = '   spam ' + 'x'.repeat(200);
		const cells = [cell('a', `first\n${long}`)];
		const m = searchNotebook(cells, 'spam');
		expect(m[0].snippet.startsWith('spam')).toBe(true);
		expect(m[0].snippet.length).toBeLessThanOrEqual(80);
	});

	it('skips empty-source cells', () => {
		const cells = [cell('a', ''), cell('b', 'target'), cell('c', '')];
		const m = searchNotebook(cells, 'target');
		expect(m).toHaveLength(1);
		expect(m[0].cellId).toBe('b');
	});
});

describe('searchNotebook - case sensitivity + unicode', () => {
	it('case-sensitive only matches exact case', () => {
		const cells = [cell('a', 'Foo foo FOO')];
		const m = searchNotebook(cells, 'Foo', opts({ caseSensitive: true }));
		expect(m).toHaveLength(1);
		expect(m[0].start).toBe(0);
	});

	it('is case-insensitive across accented latin (length-preserving)', () => {
		const cells = [cell('a', 'Café CAFÉ café')];
		const m = searchNotebook(cells, 'café');
		expect(m).toHaveLength(3);
		expect(m.map((x) => x.start)).toEqual([0, 5, 10]);
	});

	it('is case-insensitive across non-latin scripts', () => {
		// Cyrillic folds case length-preservingly (Ф U+0424 <-> ф U+0444).
		const cells = [cell('a', 'Ф ф привет ПРИВЕТ')];
		expect(searchNotebook(cells, 'ф')).toHaveLength(2); // Ф and ф
		expect(searchNotebook(cells, 'привет')).toHaveLength(2); // both cases
	});

	it('offsets stay correct after multibyte (astral) characters', () => {
		const cells = [cell('a', '😀 target')];
		const m = searchNotebook(cells, 'target');
		expect(m).toHaveLength(1);
		// '😀' is two UTF-16 code units + a space => offset 3
		expect(m[0].start).toBe(3);
	});
});

describe('searchNotebook - whole word', () => {
	it('requires word boundaries when wholeWord is set', () => {
		const cells = [cell('a', 'cat category cat_dog scatter cat')];
		const m = searchNotebook(cells, 'cat', opts({ wholeWord: true }));
		// only the standalone "cat" at start and the trailing "cat" qualify
		expect(m.map((x) => x.start)).toEqual([0, 29]);
	});

	it('without wholeWord, matches inside words too', () => {
		const cells = [cell('a', 'scatter cat')];
		expect(searchNotebook(cells, 'cat', opts({ wholeWord: false }))).toHaveLength(2);
	});
});

describe('searchNotebook - cache invalidation', () => {
	it('reuses the SAME cache entry across queries (no re-lowercase on a cache hit)', () => {
		const cells = [cell('a', 'Alpha Beta Gamma')];
		const cache = createSearchCache();
		searchNotebook(cells, 'alpha', DEFAULT_SEARCH_OPTS, cache);
		const entry1 = cache.get('a');
		expect(entry1).toBeDefined();
		// Different queries over unchanged content must not rebuild the entry.
		searchNotebook(cells, 'beta', DEFAULT_SEARCH_OPTS, cache);
		searchNotebook(cells, 'gamma', DEFAULT_SEARCH_OPTS, cache);
		expect(cache.get('a')).toBe(entry1); // identical object => lowercased buffer reused
	});

	it('rebuilds the cache entry when a cell edits (content signature changes)', () => {
		const cache = createSearchCache();
		searchNotebook([cell('a', 'version one')], 'one', DEFAULT_SEARCH_OPTS, cache);
		const entry1 = cache.get('a');
		// Same id, edited source -> new signature -> fresh entry.
		searchNotebook([cell('a', 'version two')], 'two', DEFAULT_SEARCH_OPTS, cache);
		expect(cache.get('a')).not.toBe(entry1);
	});

	it('lowercases the source once per content change, not per keystroke', () => {
		// The only toLowerCase calls in a case-insensitive search are: the query
		// (once per call) and the source (once per cache MISS). So per call the
		// count is 1 (hit) or 2 (miss). Typing a query over stable content must
		// lowercase the source exactly once (the first, missing call).
		const src = 'ZQXJ_NEEDLE ZQXJ';
		const cache = createSearchCache();
		const spy = vi.spyOn(String.prototype, 'toLowerCase');
		try {
			const deltas: number[] = [];
			for (const q of ['z', 'zq', 'zqx', 'zqxj']) {
				const before = spy.mock.calls.length;
				searchNotebook([cell('a', src)], q, DEFAULT_SEARCH_OPTS, cache);
				deltas.push(spy.mock.calls.length - before);
			}
			// First keystroke: query + source (miss) = 2. Every later keystroke: query only = 1.
			expect(deltas).toEqual([2, 1, 1, 1]);
			// A no-cache implementation would re-lowercase the source every keystroke (2,2,2,2).
		} finally {
			spy.mockRestore();
		}
	});

	it('an edit forces exactly one more lowercase of the new content', () => {
		const cache = createSearchCache();
		const spy = vi.spyOn(String.prototype, 'toLowerCase');
		try {
			const delta = (fn: () => void) => {
				const before = spy.mock.calls.length;
				fn();
				return spy.mock.calls.length - before;
			};
			expect(delta(() => searchNotebook([cell('a', 'VERSION ONE')], 'one', DEFAULT_SEARCH_OPTS, cache))).toBe(2); // miss
			expect(delta(() => searchNotebook([cell('a', 'VERSION ONE')], 'ver', DEFAULT_SEARCH_OPTS, cache))).toBe(1); // hit
			expect(delta(() => searchNotebook([cell('a', 'VERSION TWO')], 'two', DEFAULT_SEARCH_OPTS, cache))).toBe(2); // edit -> miss
		} finally {
			spy.mockRestore();
		}
	});
});

describe('contentSignature', () => {
	it('is stable for identical strings and differs on change', () => {
		expect(contentSignature('hello world')).toBe(contentSignature('hello world'));
		expect(contentSignature('hello world')).not.toBe(contentSignature('hello worlD'));
		expect(contentSignature('abc')).not.toBe(contentSignature('abcd'));
	});
});

describe('groupByCell', () => {
	it('groups matches by cell in first-occurrence (document) order with counts', () => {
		const cells = [cell('a', 'foo'), cell('b', 'foo foo'), cell('c', 'nope')];
		const m = searchNotebook(cells, 'foo');
		const groups = groupByCell(m, (id) => cells.find((c) => c.id === id)!.cell_type);
		expect(groups.map((g) => g.cellId)).toEqual(['a', 'b']);
		expect(groups.map((g) => g.count)).toEqual([1, 2]);
		expect(groups[0].snippet).toBe('foo');
	});
});
