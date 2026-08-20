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
//      wrong row the moment the tabs spill past one line. The row is then
//      THREADED OUT with the slot (`dropTargetAt`), because the marker's
//      position is NOT recoverable from the slot alone: at a wrap boundary the
//      end of one row and the start of the next are the SAME insertion index in
//      two entirely different places, and only the row the pointer resolved onto
//      tells them apart.
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
 * Where the insertion marker is DRAWN, in viewport coordinates: one exact edge,
 * spanning one exact row. `x` is the edge itself (the bar is centred on it), and
 * `top`/`bottom` are the row's, so the marker can never read as a bar across the
 * whole header on a wrapped strip.
 */
export interface DropMarker {
	x: number;
	top: number;
	bottom: number;
}

/** Where a pointer would drop a tab: the array slot AND the place to say so. */
export interface DropTarget {
	/** The insertion slot in the tab array (see `dropIndexAt`). */
	index: number;
	/** Where to draw the marker, or null when the strip holds no tabs. */
	marker: DropMarker | null;
}

/**
 * The DROP TARGET for a pointer at (x, y): the slot the dragged tab would land
 * in, and the exact edge - on the exact row - that says so.
 *
 * The slot is an INSERTION INDEX into `boxes`: the tab the dragged one would land
 * in front of, so `0` means "before the first tab" and `boxes.length` means
 * "after the last one". Both extremes are reachable - dragging past the left edge
 * of the first tab and past the right edge of the last one are the two positions
 * a naive nearest-tab rule gets wrong.
 *
 * The pointer is never required to be INSIDE a row: a y above every row lands on
 * the first, below every row lands on the last, and a y in the gutter between
 * two rows takes the nearer. A drag that leaves the strip therefore still names
 * a definite slot instead of dropping the indicator, which is what stops the
 * indicator flickering as the pointer skims the strip's edge.
 *
 * The marker is returned FROM THE SAME ROW DECISION rather than recomputed from
 * the slot, and that is the whole point of returning it here. On a wrapped strip
 * one insertion index describes TWO different places - the end of row N and the
 * start of row N+1 are the same slot in the array - so a marker derived from the
 * index alone cannot know which of them the pointer meant, and a caller that
 * renders it as an in-flow element before tab `index` cannot draw the row-start
 * one at all (a zero-width flex item always fits the line it is collected onto,
 * so it stays on the PRECEDING row). Anchoring here settles it: the marker is the
 * left edge of the row's first tab when the drop starts that row, and otherwise
 * the right edge of the tab it lands behind - which is on the same row by
 * construction, since `index` never leaves `[rowStart, rowEnd + 1]`.
 */
export function dropTargetAt(boxes: TabBox[], x: number, y: number): DropTarget {
	if (boxes.length === 0) return { index: 0, marker: null };
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
	const atRowStart = index === best.start;
	const anchor = boxes[atRowStart ? best.start : index - 1];
	return {
		index,
		marker: { x: atRowStart ? anchor.left : anchor.right, top: anchor.top, bottom: anchor.bottom }
	};
}

/** The insertion slot alone - `dropTargetAt(...).index`, kept for callers that need no marker. */
export function dropIndexAt(boxes: TabBox[], x: number, y: number): number {
	return dropTargetAt(boxes, x, y).index;
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
 * The insertion slot that steps the tab at `index` one place left (`-1`) or right
 * (`+1`) - how the keyboard reorder is expressed, so it reaches the document
 * through the same `reorderTabs` the pointer drop does rather than a second rule.
 *
 * Stepping RIGHT is `index + 2`, not `index + 1`: the tab is still in the array
 * when the slot is named, so landing after its right-hand neighbour means the slot
 * beyond it. Out-of-range slots need no clamping here - `reorderTabs` clamps them
 * onto the tab's own position, which is exactly the no-op a step off either end
 * should be.
 */
export function stepSlot(index: number, dir: -1 | 1): number {
	return dir === -1 ? index - 1 : index + 2;
}
