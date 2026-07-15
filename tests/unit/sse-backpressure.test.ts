import { describe, it, expect } from 'vitest';
import { createBackpressureMonitor } from '../../src/lib/server/sse-backpressure';
import { subscribe, publish } from '../../src/lib/server/events';

/**
 * A fake stream controller whose `desiredSize` and a fake clock are both driven
 * by the test, so the reap logic is exercised without a real socket. Mirrors the
 * slice of `ReadableStreamDefaultController` the monitor reads.
 */
function harness(graceMs: number) {
	let desiredSize: number | null = 1;
	let clock = 0;
	let reaps = 0;
	const monitor = createBackpressureMonitor({
		controller: {
			get desiredSize() {
				return desiredSize;
			}
		},
		graceMs,
		onReap: () => {
			reaps += 1;
		},
		now: () => clock
	});
	return {
		monitor,
		set desiredSize(v: number | null) {
			desiredSize = v;
		},
		advance(ms: number) {
			clock += ms;
		},
		get reaps() {
			return reaps;
		}
	};
}

describe('sse backpressure monitor', () => {
	it('reaps a controller whose desiredSize stays <= 0 past the grace window', () => {
		const h = harness(15000);
		h.desiredSize = -3; // send buffer backing up
		expect(h.monitor.check()).toBe(false); // grace timer just started
		h.advance(14999);
		expect(h.monitor.check()).toBe(false); // still within grace
		h.advance(1); // now exactly at the grace boundary
		expect(h.monitor.check()).toBe(true); // reaped
		expect(h.reaps).toBe(1);
	});

	it('never reaps a healthy controller that keeps draining (desiredSize > 0)', () => {
		const h = harness(15000);
		for (let i = 0; i < 100; i++) {
			h.desiredSize = 1; // reader keeping up
			h.advance(1000);
			expect(h.monitor.check()).toBe(false);
		}
		expect(h.reaps).toBe(0);
	});

	it('a momentary dip below zero that recovers resets the grace timer (no reap)', () => {
		const h = harness(15000);
		h.desiredSize = -5; // brief burst backs the buffer up
		h.monitor.check();
		h.advance(5000); // 5s into the grace window
		h.monitor.check();
		h.desiredSize = 2; // drained — recovered
		expect(h.monitor.check()).toBe(false);
		// A later, unrelated dip must start a FRESH grace window, not resume the old one.
		h.desiredSize = -1;
		h.monitor.check();
		h.advance(14999);
		expect(h.monitor.check()).toBe(false); // would have reaped if the timer had not reset
		expect(h.reaps).toBe(0);
	});

	it('treats desiredSize === 0 as backed up (the highWaterMark is fully consumed)', () => {
		const h = harness(10000);
		h.desiredSize = 0;
		expect(h.monitor.check()).toBe(false);
		h.advance(10000);
		expect(h.monitor.check()).toBe(true);
		expect(h.reaps).toBe(1);
	});

	it('a null desiredSize (already closed/errored) is not treated as backpressure', () => {
		const h = harness(1000);
		h.desiredSize = null;
		h.advance(100000);
		expect(h.monitor.check()).toBe(false);
		expect(h.reaps).toBe(0);
	});

	it('reaps exactly once, then is idempotent (no double teardown)', () => {
		const h = harness(1000);
		h.desiredSize = -1;
		h.monitor.check();
		h.advance(1000);
		expect(h.monitor.check()).toBe(true);
		// Subsequent checks (e.g. a late periodic tick) must not reap again.
		h.advance(1000);
		expect(h.monitor.check()).toBe(false);
		expect(h.monitor.check()).toBe(false);
		expect(h.reaps).toBe(1);
	});

	// Mirrors the route wiring: onReap runs cleanup (unsubscribe), so a reaped
	// connection leaves NO dangling subscriber on the shared events bus.
	it('reap reuses the normal teardown — the subscriber is removed from the bus', () => {
		const frames: string[] = [];
		let desiredSize: number | null = -2; // stuck from the start
		let clock = 0;
		const unsubscribe = subscribe((_e, frame) => frames.push(frame));
		let unsubscribed = false;
		const monitor = createBackpressureMonitor({
			controller: {
				get desiredSize() {
					return desiredSize;
				}
			},
			graceMs: 1000,
			onReap: () => {
				unsubscribe();
				unsubscribed = true;
			},
			now: () => clock
		});

		try {
			publish({ type: 'cell:edited', nb: '/reap.ipynb', cellId: 'a' });
			expect(frames.length).toBe(1); // subscriber is live and receiving

			monitor.check(); // starts the grace timer
			clock += 1000;
			expect(monitor.check()).toBe(true); // reaped → cleanup() called
			expect(unsubscribed).toBe(true);

			// Any event published AFTER the reap must not reach the torn-down subscriber.
			publish({ type: 'cell:edited', nb: '/reap.ipynb', cellId: 'b' });
			expect(frames.length).toBe(1); // still 1 — no dangling subscriber
		} finally {
			if (!unsubscribed) unsubscribe();
		}
	});
});
