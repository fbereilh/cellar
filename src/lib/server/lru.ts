/**
 * Cellar — a minimal bounded LRU map.
 *
 * A plain `Map` remembers insertion order, which is enough to make an LRU: on
 * every read of a live key we delete-then-reinsert it so it becomes the newest
 * entry, and when an insertion would exceed the cap we evict the OLDEST key (the
 * Map's first). That is the whole point over a size-bounded `Map` that
 * `.clear()`s wholesale when it grows: a full flush throws away every hot entry
 * the moment the cap is crossed, so the next pass re-computes all of them; an LRU
 * evicts only the coldest one, so the working set stays cached across the bound.
 *
 * Reads through `get()`/`has()` count as uses (they promote the key), so callers
 * that want a pure peek must not use them — but every current caller genuinely
 * touches the value, which is exactly the access an LRU should track.
 */
export class LruCache<K, V> {
	private map = new Map<K, V>();
	constructor(private readonly max: number) {
		if (!(max > 0)) throw new Error('LruCache max must be > 0');
	}

	/** Whether `key` is cached. Promotes it to most-recently-used, like `get`. */
	has(key: K): boolean {
		if (!this.map.has(key)) return false;
		this.touch(key);
		return true;
	}

	/** The cached value (promoting it to most-recently-used), or undefined. */
	get(key: K): V | undefined {
		const v = this.map.get(key);
		if (v === undefined && !this.map.has(key)) return undefined;
		this.touch(key);
		return v;
	}

	/** Insert/update `key`, evicting the least-recently-used entry past the cap. */
	set(key: K, value: V): void {
		// Re-inserting moves an existing key to the newest position too.
		if (this.map.has(key)) this.map.delete(key);
		this.map.set(key, value);
		if (this.map.size > this.max) {
			// The first key in iteration order is the oldest (least-recently-used).
			const oldest = this.map.keys().next().value as K;
			this.map.delete(oldest);
		}
	}

	get size(): number {
		return this.map.size;
	}

	clear(): void {
		this.map.clear();
	}

	/** Move an existing key to the most-recently-used position. */
	private touch(key: K): void {
		const v = this.map.get(key);
		if (v === undefined && !this.map.has(key)) return;
		this.map.delete(key);
		this.map.set(key, v as V);
	}
}
