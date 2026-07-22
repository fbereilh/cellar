// Pure, DOM-free render-plan controller for windowed ("virtualized") cell rendering.
//
// Design + rationale: `data/cellar-perf-cell-virtualization-a2/report.md`
//   §3   — the hand-rolled, flow-preserving spacer window (why not a library)
//   §4.1 — height estimation + measured cache
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
		pinned
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
	let spacerStart = 0; // order index the current run began at (for a stable key)

	const flushSpacer = () => {
		if (spacerPx > 0) {
			items.push({ kind: 'spacer', px: spacerPx, key: `spacer:${spacerStart}` });
			spacerPx = 0;
		}
	};

	for (let i = 0; i < order.length; i++) {
		const id = order[i];
		const h = heightOf(id, heights, estimate);
		const cellTop = offset;
		const cellBottom = offset + h;
		const inWindow = cellBottom >= top && cellTop <= bottom;
		if (inWindow || pins.has(id)) {
			flushSpacer();
			items.push({ kind: 'cell', id });
			spacerStart = i + 1;
		} else {
			spacerPx += h;
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
