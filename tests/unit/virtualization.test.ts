import { describe, it, expect } from 'vitest';
import {
	planWindow,
	estimateHeight,
	mountedIds,
	CARD_CHROME_PX,
	CODE_LINE_PX,
	MARKDOWN_BASE_PX,
	OUTPUT_PER_PX,
	OUTPUT_CAP_PX,
	type PlanItem
} from '../../src/lib/virtualization';

// A uniform-height fixture: N cells, each `h` px. Lets the window math be checked
// against exact arithmetic with no estimate involved.
function uniform(n: number, h: number) {
	const order = Array.from({ length: n }, (_, i) => `c${i}`);
	const heights = new Map(order.map((id) => [id, h]));
	return { order, heights };
}
const cellIds = (plan: PlanItem[]) => plan.filter((p) => p.kind === 'cell').map((p) => (p as { id: string }).id);
const spacerSum = (plan: PlanItem[]) =>
	plan.filter((p) => p.kind === 'spacer').reduce((a, p) => a + (p as { px: number }).px, 0);

describe('estimateHeight', () => {
	it('scales a code cell with its line count + chrome', () => {
		expect(estimateHeight({ id: 'a', cell_type: 'code', source: 'x = 1' })).toBe(CARD_CHROME_PX + 1 * CODE_LINE_PX);
		expect(estimateHeight({ id: 'a', cell_type: 'code', source: 'a\nb\nc' })).toBe(CARD_CHROME_PX + 3 * CODE_LINE_PX);
	});

	it('treats empty source as one line, never zero', () => {
		expect(estimateHeight({ id: 'a', cell_type: 'code', source: '' })).toBe(CARD_CHROME_PX + CODE_LINE_PX);
		expect(estimateHeight({ id: 'a', cell_type: 'code' })).toBe(CARD_CHROME_PX + CODE_LINE_PX);
	});

	it('uses a smaller base for markdown', () => {
		expect(estimateHeight({ id: 'm', cell_type: 'markdown', source: '# Title' })).toBe(MARKDOWN_BASE_PX + CODE_LINE_PX);
	});

	it('adds a coarse, capped output allowance for code cells with outputs', () => {
		const base = CARD_CHROME_PX + CODE_LINE_PX;
		expect(estimateHeight({ id: 'a', cell_type: 'code', source: 'x', outputs: [{}] })).toBe(base + OUTPUT_PER_PX);
		expect(estimateHeight({ id: 'a', cell_type: 'code', source: 'x', outputs: [{}, {}] })).toBe(base + 2 * OUTPUT_PER_PX);
		// Capped: 10 outputs would be 1200px but the allowance saturates.
		const many = Array.from({ length: 10 }, () => ({}));
		expect(estimateHeight({ id: 'a', cell_type: 'code', source: 'x', outputs: many })).toBe(base + OUTPUT_CAP_PX);
	});
});

describe('planWindow — flag OFF (byte-identical path)', () => {
	it('mounts every cell in order, with no spacers, when virtualize is false', () => {
		const { order, heights } = uniform(5, 100);
		const plan = planWindow({ order, heights, estimate: () => 100, virtualize: false, viewportTop: 0, viewportHeight: 200 });
		expect(plan.every((p) => p.kind === 'cell')).toBe(true);
		expect(cellIds(plan)).toEqual(order);
	});

	it('mounts every cell when virtualize is on but no viewport metrics are supplied', () => {
		const { order, heights } = uniform(5, 100);
		const plan = planWindow({ order, heights, estimate: () => 100, virtualize: true });
		expect(cellIds(plan)).toEqual(order);
		expect(spacerSum(plan)).toBe(0);
	});

	it('preserves order for an empty notebook', () => {
		expect(planWindow({ order: [], heights: new Map(), estimate: () => 0, virtualize: false })).toEqual([]);
	});
});

describe('planWindow — flag ON (windowed)', () => {
	it('mounts only the cells overlapping the viewport ± overscan', () => {
		// 10 cells × 100px = 1000px tall. Viewport [250,450], overscan 0.
		const { order, heights } = uniform(10, 100);
		const plan = planWindow({
			order,
			heights,
			estimate: () => 100,
			virtualize: true,
			viewportTop: 250,
			viewportHeight: 200,
			overscanPx: 0
		});
		// c2 [200,300), c3 [300,400), c4 [400,500) overlap [250,450].
		expect(cellIds(plan)).toEqual(['c2', 'c3', 'c4']);
	});

	it('collapses the off-screen runs into a top and bottom spacer whose heights are exact', () => {
		const { order, heights } = uniform(10, 100);
		const plan = planWindow({
			order,
			heights,
			estimate: () => 100,
			virtualize: true,
			viewportTop: 250,
			viewportHeight: 200,
			overscanPx: 0
		});
		// [ spacer(c0,c1)=200, c2, c3, c4, spacer(c5..c9)=500 ]
		expect(plan[0]).toMatchObject({ kind: 'spacer', px: 200 });
		expect(plan.at(-1)).toMatchObject({ kind: 'spacer', px: 500 });
		// Total is conserved: every cell is either mounted or in a spacer.
		const mountedPx = cellIds(plan).length * 100;
		expect(mountedPx + spacerSum(plan)).toBe(1000);
	});

	it('expands the mounted set with overscan', () => {
		const { order, heights } = uniform(10, 100);
		const plan = planWindow({
			order,
			heights,
			estimate: () => 100,
			virtualize: true,
			viewportTop: 250,
			viewportHeight: 200,
			overscanPx: 120
		});
		// Window grows to [130,570]: c1 [100,200) .. c5 [500,600) overlap it.
		expect(cellIds(plan)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
	});

	it('pins a far off-screen cell, splitting the surrounding spacer in two', () => {
		const { order, heights } = uniform(10, 100);
		const plan = planWindow({
			order,
			heights,
			estimate: () => 100,
			virtualize: true,
			viewportTop: 250,
			viewportHeight: 200,
			overscanPx: 0,
			pinned: new Set(['c8'])
		});
		// [ spacer(c0,c1)=200, c2,c3,c4, spacer(c5,c6,c7)=300, c8, spacer(c9)=100 ]
		expect(cellIds(plan)).toEqual(['c2', 'c3', 'c4', 'c8']);
		const spacers = plan.filter((p) => p.kind === 'spacer') as Array<{ px: number }>;
		expect(spacers.map((s) => s.px)).toEqual([200, 300, 100]);
		expect(spacerSum(plan) + cellIds(plan).length * 100).toBe(1000);
	});

	it('falls back to the estimate for a cell with no measured height', () => {
		const order = ['a', 'b', 'c'];
		const heights = new Map<string, number>([
			['a', 100],
			['c', 100]
		]); // 'b' unmeasured
		const estimate = (id: string) => (id === 'b' ? 500 : 100);
		const plan = planWindow({
			order,
			heights,
			estimate,
			virtualize: true,
			viewportTop: 0,
			viewportHeight: 50,
			overscanPx: 0
		});
		// a [0,100) is in-window; b starts at 100 (> 50) so it's a spacer using its
		// 500px estimate; c follows. Top has no spacer; the tail spacer = 500 + 100.
		expect(cellIds(plan)).toEqual(['a']);
		expect(spacerSum(plan)).toBe(600);
	});

	it('gives a stable key per collapsed run (start index)', () => {
		const { order, heights } = uniform(6, 100);
		const plan = planWindow({
			order,
			heights,
			estimate: () => 100,
			virtualize: true,
			viewportTop: 300,
			viewportHeight: 100,
			overscanPx: 0
		});
		const keys = plan.filter((p) => p.kind === 'spacer').map((p) => (p as { key: string }).key);
		expect(new Set(keys).size).toBe(keys.length); // unique
	});
});

describe('mountedIds', () => {
	it('extracts the mounted cell ids from a plan', () => {
		const plan: PlanItem[] = [
			{ kind: 'spacer', px: 100, key: 'spacer:0' },
			{ kind: 'cell', id: 'x' },
			{ kind: 'cell', id: 'y' },
			{ kind: 'spacer', px: 50, key: 'spacer:3' }
		];
		expect(mountedIds(plan)).toEqual(new Set(['x', 'y']));
	});
});
