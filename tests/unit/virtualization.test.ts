import { describe, it, expect } from 'vitest';
import {
	planWindow,
	estimateHeight,
	mountedIds,
	pinnedCellIds,
	queuedHeadIds,
	CARD_CHROME_PX,
	CODE_LINE_PX,
	MARKDOWN_BASE_PX,
	OUTPUT_PER_PX,
	OUTPUT_CAP_PX,
	QUEUED_PIN_LIMIT,
	ROW_GAP_PX,
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

describe('planWindow — inter-cell gap accounting (space-y-4)', () => {
	it('advances the window by the gap between cells so a deep cell stays in-window', () => {
		// 40 cells × 100px + 16px gaps ⇒ cell k's top = k·116. Viewport [1000,1200],
		// overscan 0, window [1000,1200]. WITH the 16px gap, real tops are k·116 so
		// c8 [928,1028), c9 [1044,1144), c10 [1160,1260) overlap the window; without
		// the gap the model tops are k·100 and a different (higher) run wins.
		const { order, heights } = uniform(40, 100);
		const plan = planWindow({
			order,
			heights,
			estimate: () => 100,
			virtualize: true,
			viewportTop: 1000,
			viewportHeight: 200,
			overscanPx: 0,
			gapPx: ROW_GAP_PX
		});
		expect(cellIds(plan)).toEqual(['c8', 'c9', 'c10']);
		// Ignoring the gap would have windowed a different (higher) run.
		const noGap = planWindow({
			order,
			heights,
			estimate: () => 100,
			virtualize: true,
			viewportTop: 1000,
			viewportHeight: 200,
			overscanPx: 0,
			gapPx: 0
		});
		expect(cellIds(noGap)).not.toEqual(cellIds(plan));
	});

	it("a coalesced spacer's px includes its run's internal gaps (Σheights + (K-1)·gap)", () => {
		// 10 cells × 100px, gap 16. Viewport [500,560] with overscan 0 windows the cell
		// straddling that band and collapses the runs before and after into spacers.
		const { order, heights } = uniform(10, 100);
		const plan = planWindow({
			order,
			heights,
			estimate: () => 100,
			virtualize: true,
			viewportTop: 500,
			viewportHeight: 60,
			overscanPx: 0,
			gapPx: ROW_GAP_PX
		});
		const cells = cellIds(plan);
		const spacers = plan.filter((p) => p.kind === 'spacer') as Array<{ px: number }>;
		// Total flow height is conserved: Σ(mounted heights) + Σ(spacer px) + all
		// outer gaps between plan items = the full stack height (N·100 + (N-1)·16).
		const K = cells.length;
		const mountedPx = K * 100;
		const spacerPx = spacers.reduce((a, s) => a + s.px, 0);
		const planGaps = (plan.length - 1) * ROW_GAP_PX; // gap between every pair of plan items
		expect(mountedPx + spacerPx + planGaps).toBe(10 * 100 + 9 * ROW_GAP_PX);
		// And a run of K cells contributes exactly Σheights + (K-1)·gap.
		const topSpacer = plan[0] as { kind: string; px: number };
		if (topSpacer.kind === 'spacer') {
			// c0..cJ collapsed; recover J from the first mounted cell's index.
			const firstMounted = Number((cells[0] as string).slice(1));
			expect(topSpacer.px).toBe(firstMounted * 100 + (firstMounted - 1) * ROW_GAP_PX);
		}
	});

	it('defaults gapPx to 0 so the uniform-height model is unchanged', () => {
		const { order, heights } = uniform(10, 100);
		const withDefault = planWindow({ order, heights, estimate: () => 100, virtualize: true, viewportTop: 250, viewportHeight: 200, overscanPx: 0 });
		const withZero = planWindow({ order, heights, estimate: () => 100, virtualize: true, viewportTop: 250, viewportHeight: 200, overscanPx: 0, gapPx: 0 });
		expect(cellIds(withDefault)).toEqual(cellIds(withZero));
		expect(spacerSum(withDefault)).toBe(spacerSum(withZero));
	});
});

describe('queuedHeadIds (P3)', () => {
	it('returns the queue in run order, capped at the head limit', () => {
		const queued = { e: 5, a: 1, c: 3, b: 2, d: 4 };
		expect(queuedHeadIds(queued)).toEqual(['a', 'b', 'c']);
		expect(QUEUED_PIN_LIMIT).toBe(3);
	});

	it('caps on purpose: a huge queue can never pin the whole notebook', () => {
		const queued: Record<string, number> = {};
		for (let i = 0; i < 300; i++) queued[`c${i}`] = i + 1;
		expect(queuedHeadIds(queued)).toEqual(['c0', 'c1', 'c2']);
		expect(queuedHeadIds(queued, 10)).toHaveLength(10);
	});

	it('is empty for no queue, an empty queue, or a zero limit', () => {
		expect(queuedHeadIds(undefined)).toEqual([]);
		expect(queuedHeadIds(null)).toEqual([]);
		expect(queuedHeadIds({})).toEqual([]);
		expect(queuedHeadIds({ a: 1 }, 0)).toEqual([]);
	});

	it('ignores non-numeric positions rather than ordering on garbage', () => {
		const queued = { a: 2, bad: Number.NaN, c: 1 } as unknown as Record<string, number>;
		expect(queuedHeadIds(queued)).toEqual(['c', 'a']);
	});
});

describe('pinnedCellIds (P3)', () => {
	it('unions running, queued heads, active, focused and scroll targets', () => {
		expect(
			pinnedCellIds({
				runningId: 'r',
				queued: { q1: 1, q2: 2, q3: 3, q4: 4 },
				activeId: 'a',
				focusedId: 'f',
				scrollPins: new Set(['s'])
			})
		).toEqual(new Set(['r', 'q1', 'q2', 'q3', 'a', 'f', 's']));
	});

	it('is empty when nothing is running, queued, selected or focused', () => {
		expect(pinnedCellIds({})).toEqual(new Set());
		expect(pinnedCellIds({ runningId: null, activeId: null, focusedId: null, queued: {} })).toEqual(new Set());
	});

	it('keeps the focused cell pinned even when the selection moved off it', () => {
		// A focus event still in flight (or focus held by a cell the keyboard has
		// since selected past) must not drop the editing cell's node.
		expect(pinnedCellIds({ activeId: 'a', focusedId: 'edited' })).toEqual(new Set(['a', 'edited']));
	});

	it('drops a pin the moment its reason lapses', () => {
		const running = pinnedCellIds({ runningId: 'r', queued: { q: 1 } });
		expect(running.has('r')).toBe(true);
		// Run ended, queue drained, nothing selected ⇒ nothing pinned.
		expect(pinnedCellIds({ runningId: null, queued: {} })).toEqual(new Set());
	});

	it('mounts a pinned cell far outside the window (the pin reaches planWindow)', () => {
		const { order, heights } = uniform(20, 100);
		const pinned = pinnedCellIds({ runningId: 'c17', queued: { c15: 1 }, focusedId: 'c12' });
		const plan = planWindow({
			order,
			heights,
			estimate: () => 100,
			virtualize: true,
			viewportTop: 0,
			viewportHeight: 200,
			overscanPx: 0,
			pinned
		});
		const ids = cellIds(plan);
		expect(ids).toContain('c17'); // running, far off-screen
		expect(ids).toContain('c15'); // queued head
		expect(ids).toContain('c12'); // focused (editing)
		expect(ids).not.toContain('c10'); // an ordinary off-screen cell is still a spacer
		// Flow height is still conserved with three spacer splits.
		expect(spacerSum(plan) + ids.length * 100).toBe(2000);
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
