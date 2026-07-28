// @vitest-environment jsdom
/**
 * The DataFrame grid must key its rows by POSITION, never by the pandas index label.
 *
 * A pandas index is not guaranteed unique, so keying the row `{#each}` by the label
 * throws Svelte's `each_key_duplicate` during render. Nothing wraps a cell in an
 * error boundary, so that uncaught error takes down the whole notebook's render
 * tree: with windowing on the render loop dies the moment the offending cell scrolls
 * into the window (everything below it stays blank forever, in the same place every
 * time), and with "Render all cells" on it throws at load and NOTHING renders.
 *
 * Two halves, because either alone would be misleading:
 *   1. the PRECONDITION, through the real parser - ordinary pandas output really does
 *      carry duplicate index labels (a plain `set_index`, and a flattened MultiIndex
 *      whose joined parts collide), so the label is genuinely unusable as a key;
 *   2. a SOURCE GUARD on the keyed `{#each}` - the whole defect is one expression
 *      wide, and vitest deliberately runs without the SvelteKit plugin (see
 *      vitest.config.ts), so the component cannot be mounted here. The behavioural
 *      proof lives in `tests/e2e/dataframe-duplicate-index.spec.ts`, which renders
 *      the real thing in a browser and asserts ZERO console errors.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePandasDataFrameHtml } from '../../src/lib/dataframeHtml';

// `import.meta.url` is not a file: URL under the jsdom environment, so resolve the
// repo from vitest's cwd (the project root) instead.
const REPO = process.cwd();

/** A pandas `_repr_html_` table with the given row headers (the index labels). */
function pandasHtml(indexLabels: string[][], columns = ['value']): string {
	const head = `<tr style="text-align: right;"><th></th>${columns.map((c) => `<th>${c}</th>`).join('')}</tr>`;
	const body = indexLabels
		.map(
			(labels, r) =>
				`<tr>${labels.map((l) => `<th>${l}</th>`).join('')}${columns.map((_, c) => `<td>${r * 10 + c}</td>`).join('')}</tr>`
		)
		.join('');
	return `<div><table border="1" class="dataframe"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

/** How `DataFrameGrid` derives a row's key: its position in the payload. */
const rowKeys = (data: unknown[][]) => data.map((_, i) => i);

describe('a pandas index is not unique, so it cannot key the grid', () => {
	it('parses a plain duplicate index (set_index on a repeated column)', () => {
		// The shape from the reported notebook: `.set_index("bidder_id")` where one
		// bidder bid three times and another twice.
		const payload = parsePandasDataFrameHtml(
			pandasHtml([['3376'], ['3376'], ['3376'], ['3788'], ['3788'], ['5272']])
		);
		expect(payload).not.toBeNull();
		expect(payload!.index).toEqual([3376, 3376, 3376, 3788, 3788, 5272]);
		// The precondition: labels repeat, so they are NOT usable as keys...
		expect(new Set(payload!.index).size).toBeLessThan(payload!.index.length);
		// ...while positions are unique for the very same payload.
		expect(new Set(rowKeys(payload!.data)).size).toBe(payload!.data.length);
	});

	it('parses a flattened MultiIndex whose joined labels collide', () => {
		// dataframeHtml joins a MultiIndex row's parts with ' / ', so two distinct
		// tuples can flatten onto one label (here: a groupby over arm x outcome).
		const payload = parsePandasDataFrameHtml(
			pandasHtml([
				['control', 'win'],
				['control', 'win'],
				['test', 'win'],
				['test', 'win']
			])
		);
		expect(payload).not.toBeNull();
		expect(payload!.index).toEqual(['control / win', 'control / win', 'test / win', 'test / win']);
		expect(new Set(payload!.index).size).toBeLessThan(payload!.index.length);
		expect(new Set(rowKeys(payload!.data)).size).toBe(payload!.data.length);
	});

	it('a unique index still parses normally (the fix changes nothing for it)', () => {
		const payload = parsePandasDataFrameHtml(pandasHtml([['a'], ['b'], ['c']]));
		expect(payload!.index).toEqual(['a', 'b', 'c']);
		expect(new Set(payload!.index).size).toBe(payload!.index.length);
	});
});

describe('DataFrameGrid source guard', () => {
	const src = readFileSync(join(REPO, 'src/lib/DataFrameGrid.svelte'), 'utf8');

	it('keys the row {#each} by the row POSITION, never by the index label', () => {
		const each = src.match(/\{#each pageRows as row \(([^)]*)\)\}/);
		expect(each, 'the pageRows {#each} should still exist').not.toBeNull();
		expect(each![1].trim()).toBe('row.key');
		// The exact regression this file exists to prevent.
		expect(src).not.toContain('{#each pageRows as row (row.idx)}');
	});

	it('derives that key from the row index of the payload, not from the label', () => {
		// `key: i` where `i` is the .map() position - the property that makes keys
		// unique for ANY payload, including the duplicate-index ones above.
		expect(src).toMatch(/rawData\.map\(\s*\(cells,\s*i\)\s*=>\s*\(\{\s*key:\s*i\s*,/);
	});
});
