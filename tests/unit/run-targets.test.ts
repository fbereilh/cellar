import { describe, it, expect } from 'vitest';
import { codeIdsAll, codeIdsAbove, type RunTargetCell } from '../../src/lib/runTargets';

const nb: RunTargetCell[] = [
	{ id: 'a', cell_type: 'markdown' },
	{ id: 'b', cell_type: 'code' },
	{ id: 'c', cell_type: 'markdown' },
	{ id: 'd', cell_type: 'code' },
	{ id: 'e', cell_type: 'code' }
];

describe('codeIdsAll', () => {
	it('returns every code cell in document order, skipping non-code', () => {
		expect(codeIdsAll(nb)).toEqual(['b', 'd', 'e']);
	});
	it('is empty for a markdown-only notebook', () => {
		expect(codeIdsAll([{ id: 'x', cell_type: 'markdown' }])).toEqual([]);
	});
	it('is empty for an empty notebook', () => {
		expect(codeIdsAll([])).toEqual([]);
	});
});

describe('codeIdsAbove', () => {
	it('returns code cells strictly above the target (exclusive of it and below)', () => {
		// Above 'd' (index 3): a(md), b(code), c(md) -> only 'b'.
		expect(codeIdsAbove(nb, 'd')).toEqual(['b']);
		// Above 'e' (index 4): b and d.
		expect(codeIdsAbove(nb, 'e')).toEqual(['b', 'd']);
	});
	it('excludes the target cell itself even when it is code', () => {
		expect(codeIdsAbove(nb, 'b')).not.toContain('b');
	});
	it('is a no-op ([]) for the first cell', () => {
		expect(codeIdsAbove(nb, 'a')).toEqual([]);
	});
	it('is a no-op ([]) when the first cell is a code cell', () => {
		const nb2: RunTargetCell[] = [
			{ id: 'first', cell_type: 'code' },
			{ id: 'second', cell_type: 'code' }
		];
		expect(codeIdsAbove(nb2, 'first')).toEqual([]);
		expect(codeIdsAbove(nb2, 'second')).toEqual(['first']);
	});
	it('is a no-op ([]) for an unknown id', () => {
		expect(codeIdsAbove(nb, 'nope')).toEqual([]);
	});
	it('skips non-code cells above the target', () => {
		const nb3: RunTargetCell[] = [
			{ id: 'm1', cell_type: 'markdown' },
			{ id: 'm2', cell_type: 'markdown' },
			{ id: 'target', cell_type: 'code' }
		];
		expect(codeIdsAbove(nb3, 'target')).toEqual([]);
	});
});
