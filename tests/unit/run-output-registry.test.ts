import { describe, it, expect, beforeEach } from 'vitest';
import {
	registerRunOutputs,
	unregisterRunOutputs,
	truncateActiveRunOutputs,
	__resetRunOutputRegistry
} from '../../src/lib/server/run-output-registry';

/**
 * The seam between the clear path and the run producing the outputs. What matters
 * is WHICH accumulator a clear reaches: it must be the one belonging to that exact
 * (notebook, cell), and a clear of a cell with no run in flight must do nothing at
 * all — every clear goes through here and almost none lands on a running cell.
 */
function spy() {
	let resets = 0;
	return { acc: { reset: () => void resets++ }, count: () => resets };
}

beforeEach(() => __resetRunOutputRegistry());

describe('run-output registry', () => {
	it('truncates the accumulator of the run in flight for that cell', () => {
		const a = spy();
		registerRunOutputs('/ws/nb.ipynb', 'c1', a.acc);

		expect(truncateActiveRunOutputs('/ws/nb.ipynb', 'c1')).toBe(true);
		expect(a.count()).toBe(1);
	});

	it('is a silent no-op when that cell has no run in flight', () => {
		expect(truncateActiveRunOutputs('/ws/nb.ipynb', 'c1')).toBe(false);
	});

	it('never reaches another cell of the same notebook', () => {
		const running = spy();
		const other = spy();
		registerRunOutputs('/ws/nb.ipynb', 'c1', running.acc);
		registerRunOutputs('/ws/nb.ipynb', 'c2', other.acc);

		truncateActiveRunOutputs('/ws/nb.ipynb', 'c1');

		expect(running.count()).toBe(1);
		expect(other.count()).toBe(0);
	});

	it('never reaches the same cell id in a DIFFERENT notebook', () => {
		// Cell ids are unique per document, not globally — two notebooks legitimately
		// hold a `c1`, and they run against separate kernels in parallel.
		const mine = spy();
		const theirs = spy();
		registerRunOutputs('/ws/a.ipynb', 'c1', mine.acc);
		registerRunOutputs('/ws/b.ipynb', 'c1', theirs.acc);

		truncateActiveRunOutputs('/ws/a.ipynb', 'c1');

		expect(mine.count()).toBe(1);
		expect(theirs.count()).toBe(0);
	});

	it('forgets a finished run, so a later clear truncates nothing', () => {
		const a = spy();
		registerRunOutputs('/ws/nb.ipynb', 'c1', a.acc);
		unregisterRunOutputs('/ws/nb.ipynb', 'c1');

		expect(truncateActiveRunOutputs('/ws/nb.ipynb', 'c1')).toBe(false);
		expect(a.count()).toBe(0);
	});

	it('re-running a cell replaces the entry, so a clear reaches the CURRENT run', () => {
		const first = spy();
		const second = spy();
		registerRunOutputs('/ws/nb.ipynb', 'c1', first.acc);
		registerRunOutputs('/ws/nb.ipynb', 'c1', second.acc);

		truncateActiveRunOutputs('/ws/nb.ipynb', 'c1');

		expect(second.count()).toBe(1);
		expect(first.count()).toBe(0);
	});
});
