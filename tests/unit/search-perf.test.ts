/**
 * Search keystroke-latency harness (P1 perf acceptance).
 *
 * Two honest, non-flaky claims about the engine at N=300:
 *
 *  1. **Flat at scale.** A single engine call over a 300-cell notebook stays well
 *     within one animation frame (~16ms), so even undebounced it never stalls a
 *     keystroke. (In the app the query is debounced ~120ms, so it runs far less
 *     often than this even measures.)
 *
 *  2. **Steady-state is flat, not worse than cold.** Re-searching stable content
 *     (cache hits) is no slower than searching it cold (a fresh cache each call).
 *     This guards against the cache adding overhead and pins the allocation-lean
 *     steady state the cache exists to provide.
 *
 * The *proof* that the cache avoids re-lowercasing lives in `search.test.ts`
 * (the toLowerCase call-count deltas). Wall-clock can't show that cleanly: V8's
 * ASCII `toLowerCase` is cheap next to the match scan, and unlike the legacy
 * one-result-per-cell filter this engine returns EVERY match (strictly more
 * work) - so a raw ms comparison to the old derived would be apples-to-oranges.
 * Timing is noisy, so both figures are best-of-many after a warmup.
 */
import { describe, it, expect } from 'vitest';
import { searchNotebook, createSearchCache, DEFAULT_SEARCH_OPTS } from '../../src/lib/search';
import type { CellOutput } from '../../src/lib/server/types';

interface TCell {
	id: string;
	cell_type: string;
	source: string;
	outputs?: CellOutput[];
}

/** A synthetic N-cell notebook with a mix of short/long code + markdown sources. */
function makeNotebook(n: number): TCell[] {
	const cells: TCell[] = [];
	for (let i = 0; i < n; i++) {
		const md = i % 5 === 0;
		const big = i % 7 === 0;
		const body = big
			? `# Section ${i}\n` + `some Analysis text with Pandas and numpy `.repeat(60)
			: `import pandas as pd\ndf${i} = pd.read_csv('data_${i}.csv')\nresult = df${i}.groupby('k').sum()`;
		cells.push({ id: `cell-${i}`, cell_type: md ? 'markdown' : 'code', source: body });
	}
	return cells;
}

/** One timed pass: type `query` a char at a time, running a search per prefix. */
function keystrokePass(query: string, run: (prefix: string) => void): number {
	const start = performance.now();
	for (let k = 1; k <= query.length; k++) run(query.slice(0, k));
	return performance.now() - start;
}

/** Time typing `query` one char at a time (a search per prefix), best-of-`runs`. */
function bestKeystrokeTime(query: string, run: (prefix: string) => void, runs: number): number {
	let best = Infinity;
	for (let r = 0; r < runs; r++) best = Math.min(best, keystrokePass(query, run));
	return best;
}

/**
 * Best-of-`runs` for TWO variants, measured ROUND-ROBIN rather than one after the
 * other.
 *
 * Timing all of A and then all of B lets a scheduling hiccup land entirely inside
 * one phase and permanently bias the comparison, because best-of only rescues a
 * phase that contains at least one quiet round. That is exactly how this test
 * flaked on a contended CI runner: both figures came back ~4x their idle value and
 * the ORDER inverted (cached 31.7ms vs cold 24.0ms, against a stable ~0.70 ratio on
 * an idle machine), so the assertion failed on runner noise rather than on anything
 * the engine did. Interleaving makes both variants sample the same noise window, so
 * a quiet moment is available to each and a busy one penalizes neither alone.
 */
function bestPairedKeystrokeTimes(
	query: string,
	a: (prefix: string) => void,
	b: (prefix: string) => void,
	runs: number
): { a: number; b: number } {
	let bestA = Infinity;
	let bestB = Infinity;
	for (let r = 0; r < runs; r++) {
		// Alternate which variant goes first, so neither systematically pays for the
		// other's cache/JIT warmth within a round.
		if (r % 2 === 0) {
			bestA = Math.min(bestA, keystrokePass(query, a));
			bestB = Math.min(bestB, keystrokePass(query, b));
		} else {
			bestB = Math.min(bestB, keystrokePass(query, b));
			bestA = Math.min(bestA, keystrokePass(query, a));
		}
	}
	return { a: bestA, b: bestB };
}

describe('search keystroke latency (N=300)', () => {
	const cells = makeNotebook(300);

	it('a single engine call stays within one animation frame', () => {
		const cache = createSearchCache();
		// Warm up (JIT + first-miss cache fill).
		for (const q of ['pandas', 'groupby', 'read_csv']) {
			for (let k = 1; k <= q.length; k++) searchNotebook(cells, q.slice(0, k), DEFAULT_SEARCH_OPTS, cache);
		}
		let worstPerCall = 0;
		for (const q of ['pandas', 'groupby', 'read_csv', 'numpy']) {
			let best = Infinity;
			for (let r = 0; r < 9; r++) {
				const start = performance.now();
				searchNotebook(cells, q, DEFAULT_SEARCH_OPTS, cache);
				best = Math.min(best, performance.now() - start);
			}
			worstPerCall = Math.max(worstPerCall, best);
		}
		// eslint-disable-next-line no-console
		console.log(`[search-perf N=300] worst single call=${worstPerCall.toFixed(3)}ms`);
		expect(worstPerCall).toBeLessThan(16);
	});

	it('scope:all with multi-MB outputs stays bounded (the per-cell cap holds)', () => {
		// Every cell carries a ~3 MB single-line output; without the SEARCH_SCAN_CAP
		// the engine would extract + lowercase ~900 MB per keystroke. With the cap it
		// scans at most SEARCH_SCAN_CAP chars/cell. A realistic query matches a
		// handful of times, so a settled query stays within a frame.
		const HUGE = 300;
		// A rare token near the start (within the cap) + megabytes of filler after it.
		const bigOutput = 'x'.repeat(5000) + 'RAREMARKER' + 'y'.repeat(3_000_000);
		const heavy: TCell[] = [];
		for (let i = 0; i < HUGE; i++) {
			heavy.push({
				id: `h-${i}`,
				cell_type: 'code',
				source: `df${i} = load()`,
				outputs: [{ output_type: 'stream', name: 'stdout', text: bigOutput }]
			});
		}
		const cache = createSearchCache();
		// Warm: first miss extracts+caps+lowercases each output once.
		searchNotebook(heavy, 'raremarker', DEFAULT_SEARCH_OPTS, cache);
		let best = Infinity;
		for (let r = 0; r < 9; r++) {
			const start = performance.now();
			const m = searchNotebook(heavy, 'raremarker', DEFAULT_SEARCH_OPTS, cache);
			best = Math.min(best, performance.now() - start);
			expect(m).toHaveLength(HUGE); // one match per cell, all inside the cap
		}
		// eslint-disable-next-line no-console
		console.log(`[search-perf N=300 big-outputs] warm call=${best.toFixed(3)}ms`);
		expect(best).toBeLessThan(16);
	});

	it('cache-hit (steady state) is no slower than cold', () => {
		const query = 'pandas';
		const warm = createSearchCache();
		for (let k = 1; k <= query.length; k++) searchNotebook(cells, query.slice(0, k), DEFAULT_SEARCH_OPTS, warm);

		// Measured round-robin, not one phase after the other: see
		// `bestPairedKeystrokeTimes` for why sequential phases made this flaky on CI.
		// Cold: a fresh cache each keystroke forces the source to be re-lowercased.
		const { a: cached, b: cold } = bestPairedKeystrokeTimes(
			query,
			(p) => searchNotebook(cells, p, DEFAULT_SEARCH_OPTS, warm),
			(p) => searchNotebook(cells, p, DEFAULT_SEARCH_OPTS, createSearchCache()),
			15
		);

		// eslint-disable-next-line no-console
		console.log(`[search-perf N=300] cached=${cached.toFixed(3)}ms cold=${cold.toFixed(3)}ms`);
		// Flat: steady state must not be materially slower than cold (allow timing noise).
		expect(cached).toBeLessThanOrEqual(cold * 1.3 + 0.05);
	});
});
