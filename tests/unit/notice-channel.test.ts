import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createNoticeChannel, NOTICE_TIMEOUT_MS } from '../../src/lib/notice.svelte';

// The channel's whole job is WHEN a message comes down, and the two kinds need
// opposite rules: a result auto-dismisses (a refusal the user retries must not
// need dismissing first), while progress posted before a minutes-long operation
// must stay up or the user is left with no sign anything is in flight.

describe('shell notice channel', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('auto-dismisses a result message', () => {
		const n = createNoticeChannel();
		n.show('Exported 3 cells → lib.py.');
		expect(n.message).toBe('Exported 3 cells → lib.py.');
		expect(n.sticky).toBe(false);

		vi.advanceTimersByTime(NOTICE_TIMEOUT_MS - 1);
		expect(n.message).not.toBe('');
		vi.advanceTimersByTime(1);
		expect(n.message).toBe('');
	});

	it('never auto-dismisses a sticky progress message', () => {
		const n = createNoticeChannel();
		n.show('Converting: running all cells…', { sticky: true });
		expect(n.sticky).toBe(true);

		// A convert runs every cell and can take minutes; far past the result timeout
		// it must still be the only thing telling the user why nothing has happened.
		vi.advanceTimersByTime(NOTICE_TIMEOUT_MS * 100);
		expect(n.message).toBe('Converting: running all cells…');
	});

	it('lets a result message replace a sticky one and take its own timeout', () => {
		const n = createNoticeChannel();
		n.show('Converting: running all cells…', { sticky: true });
		n.show('Converted to out.ipynb — ran 4/4 cells.');
		expect(n.sticky).toBe(false);

		vi.advanceTimersByTime(NOTICE_TIMEOUT_MS);
		expect(n.message).toBe('');
	});

	it('re-fires the nonce for a repeated identical message', () => {
		const n = createNoticeChannel();
		const refusal = 'A notebook keeps at least one cell - that delete would leave none.';
		n.show(refusal);
		const first = n.seq;
		n.show(refusal);
		// Re-assigning the same string is a reactive no-op, so the nonce moving is the
		// only thing that can re-show the toast on a retried refusal.
		expect(n.seq).toBeGreaterThan(first);
		expect(n.message).toBe(refusal);
	});

	it('restarts the countdown on a repeat rather than inheriting the old one', () => {
		const n = createNoticeChannel();
		n.show('Checkpoint saved.');
		vi.advanceTimersByTime(NOTICE_TIMEOUT_MS - 100);
		n.show('Checkpoint saved.');
		vi.advanceTimersByTime(200);
		expect(n.message).toBe('Checkpoint saved.');
		vi.advanceTimersByTime(NOTICE_TIMEOUT_MS);
		expect(n.message).toBe('');
	});

	it('dismisses both kinds early and cancels any pending timer', () => {
		const n = createNoticeChannel();
		n.show('Converting: running all cells…', { sticky: true });
		n.dismiss();
		expect(n.message).toBe('');
		expect(n.sticky).toBe(false);

		n.show('Checkpoint saved.');
		n.dismiss();
		expect(n.message).toBe('');
		// The cancelled timer must not fire later and blank a message posted since.
		n.show('Converting: running all cells…', { sticky: true });
		vi.advanceTimersByTime(NOTICE_TIMEOUT_MS * 2);
		expect(n.message).toBe('Converting: running all cells…');
	});
});
