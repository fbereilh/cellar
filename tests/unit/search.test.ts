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
	strippedMarkdown,
	SEARCH_SCAN_CAP,
	DEFAULT_SEARCH_OPTS,
	type SearchOpts
} from '../../src/lib/search';
import type { CellOutput } from '../../src/lib/server/types';

interface TCell {
	id: string;
	cell_type: string;
	source: string;
	outputs?: CellOutput[];
}
const cell = (id: string, source: string, cell_type = 'code'): TCell => ({ id, cell_type, source });
// P1 default was source-only; keep these unit tests deterministic against the
// engine's *source* behavior by pinning scope:'source' unless a case opts into 'all'.
const opts = (o: Partial<SearchOpts> = {}): SearchOpts => ({
	...DEFAULT_SEARCH_OPTS,
	scope: 'source',
	...o
});
const allOpts = (o: Partial<SearchOpts> = {}): SearchOpts => ({
	...DEFAULT_SEARCH_OPTS,
	scope: 'all',
	...o
});

// nbformat output builders for the P2 coverage tests.
const streamOut = (text: string, name = 'stdout'): CellOutput => ({
	output_type: 'stream',
	name,
	text
});
const resultOut = (text: string): CellOutput => ({
	output_type: 'execute_result',
	data: { 'text/plain': text },
	metadata: {},
	execution_count: 1
});
const errorOut = (ename: string, evalue: string, traceback: string[]): CellOutput => ({
	output_type: 'error',
	ename,
	evalue,
	traceback
});
const dataframeOut = (columns: string[], data: unknown[][]): CellOutput => ({
	output_type: 'execute_result',
	data: {
		'application/vnd.cellar.dataframe+json': {
			columns,
			dtypes: columns.map(() => 'object'),
			index: data.map((_, i) => i),
			index_name: '',
			data,
			total_rows: data.length,
			total_cols: columns.length
		}
	},
	metadata: {},
	execution_count: 1
});

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

	it('rebuilds the cached buffer when a cell edits (content signature changes)', () => {
		const cache = createSearchCache();
		// The old query must no longer match after the edit, and the new one must.
		expect(searchNotebook([cell('a', 'version one')], 'one', DEFAULT_SEARCH_OPTS, cache)).toHaveLength(1);
		// Same id, edited source -> new signature -> the source buffer is rebuilt in
		// place (the entry object is reused so the independent outputs cache survives
		// a source-only edit; see the output-cache-invalidation tests).
		expect(searchNotebook([cell('a', 'version two')], 'two', DEFAULT_SEARCH_OPTS, cache)).toHaveLength(1);
		expect(searchNotebook([cell('a', 'version two')], 'one', DEFAULT_SEARCH_OPTS, cache)).toHaveLength(0);
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
		const m = searchNotebook(cells, 'foo', opts());
		const groups = groupByCell(m, (id) => cells.find((c) => c.id === id)!.cell_type);
		expect(groups.map((g) => g.cellId)).toEqual(['a', 'b']);
		expect(groups.map((g) => g.count)).toEqual([1, 2]);
		expect(groups[0].snippet).toBe('foo');
		expect(groups[0].field).toBe('source');
	});
});

// ---- P2: coverage (outputs + rendered markdown, capped, scope toggle) ----------

describe('scope: default is all (source + markdown + outputs)', () => {
	it('DEFAULT_SEARCH_OPTS.scope is "all"', () => {
		expect(DEFAULT_SEARCH_OPTS.scope).toBe('all');
	});
});

describe('searchNotebook - output coverage (scope:all)', () => {
	it('finds a match in a printed stream value', () => {
		const cells: TCell[] = [
			{ id: 'a', cell_type: 'code', source: 'print(x)', outputs: [streamOut('the answer is 42\n')] }
		];
		const m = searchNotebook(cells, 'answer', allOpts());
		expect(m).toHaveLength(1);
		expect(m[0]).toMatchObject({ cellId: 'a', field: 'output', outputIndex: 0 });
		expect(m[0].snippet).toContain('answer');
	});

	it('finds a match in an execute_result text/plain repr', () => {
		const cells: TCell[] = [
			{ id: 'a', cell_type: 'code', source: 'x', outputs: [resultOut("'hello world'")] }
		];
		const m = searchNotebook(cells, 'world', allOpts());
		expect(m).toHaveLength(1);
		expect(m[0].field).toBe('output');
	});

	it('finds a match in an error message / traceback (ANSI stripped)', () => {
		const cells: TCell[] = [
			{
				id: 'a',
				cell_type: 'code',
				source: 'boom()',
				outputs: [
					errorOut('ValueError', 'bad thing happened', [
						'[0;31mTraceback (most recent call last)[0m',
						'[0;31mValueError[0m: bad thing happened'
					])
				]
			}
		];
		const m = searchNotebook(cells, 'bad thing', allOpts());
		expect(m.length).toBeGreaterThanOrEqual(1);
		expect(m[0].field).toBe('output');
		// The ANSI escape must not leak into the searchable text.
		expect(m.some((x) => x.snippet.includes(''))).toBe(false);
	});

	it('finds a match inside a DataFrame cell value (structured payload)', () => {
		const cells: TCell[] = [
			{
				id: 'a',
				cell_type: 'code',
				source: 'df',
				outputs: [dataframeOut(['name', 'city'], [['alice', 'berlin'], ['bob', 'tokyo']])]
			}
		];
		expect(searchNotebook(cells, 'berlin', allOpts())).toHaveLength(1);
		expect(searchNotebook(cells, 'city', allOpts()).some((x) => x.field === 'output')).toBe(true);
	});

	it('tags matches with their output index across multiple outputs', () => {
		const cells: TCell[] = [
			{
				id: 'a',
				cell_type: 'code',
				source: 'x',
				outputs: [streamOut('needle here\n'), resultOut('another needle')]
			}
		];
		const m = searchNotebook(cells, 'needle', allOpts());
		expect(m.map((x) => x.outputIndex)).toEqual([0, 1]);
	});

	it('scope:source ignores outputs entirely (P1 behavior preserved)', () => {
		const cells: TCell[] = [
			{ id: 'a', cell_type: 'code', source: 'x', outputs: [streamOut('answer 42\n')] }
		];
		expect(searchNotebook(cells, 'answer', opts())).toEqual([]);
		expect(searchNotebook(cells, 'answer', allOpts())).toHaveLength(1);
	});

	it('does not match rich non-text output (no text/plain fallback)', () => {
		const image: CellOutput = {
			output_type: 'display_data',
			data: { 'image/png': 'iVBORencodedbytes' },
			metadata: {}
		};
		const cells: TCell[] = [{ id: 'a', cell_type: 'code', source: 'plot', outputs: [image] }];
		expect(searchNotebook(cells, 'encodedbytes', allOpts())).toEqual([]);
	});
});

describe('searchNotebook - rendered-markdown coverage (scope:all)', () => {
	it('finds a heading word even though the source has ## syntax', () => {
		const cells = [cell('a', '## Setup Instructions', 'markdown')];
		const m = searchNotebook(cells, 'Setup', allOpts());
		// One match in raw source, one in the rendered-markdown text.
		expect(m.map((x) => x.field).sort()).toEqual(['markdown', 'source']);
	});

	it('finds a link/emphasis word that is hidden by md syntax in source', () => {
		// "docs" is the visible link text; the query has no md punctuation so it only
		// matches the rendered text, not the raw `[docs](http://x)`.
		const cells = [cell('a', 'see the [docs](http://example.com) now', 'markdown')];
		const m = searchNotebook(cells, 'docs', allOpts());
		expect(m.some((x) => x.field === 'markdown')).toBe(true);
	});

	it('scope:source only searches raw markdown source', () => {
		const cells = [cell('a', '## Setup', 'markdown')];
		const m = searchNotebook(cells, 'Setup', opts());
		expect(m).toHaveLength(1);
		expect(m[0].field).toBe('source');
	});
});

describe('strippedMarkdown', () => {
	it('strips headings, emphasis, links, code, and list markers', () => {
		expect(strippedMarkdown('## Setup').trim()).toBe('Setup');
		expect(strippedMarkdown('**bold** and *italic*')).toBe('bold and italic');
		expect(strippedMarkdown('[docs](http://x)')).toBe('docs');
		expect(strippedMarkdown('![alt text](img.png)')).toBe('alt text');
		expect(strippedMarkdown('use `pd.read_csv`')).toBe('use pd.read_csv');
		expect(strippedMarkdown('- item one').trim()).toBe('item one');
		expect(strippedMarkdown('1. first').trim()).toBe('first');
		expect(strippedMarkdown('> a quote').trim()).toBe('a quote');
	});
});

describe('searchNotebook - per-cell output cap', () => {
	it('scans a giant output only up to SEARCH_SCAN_CAP', () => {
		// A needle placed just past the cap is NOT found; one just before it is.
		const filler = 'a'.repeat(SEARCH_SCAN_CAP + 500);
		const before = filler.slice(0, SEARCH_SCAN_CAP - 10) + 'NEEDLE' + filler.slice(SEARCH_SCAN_CAP - 4);
		const past = 'x'.repeat(SEARCH_SCAN_CAP + 100) + 'BEYOND';
		const cells: TCell[] = [
			{ id: 'a', cell_type: 'code', source: 's', outputs: [streamOut(before)] },
			{ id: 'b', cell_type: 'code', source: 's', outputs: [streamOut(past)] }
		];
		expect(searchNotebook(cells, 'NEEDLE', allOpts())).toHaveLength(1);
		expect(searchNotebook(cells, 'BEYOND', allOpts())).toEqual([]);
	});

	it('caps across multiple outputs of one cell (total, not per-output)', () => {
		const big = 'y'.repeat(SEARCH_SCAN_CAP);
		const cells: TCell[] = [
			{ id: 'a', cell_type: 'code', source: 's', outputs: [streamOut(big), streamOut('TAIL')] }
		];
		// The first output already fills the cap, so the second is never scanned.
		expect(searchNotebook(cells, 'TAIL', allOpts())).toEqual([]);
	});
});

describe('searchNotebook - output cache invalidation (scope:all)', () => {
	it('rebuilds the output cache only when the outputs array identity changes', () => {
		const cache = createSearchCache();
		const outs1 = [streamOut('alpha beta')];
		const c1: TCell = { id: 'a', cell_type: 'code', source: 's', outputs: outs1 };
		// First scan extracts + lowercases the outputs once.
		searchNotebook([c1], 'alpha', allOpts(), cache);
		const built1 = cache.get('a')!;
		// A different query over the SAME outputs array reuses the extracted text.
		const spy = vi.spyOn(String.prototype, 'toLowerCase');
		try {
			searchNotebook([c1], 'beta', allOpts(), cache);
			// Only the query is lowercased on a hit (outputs text reused).
			const hitCalls = spy.mock.calls.length;
			expect(hitCalls).toBe(1);
			// Re-running the cell (a NEW outputs array) forces re-extraction.
			const c2: TCell = { id: 'a', cell_type: 'code', source: 's', outputs: [streamOut('gamma')] };
			spy.mock.calls.length = 0;
			searchNotebook([c2], 'gamma', allOpts(), cache);
			// query + the new output text = 2 lowercases.
			expect(spy.mock.calls.length).toBe(2);
		} finally {
			spy.mockRestore();
		}
		expect(built1).toBe(cache.get('a')); // same entry object, output slot swapped in place
	});

	it('editing source does not re-extract unchanged outputs', () => {
		const cache = createSearchCache();
		const outs = [streamOut('printed value')];
		searchNotebook(
			[{ id: 'a', cell_type: 'code', source: 'x = 1', outputs: outs }],
			'value',
			allOpts(),
			cache
		);
		const spy = vi.spyOn(String.prototype, 'toLowerCase');
		try {
			// Same outputs array reference, edited source.
			searchNotebook(
				[{ id: 'a', cell_type: 'code', source: 'x = 2', outputs: outs }],
				'value',
				allOpts(),
				cache
			);
			// query (1) + the edited source re-lowercase (1) = 2; the output text is NOT
			// re-lowercased (its array identity is unchanged).
			expect(spy.mock.calls.length).toBe(2);
		} finally {
			spy.mockRestore();
		}
	});
});
