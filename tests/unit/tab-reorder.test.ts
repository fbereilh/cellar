/**
 * Drag-and-drop reordering of the open-file tab strip - the pure rules
 * (`$lib/tabReorder`).
 *
 * The two decisions worth testing live here rather than in `Navbar.svelte`:
 * WHERE a pointer at (x, y) drops (the strip wraps, so this is a two-dimensional
 * question, not a left-to-right scan) and WHAT the resulting order is. vitest
 * runs without the SvelteKit plugin, so a rule left inside the component could
 * not be driven at all; `tests/e2e/tab-drag-reorder.spec.ts` proves the wiring
 * in a real browser, and this proves the rules.
 */
import { describe, it, expect } from 'vitest';
import {
	DRAG_THRESHOLD_PX,
	dropIndexAt,
	exceedsDragThreshold,
	landingIndex,
	moveTabBy,
	reorderTabs,
	type TabBox
} from '$lib/tabReorder';

/** A strip of `n` 100px-wide, 30px-tall tabs on one row, starting at x=0. */
function oneRow(n: number, top = 0): TabBox[] {
	return Array.from({ length: n }, (_, i) => ({
		id: 't' + i,
		left: i * 100,
		right: (i + 1) * 100,
		top,
		bottom: top + 30
	}));
}

const tabs = (...ids: string[]) => ids.map((id) => ({ id }));
const idsOf = (list: { id: string }[]) => list.map((t) => t.id);

describe('drag threshold', () => {
	it('ignores the hand-jitter of an ordinary click', () => {
		// The whole point: a press that barely moves stays a click, so
		// click-to-switch and close-tab keep working exactly as before.
		expect(exceedsDragThreshold(0, 0)).toBe(false);
		expect(exceedsDragThreshold(2, 2)).toBe(false); // ~2.8px
		expect(exceedsDragThreshold(-3, 0)).toBe(false);
	});

	it('fires past the threshold, in any direction', () => {
		expect(exceedsDragThreshold(DRAG_THRESHOLD_PX, 0)).toBe(true);
		expect(exceedsDragThreshold(0, -DRAG_THRESHOLD_PX)).toBe(true);
		expect(exceedsDragThreshold(-4, 4)).toBe(true);
	});

	it('measures distance, not either axis alone', () => {
		// 3-4-5: neither leg reaches 4, but the travel is 5.
		expect(exceedsDragThreshold(3, 4)).toBe(true);
	});
});

describe('dropIndexAt - one row', () => {
	const boxes = oneRow(4); // |0..100|100..200|200..300|300..400|

	it('drops before a tab while the pointer is left of its midpoint', () => {
		expect(dropIndexAt(boxes, 10, 15)).toBe(0);
		expect(dropIndexAt(boxes, 49, 15)).toBe(0);
	});

	it('drops after a tab once the pointer passes its midpoint', () => {
		expect(dropIndexAt(boxes, 51, 15)).toBe(1);
		expect(dropIndexAt(boxes, 149, 15)).toBe(1);
		expect(dropIndexAt(boxes, 151, 15)).toBe(2);
	});

	it('reaches the very first slot', () => {
		// Dragging out past the left edge of the strip.
		expect(dropIndexAt(boxes, -500, 15)).toBe(0);
	});

	it('reaches the very last slot', () => {
		expect(dropIndexAt(boxes, 351, 15)).toBe(4);
		expect(dropIndexAt(boxes, 5000, 15)).toBe(4);
	});

	it('names a slot even when the pointer leaves the strip vertically', () => {
		// A drag that wanders above or below still has a definite target, so the
		// indicator never blinks out as the pointer skims the strip's edge.
		expect(dropIndexAt(boxes, 250, -400)).toBe(3);
		expect(dropIndexAt(boxes, 250, 900)).toBe(3);
	});

	it('answers 0 for an empty strip', () => {
		expect(dropIndexAt([], 10, 10)).toBe(0);
	});

	it('answers within a single-tab strip', () => {
		const one = oneRow(1);
		expect(dropIndexAt(one, 10, 15)).toBe(0);
		expect(dropIndexAt(one, 90, 15)).toBe(1);
	});
});

describe('dropIndexAt - a wrapped, multi-row strip', () => {
	// Row 0: t0 t1 t2 (y 0..30). Row 1: t3 t4 (y 30..60). This is the case a
	// naive left-to-right scan gets wrong - x alone cannot tell the rows apart.
	const boxes: TabBox[] = [...oneRow(3, 0), ...oneRow(2, 30).map((b, i) => ({ ...b, id: 't' + (3 + i) }))];

	it('picks the gap on the row the pointer is on, not the first row that matches x', () => {
		expect(dropIndexAt(boxes, 150, 15)).toBe(2); // row 0, past t1's midpoint
		expect(dropIndexAt(boxes, 150, 45)).toBe(5); // row 1, past t4's midpoint
	});

	it('puts the end of a row at the boundary of that row, not the end of the strip', () => {
		// Far right of row 0 → slot 3 (after t2), NOT slot 5.
		expect(dropIndexAt(boxes, 9000, 15)).toBe(3);
	});

	it('starts a row at its own first slot', () => {
		expect(dropIndexAt(boxes, -9000, 45)).toBe(3); // before t3, the first tab of row 1
	});

	it('takes the nearer row when the pointer is in the gutter between two', () => {
		// Rows here abut, so probe just inside each instead: the row choice is by
		// vertical distance, and a pointer inside a row is distance 0 from it.
		expect(dropIndexAt(boxes, 250, 1)).toBe(3); // row 0
		expect(dropIndexAt(boxes, 250, 59)).toBe(5); // row 1
	});

	it('tolerates the sub-pixel top values a real flex row reports', () => {
		// Same row, tops differing by a fraction of a pixel: still one row.
		const jittery: TabBox[] = [
			{ id: 'a', left: 0, right: 100, top: 0, bottom: 30 },
			{ id: 'b', left: 100, right: 200, top: 0.4, bottom: 30.4 }
		];
		expect(dropIndexAt(jittery, 150, 15)).toBe(2);
	});
});

describe('reorderTabs', () => {
	const four = tabs('a', 'b', 'c', 'd');

	it('moves a tab to an earlier slot', () => {
		expect(idsOf(reorderTabs(four, 'c', 0))).toEqual(['c', 'a', 'b', 'd']);
		expect(idsOf(reorderTabs(four, 'd', 1))).toEqual(['a', 'd', 'b', 'c']);
	});

	it('moves a tab to a later slot', () => {
		expect(idsOf(reorderTabs(four, 'a', 4))).toEqual(['b', 'c', 'd', 'a']);
		expect(idsOf(reorderTabs(four, 'a', 3))).toEqual(['b', 'c', 'a', 'd']);
	});

	it('reaches both ends', () => {
		expect(idsOf(reorderTabs(four, 'd', 0))).toEqual(['d', 'a', 'b', 'c']);
		expect(idsOf(reorderTabs(four, 'a', four.length))).toEqual(['b', 'c', 'd', 'a']);
	});

	it('leaves every other tab in its relative order', () => {
		expect(idsOf(reorderTabs(tabs('a', 'b', 'c', 'd', 'e'), 'b', 4))).toEqual(['a', 'c', 'd', 'b', 'e']);
	});

	it('is a genuine NO-OP when dropped back where it started', () => {
		// Both slots that describe the tab's own position, returned by REFERENCE so
		// a caller (and the shell's persistence effect) can see nothing changed.
		expect(reorderTabs(four, 'b', 1)).toBe(four);
		expect(reorderTabs(four, 'b', 2)).toBe(four);
	});

	it('no-ops for an unknown id rather than inventing a position', () => {
		expect(reorderTabs(four, 'nope', 0)).toBe(four);
	});

	it('clamps an out-of-range slot onto the strip', () => {
		expect(idsOf(reorderTabs(four, 'c', -5))).toEqual(['c', 'a', 'b', 'd']);
		expect(idsOf(reorderTabs(four, 'b', 99))).toEqual(['a', 'c', 'd', 'b']);
	});

	it('never moves anything in a single-tab strip', () => {
		const one = tabs('a');
		expect(reorderTabs(one, 'a', 0)).toBe(one);
		expect(reorderTabs(one, 'a', 1)).toBe(one);
	});

	it('does not mutate the input', () => {
		const before = idsOf(four);
		reorderTabs(four, 'a', 4);
		expect(idsOf(four)).toEqual(before);
	});

	it('carries the whole tab object, not just its id', () => {
		const rich = [
			{ id: 'a', path: 'a.ipynb', seq: 0 },
			{ id: 'b', path: 'b.ipynb', seq: 1 }
		];
		expect(reorderTabs(rich, 'b', 0)[0]).toEqual({
			id: 'b',
			path: 'b.ipynb',
			seq: 1
		});
	});
});

describe('landingIndex', () => {
	it('accounts for the tab being lifted out before it is put back', () => {
		expect(landingIndex(2, 0)).toBe(0); // moving left: slot is the landing index
		expect(landingIndex(0, 4)).toBe(3); // moving right: everything after shifts down one
		expect(landingIndex(1, 1)).toBe(1);
	});
});

describe('moveTabBy - the keyboard step', () => {
	const four = tabs('a', 'b', 'c', 'd');

	it('steps one place in either direction', () => {
		expect(idsOf(moveTabBy(four, 'c', -1))).toEqual(['a', 'c', 'b', 'd']);
		expect(idsOf(moveTabBy(four, 'c', 1))).toEqual(['a', 'b', 'd', 'c']);
	});

	it('is inert at either end, so holding the key writes nothing', () => {
		expect(moveTabBy(four, 'a', -1)).toBe(four);
		expect(moveTabBy(four, 'd', 1)).toBe(four);
	});

	it('no-ops for an unknown id', () => {
		expect(moveTabBy(four, 'nope', 1)).toBe(four);
	});

	it('agrees with reorderTabs about what one step means', () => {
		// The component expresses a keyboard step as an insertion slot so both
		// gestures come through ONE seam; the two must not disagree.
		for (let i = 0; i < four.length; i++) {
			const id = four[i].id;
			expect(idsOf(reorderTabs(four, id, i - 1))).toEqual(idsOf(moveTabBy(four, id, -1)));
			expect(idsOf(reorderTabs(four, id, i + 2))).toEqual(idsOf(moveTabBy(four, id, 1)));
		}
	});
});
