// Pure, DOM-free multi-cell selection algebra.
//
// THE INVARIANT THIS MODULE EXISTS FOR: a selection is a set of document-model
// cell ids, resolved against the document ORDER (the full `cells` array) - never
// against mounted DOM nodes. Windowed ("virtualized") cell rendering is on by
// default, so at any moment most of a large notebook has no DOM at all: a
// Shift-range whose endpoints are 200 cells apart must still select every cell
// between them, and a bulk delete/move/retype must act on exactly those ids
// whether or not they happen to be mounted. Walking the DOM would silently
// select only what is on screen - the one bug this whole module is shaped to
// prevent. (Selected cells are deliberately NOT pinned into the mounted set
// either: pinning a select-all would mount the entire notebook and undo
// windowing. A selected cell simply renders selected when it scrolls in, because
// `selected` is derived from this set, not from anything the cell remembers.)
//
// The three pieces of state the notebook keeps, and why each is separate:
//   - `activeId`   the PRIMARY cell: what takes DOM focus, what the single-cell
//                  ops address, and the moving END of a keyboard/Shift range.
//   - `anchorId`   the range ANCHOR: where a Shift range starts from. Kept apart
//                  from `activeId` so a second Shift+click re-ranges from the
//                  same origin (the platform convention) rather than from
//                  wherever the previous Shift+click happened to land.
//   - `selectedIds` the selection itself. It always contains `activeId`, so a
//                  plain single selection is the degenerate `{activeId}` case
//                  and every bulk op is the single-cell op at size 1.

/** The modifier intent of a selection gesture (a click, or a keyboard extend). */
export interface SelectionGesture {
	/** Shift: (re)range contiguously from the anchor to this cell. */
	extend?: boolean;
	/** Cmd (macOS) / Ctrl: toggle this cell in or out of the selection. */
	toggle?: boolean;
}

/** The modifier/button state of a pointer press, as much of it as this decides on. */
export interface PointerModifiers {
	button: number;
	shiftKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
}

/** What a pointer press MEANS to the selection. */
export interface PointerIntent extends SelectionGesture {
	extend: boolean;
	toggle: boolean;
	/**
	 * A context-menu / auxiliary press: NOT a selection gesture at all, so it must
	 * neither build a selection nor collapse one.
	 */
	secondary: boolean;
}

/**
 * Decode a pointer press into its selection intent, for the ONE platform question
 * this gesture turns on: what the Ctrl key means.
 *
 * On macOS the platform secondary (context-menu) press is CTRL+CLICK, which
 * arrives as `button === 0` with `ctrlKey` set, and the toggle modifier there is
 * Cmd. Deciding on the button alone therefore read a Mac right-click as a PLAIN
 * click and collapsed a five-cell selection an instant before the native menu
 * opened - exactly the failure the button check exists to prevent, reached
 * through the macOS spelling of the same gesture. Everywhere else Ctrl+click IS
 * the toggle, so the two readings must never be conflated.
 *
 * A secondary press yields NO extend/toggle whatever else is held (Ctrl+Shift on
 * macOS still opens the menu), so the caller's one rule is: a secondary press
 * preserves the selection by not collapsing it - never by cancelling the event,
 * which would suppress the compatibility mouse events the native menu needs.
 */
export function pointerIntent(e: PointerModifiers, mac: boolean): PointerIntent {
	const secondary = e.button !== 0 || (mac && e.ctrlKey);
	return {
		extend: !secondary && e.shiftKey,
		toggle: !secondary && (mac ? e.metaKey : e.ctrlKey),
		secondary
	};
}

/** One adjacent-swap step of a bulk move: put `id` at `toIndex`. */
export interface MoveStep {
	id: string;
	toIndex: number;
}

/**
 * The contiguous range of ids from `anchorId` to `targetId` inclusive, BY INDEX
 * in the full document order. Cells a folded heading is hiding lie in that order
 * too and are included: a collapsed section is part of the document, and Jupyter
 * likewise operates on a collapsed heading's whole section. An unknown endpoint
 * degrades to the other one alone (and to `[]` when neither is known).
 */
export function rangeIds(order: readonly string[], anchorId: string | null, targetId: string | null): string[] {
	const a = anchorId == null ? -1 : order.indexOf(anchorId);
	const b = targetId == null ? -1 : order.indexOf(targetId);
	if (a < 0 && b < 0) return [];
	if (a < 0) return [order[b]];
	if (b < 0) return [order[a]];
	const from = Math.min(a, b);
	const to = Math.max(a, b);
	return order.slice(from, to + 1);
}

/** The selection in document order (ids absent from `order` are dropped). */
export function orderedSelection(order: readonly string[], selected: ReadonlySet<string>): string[] {
	return order.filter((id) => selected.has(id));
}

/**
 * True when the selection occupies one unbroken run of the document order.
 *
 * Part of this module's algebra rather than a rule any surface reads today: the
 * ops are all contiguity-agnostic on purpose (`moveSelectionPlan` generalizes to a
 * scattered selection with no special case), so the only caller is the unit suite,
 * which uses it to state what a move did to the selection's SHAPE.
 */
export function isContiguous(order: readonly string[], selected: ReadonlySet<string>): boolean {
	const idx = order.flatMap((id, i) => (selected.has(id) ? [i] : []));
	if (idx.length <= 1) return true;
	return idx[idx.length - 1] - idx[0] === idx.length - 1;
}

/**
 * Toggle `id` in or out of `selected` (the Cmd/Ctrl gesture), returning the new
 * set. A toggle that would empty the selection is REFUSED (the set comes back
 * unchanged): a notebook always has a selected cell - command mode acts on it,
 * and `activeId` must stay a member - so "deselect the last one" has no useful
 * meaning and would strand the keyboard with nothing to act on.
 */
export function toggled(selected: ReadonlySet<string>, id: string): Set<string> {
	const next = new Set(selected);
	if (next.has(id)) {
		if (next.size <= 1) return next; // refuse to empty the selection
		next.delete(id);
	} else {
		next.add(id);
	}
	return next;
}

/**
 * Which cell should be primary (`activeId`) after `id` was toggled OUT of the
 * selection: the nearest remaining selected cell, preferring the one below (the
 * direction a deletion also settles in). Null only when nothing is left.
 */
export function nearestSelected(order: readonly string[], selected: ReadonlySet<string>, id: string): string | null {
	const at = order.indexOf(id);
	if (at < 0) return orderedSelection(order, selected)[0] ?? null;
	for (let i = at + 1; i < order.length; i++) if (selected.has(order[i])) return order[i];
	for (let i = at - 1; i >= 0; i--) if (selected.has(order[i])) return order[i];
	return null;
}

/**
 * Where the primary goes when a fold hides it while a MULTI-cell selection is
 * standing: the nearest still-visible MEMBER of that selection, preferring the
 * one below (the same direction `nearestSelected` settles in). Null when the fold
 * hides every member - the one case with nowhere inside the selection to put the
 * primary, and the only one where the caller may collapse.
 *
 * Re-seating rather than collapsing is what satisfies both standing rules at
 * once: `selectedIds` may legitimately CONTAIN fold-hidden cells (a Shift range
 * fills in by document index and select-all takes the whole order), while the
 * primary must stay a MEMBER of it, or `pruneSelection`'s `kept.add(activeId)`
 * would silently widen the set on the next refetch.
 */
export function reseatHiddenPrimary(
	order: readonly string[],
	selected: ReadonlySet<string>,
	activeId: string,
	hidden: ReadonlySet<string>
): string | null {
	const usable = (id: string) => selected.has(id) && !hidden.has(id);
	const at = order.indexOf(activeId);
	if (at < 0) return orderedSelection(order, selected).find((id) => !hidden.has(id)) ?? null;
	for (let i = at + 1; i < order.length; i++) if (usable(order[i])) return order[i];
	for (let i = at - 1; i >= 0; i--) if (usable(order[i])) return order[i];
	return null;
}

/**
 * The cell to select after `removed` is deleted: whatever slides into the place
 * of the FIRST removed cell, clamped to the end. Deliberately identical to the
 * single-cell rule (`selectAfterRemoval`) at size 1 - one removal at index `i`
 * leaves `survivors[min(i, len-1)]`.
 */
export function selectionAfterRemoval(order: readonly string[], removed: ReadonlySet<string>): string | null {
	const survivors = order.filter((id) => !removed.has(id));
	if (!survivors.length) return null;
	let before = 0;
	for (const id of order) {
		if (removed.has(id)) break;
		before++;
	}
	return survivors[Math.min(before, survivors.length - 1)];
}

/**
 * The adjacent-swap steps that move every selected cell one position `dir`,
 * carrying the selection as a unit.
 *
 * Semantics (JupyterLab's, and the reason they generalize cleanly to a
 * NON-contiguous selection with no special case): each selected cell swaps with
 * its unselected neighbour in `dir`, walking the document from that end. A
 * contiguous block therefore slides as a block and stays contiguous; a scattered
 * selection has each of its cells step one position, keeping relative order and
 * the gaps between them. Nothing is "gathered" - a move never restructures a
 * selection the user built.
 *
 * The whole move is BLOCKED (empty plan) when the selection already touches the
 * edge it is moving toward, so a partial slide can never silently reorder the
 * selection relative to itself.
 *
 * Each step is expressed as "put `id` at `toIndex`", which is exactly one
 * adjacent swap - so replaying the steps in order through the existing
 * splice-based `cell:moved` apply reproduces the result on every client, and no
 * new event shape is needed.
 */
export function moveSelectionPlan(order: readonly string[], selected: ReadonlySet<string>, dir: 'up' | 'down'): MoveStep[] {
	const n = order.length;
	if (!n || !selected.size) return [];
	const edge = dir === 'up' ? order[0] : order[n - 1];
	if (selected.has(edge)) return []; // already against the wall
	const work = [...order];
	const steps: MoveStep[] = [];
	if (dir === 'up') {
		for (let p = 1; p < n; p++) {
			if (!selected.has(work[p]) || selected.has(work[p - 1])) continue;
			const id = work[p];
			work.splice(p, 1);
			work.splice(p - 1, 0, id);
			steps.push({ id, toIndex: p - 1 });
		}
	} else {
		for (let p = n - 2; p >= 0; p--) {
			if (!selected.has(work[p]) || selected.has(work[p + 1])) continue;
			const id = work[p];
			work.splice(p, 1);
			work.splice(p + 1, 0, id);
			steps.push({ id, toIndex: p + 1 });
		}
	}
	return steps;
}

/**
 * Apply a move plan to an id order the way a RECEIVING client does: tolerantly.
 * An unknown id is skipped and an out-of-range index is clamped, exactly like
 * `LiveNotebook`'s `cell:moved` handler, because a tab applying someone else's
 * events cannot refuse them - it has no plan to abandon, only events to replay.
 *
 * That is what the tests use it for: proving the `cell:moved` events a batch emits
 * replay into the order the batch actually persisted.
 *
 * The two INITIATING halves - `LiveNotebook`'s `moveSelection` and the server's
 * `moveCells` - deliberately do NOT go through this, and routing them through it
 * would be wrong rather than merely redundant: each interleaves the
 * `clampMoveIndex` guard step by step (an adjacent swap's legality depends on the
 * swaps before it) and abandons the WHOLE plan on a refusal, so it never persists
 * or renders a selection half-slid past itself. Tolerant replay and guarded apply
 * are different contracts; the duplication between those two is the deliberate
 * client/server mirror `clampMoveIndex` exists to keep in step.
 */
export function applyMovePlan(order: readonly string[], steps: readonly MoveStep[]): string[] {
	const work = [...order];
	for (const { id, toIndex } of steps) {
		const from = work.indexOf(id);
		if (from < 0) continue;
		work.splice(from, 1);
		work.splice(Math.max(0, Math.min(toIndex, work.length)), 0, id);
	}
	return work;
}

/**
 * Resolve a selection gesture on `id` into the next selection state.
 *
 * `extend` (Shift) REPLACES the selection with the anchor→id range and moves the
 * primary to `id` while leaving the anchor put, so a second Shift+click
 * re-ranges from the same origin. `toggle` (Cmd/Ctrl) flips `id`: toggling it IN
 * makes it both primary and anchor, and toggling it OUT moves the primary ONLY
 * when `id` WAS the primary. A plain gesture collapses to `id` alone.
 */
export function applyGesture(
	order: readonly string[],
	state: { activeId: string | null; anchorId: string | null; selected: ReadonlySet<string> },
	id: string,
	gesture: SelectionGesture = {}
): { activeId: string; anchorId: string; selected: Set<string> } {
	if (gesture.extend) {
		const anchor = state.anchorId && order.includes(state.anchorId) ? state.anchorId : (state.activeId ?? id);
		return { activeId: id, anchorId: anchor, selected: new Set(rangeIds(order, anchor, id)) };
	}
	if (gesture.toggle) {
		const selected = toggled(state.selected, id);
		// Toggling a cell OUT only moves the primary when the cell WAS the primary -
		// then primacy goes to the nearest survivor and the anchor follows it, so the
		// next Shift range starts where the user just was. Deselecting ANY OTHER cell
		// must leave both ends exactly where the user put them: moving them there would
		// silently relocate DOM focus (the caller focuses the resulting primary) and
		// re-seat the origin of the next Shift range, neither of which a deselect asked
		// for. `nearestSelected`'s own contract is scoped to the primary's replacement.
		if (!selected.has(id) && state.activeId != null && state.activeId !== id) {
			return { activeId: state.activeId, anchorId: state.anchorId ?? state.activeId, selected };
		}
		const active = selected.has(id) ? id : (nearestSelected(order, selected, id) ?? id);
		return { activeId: active, anchorId: active, selected };
	}
	return { activeId: id, anchorId: id, selected: new Set([id]) };
}

/**
 * Where the head lands when it sits on a cell `walk` does not contain (a
 * fold-hidden cell): the `delta`-th walkable cell past its DOCUMENT position, in
 * the direction of travel. Undefined when nothing is left that way; a head absent
 * from the document order too has no position to step from, so the walk restarts.
 *
 * Shared by BOTH keyboard moves - plain `j`/`k` and Shift+J/K - because both walk
 * the selectable list from a head that may legitimately be fold-hidden (select-all
 * leaves the head on the last cell of the document without revealing it, since a
 * reveal writes persisted fold state). Restarting at `walk[0]` instead flings the
 * selection to the TOP of the notebook on the first keystroke after Cmd/Ctrl+A;
 * one rule here is what keeps the two paths from diverging on that again.
 */
export function stepFromUnwalkableHead(
	order: readonly string[],
	walk: readonly string[],
	activeId: string | null,
	delta: number
): string | undefined {
	const pos = activeId == null ? -1 : order.indexOf(activeId);
	if (pos < 0) return walk[0];
	if (!delta) return undefined;
	// Walkable cells lying before the head in document order; the head sits in the
	// gap at exactly this insertion point, so `before` is the next entry downward
	// and `before - 1` the next entry upward.
	const before = walk.filter((id) => order.indexOf(id) < pos).length;
	return walk[delta > 0 ? before + delta - 1 : before + delta];
}

/**
 * Extend the contiguous selection one step in `delta` from the current primary
 * (Shift+J/K, Shift+Arrows). `walk` is the list the head moves along - the
 * SELECTABLE cells, so the head skips cells a folded heading hides exactly like
 * plain `j`/`k` - while the resulting range still fills in by full-document
 * index. Returns null when the head cannot move (no list, or already at the end).
 *
 * The head may legitimately BE a fold-hidden cell, and then it is absent from
 * `walk`: select-all leaves the head on the last cell of the document without
 * revealing it (revealing writes persisted fold state, which a selection must not
 * do). Such a head is resolved by its DOCUMENT position - the step lands on the
 * nearest walkable cell in the direction of travel - because falling back to
 * `walk[0]` would fling the head to the top of the notebook and `rangeIds` would
 * then collapse the whole selection on one keystroke. Only a head absent from the
 * document order itself (a deleted cell) has no position to step from, and there
 * the walk restarts at its first entry.
 */
export function extendSelection(
	order: readonly string[],
	walk: readonly string[],
	state: { activeId: string | null; anchorId: string | null },
	delta: number
): { activeId: string; anchorId: string; selected: Set<string> } | null {
	if (!walk.length) return null;
	const at = state.activeId ? walk.indexOf(state.activeId) : -1;
	const next = at >= 0 ? walk[at + delta] : stepFromUnwalkableHead(order, walk, state.activeId, delta);
	if (!next) return null;
	const anchor = state.anchorId && order.includes(state.anchorId) ? state.anchorId : (state.activeId ?? next);
	return { activeId: next, anchorId: anchor, selected: new Set(rangeIds(order, anchor, next)) };
}
