/**
 * `src/lib/coalescedReload.ts` — single-flight that does not swallow a trigger.
 *
 * The two halves pull in opposite directions and only the pair is correct: fewer
 * requests when triggers genuinely coincide, but never an ANSWER that predates the
 * change the caller was told about. Both are asserted here, along with the loop
 * hazard that a trailing re-run introduces, because the sidebar panel that uses it
 * cannot be mounted under vitest (see `git-notebooks-panel.test.ts`).
 */
import { describe, it, expect } from 'vitest';
import { createCoalescedReload } from '../../src/lib/coalescedReload';

/** A fetcher that records its calls and hands back a resolver per call. */
function recorder() {
	const keys: string[] = [];
	const settle: Array<() => void> = [];
	const fetcher = (key: string) => {
		keys.push(key);
		return new Promise<void>((resolve) => settle.push(resolve));
	};
	return { keys, settle, fetcher };
}

/** Let every pending microtask (the `.finally` chain) run. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('createCoalescedReload', () => {
	it('coalesces simultaneous identical calls onto ONE request', async () => {
		const { keys, settle, fetcher } = recorder();
		const reload = createCoalescedReload(fetcher);

		const a = reload.run('q');
		const b = reload.run('q');
		expect(keys).toEqual(['q']);
		expect(b).toBe(a);

		settle[0]();
		await flush();
		// One trailing re-read for the calls that coalesced — not one per call.
		expect(keys).toEqual(['q', 'q']);
	});

	it('never SWALLOWS a trigger that arrives during a request', async () => {
		// The defect this exists for: a `notebook:root` landing while an unrelated
		// window-focus read is out was answered by that read's reply, which was issued
		// BEFORE the root change — so the panel kept showing the old checkout until some
		// later, independent trigger.
		const { keys, settle, fetcher } = recorder();
		const reload = createCoalescedReload(fetcher);

		reload.run('q'); // the focus read
		await flush();
		reload.run('q'); // the root change, mid-request
		settle[0]();
		await flush();

		expect(keys).toEqual(['q', 'q']);
	});

	it('fires exactly ONE re-run however many triggers coalesced', async () => {
		const { keys, settle, fetcher } = recorder();
		const reload = createCoalescedReload(fetcher);

		reload.run('q');
		for (let i = 0; i < 5; i++) reload.run('q');
		settle[0]();
		await flush();

		expect(keys).toEqual(['q', 'q']);
	});

	it('cannot loop: the re-run is not itself a trigger', async () => {
		const { keys, settle, fetcher } = recorder();
		const reload = createCoalescedReload(fetcher);

		reload.run('q');
		reload.run('q');
		settle[0]();
		await flush();
		expect(keys).toHaveLength(2);

		settle[1]();
		await flush();
		expect(keys).toHaveLength(2);
	});

	it('does not coalesce a DIFFERENT key, and that fresh run clears the pending re-read', async () => {
		// A different key already reads the newer state, so it subsumes the re-read a
		// coalesced call had scheduled — replaying the old query afterwards would undo
		// the newer answer's ordering.
		const { keys, settle, fetcher } = recorder();
		const reload = createCoalescedReload(fetcher);

		reload.run('a');
		reload.run('a'); // schedules a trailing re-read of 'a'
		reload.run('b'); // …which this supersedes
		expect(keys).toEqual(['a', 'b']);

		settle[0]();
		settle[1]();
		await flush();
		expect(keys).toEqual(['a', 'b']);
	});

	it('a displaced run decides nothing when it settles', async () => {
		const { keys, settle, fetcher } = recorder();
		const reload = createCoalescedReload(fetcher);

		reload.run('a');
		reload.run('b');
		reload.run('b'); // a real trigger against the CURRENT run
		settle[0](); // the displaced 'a' settles first
		await flush();
		expect(keys).toEqual(['a', 'b']);

		settle[1]();
		await flush();
		expect(keys).toEqual(['a', 'b', 'b']);
	});

	it('reset() drops the in-flight run and any pending re-read', async () => {
		const { keys, settle, fetcher } = recorder();
		const reload = createCoalescedReload(fetcher);

		reload.run('q');
		reload.run('q');
		reload.reset();
		settle[0]();
		await flush();
		// Nothing replayed: the caller decided the answer was moot.
		expect(keys).toEqual(['q']);

		// …and the next call starts a fresh run rather than joining the abandoned one.
		reload.run('q');
		expect(keys).toEqual(['q', 'q']);
	});
});
