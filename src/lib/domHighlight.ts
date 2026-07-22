/**
 * DOM highlight overlay for Search P4 - the browser half for the three *rendered*
 * surfaces (static-code stand-in, rendered markdown, cell outputs). CodeMirror
 * editors are handled separately (`cmSearchHighlight.ts`), because CM maintains its
 * own decorations across re-renders.
 *
 * Primary mechanism: the **CSS Custom Highlight API** - `Range`-based, so it paints
 * matches WITHOUT mutating the DOM (no `<mark>` reflow, trivial to clear). Two named
 * highlights, styled in `app.css`:
 *   - `cellar-search`        - every match
 *   - `cellar-search-active` - the active match (higher priority, distinct style)
 *
 * Fallback (browsers without the API): a reversible `<mark>` wrap of single-text-
 * node ranges. Best-effort - the app targets modern Chromium where the primary path
 * always runs; the fallback exists so an old engine degrades to visible (if
 * slightly coarser) highlighting rather than none.
 *
 * ## Ownership model
 * Each caller (one per cell surface) owns a stable string `key` and calls
 * {@link setSurfaceRanges} with its current `all`/`active` ranges (or
 * {@link clearSurface} to drop them). The registry is rebuilt from the union of all
 * live contributions, coalesced to one microtask so N cells updating in a frame
 * cost one rebuild. Keys must be unique per mounted cell INSTANCE (cell ids repeat
 * across notebooks and every notebook stays mounted), so callers key off a
 * per-instance token, never the cell id.
 */

const ALL = 'cellar-search';
const ACTIVE = 'cellar-search-active';

interface Contribution {
	all: Range[];
	active: Range[];
	/** Fallback only: the `<mark>` elements this surface inserted, for reversal. */
	marks?: HTMLElement[];
}

const contributions = new Map<string, Contribution>();
let rebuildQueued = false;
let keyCounter = 0;

/**
 * Allocate a process-unique surface-key prefix for one mounted component instance.
 * Registry keys must not collide across cells, and cell ids repeat across notebooks
 * (every notebook stays mounted), so callers key surfaces off this, never a cell id.
 */
export function allocSurfaceKey(): string {
	return `s${++keyCounter}`;
}

/** True when the CSS Custom Highlight API is usable (the primary path). */
export function supportsHighlightApi(): boolean {
	return (
		typeof CSS !== 'undefined' &&
		!!(CSS as unknown as { highlights?: unknown }).highlights &&
		typeof Highlight !== 'undefined' &&
		typeof Range !== 'undefined'
	);
}

/** Coalesce registry rebuilds to one microtask (many cells update per frame). */
function queueRebuild() {
	if (rebuildQueued) return;
	rebuildQueued = true;
	queueMicrotask(() => {
		rebuildQueued = false;
		rebuildRegistry();
	});
}

/** Rebuild both named highlights from the union of live contributions. */
function rebuildRegistry() {
	if (!supportsHighlightApi()) return;
	const all: Range[] = [];
	const active: Range[] = [];
	for (const c of contributions.values()) {
		for (const r of c.all) all.push(r);
		for (const r of c.active) active.push(r);
	}
	const registry = (CSS as unknown as { highlights: Map<string, Highlight> }).highlights;
	if (all.length) registry.set(ALL, new Highlight(...all));
	else registry.delete(ALL);
	if (active.length) {
		const hi = new Highlight(...active);
		hi.priority = 1; // active wins where it overlaps an all-match range
		registry.set(ACTIVE, hi);
	} else registry.delete(ACTIVE);
}

/**
 * Set (replacing any prior) the highlight ranges a surface contributes. `active`
 * ranges go into the emphasized highlight; `all` into the base one. Under the
 * fallback the ranges are turned into reversible `<mark>` wraps instead.
 */
export function setSurfaceRanges(key: string, all: Range[], active: Range[]) {
	if (!supportsHighlightApi()) {
		applyMarkFallback(key, all, active);
		return;
	}
	contributions.set(key, { all, active });
	queueRebuild();
}

/** Drop a surface's contribution (e.g. its cell unmounted, or the query cleared). */
export function clearSurface(key: string) {
	const prev = contributions.get(key);
	if (!prev) return;
	if (prev.marks) removeMarks(prev.marks);
	contributions.delete(key);
	queueRebuild();
}

// ---- Text-node range building --------------------------------------------------

/**
 * Locate `query` occurrences in an element's concatenated visible text and return
 * them as DOM `Range`s (case/whole-word per `opts`). Ranges may span text-node
 * boundaries (the Custom Highlight API and `Range` both allow it), so a match split
 * across inline tokens - common in syntax-highlighted static code - still paints.
 *
 * @param root the surface container (already scoped by the caller so it holds only
 *   the surface's own text, e.g. `.cm-static-content`, not the line-number gutter).
 * @param findFn the pure occurrence scanner (injected so this module stays free of
 *   the search engine; callers pass `findOccurrences`).
 */
export function buildTextRanges(
	root: Element,
	query: string,
	opts: { caseSensitive: boolean; wholeWord: boolean; regex?: boolean },
	findFn: (
		hay: string,
		needle: string,
		o: { caseSensitive: boolean; wholeWord: boolean; regex?: boolean }
	) => Array<{ start: number; end: number }>
): Range[] {
	if (!query) return [];
	const doc = root.ownerDocument;
	const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	// Flat map of the concatenated text -> (node, offset-within-node).
	const nodes: Text[] = [];
	const starts: number[] = []; // global start offset of each node's text
	let full = '';
	for (let n = walker.nextNode(); n; n = walker.nextNode()) {
		const t = n as Text;
		const data = t.data;
		if (!data) continue;
		nodes.push(t);
		starts.push(full.length);
		full += data;
	}
	if (!full) return [];
	const occ = findFn(full, query, opts);
	if (!occ.length) return [];

	const ranges: Range[] = [];
	for (const { start, end } of occ) {
		const s = locate(nodes, starts, start);
		const e = locate(nodes, starts, end);
		if (!s || !e) continue;
		const range = doc.createRange();
		range.setStart(s.node, s.offset);
		range.setEnd(e.node, e.offset);
		ranges.push(range);
	}
	return ranges;
}

/** Map a global text offset to the (node, local offset) that contains it. */
function locate(nodes: Text[], starts: number[], offset: number): { node: Text; offset: number } | null {
	if (!nodes.length) return null;
	// Binary search for the last node whose start <= offset.
	let lo = 0;
	let hi = starts.length - 1;
	let idx = 0;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (starts[mid] <= offset) {
			idx = mid;
			lo = mid + 1;
		} else hi = mid - 1;
	}
	// An end offset sitting exactly at a node boundary belongs to the previous
	// node's tail (so the range ends where the text ends, not at the next node's 0).
	const node = nodes[idx];
	let local = offset - starts[idx];
	if (local > node.length && idx < nodes.length - 1) {
		return { node: nodes[idx + 1], offset: 0 };
	}
	if (local < 0) local = 0;
	if (local > node.length) local = node.length;
	return { node, offset: local };
}

// ---- `<mark>` fallback ----------------------------------------------------------

/** Wrap single-text-node ranges in `<mark>` (reversible), for browsers without the API. */
function applyMarkFallback(key: string, all: Range[], active: Range[]) {
	const prev = contributions.get(key);
	if (prev?.marks) removeMarks(prev.marks);
	const marks: HTMLElement[] = [];
	const wrap = (range: Range, cls: string) => {
		// Only single-text-node ranges are wrappable with surroundContents.
		if (range.startContainer !== range.endContainer) return;
		const doc = range.startContainer.ownerDocument;
		if (!doc) return;
		const mark = doc.createElement('mark');
		mark.className = cls;
		try {
			range.surroundContents(mark);
			marks.push(mark);
		} catch {
			// A range that partially selects a node throws; skip it (best-effort).
		}
	};
	// Active first, then base, so an active range isn't consumed by a base wrap.
	for (const r of active) wrap(r, 'cellar-search-mark cellar-search-mark-active');
	for (const r of all) wrap(r, 'cellar-search-mark');
	contributions.set(key, { all: [], active: [], marks });
}

/** Unwrap `<mark>` elements, restoring the original text nodes. */
function removeMarks(marks: HTMLElement[]) {
	for (const mark of marks) {
		const parent = mark.parentNode;
		if (!parent) continue; // already detached by a Svelte re-render
		while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
		parent.removeChild(mark);
		parent.normalize();
	}
}
