/**
 * Perf Tier 3, item 1: the dataflow analysis cache is a bounded LRU, not a `Map`
 * that `.clear()`s wholesale when it crosses the cap.
 *
 * The regression the LRU fixes: a full flush at the bound throws away EVERY hot
 * entry, so the next analysis pass re-runs the `symtable` subprocess over every
 * live cell. An LRU evicts only the coldest source, so a notebook's working set
 * stays cached across the bound. These tests pin that behavior on the reusable
 * `LruCache` the dataflow cache is built on.
 */
import { describe, it, expect } from 'vitest';
import { LruCache } from '../../src/lib/server/lru';

describe('LruCache', () => {
	it('evicts the LEAST-recently-used entry at the cap (not a full flush)', () => {
		const c = new LruCache<string, number>(3);
		c.set('a', 1);
		c.set('b', 2);
		c.set('c', 3);
		// One past the cap: 'a' is the oldest, so ONLY 'a' is evicted — 'b'/'c' survive.
		c.set('d', 4);
		expect(c.size).toBe(3);
		expect(c.has('a')).toBe(false);
		expect(c.get('b')).toBe(2);
		expect(c.get('c')).toBe(3);
		expect(c.get('d')).toBe(4);
	});

	it('a read promotes a key so a HOT entry survives eviction', () => {
		const c = new LruCache<string, number>(3);
		c.set('a', 1);
		c.set('b', 2);
		c.set('c', 3);
		// Touch 'a' — it becomes most-recently-used, so 'b' (now oldest) is evicted next.
		expect(c.get('a')).toBe(1);
		c.set('d', 4);
		expect(c.has('a')).toBe(true); // the hot entry stayed cached across the bound
		expect(c.has('b')).toBe(false); // the cold one went instead
		expect(c.get('c')).toBe(3);
		expect(c.get('d')).toBe(4);
	});

	it('re-setting an existing key updates its value and refreshes its recency', () => {
		const c = new LruCache<string, number>(2);
		c.set('a', 1);
		c.set('b', 2);
		c.set('a', 10); // update + promote 'a'
		c.set('c', 3); // evicts 'b' (now oldest), keeps the just-updated 'a'
		expect(c.get('a')).toBe(10);
		expect(c.has('b')).toBe(false);
		expect(c.get('c')).toBe(3);
		expect(c.size).toBe(2);
	});

	it('the working set never gets flushed: a hot set smaller than the cap survives cold churn', () => {
		const CAP = 50;
		const HOT = 40; // leave headroom below the cap for one-off cold inserts to churn in
		const c = new LruCache<number, number>(CAP);
		// Seed a hot working set of HOT keys.
		for (let i = 0; i < HOT; i++) c.set(i, i);
		// A long run of one-off cold inserts, each preceded by a full re-touch of the
		// hot set (exactly what a dataflow analysis pass does for the visible cells).
		for (let cold = 1000; cold < 1100; cold++) {
			for (let i = 0; i < HOT; i++) expect(c.get(i)).toBe(i); // promote the hot set to MRU
			c.set(cold, cold); // a cold one-off — evicts an older COLD key, never a hot one
		}
		// Every hot key is still cached; a full-flush `Map` would have dropped them all
		// the first time it crossed the cap.
		for (let i = 0; i < HOT; i++) expect(c.has(i)).toBe(true);
		expect(c.size).toBe(CAP);
	});

	it('preserves falsy values (0/empty) — presence is by key, not truthiness', () => {
		const c = new LruCache<string, number>(2);
		c.set('z', 0);
		expect(c.has('z')).toBe(true);
		expect(c.get('z')).toBe(0);
	});

	it('rejects a non-positive cap', () => {
		expect(() => new LruCache<string, number>(0)).toThrow();
	});
});
