/**
 * Full-cell collapse: hide a cell's INPUT and OUTPUT, leaving only its header row.
 *
 * The pure half of the feature - the storage key, the record's shape, and the
 * one-line preview the collapsed header shows - so the rules are unit-testable
 * without mounting a component (vitest runs without the SvelteKit plugin). The
 * wiring lives in `LiveNotebook.svelte` (owns the record, persists it) and
 * `Cell.svelte` (the chevron + the collapsed render).
 *
 * Three collapse-ish features coexist and are deliberately ORTHOGONAL:
 *   - THIS one: the whole cell contracts to its header (input + output hidden),
 *     whatever its length.
 *   - `editorCollapsed` ($lib/LiveNotebook): contracts only a TALL code editor to
 *     a fixed-height scroll box. Untouched by a full collapse - expanding restores
 *     whatever it was.
 *   - heading folding (`$lib/headings`): hides a RANGE of cells under a markdown
 *     heading (`display:none`, so those cells render nothing at all).
 *
 * ONE accepted seam between this and folding: the fold chevron and the "N cells
 * hidden" chip are drawn inside the rendered markdown, so collapsing a markdown cell
 * whose heading is currently FOLDED hides them along with the body - the folded range
 * stays hidden with no in-notebook marker of why. It is cosmetic, reachable only by
 * deliberately folding AND collapsing the same cell, recoverable three ways (expand
 * the cell, the sidebar Outline chevron, `h`/`l`), and the collapsed header's preview
 * still reads the heading itself (`## Setup`). Left as-is on purpose: a fold marker on
 * the collapsed header would defeat the minimal row the feature exists for, and
 * touching fold state on collapse - refusing, or auto-unfolding - would mean writing
 * state the user never asked to change, which this codebase treats as a defect.
 *
 * The state is keyed by cell id in a plain record - never off a mounted DOM node -
 * because windowed rendering destroys and rebuilds a Cell whenever it leaves and
 * re-enters the window (the "a Cell instance is DISPOSABLE" rule). It is persisted
 * per notebook through the per-project UI store, like `editorCollapsed`: "hide this
 * cell" is a deliberate, durable intent, so it survives a reload - and, being a view
 * preference, it never touches the `.ipynb` (zero git diff).
 *
 * Collapse is purely USER-driven: nothing in the app collapses or expands a cell on
 * the user's behalf, and only explicit edit-intent expands one. A mere navigation or
 * selection deliberately does NOT - `j`/`k`, follow-running and the FIND BAR land on
 * a collapsed cell and leave it collapsed, so its match is counted but not painted.
 * That is a decided product trade, not an oversight: a `hide_input` (report-view)
 * cell's match is equally invisible today, so the two hide features stay consistent,
 * and a Ctrl+F sweep can never silently discard collapse state the user set by hand.
 */

/** Which cells are collapsed. Only `true` is ever stored - see `withCollapse`. */
export type CollapsedRecord = Record<string, true | undefined>;

/** Per-notebook UI-store key holding that notebook's collapsed-cell record. */
export const COLLAPSED_KEY_PREFIX = 'cellar-cell-collapsed:';

/** The UI-store key for a notebook, or null before its canonical id is known. */
export function collapsedKeyFor(canonicalId: string | null | undefined): string | null {
	return canonicalId ? `${COLLAPSED_KEY_PREFIX}${canonicalId}` : null;
}

/**
 * Normalize whatever the UI store hands back into a record.
 *
 * That value is untrusted (the store is a hand-editable per-project JSON file, and
 * an older build may have written a different shape), and it feeds a render, so
 * anything that is not an explicit `true` is dropped rather than read for its
 * truthiness - a stray string would otherwise collapse a cell nobody collapsed.
 */
export function sanitizeCollapsed(saved: unknown): CollapsedRecord {
	if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};
	const out: CollapsedRecord = {};
	for (const [id, v] of Object.entries(saved as Record<string, unknown>)) {
		if (v === true && id) out[id] = true;
	}
	return out;
}

/**
 * Set or clear one cell's collapse, returning a NEW record (Svelte reactivity).
 *
 * Expanding DELETES the entry rather than storing `false`, which is what keeps the
 * persisted record proportional to the cells actually collapsed - and makes this
 * double as the delete-path cleanup, exactly like `setRawEdit`: a deleted cell can
 * never come back under the same id, so its entry must not outlive it. That covers
 * the deletions a tab OBSERVES; `retainCells` is the backstop for the ones it does
 * not (a delete during a disconnect, a checkpoint restore).
 */
export function withCollapse(record: CollapsedRecord, id: string, collapsed: boolean): CollapsedRecord {
	if (!!record[id] === collapsed) return record; // no-op: keep the identity, skip the write
	const next = { ...record };
	if (collapsed) next[id] = true;
	else delete next[id];
	return next;
}

/** Drop several ids at once (a bulk delete), returning a new record only if any hit. */
export function withoutCells(record: CollapsedRecord, ids: Iterable<string>): CollapsedRecord {
	let next: CollapsedRecord | null = null;
	for (const id of ids) {
		if (!record[id]) continue;
		next ??= { ...record };
		delete next[id];
	}
	return next ?? record;
}

/**
 * Keep only the entries whose cell still exists, returning the SAME record when
 * nothing is dropped (so a load that changes nothing writes nothing).
 *
 * The per-delete cleanup above only covers deletions THIS tab observed. Two real
 * paths remove a cell without one reaching it: a cell deleted while this tab was
 * disconnected (the reconnect / seq-gap refetch is exactly that case), and a
 * checkpoint restore (`notebook:restored` -> a refetch). Reconciling against the
 * cells a load actually returned is what makes "the persisted record can never
 * outlive the cells" true in general rather than only along the observed paths -
 * otherwise a stale id sits in the per-project JSON for good.
 */
export function retainCells(record: CollapsedRecord, ids: Iterable<string>): CollapsedRecord {
	const alive = ids instanceof Set ? (ids as Set<string>) : new Set(ids);
	let next: CollapsedRecord | null = null;
	for (const id of Object.keys(record)) {
		if (alive.has(id)) continue;
		next ??= { ...record };
		delete next[id];
	}
	return next ?? record;
}

/** Longest preview shown in a collapsed header before it is elided. */
export const COLLAPSED_PREVIEW_CAP = 120;

/**
 * The one-line source preview a collapsed header shows beside the cell id.
 *
 * Without it a collapsed notebook is a stack of identical chrome rows, and the id
 * alone identifies a cell only to something holding a handle to it. The first
 * NON-EMPTY line is what a human recognizes the cell by (a heading, the def, the
 * first statement), so leading blank lines are skipped rather than previewed as
 * nothing. The cap bounds the string handed to the DOM; CSS truncates whatever
 * still overflows the header.
 */
export function collapsedPreview(source: string | null | undefined, cap = COLLAPSED_PREVIEW_CAP): string {
	if (!source) return '';
	for (const line of source.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		return trimmed.length > cap ? `${trimmed.slice(0, cap)}…` : trimmed;
	}
	return '';
}
