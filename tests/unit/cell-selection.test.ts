/**
 * Multi-cell selection - the pure algebra (`$lib/cellSelection`).
 *
 * This is the must-pass gate for the feature: every selection rule and every
 * bulk-op target list is decided here, over a plain array of ids in DOCUMENT
 * order. Nothing in this module knows what is mounted, which is exactly the
 * point - windowed rendering is on by default, so a Shift range whose endpoints
 * are 200 cells apart has most of its members absent from the DOM, and a rule
 * that consulted the DOM would silently select only what happened to be on
 * screen. The `LiveNotebook` wiring is thin over these functions; the e2e
 * (`tests/e2e/multi-select.spec.ts`) proves the wiring, and this proves the rules.
 */
import { describe, it, expect } from 'vitest';
import {
	applyGesture,
	applyMovePlan,
	extendSelection,
	isContiguous,
	moveSelectionPlan,
	nearestSelected,
	orderedSelection,
	pointerIntent,
	rangeIds,
	reseatHiddenPrimary,
	selectionAfterRemoval,
	stepFromUnwalkableHead,
	toggled
} from '../../src/lib/cellSelection';

const ORDER = ['a', 'b', 'c', 'd', 'e'];
const set = (...ids: string[]) => new Set(ids);

describe('rangeIds - the Shift gesture, by document index', () => {
	it('selects everything between the two endpoints, inclusive', () => {
		expect(rangeIds(ORDER, 'b', 'd')).toEqual(['b', 'c', 'd']);
	});

	it('is direction-agnostic: dragging the range upward selects the same cells', () => {
		expect(rangeIds(ORDER, 'd', 'b')).toEqual(['b', 'c', 'd']);
	});

	it('a range onto the anchor itself is that one cell', () => {
		expect(rangeIds(ORDER, 'c', 'c')).toEqual(['c']);
	});

	it('spans the WHOLE document order, not some visible subset - the windowing contract', () => {
		// 300 cells; under windowing well under 20 of them have a DOM node at once.
		const long = Array.from({ length: 300 }, (_, i) => `c${i}`);
		const picked = rangeIds(long, 'c5', 'c280');
		expect(picked).toHaveLength(276);
		expect(picked[0]).toBe('c5');
		expect(picked.at(-1)).toBe('c280');
	});

	it('degrades to the surviving endpoint when the other is gone (a remote delete)', () => {
		expect(rangeIds(ORDER, 'gone', 'c')).toEqual(['c']);
		expect(rangeIds(ORDER, 'c', 'gone')).toEqual(['c']);
		expect(rangeIds(ORDER, 'gone', 'also-gone')).toEqual([]);
	});
});

describe('toggled - the Cmd/Ctrl gesture', () => {
	it('adds a cell that is out and removes one that is in', () => {
		expect([...toggled(set('a'), 'c')]).toEqual(['a', 'c']);
		expect([...toggled(set('a', 'c'), 'c')]).toEqual(['a']);
	});

	it('REFUSES to empty the selection - a notebook always has a selected cell', () => {
		// Command mode acts on the selection and the primary must stay a member, so
		// "deselect the last one" would strand the keyboard with nothing to act on.
		expect([...toggled(set('c'), 'c')]).toEqual(['c']);
	});

	it('never mutates the set it was handed', () => {
		const before = set('a');
		toggled(before, 'b');
		expect([...before]).toEqual(['a']);
	});
});

describe('orderedSelection / isContiguous', () => {
	it('returns the selection in document order however it was built', () => {
		expect(orderedSelection(ORDER, set('d', 'a', 'c'))).toEqual(['a', 'c', 'd']);
	});

	it('drops ids the document no longer has', () => {
		expect(orderedSelection(ORDER, set('a', 'ghost'))).toEqual(['a']);
	});

	it('tells an unbroken run from a scattered one', () => {
		expect(isContiguous(ORDER, set('b', 'c', 'd'))).toBe(true);
		expect(isContiguous(ORDER, set('b', 'd'))).toBe(false);
		expect(isContiguous(ORDER, set('c'))).toBe(true);
		expect(isContiguous(ORDER, set())).toBe(true);
	});
});

describe('applyGesture - what a click does', () => {
	const plain = { activeId: 'c', anchorId: 'c', selected: set('c') };

	it('a plain click collapses to that cell alone and re-anchors there', () => {
		const next = applyGesture(ORDER, plain, 'e');
		expect(next.activeId).toBe('e');
		expect(next.anchorId).toBe('e');
		expect([...next.selected]).toEqual(['e']);
	});

	it('Shift+click ranges from the anchor and moves the primary to the clicked cell', () => {
		const next = applyGesture(ORDER, plain, 'e', { extend: true });
		expect(next.activeId).toBe('e');
		expect([...next.selected]).toEqual(['c', 'd', 'e']);
	});

	it('a SECOND Shift+click re-ranges from the SAME anchor, not from the last one', () => {
		// The platform convention, and the reason `anchorId` is separate from
		// `activeId`: shift-clicking back up shrinks the range instead of inverting it
		// around wherever the previous shift-click landed.
		const first = applyGesture(ORDER, plain, 'e', { extend: true });
		expect(first.anchorId).toBe('c');
		const second = applyGesture(ORDER, { ...first, selected: first.selected }, 'd', { extend: true });
		expect(second.anchorId).toBe('c');
		expect([...second.selected]).toEqual(['c', 'd']);
	});

	it('Cmd/Ctrl+click toggles a cell in without disturbing the rest (non-contiguous)', () => {
		const next = applyGesture(ORDER, plain, 'e', { toggle: true });
		expect([...next.selected]).toEqual(['c', 'e']);
		expect(next.activeId).toBe('e');
		expect(next.anchorId).toBe('e'); // the anchor follows the primary
		expect(isContiguous(ORDER, next.selected)).toBe(false);
	});

	it('Cmd/Ctrl+click on the PRIMARY hands primacy to the nearest survivor', () => {
		const state = { activeId: 'c', anchorId: 'a', selected: set('a', 'c', 'e') };
		const next = applyGesture(ORDER, state, 'c', { toggle: true });
		expect([...next.selected]).toEqual(['a', 'e']);
		expect(next.activeId).toBe('e'); // prefers the one below, as a deletion does
	});

	it('Cmd/Ctrl+click on a NON-primary leaves the primary and the anchor alone', () => {
		// The companion of the case above, and the one that shipped through several
		// reviews unwritten. `nearestSelected` answers "who replaces the primary", so
		// applying it to ANY toggled-out cell silently relocated both ends: with {a,c,e}
		// and the primary on `e`, deselecting `a` moved the primary (and with it DOM
		// focus, which the caller places on it) to `c` and re-seated the origin of the
		// next Shift range - none of which a deselect asked for.
		const state = { activeId: 'e', anchorId: 'a', selected: set('a', 'c', 'e') };
		const next = applyGesture(ORDER, state, 'a', { toggle: true });
		expect([...next.selected]).toEqual(['c', 'e']); // shrank by exactly the toggled id
		expect(next.activeId).toBe('e');
		expect(next.anchorId).toBe('a');
	});

	it('…and that holds for a toggled-out cell BELOW the primary too', () => {
		const state = { activeId: 'b', anchorId: 'b', selected: set('b', 'c', 'e') };
		const next = applyGesture(ORDER, state, 'e', { toggle: true });
		expect([...next.selected]).toEqual(['b', 'c']);
		expect(next.activeId).toBe('b');
		expect(next.anchorId).toBe('b');
	});
});

describe('pointerIntent - what Ctrl means, which is a PLATFORM question', () => {
	const press = (over: Partial<Parameters<typeof pointerIntent>[0]> = {}) => ({
		button: 0,
		shiftKey: false,
		ctrlKey: false,
		metaKey: false,
		...over
	});

	it('reads a macOS Ctrl+click as the SECONDARY press it is, never as a selection gesture', () => {
		// The bug this exists for: on macOS the context-menu press is Ctrl+click, which
		// arrives as `button === 0` with `ctrlKey` set, while the toggle modifier there
		// is Cmd. Deciding on the button alone therefore read it as a PLAIN click, whose
		// caller collapses the selection to that one cell - destroying a five-cell
		// selection an instant before the native menu opened.
		const intent = pointerIntent(press({ ctrlKey: true }), true);
		expect(intent.secondary).toBe(true);
		expect(intent.toggle).toBe(false);
		expect(intent.extend).toBe(false);
	});

	it('still reads a Ctrl+click OFF macOS as the toggle gesture', () => {
		const intent = pointerIntent(press({ ctrlKey: true }), false);
		expect(intent.secondary).toBe(false);
		expect(intent.toggle).toBe(true);
	});

	it('takes Cmd as the toggle on macOS and Ctrl everywhere else', () => {
		expect(pointerIntent(press({ metaKey: true }), true).toggle).toBe(true);
		expect(pointerIntent(press({ metaKey: true }), false).toggle).toBe(false);
	});

	it('a non-primary button is secondary on every platform, whatever is held', () => {
		for (const mac of [true, false]) {
			expect(pointerIntent(press({ button: 2 }), mac).secondary).toBe(true);
			expect(pointerIntent(press({ button: 1, shiftKey: true }), mac).extend).toBe(false);
			expect(pointerIntent(press({ button: 2, ctrlKey: true, metaKey: true }), mac).toggle).toBe(false);
		}
	});

	it('a macOS Ctrl+Shift+click is still the context menu, so it builds no range', () => {
		// Preserving the selection is the safe direction: the menu opens either way, and
		// a press that re-ranged behind it would silently discard what the user had.
		const intent = pointerIntent(press({ ctrlKey: true, shiftKey: true }), true);
		expect(intent.secondary).toBe(true);
		expect(intent.extend).toBe(false);
	});

	it('an unmodified primary press is a plain click: no gesture, not secondary', () => {
		const intent = pointerIntent(press(), true);
		expect(intent).toEqual({ extend: false, toggle: false, secondary: false });
	});

	it('Shift is the range gesture on both platforms', () => {
		expect(pointerIntent(press({ shiftKey: true }), true).extend).toBe(true);
		expect(pointerIntent(press({ shiftKey: true }), false).extend).toBe(true);
	});
});

describe('stepFromUnwalkableHead - the ONE fold-hidden-head rule, shared by j/k and Shift+J/K', () => {
	// Exported so plain `j`/`k` resolves a head the walk does not contain exactly as
	// Shift+J/K does. `selectRelative` used to take a bare `findIndex` miss as
	// "restart at the first entry", so the very next keystroke after Cmd/Ctrl+A on a
	// notebook whose tail section is collapsed flung the selection to the TOP.
	const WALK = ['a', 'b', 'c']; // `d` and `e` hidden by a collapsed heading

	it('steps to the nearest walkable cell in the direction of travel', () => {
		expect(stepFromUnwalkableHead(ORDER, WALK, 'e', -1)).toBe('c');
		expect(stepFromUnwalkableHead(ORDER, ['a', 'e'], 'c', 1)).toBe('e');
	});

	it('is undefined when nothing is left that way, so the caller stays put', () => {
		expect(stepFromUnwalkableHead(ORDER, WALK, 'e', 1)).toBeUndefined();
		expect(stepFromUnwalkableHead(ORDER, ['c', 'd'], 'a', -1)).toBeUndefined();
	});

	it('restarts the walk only when the head is gone from the document too', () => {
		expect(stepFromUnwalkableHead(ORDER, WALK, 'deleted', 1)).toBe('a');
		expect(stepFromUnwalkableHead(ORDER, WALK, null, -1)).toBe('a');
	});
});

describe('extendSelection - Shift+J/K and Shift+Arrows', () => {
	it('grows the range one cell in the given direction', () => {
		const next = extendSelection(ORDER, ORDER, { activeId: 'c', anchorId: 'c' }, 1);
		expect(next?.activeId).toBe('d');
		expect([...(next?.selected ?? [])]).toEqual(['c', 'd']);
	});

	it('SHRINKS the range when it reverses, because it re-derives from the anchor', () => {
		const grown = extendSelection(ORDER, ORDER, { activeId: 'b', anchorId: 'b' }, 1);
		const shrunk = extendSelection(ORDER, ORDER, { activeId: grown!.activeId, anchorId: grown!.anchorId }, -1);
		expect([...shrunk!.selected]).toEqual(['b']);
	});

	it('walks the SELECTABLE list, so the head skips cells a folded heading hides…', () => {
		// `c` is inside a collapsed section: `j`/`k` skip it, so the head must too.
		const walk = ['a', 'b', 'd', 'e'];
		const next = extendSelection(ORDER, walk, { activeId: 'b', anchorId: 'b' }, 1);
		expect(next?.activeId).toBe('d');
		// …but the RANGE still fills in by full-document index, so the folded cell is
		// part of the selection - a collapsed section is part of the document.
		expect([...(next?.selected ?? [])]).toEqual(['b', 'c', 'd']);
	});

	it('returns null at either end (nothing to extend onto)', () => {
		expect(extendSelection(ORDER, ORDER, { activeId: 'a', anchorId: 'a' }, -1)).toBeNull();
		expect(extendSelection(ORDER, ORDER, { activeId: 'e', anchorId: 'e' }, 1)).toBeNull();
		expect(extendSelection(ORDER, [], { activeId: 'a', anchorId: 'a' }, 1)).toBeNull();
	});

	it('steps by DOCUMENT position when the head itself is fold-hidden', () => {
		// The shape select-all leaves: it puts the head on the last cell of the
		// document without revealing it (a reveal writes persisted fold state), so a
		// collapsed tail section makes the head absent from the walk. Restarting the
		// walk at its first entry would fling the head to the top and `rangeIds` would
		// collapse the whole selection on one keystroke.
		const walk = ['a', 'b', 'c'];
		const shrunk = extendSelection(ORDER, walk, { activeId: 'e', anchorId: 'a' }, -1);
		expect(shrunk?.activeId).toBe('c');
		expect([...(shrunk?.selected ?? [])]).toEqual(['a', 'b', 'c']);

		// The other direction from a hidden head lands on the nearest walkable cell
		// BELOW it - and null when the collapsed section runs to the end.
		expect(extendSelection(ORDER, walk, { activeId: 'd', anchorId: 'a' }, 1)).toBeNull();
		expect(extendSelection(ORDER, ['a', 'e'], { activeId: 'c', anchorId: 'a' }, 1)?.activeId).toBe('e');
	});

	it('restarts the walk only when the head is gone from the document too', () => {
		const next = extendSelection(ORDER, ORDER, { activeId: 'deleted', anchorId: 'deleted' }, 1);
		expect(next?.activeId).toBe('a');
	});
});

describe('selectionAfterRemoval - where the selection lands after a bulk delete', () => {
	it('takes whatever slid into the place of the FIRST removed cell', () => {
		expect(selectionAfterRemoval(ORDER, set('b', 'c'))).toBe('d');
	});

	it('clamps to the last survivor when the removal ran off the end', () => {
		expect(selectionAfterRemoval(ORDER, set('d', 'e'))).toBe('c');
	});

	it('handles a scattered removal', () => {
		expect(selectionAfterRemoval(ORDER, set('a', 'c', 'e'))).toBe('b');
	});

	it('is IDENTICAL to the single-cell rule at size 1 - the common case cannot drift', () => {
		// The single path selects `cells[min(i, len-1)]` of the post-removal array.
		for (let i = 0; i < ORDER.length; i++) {
			const survivors = ORDER.filter((id) => id !== ORDER[i]);
			expect(selectionAfterRemoval(ORDER, set(ORDER[i]))).toBe(survivors[Math.min(i, survivors.length - 1)]);
		}
	});

	it('is null only when nothing survives', () => {
		expect(selectionAfterRemoval(ORDER, new Set(ORDER))).toBeNull();
	});
});

describe('nearestSelected', () => {
	it('prefers the selected cell below, then falls back above', () => {
		expect(nearestSelected(ORDER, set('a', 'e'), 'c')).toBe('e');
		expect(nearestSelected(ORDER, set('a'), 'c')).toBe('a');
		expect(nearestSelected(ORDER, set(), 'c')).toBeNull();
	});
});

describe('reseatHiddenPrimary - a fold hiding the primary must not discard the selection', () => {
	it('moves the primary to the nearest still-visible MEMBER, keeping the set', () => {
		// Selection b..e, primary c, and the fold swallows b and c.
		expect(reseatHiddenPrimary(ORDER, set('b', 'c', 'd', 'e'), 'c', set('b', 'c'))).toBe('d');
	});

	it('falls back above when nothing selected below survives the fold', () => {
		expect(reseatHiddenPrimary(ORDER, set('a', 'c', 'd'), 'c', set('c', 'd'))).toBe('a');
	});

	it('is null ONLY when the fold hides every member - the one case with nowhere to go', () => {
		expect(reseatHiddenPrimary(ORDER, set('c', 'd'), 'c', set('c', 'd'))).toBeNull();
		// The degenerate single-cell selection is exactly that case, so the caller
		// still collapses onto the owning header as it always did.
		expect(reseatHiddenPrimary(ORDER, set('c'), 'c', set('c'))).toBeNull();
	});
});

describe('moveSelectionPlan - carrying a selection as a unit', () => {
	const order = (steps: ReturnType<typeof moveSelectionPlan>, from = ORDER) => applyMovePlan(from, steps);

	it('slides a CONTIGUOUS block up as a block, keeping it contiguous', () => {
		const steps = moveSelectionPlan(ORDER, set('c', 'd'), 'up');
		const next = order(steps);
		expect(next).toEqual(['a', 'c', 'd', 'b', 'e']);
		expect(isContiguous(next, set('c', 'd'))).toBe(true);
	});

	it('slides a contiguous block down as a block', () => {
		expect(order(moveSelectionPlan(ORDER, set('b', 'c'), 'down'))).toEqual(['a', 'd', 'b', 'c', 'e']);
	});

	it('steps a NON-CONTIGUOUS selection one place each, preserving order and gaps', () => {
		// Deliberately NOT a "gather into a block" - a move must never restructure a
		// selection the user built by hand.
		expect(order(moveSelectionPlan(ORDER, set('b', 'd'), 'up'))).toEqual(['b', 'a', 'd', 'c', 'e']);
		expect(order(moveSelectionPlan(ORDER, set('b', 'd'), 'down'))).toEqual(['a', 'c', 'b', 'e', 'd']);
	});

	it('BLOCKS the whole move when the selection already touches that edge', () => {
		// Blocking beats a partial slide: a partial one would silently reorder the
		// selection relative to itself.
		expect(moveSelectionPlan(ORDER, set('a', 'c'), 'up')).toEqual([]);
		expect(moveSelectionPlan(ORDER, set('c', 'e'), 'down')).toEqual([]);
	});

	it('is a plain adjacent swap at size 1 - identical to the single-cell move', () => {
		expect(order(moveSelectionPlan(ORDER, set('c'), 'up'))).toEqual(['a', 'c', 'b', 'd', 'e']);
		expect(order(moveSelectionPlan(ORDER, set('c'), 'down'))).toEqual(['a', 'b', 'd', 'c', 'e']);
	});

	it('every step is ONE adjacent swap, so replaying them reproduces the result', () => {
		// This is what lets the batch reuse the ordinary `cell:moved` event: each step
		// is a splice-out/splice-in of neighbouring positions, which every client
		// already applies.
		for (const dir of ['up', 'down'] as const) {
			const steps = moveSelectionPlan(ORDER, set('b', 'c', 'e'), dir);
			const work = [...ORDER];
			for (const step of steps) {
				const from = work.indexOf(step.id);
				expect(Math.abs(from - step.toIndex)).toBe(1);
				work.splice(from, 1);
				work.splice(step.toIndex, 0, step.id);
			}
			expect(work).toEqual(applyMovePlan(ORDER, steps));
		}
	});

	it('moves a selection whose members are far apart in a long notebook', () => {
		const long = Array.from({ length: 300 }, (_, i) => `c${i}`);
		const selected = set('c10', 'c150', 'c299');
		const next = applyMovePlan(long, moveSelectionPlan(long, selected, 'up'));
		expect(next.indexOf('c10')).toBe(9);
		expect(next.indexOf('c150')).toBe(149);
		expect(next.indexOf('c299')).toBe(298);
		expect(next).toHaveLength(300);
		expect(new Set(next).size).toBe(300); // nothing lost or duplicated
	});

	it('is a no-op for an empty selection or an empty document', () => {
		expect(moveSelectionPlan(ORDER, set(), 'up')).toEqual([]);
		expect(moveSelectionPlan([], set('a'), 'down')).toEqual([]);
	});
});
