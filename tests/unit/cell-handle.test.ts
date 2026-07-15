/**
 * Short cell-id handles + the prefix-accepting resolver (token diet).
 *
 * A HANDLE is the shortest unique prefix (length >= 8) of a cell's full UUID,
 * within one notebook. `computeHandles` emits them and `resolveCellId` accepts a
 * handle, any longer prefix, or the full UUID back — rejecting an ambiguous prefix
 * (matches >1 cell) or an unknown ref rather than silently picking a cell. These
 * are the pure-function guarantees; the integration test proves the tool surface
 * actually emits + resolves them.
 */
import { describe, it, expect } from 'vitest';
import { computeHandles, resolveCellId } from '../../src/lib/server/mcp/cellHandle';

const cells = (...ids: string[]) => ids.map((id) => ({ id }));

// Realistic-looking UUIDs whose first 8 chars are all distinct.
const A = 'a1b2c3d4-1111-4111-8111-000000000001';
const B = 'b9c8d7e6-2222-4222-8222-000000000002';
const C = 'c0d1e2f3-3333-4333-8333-000000000003';

describe('computeHandles', () => {
	it('emits an 8-char handle when the first 8 chars are unique', () => {
		const map = computeHandles(cells(A, B, C));
		expect(map.get(A)).toBe('a1b2c3d4');
		expect(map.get(B)).toBe('b9c8d7e6');
		expect(map.get(C)).toBe('c0d1e2f3');
		for (const h of map.values()) expect(h.length).toBe(8);
	});

	it('lengthens BOTH handles just enough when two cells collide on their first 8 chars', () => {
		// Same first 8 (+the dash), differ at the 10th char.
		const X = 'deadbeef-aaaa-4aaa-8aaa-000000000001';
		const Y = 'deadbeef-bbbb-4bbb-8bbb-000000000002';
		const map = computeHandles(cells(X, Y, A));
		// A is uncontended → still 8 chars.
		expect(map.get(A)).toBe('a1b2c3d4');
		// X and Y share 'deadbeef-' (9 chars) and first differ at index 9, so each
		// handle grows to 10 chars — never ambiguous.
		expect(map.get(X)).toBe('deadbeef-a');
		expect(map.get(Y)).toBe('deadbeef-b');
		expect(map.get(X)).not.toBe(map.get(Y));
		// Every emitted handle resolves back to exactly the cell it names.
		const all = cells(X, Y, A);
		for (const [id, handle] of map) expect(resolveCellId(all, handle)).toBe(id);
	});

	it('falls back to the whole id when it is shorter than the 8-char floor', () => {
		const map = computeHandles(cells('short', 'other'));
		expect(map.get('short')).toBe('short');
	});
});

describe('resolveCellId', () => {
	const all = cells(A, B, C);

	it('accepts the 8-char short handle', () => {
		expect(resolveCellId(all, 'a1b2c3d4')).toBe(A);
	});

	it('accepts any longer unique prefix', () => {
		expect(resolveCellId(all, 'a1b2c3d4-1111')).toBe(A);
		expect(resolveCellId(all, 'a1b2')).toBe(A); // still unique here
	});

	it('accepts the full UUID unchanged (exact match wins)', () => {
		expect(resolveCellId(all, A)).toBe(A);
	});

	it('rejects an ambiguous prefix (matches >1 cell) with an actionable error', () => {
		const P = 'ff00aa11-1111-4111-8111-000000000001';
		const Q = 'ff00aa11-2222-4222-8222-000000000002';
		const many = cells(P, Q, A);
		expect(() => resolveCellId(many, 'ff00aa11')).toThrow(/ambiguous/i);
		// It names how many it matched and tells the caller what to do.
		expect(() => resolveCellId(many, 'ff00aa11')).toThrow(/more characters|full id/i);
		// A longer prefix past the divergence resolves cleanly again.
		expect(resolveCellId(many, 'ff00aa11-1')).toBe(P);
	});

	it('rejects an unknown ref with a not-found error', () => {
		expect(() => resolveCellId(all, 'zzzzzzzz')).toThrow(/no cell matches/i);
	});

	it('rejects an empty ref', () => {
		expect(() => resolveCellId(all, '')).toThrow(/required/i);
		expect(() => resolveCellId(all, '   ')).toThrow(/required/i);
	});
});
