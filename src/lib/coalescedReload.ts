/**
 * Single-flight WITH a trailing re-run: concurrent calls for the same key share
 * one request, but a call that arrives DURING one is never SWALLOWED.
 *
 * Plain single-flight is wrong for a panel driven by change signals. Handing the
 * in-flight promise back answers the new trigger with a response that was issued
 * BEFORE the change that trigger announces, and nothing schedules another read —
 * so a `notebook:root` landing while an unrelated window-focus read is still out
 * leaves the old checkout on screen until some later, independent trigger. The
 * generation guard cannot help: it only decides which reply may be WRITTEN, and
 * here there is exactly one reply and it is stale.
 *
 * So a coalesced call marks the run superseded, and exactly ONE re-run is fired
 * once it settles — however many calls coalesced onto it. Genuinely simultaneous
 * duplicates (a mount effect racing `sse:open` on the initial connect) still cost
 * one round trip plus that single re-read, rather than N.
 *
 * It cannot loop: the re-run starts with the flag already cleared and nothing in
 * flight, so only a further real call can set it again. A call for a DIFFERENT
 * key is not coalesced at all — it starts a fresh run that already reads the newer
 * state — and it clears the flag, since that run subsumes the pending re-read.
 */
export interface CoalescedReload {
	/** Run `key`, sharing an identical in-flight run and scheduling one trailing re-run. */
	run(key: string): Promise<void>;
	/**
	 * Forget the in-flight run and any pending re-read, for a caller that has decided
	 * the answer is moot (the panel's "no notebook is open" path). A run still out is
	 * left to settle and write nothing — its generation guard is what discards it.
	 */
	reset(): void;
}

/** Wrap a fetcher so identical concurrent calls coalesce without swallowing a trigger. */
export function createCoalescedReload(fetcher: (key: string) => Promise<void>): CoalescedReload {
	let inFlight: { key: string; done: Promise<void> } | null = null;
	let superseded = false;

	function run(key: string): Promise<void> {
		if (inFlight?.key === key) {
			superseded = true;
			return inFlight.done;
		}
		superseded = false;
		const done = fetcher(key).finally(() => {
			// Only the run that is still the current one may decide what happens next;
			// a run displaced by a newer key has already been answered by that newer
			// request, and re-running here would undo its ordering.
			if (inFlight?.done !== done) return;
			inFlight = null;
			if (superseded) {
				superseded = false;
				run(key);
			}
		});
		inFlight = { key, done };
		return done;
	}

	return {
		run,
		reset() {
			inFlight = null;
			superseded = false;
		}
	};
}
