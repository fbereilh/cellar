// The pure rules behind drag-and-drop reordering of the open-file tab strip.
//
// Kept out of `Navbar.svelte` deliberately: the two interesting decisions here -
// where a pointer at (x, y) would DROP a tab, and what the resulting order is -
// are pure functions of geometry and an array, and vitest runs without the
// SvelteKit plugin so a rule left inside the component could not be tested at
// all. `virtualization.ts` / `cellSelection.ts` / `sidebarSections.ts` are the
// same shape for the same reason.
//
// Two things make this less trivial than "swap two array slots":
//
//   1. The strip WRAPS (`flex-wrap`), so it is a multi-row layout. Hit-testing
//      has to pick a ROW first and only then a gap within it - a single
//      left-to-right scan over every tab would put the drop indicator on the
//      wrong row the moment the tabs spill past one line.
//   2. Dropping a tab back where it started must be a genuine NO-OP, not a
//      rebuilt array that churns state (and, through the shell's persistence
//      `$effect`, rewrites the saved session). Both reorder helpers therefore
//      return the SAME ARRAY REFERENCE when nothing moves, so "no move" is a
//      structural fact a caller can test with `===` rather than a convention.

/**
 * How far (px) the pointer must travel from where it went down before a press
 * becomes a drag. Small enough that a deliberate drag feels immediate, large
 * enough that the hand-jitter of an ordinary click never reorders a tab - which
 * is what keeps click-to-switch and close-tab as reliable as they were before
 * tabs became draggable.
 */
export const DRAG_THRESHOLD_PX = 4;

/** One tab's laid-out box, in viewport coordinates (a `getBoundingClientRect`). */
export interface TabBox {
	id: string;
	left: number;
	right: number;
	top: number;
	bottom: number;
}

/** True once a press has travelled far enough to count as a drag. */
export function exceedsDragThreshold(dx: number, dy: number, threshold = DRAG_THRESHOLD_PX): boolean {
	return Math.hypot(dx, dy) >= threshold;
}

/**
 * Split boxes (in document order) into visual rows.
 *
 * Two tabs share a row when their vertical CENTRES are closer than half the
 * shorter box - a tolerant test, because sub-pixel layout means tabs on one row
 * rarely report byte-identical `top` values, while a genuine wrap moves the box
 * by a whole row height. Returned as index ranges so a row can be mapped back
 * onto positions in the original array.
 */
function rowsOf(boxes: TabBox[]): { start: number; end: number }[] {
	const rows: { start: number; end: number }[] = [];
	for (let i = 0; i < boxes.length; i++) {
		const b = boxes[i];
		const row = rows[rows.length - 1];
		if (row) {
			const first = boxes[row.start];
			const tolerance = Math.min(first.bottom - first.top, b.bottom - b.top) / 2;
			const sameRow = Math.abs((b.top + b.bottom) / 2 - (first.top + first.bottom) / 2) < tolerance;
			if (sameRow) {
				row.end = i;
				continue;
			}
		}
		rows.push({ start: i, end: i });
	}
	return rows;
}

/**
 * The INSERTION INDEX a pointer at (x, y) would drop at: the slot in `boxes`
 * the dragged tab would land in front of, so `0` means "before the first tab"
 * and `boxes.length` means "after the last one". Both extremes are reachable -
 * dragging past the left edge of the first tab and past the right edge of the
 * last one are the two positions a naive nearest-tab rule gets wrong.
 *
 * The pointer is never required to be INSIDE a row: a y above every row lands on
 * the first, below every row lands on the last, and a y in the gutter between
 * two rows takes the nearer. A drag that leaves the strip therefore still names
 * a definite slot instead of dropping the indicator, which is what stops the
 * indicator flickering as the pointer skims the strip's edge.
 */
export function dropIndexAt(boxes: TabBox[], x: number, y: number): number {
	if (boxes.length === 0) return 0;
	const rows = rowsOf(boxes);
	// Nearest row by vertical distance; 0 for a row the pointer is inside.
	let best = rows[0];
	let bestDist = Infinity;
	for (const row of rows) {
		const top = boxes[row.start].top;
		const bottom = boxes[row.start].bottom;
		const dist = y < top ? top - y : y > bottom ? y - bottom : 0;
		if (dist < bestDist) {
			bestDist = dist;
			best = row;
		}
	}
	// Within the row, count the tabs whose midpoint the pointer is already past.
	let index = best.start;
	for (let i = best.start; i <= best.end; i++) {
		const mid = (boxes[i].left + boxes[i].right) / 2;
		if (x < mid) break;
		index = i + 1;
	}
	return index;
}

/** Where `insertAt` puts the tab currently at `from`, as an index in the result. */
export function landingIndex(from: number, insertAt: number): number {
	return insertAt > from ? insertAt - 1 : insertAt;
}

/**
 * `tabs` with `id` moved to insertion slot `insertAt`.
 *
 * Returns `tabs` UNCHANGED (same reference) when the id is unknown or the slot
 * is one the tab already occupies - `insertAt === from` (just before itself) and
 * `insertAt === from + 1` (just after itself) both describe the tab's current
 * position, and a drop there is the "put it back where I found it" gesture.
 */
export function reorderTabs<T extends { id: string }>(tabs: T[], id: string, insertAt: number): T[] {
	const from = tabs.findIndex((t) => t.id === id);
	if (from < 0) return tabs;
	const slot = Math.max(0, Math.min(tabs.length, insertAt));
	if (slot === from || slot === from + 1) return tabs;
	const next = tabs.slice();
	const [moved] = next.splice(from, 1);
	next.splice(landingIndex(from, slot), 0, moved);
	return next;
}

/**
 * `tabs` with `id` stepped `delta` places (the keyboard reorder). Returns `tabs`
 * unchanged when the id is unknown or the step would leave the strip, so holding
 * the shortcut against either end is inert rather than a stream of no-op writes.
 */
export function moveTabBy<T extends { id: string }>(tabs: T[], id: string, delta: number): T[] {
	const from = tabs.findIndex((t) => t.id === id);
	if (from < 0) return tabs;
	const to = from + delta;
	if (to < 0 || to >= tabs.length) return tabs;
	const next = tabs.slice();
	const [moved] = next.splice(from, 1);
	next.splice(to, 0, moved);
	return next;
}
