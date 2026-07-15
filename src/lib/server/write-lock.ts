/**
 * Cellar — per-path write serialization.
 *
 * Serializes writes to the SAME notebook path so two persists (a debounced
 * autosave and a run-end output persist can fire close together) never
 * interleave; writes to DIFFERENT paths still proceed concurrently.
 *
 * The primitive is a `Map<key, Promise>` tail-chain: each write for a key is
 * chained after the previous write for that key. The map entry is deleted once
 * a key's chain drains, so it can never grow unbounded.
 *
 * Two entry points, because Cellar's notebook persist is SYNCHRONOUS and must
 * stay so (the on-disk file has to exist the instant persist returns — an
 * unload flush and the git paths read the file right after writing it):
 *
 *  - `serializeWriteSync(key, write)` — the fast path Cellar's persist uses.
 *    When the key is idle (the normal case, since a synchronous critical
 *    section cannot be interrupted by another) it runs INLINE and the durable
 *    write has completed before the call returns. If a prior ASYNC write to the
 *    same key is still in flight, it queues behind it instead of racing.
 *  - `withPathLock(key, fn)` — a general async lock for any asynchronous
 *    writer; returns a promise that settles when this write settles.
 *
 * Both share the one chain per key, so a sync and an async writer to the same
 * path are still mutually serialized.
 */

/** Tail promise per key; presence means a write for that key is in flight. */
const chains = new Map<string, Promise<unknown>>();

/** Chain a new tail onto `key` and arrange its own cleanup when it drains. */
function chain(key: string, run: Promise<unknown>): void {
	const tail = run.then(
		() => undefined,
		() => undefined
	);
	chains.set(key, tail);
	// Delete only if we are still the tail — a later write may have chained on.
	void tail.then(() => {
		if (chains.get(key) === tail) chains.delete(key);
	});
}

/**
 * Run a self-contained synchronous `write` serialized per `key`.
 *
 * Fast path (key idle): runs inline and synchronously, so a durable disk write
 * is on disk before this returns. Any error propagates synchronously to the
 * caller (nothing was queued, so there is no chain to wedge).
 *
 * Slow path (a prior async write to `key` is pending): queues `write` behind it
 * and returns without running it yet; it runs when the chain reaches it.
 */
export function serializeWriteSync(key: string, write: () => void): void {
	const prev = chains.get(key);
	if (!prev) {
		// Idle: run now. Do not populate the map — the write completes before any
		// other synchronous call to this key could begin, so there is nothing to
		// serialize against and no entry to leak.
		write();
		return;
	}
	// Contended by an in-flight async write: queue after it.
	const run = prev.then(
		() => write(),
		() => write()
	);
	run.catch(() => {}); // caller does not await; don't surface as unhandled
	chain(key, run);
}

/**
 * Run `fn` serialized per `key`, awaiting any in-flight write to the same key
 * first. Returns a promise settling with `fn`'s result. Writes to different
 * keys run concurrently. The map entry is cleaned up when the chain drains.
 */
export function withPathLock<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
	const prev = chains.get(key) ?? Promise.resolve();
	const run = prev.then(
		() => fn(),
		() => fn()
	);
	chain(key, run);
	return run;
}

/** In-flight key count. Test-only: asserts the map does not retain entries. */
export function pendingWriteCount(): number {
	return chains.size;
}
