// Pure, DOM-free render-plan controller for windowed ("virtualized") cell rendering.
//
// Design + rationale: `data/cellar-perf-cell-virtualization-a2/report.md`
//   §3   — the hand-rolled, flow-preserving spacer window (why not a library)
//   §4.1 — height estimation + measured cache
//
// Scroll stability is the browser's: the scroll pane keeps its native
// `overflow-anchor`, which re-anchors the viewport when an off-screen cell mounts
// (spacer→cell) or resizes. This module only decides WHICH cells to mount; it holds
// no scrollTop compensation of its own. To let native anchoring track the real
// layout, the offset model accounts for the `space-y-4` inter-cell gap (`gapPx`), so
// a spacer reproduces the exact flow space its collapsed run occupied.
//
// This is the FOUNDATION phase (P0+P1). Windowing is flag-gated OFF: `planWindow`
// returns "every cell mounted" whenever `virtualize` is false OR the viewport
// metrics are absent, so the notebook renders byte-identically to the eager
// `{#each}`. Actual spacer coalescing only runs when a caller opts in AND supplies
// live `viewportTop`/`viewportHeight` — wired but dormant at this phase.
//
// INVARIANT (enforce in review): this module is render-only. It never reads from,
// gates on, or mutates the document model (`cells`). Heights flow in from measured
// DOM nodes; the plan flows out to what `Notebook.svelte` mounts. Nothing here may
// feed back into `cells`.

/** The minimal cell shape `estimateHeight` needs (a subset of `UICell`). */
export interface HeightCell {
	id: string;
	cell_type?: string;
	source?: string;
	outputs?: unknown[] | null;
}

/** A mounted cell in the render plan: emit the full `<Cell>` subtree. */
export interface PlanCell {
	kind: 'cell';
	id: string;
}
/** A collapsed run of off-screen cells: emit one inert `height:{px}` spacer. */
export interface PlanSpacer {
	kind: 'spacer';
	px: number;
	/** Stable-ish key for the keyed `{#each}` (start index of the collapsed run). */
	key: string;
}
export type PlanItem = PlanCell | PlanSpacer;

export interface PlanWindowArgs {
	/** Visible cell ids in document order. */
	order: string[];
	/** Measured card heights (px); a miss falls back to `estimate(id)`. */
	heights: Map<string, number>;
	/** Height estimate for a never-measured cell. */
	estimate: (id: string) => number;
	/** OFF ⇒ every cell mounted (the byte-identical-to-today path). */
	virtualize?: boolean;
	/** Scroll offset of the viewport within the notebook (scrollParent.scrollTop). */
	viewportTop?: number;
	/** Visible height of the viewport (scrollParent.clientHeight). */
	viewportHeight?: number;
	/** Extra px mounted above and below the viewport. */
	overscanPx?: number;
	/** Cells forced into the mounted set wherever they are (running / active / scroll target). */
	pinned?: Set<string>;
	/**
	 * Vertical gap (px) the flow renders between adjacent cells (the `space-y-4`
	 * margin between siblings). Added to the running offset between every pair of
	 * cells so the model position tracks the real DOM `scrollTop`; also folded into a
	 * coalesced spacer's height so it reproduces the exact flow space its run occupied.
	 * DEFAULT 0 (the uniform-height tests assume no gap).
	 */
	gapPx?: number;
}

// ---- Height estimation constants (§4.1) ------------------------------------
// Estimates are ONLY ever used for cells that have never been on screen; the
// instant a cell mounts, its real measured height replaces the estimate. These
// are coarse on purpose and get tuned in a later phase (P5).
export const CARD_CHROME_PX = 64; // card border + toolbar + vertical padding
export const CODE_LINE_PX = 19; // one CodeMirror line
export const MARKDOWN_BASE_PX = 60; // a small constant for a rendered markdown cell
export const OUTPUT_PER_PX = 120; // coarse per-output block
export const OUTPUT_CAP_PX = 480; // ...capped so one huge output can't dominate
export const DEFAULT_OVERSCAN_PX = 800;
// The `space-y-4` margin the cell stack renders between adjacent rows (1rem).
export const ROW_GAP_PX = 16;

/**
 * Estimate a cell's rendered height from its source line count (+ a coarse
 * output allowance). Used only for cells that have never been measured.
 */
export function estimateHeight(cell: HeightCell): number {
	const source = cell.source ?? '';
	const lines = source.length === 0 ? 1 : source.split('\n').length;
	if (cell.cell_type === 'markdown') {
		return MARKDOWN_BASE_PX + lines * CODE_LINE_PX;
	}
	let h = CARD_CHROME_PX + lines * CODE_LINE_PX;
	const nOut = cell.outputs?.length ?? 0;
	if (nOut > 0) h += Math.min(OUTPUT_CAP_PX, nOut * OUTPUT_PER_PX);
	return h;
}

/** Measured height if present + positive, else the estimate (never negative). */
function heightOf(id: string, heights: Map<string, number>, estimate: (id: string) => number): number {
	const measured = heights.get(id);
	if (measured != null && measured > 0) return measured;
	return Math.max(0, estimate(id));
}

/**
 * Build the render plan over `order`: each cell is either mounted or collapsed
 * into a spacer. Consecutive off-screen cells collapse into a single spacer; a
 * pinned cell outside the window splits the surrounding spacer in two.
 *
 * Flag OFF (or no viewport) ⇒ every cell mounted, no spacers. This is the
 * byte-identical-to-today path and the core safety property of this phase.
 */
export function planWindow(args: PlanWindowArgs): PlanItem[] {
	const {
		order,
		heights,
		estimate,
		virtualize = false,
		viewportTop,
		viewportHeight,
		overscanPx = DEFAULT_OVERSCAN_PX,
		pinned,
		gapPx = 0
	} = args;

	// No windowing without an explicit opt-in AND a viewport to window against.
	if (!virtualize || viewportTop == null || viewportHeight == null) {
		return order.map((id) => ({ kind: 'cell', id }));
	}

	const top = viewportTop - overscanPx;
	const bottom = viewportTop + viewportHeight + overscanPx;
	const pins = pinned ?? new Set<string>();

	const items: PlanItem[] = [];
	let offset = 0; // running top edge of the current cell in the stacked flow
	let spacerPx = 0; // accumulated height of the current off-screen run
	let spacerCount = 0; // cells collapsed into the current run (drives its internal gaps)
	let spacerStart = 0; // order index the current run began at (for a stable key)

	const flushSpacer = () => {
		if (spacerPx > 0) {
			items.push({ kind: 'spacer', px: spacerPx, key: `spacer:${spacerStart}` });
			spacerPx = 0;
			spacerCount = 0;
		}
	};

	for (let i = 0; i < order.length; i++) {
		const id = order[i];
		const h = heightOf(id, heights, estimate);
		// The gap precedes every cell but the first, matching `space-y-4`'s
		// between-siblings margin, so cell k's top = Σ(heights before it) + k·gap.
		if (i > 0) offset += gapPx;
		const cellTop = offset;
		const cellBottom = offset + h;
		const inWindow = cellBottom >= top && cellTop <= bottom;
		if (inWindow || pins.has(id)) {
			flushSpacer();
			items.push({ kind: 'cell', id });
			spacerStart = i + 1;
		} else {
			// A spacer stands in for K cells; it carries their heights plus the K-1
			// gaps BETWEEN them (the outer gaps to its neighbors are drawn by
			// `space-y-4` around the spacer div itself).
			if (spacerCount > 0) spacerPx += gapPx;
			spacerPx += h;
			spacerCount++;
		}
		offset = cellBottom;
	}
	flushSpacer();
	return items;
}

/** The mounted cell ids of a plan (convenience for a render guard). */
export function mountedIds(plan: PlanItem[]): Set<string> {
	const s = new Set<string>();
	for (const item of plan) if (item.kind === 'cell') s.add(item.id);
	return s;
}

// ---- The pinned set (P3) ----------------------------------------------------
// A pin forces a cell to stay mounted wherever it is, splitting the surrounding
// spacer. Pins are what make windowing invisible to the features that need a live
// DOM node for a cell the viewport has left behind (report §5.2, §5.3):
//
//   running        — a streaming cell keeps a live node, so its height stays honest
//                    while its output grows (the scrollbar can't lie mid-run) and
//                    follow / jump-to-running always find a real node. Correctness
//                    never depended on it: `applyOutput` writes the MODEL, which is
//                    live whether or not the cell is mounted — pinning is about the
//                    height and the node, not about the bytes.
//   queued heads   — the cells about to run next, so a run starting does not have to
//                    mount its cell from cold (and the queued affordance is real).
//   active         — the selected cell must not vanish mid-series (j/k, a/b, dd).
//   focused        — the cell holding DOM focus. Distinct from `active` on purpose:
//                    a focus event may still be in flight, and the editing cell is
//                    the one thing whose unmount would lose user state (CodeMirror
//                    cursor + undo). It becomes unmount-eligible only after blur, by
//                    which point the edit has already flushed (`Cell.flushEdit`), so
//                    text is never at risk. We deliberately do NOT pin every cell
//                    edited this session — that would keep every visited editor alive
//                    and defeat the memory win (report §7 Q2).
//   scroll targets — transient pins owned by `LiveNotebook.ensureCellMounted`.
//
// Every pin is DROPPED the moment its reason lapses (the run ends, the cell leaves
// the queue, selection/focus moves, the jump settles); a cell outside the window
// with no live reason then collapses back into a spacer on the next re-plan.

/** How many queued cells (nearest the front of the kernel's FIFO) stay pinned. */
export const QUEUED_PIN_LIMIT = 3;

/**
 * The queued cells nearest the front of the kernel's global FIFO, in run order.
 *
 * Capped on purpose: `queued` is a GLOBAL queue that an agent's `run_cells` (or a
 * user mashing Run) can fill with dozens of this notebook's cells, and pinning all
 * of them would mount most of the notebook — defeating the window exactly when the
 * machine is busiest. The heads are the only ones about to need a node.
 */
export function queuedHeadIds(
	queued: Record<string, number> | null | undefined,
	limit: number = QUEUED_PIN_LIMIT
): string[] {
	if (!queued || limit <= 0) return [];
	const entries: Array<[string, number]> = [];
	for (const [id, pos] of Object.entries(queued)) {
		if (typeof pos === 'number' && Number.isFinite(pos)) entries.push([id, pos]);
	}
	// Position first; id as a tiebreak so the set is deterministic (positions are
	// global, so two cells of one notebook never actually share one).
	entries.sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
	return entries.slice(0, limit).map(([id]) => id);
}

export interface PinInputs {
	/** The cell running in THIS notebook (≤1). */
	runningId?: string | null;
	/** cell id → 1-based position in the kernel's global run queue. */
	queued?: Record<string, number> | null;
	/** The selected cell (command-mode target). */
	activeId?: string | null;
	/** The cell holding DOM focus (its editor, or the card itself). */
	focusedId?: string | null;
	/** Transient jump targets (`ensureCellMounted`). */
	scrollPins?: Iterable<string> | null;
	/** Override the queued-head cap (tests). */
	queuedPinLimit?: number;
}

/** The union of every reason a cell must stay mounted (see the doctrine above). */
export function pinnedCellIds(inputs: PinInputs): Set<string> {
	const pins = new Set<string>();
	if (inputs.runningId) pins.add(inputs.runningId);
	for (const id of queuedHeadIds(inputs.queued, inputs.queuedPinLimit ?? QUEUED_PIN_LIMIT)) pins.add(id);
	if (inputs.activeId) pins.add(inputs.activeId);
	if (inputs.focusedId) pins.add(inputs.focusedId);
	if (inputs.scrollPins) for (const id of inputs.scrollPins) pins.add(id);
	return pins;
}
