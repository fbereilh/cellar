/**
 * DOM highlight overlay for Search P4 - the browser half for the *rendered*
 * surfaces (static-code stand-in, rendered markdown, cell outputs, and the
 * toolbar's `cell #xxxxxxxx` id chip for a `field: 'id'` match). CodeMirror
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
 * Typeset math is ONE opaque unit to this walk (`.katex` for a rendered expression,
 * `.katex-error` for an unparseable one - see `$lib/markdown`).
 *
 * KaTeX writes each expression's text into the container THREE times: the clipped,
 * screen-reader-only `.katex-mathml` MathML branch, that branch's `<annotation>`
 * carrying the raw TeX, and the visible `.katex-html` glyphs. A plain text walk
 * counts all three, while the search model counts the expression ONCE (from the
 * cell source, where it is still `$x^2$`) - so the model's ordinal landed on an
 * invisible node and the painted highlight count diverged from the reported one.
 */
const MATH_SELECTOR = '.katex, .katex-error';

/**
 * Was this node produced by KaTeX's OWN error path rather than the markdown-it
 * plugin's?
 *
 * Both wear `katex-error` and they carry the source TeX in OPPOSITE places, so the
 * two must be told apart structurally, never by guessing which string looks like a
 * message. KaTeX's `renderError` (the `throwOnError:false` swallow of a `ParseError`)
 * is the ONLY place KaTeX emits the class, it always builds a `<span>`, and it sets
 * `title` (the message) and `style="color:…"` (the error color) unconditionally on
 * the same three lines. The plugin's own `catch` - reachable because `throwOnError`
 * suppresses only `ParseError`, so a `RangeError` from deeply nested input still
 * propagates - emits `<span class="katex-error" title="{latex}">{message}</span>`
 * and `<p class="katex-block katex-error" title="{latex}">{message}</p>`: latex in
 * the title, message in the text, and no `style` at all (its block form is a `<p>`,
 * a shape KaTeX never emits). So "a span carrying an inline style" is a property of
 * how each node is BUILT, not of what it says.
 */
function isKatexNativeError(el: Element): boolean {
	return el.tagName === 'SPAN' && el.hasAttribute('style');
}

/**
 * The text a typeset expression contributes to the walk: its own TeX SOURCE between
 * the delimiters it was written with, which is what the model's text holds for that
 * region. The glyphs are deliberately not used - they are a different string from
 * the source (`$\alpha$` renders "α"), so counting them would shift every later
 * occurrence's ordinal.
 */
function mathSourceText(el: Element): string {
	// The delimiter comes from what the SOURCE wrote, not from what KaTeX chose to
	// render: the plugin promotes INLINE math matching `\begin{align|equation|…}` to
	// `displayMode`, so `.katex-display` appears over a single-`$` source and reading
	// it would rebuild `$$…$$` - two characters per side the model never had. Only
	// the plugin's `<p class="katex-block">` wrapper marks a `$$…$$` source; it wraps
	// every block form and nothing else.
	const delim = el.closest('p.katex-block') ? '$$' : '$';
	// `.katex` (typeset): the `<annotation>` carries the source TeX verbatim.
	// `.katex-error`: the source TeX is the visible text on KaTeX's own node and the
	// `title` on the plugin's - see {@link isKatexNativeError}.
	//
	// A `.katex` subtree with NO `<annotation>` contributes the DELIMITERS ALONE - a
	// known, bounded length change - and emphatically NOT the `.katex-html` glyphs:
	// those are a different string from the source (`$\alpha$` renders "α"), so
	// substituting them is exactly the silent ordinal shift this whole helper exists to
	// prevent. Unreachable today, and reachable only by a deliberate config change:
	// KaTeX's default `output:'htmlAndMathml'` always emits the annotation, and
	// `MARKDOWN_SANITIZE_CONFIG`'s `ADD_TAGS` is what keeps it through DOMPurify - so
	// setting `output:'html'`/`'mathml'` in `MATH_OPTIONS`, or dropping `annotation`
	// from that allowlist, lands here (both in `$lib/markdown`).
	const tex = el.classList.contains('katex-error')
		? isKatexNativeError(el)
			? (el.textContent ?? '')
			: (el.getAttribute('title') ?? '')
		: (el.querySelector('annotation')?.textContent ?? '');
	return delim + tex + delim;
}

/**
 * Locate `query` occurrences in an element's concatenated visible text and return
 * them as DOM `Range`s (case/whole-word per `opts`). Ranges may span text-node
 * boundaries (the Custom Highlight API and `Range` both allow it), so a match split
 * across inline tokens - common in syntax-highlighted static code - still paints.
 *
 * The returned array is POSITIONAL: entry `i` is the i-th occurrence of the query in
 * this surface, and it is **`null` when that occurrence cannot be painted** - which
 * today means it fell inside typeset math ({@link MATH_SELECTOR}), whose source text
 * the model counts but whose rendered glyphs are a different string. Callers must
 * therefore index by ordinal and tolerate a hole, never compact the array: dropping
 * the entry would slide every later occurrence's ordinal by one and emphasize the
 * wrong match (see `buildCellHighlights`).
 *
 * What the math substitution has to preserve is the SEQUENCE of occurrences, not the
 * region's length: a reconstruction the query never matches inside costs nothing,
 * while one that yields a different NUMBER of matches than the model's own text does
 * slides every later ordinal. Two accepted narrowings change lengths only: the
 * plugin's `` $`x`$ `` form reconstructs WITHOUT the backticks, which is right because
 * `strippedMarkdown` strips code-span backticks from the model too; and a fenced
 * `$$`-on-its-own-line block loses the newline after the opening delimiter (markdown-it
 * does not keep it), so only a query spanning that newline is affected.
 *
 * A THIRD narrowing does change the occurrence COUNT, and is accepted deliberately:
 * `strippedMarkdown` collapses `_x_` / `*x*` / `~~x~~` pairs across the WHOLE source,
 * math included, while `mathSourceText` reconstructs the annotation TeX verbatim. So
 * for `Use $x_1$ and $y_1$; snake_case names.` the model's text holds ONE `_` and this
 * walk builds three: a find for a bare emphasis character (`_`, `*`, `~`) - or for a
 * span containing one - drifts, dropping or shifting the later prose ordinals. It
 * bites only when the query matches such a character AND the document's math uses one
 * (a subscript is the everyday case). Neither side is worth fixing: `strippedMarkdown`
 * is the search engine's cached hot path and is deliberately math-unaware, so teaching
 * it to skip `$…$` spans would couple it to math-delimiter awareness for an info-level
 * drift; and the mirror move - emphasis-collapsing the reconstructed TeX - is simply
 * wrong, because `x_1` is a subscript, not emphasis. Pinned as-is by
 * `tests/unit/search-math-highlight.test.ts`.
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
): Array<Range | null> {
	if (!query) return [];
	const doc = root.ownerDocument;
	// Flat map of the concatenated text -> (node, offset-within-node), plus the
	// unpaintable spans typeset math contributed.
	const nodes: Text[] = [];
	const starts: number[] = []; // global start offset of each node's text
	const opaque: Array<{ start: number; end: number }> = [];
	let full = '';
	// A hand-rolled descent rather than a TreeWalker: a math subtree must be
	// REPLACED by its source text (contributing offsets but no nodes), and neither
	// `FILTER_REJECT` nor `FILTER_SKIP` can both yield the element and skip inside it.
	const walk = (parent: Node) => {
		for (let child = parent.firstChild; child; child = child.nextSibling) {
			if (child.nodeType === Node.TEXT_NODE) {
				const t = child as Text;
				if (!t.data) continue;
				nodes.push(t);
				starts.push(full.length);
				full += t.data;
				continue;
			}
			if (child.nodeType !== Node.ELEMENT_NODE) continue;
			const el = child as Element;
			if (el.matches(MATH_SELECTOR)) {
				const text = mathSourceText(el);
				if (text) {
					opaque.push({ start: full.length, end: full.length + text.length });
					full += text;
				}
				continue; // its subtree yields no paintable range
			}
			walk(el);
		}
	};
	walk(root);
	if (!full) return [];
	const occ = findFn(full, query, opts);
	if (!occ.length) return [];

	const ranges: Array<Range | null> = [];
	for (const { start, end } of occ) {
		if (opaque.some((o) => start < o.end && end > o.start)) {
			ranges.push(null); // inside math: keep the ordinal, paint nothing
			continue;
		}
		const s = locate(nodes, starts, start);
		const e = locate(nodes, starts, end);
		if (!s || !e) {
			ranges.push(null);
			continue;
		}
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
