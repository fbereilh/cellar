import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createNowTicker, NOW_TICK_MS } from '../../src/lib/nowTicker';

/**
 * The shared app-wide "now" ticker (replaces the per-cell setInterval that made a
 * 200-cell notebook run ~200 timers). These pin the ref-counting invariants the
 * whole consolidation rests on: exactly ONE interval regardless of subscriber
 * count, a tick that actually advances the label source, and no leaked timer when
 * every subscriber (cell) unmounts.
 */
describe('createNowTicker', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('runs exactly ONE interval no matter how many subscribers (cells)', () => {
		const ticker = createNowTicker(() => {}, 15000);
		expect(ticker.running).toBe(false);

		// Simulate 200 cells subscribing.
		const releases = Array.from({ length: 200 }, () => ticker.subscribe());
		expect(ticker.count).toBe(200);
		expect(ticker.running).toBe(true);
		// Only one interval is armed: vitest tracks a single pending timer.
		expect(vi.getTimerCount()).toBe(1);

		// Releasing all but one keeps the single interval running.
		for (const r of releases.slice(1)) r();
		expect(ticker.count).toBe(1);
		expect(ticker.running).toBe(true);
		expect(vi.getTimerCount()).toBe(1);
	});

	it('ticks the label source on the shared cadence', () => {
		let ticks = 0;
		const ticker = createNowTicker(() => ticks++, 15000);

		const release = ticker.subscribe();
		// Fires once immediately on start so a fresh subscriber is never stale.
		expect(ticks).toBe(1);

		vi.advanceTimersByTime(15000);
		expect(ticks).toBe(2);
		vi.advanceTimersByTime(15000);
		expect(ticks).toBe(3);

		release();
	});

	it('stops the interval when the last subscriber releases — no leaked timer', () => {
		const ticker = createNowTicker(() => {}, 15000);
		const a = ticker.subscribe();
		const b = ticker.subscribe();
		expect(ticker.running).toBe(true);

		a();
		expect(ticker.running).toBe(true); // b still needs it
		b();
		expect(ticker.running).toBe(false); // last one out stops the timer
		expect(ticker.count).toBe(0);
		expect(vi.getTimerCount()).toBe(0);

		// No further ticks after teardown.
		let ticks = 0;
		const t2 = createNowTicker(() => ticks++, 15000);
		const r = t2.subscribe();
		r();
		vi.advanceTimersByTime(60000);
		expect(ticks).toBe(1); // only the immediate start tick, none after release
	});

	it('a re-subscribe after full teardown re-arms exactly one interval', () => {
		const ticker = createNowTicker(() => {}, 15000);
		ticker.subscribe()();
		expect(ticker.running).toBe(false);
		const r = ticker.subscribe();
		expect(ticker.running).toBe(true);
		expect(vi.getTimerCount()).toBe(1);
		r();
	});

	it('cleanup is idempotent — a double release never over-decrements', () => {
		const ticker = createNowTicker(() => {}, 15000);
		const a = ticker.subscribe();
		const b = ticker.subscribe();
		a();
		a(); // double release of the same subscription
		expect(ticker.count).toBe(1); // still only b outstanding, not -1
		expect(ticker.running).toBe(true);
		b();
		expect(ticker.count).toBe(0);
		expect(ticker.running).toBe(false);
	});

	it('exposes a sane default cadence', () => {
		expect(NOW_TICK_MS).toBe(15000);
	});
});
