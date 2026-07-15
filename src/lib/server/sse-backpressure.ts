/**
 * Cellar — SSE stream backpressure guard.
 *
 * A `ReadableStream` response under adapter-node uses an unbounded internal
 * queue: `controller.enqueue()` always succeeds, and if the consumer (the HTTP
 * socket) stops draining — an asleep laptop, a half-open TCP connection — every
 * pushed `run:output`/`widget:update` chunk piles up in server heap until TCP
 * finally resets. A runaway cell streaming to such a dead-but-connected peer is
 * the most realistic OOM path for the events stream.
 *
 * `controller.desiredSize` is the signal: for the default counting strategy it is
 * `highWaterMark - queuedChunks`, so it goes `<= 0` the moment the queue outpaces
 * the reader and grows more negative as the buffer backs up. A *healthy* client
 * drains promptly, so its `desiredSize` only dips negative momentarily under a
 * burst and recovers. This monitor therefore reaps ONLY a connection whose
 * `desiredSize` stays `<= 0` continuously past a grace window — the momentary dip
 * of a draining client resets the timer and is never reaped.
 *
 * Reaping is safe: the client's `EventSource` reconnects automatically and each
 * notebook resyncs (fresh snapshots on connect + the seq-gap refetch backstop),
 * so a stuck peer recovers cleanly with no lost state.
 *
 * This is pure logic with an injectable clock so it is unit-testable without a
 * real socket (see `tests/unit/sse-backpressure.test.ts`).
 */

/** The slice of `ReadableStreamDefaultController` this monitor reads. */
export interface BackpressureSource {
	/** `null` once the stream is closed/errored; otherwise `highWaterMark - queued`. */
	readonly desiredSize: number | null;
}

export interface BackpressureMonitorOptions {
	/** The stream controller (or any object exposing `desiredSize`). */
	controller: BackpressureSource;
	/** How long `desiredSize` may stay `<= 0` before the peer is reaped. */
	graceMs: number;
	/** Called once when the peer is judged stuck; wire this to teardown + close. */
	onReap: () => void;
	/** Clock injection point for tests; defaults to `Date.now`. */
	now?: () => number;
}

export interface BackpressureMonitor {
	/**
	 * Sample `desiredSize` and reap if it has stayed `<= 0` past the grace window.
	 * Call after each enqueue and on a periodic tick. Returns `true` iff it reaped
	 * on this call (so callers can stop their own timers). Idempotent after a reap.
	 */
	check: () => boolean;
}

export function createBackpressureMonitor({
	controller,
	graceMs,
	onReap,
	now = () => Date.now()
}: BackpressureMonitorOptions): BackpressureMonitor {
	/** When `desiredSize` first went `<= 0` in the current backed-up streak, or `null` when draining. */
	let backedUpSince: number | null = null;
	let reaped = false;

	return {
		check(): boolean {
			if (reaped) return false;
			const ds = controller.desiredSize;
			// `null` means the stream is already closed/errored — nothing to reap.
			// `> 0` means the reader is keeping up: reset the streak. Both are healthy.
			if (ds === null || ds > 0) {
				backedUpSince = null;
				return false;
			}
			// `ds <= 0`: the queue is backing up. Start (or continue) the grace timer.
			const t = now();
			if (backedUpSince === null) {
				backedUpSince = t;
				return false;
			}
			if (t - backedUpSince >= graceMs) {
				reaped = true;
				onReap();
				return true;
			}
			return false;
		}
	};
}
