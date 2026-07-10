// Markdown-header helpers shared by the notebook renderer (collapsible headings),
// the fold bookkeeping in LiveNotebook, and the sidebar Outline. All three read
// the same model, so a chevron in the outline and a chevron in the notebook are
// the same control over the same state.
//
// The foldable unit is a *heading occurrence*, not a cell: a markdown cell may
// hold several headings (`# Intro` / `## Setup` / `### Details` in one cell is
// common), and each of them gets its own chevron. A cell is therefore split into
// segments at its heading lines; a heading's section runs from just after that
// heading until the next heading of the same or higher level, wherever it lives -
// later in the same cell, or in a following cell.
//
// A heading occurrence is addressed by a `foldKey`: the plain cell id for a
// cell's leading heading (the overwhelmingly common case, and what the keyboard
// fold shortcuts + `revealCell` address), `<cellId>#<segmentIndex>` otherwise.

const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s{0,3}(```|~~~)/;

/** Fold-state key for the heading at `segIndex` of cell `cellId`. */
export function foldKey(cellId, segIndex) {
	return segIndex === 0 ? cellId : `${cellId}#${segIndex}`;
}

/** The cell a fold key addresses. */
export function cellIdOfKey(key) {
	const i = String(key).indexOf('#');
	return i === -1 ? key : String(key).slice(0, i);
}

/**
 * Split a markdown source at its heading lines (fenced code blocks are skipped,
 * so a `# comment` inside ```…``` is never a heading). Returns one segment per
 * heading plus, when the source opens with content, a leading non-heading
 * segment. Each segment is `{ index, level, title, heading, body }`; `level` is
 * null for the non-heading segment. Always returns at least one segment, so
 * every markdown cell has something to hide.
 */
export function splitHeadingSegments(source) {
	const segs = [];
	let level = null;
	let title = null;
	let heading = '';
	let body = [];
	let inFence = false;

	const flush = () => {
		const text = body.join('\n');
		if (level != null || text.trim()) segs.push({ index: segs.length, level, title, heading, body: text });
	};

	for (const line of (source ?? '').split('\n')) {
		if (FENCE.test(line)) inFence = !inFence;
		const m = inFence ? null : HEADING.exec(line);
		if (m) {
			flush();
			level = m[1].length;
			title = m[2].trim();
			heading = line.trim();
			body = [];
		} else {
			body.push(line);
		}
	}
	flush();
	if (!segs.length) segs.push({ index: 0, level: null, title: null, heading: '', body: source ?? '' });
	return segs;
}

/** Header level (1-6) of a markdown cell's *leading* heading, or null. */
export function headerLevel(cell) {
	if (!cell || cell.cell_type !== 'markdown') return null;
	return splitHeadingSegments(cell.source)[0]?.level ?? null;
}

/** Every heading in the notebook, in document order (the Outline's rows). */
export function outlineHeadings(cells) {
	const out = [];
	for (const cell of cells ?? []) {
		if (cell.cell_type !== 'markdown') continue;
		for (const s of splitHeadingSegments(cell.source)) {
			if (s.level != null) out.push({ key: foldKey(cell.id, s.index), cellId: cell.id, level: s.level, title: s.title });
		}
	}
	return out;
}

// The notebook flattened to fold *units*, in document order. A code cell is one
// unit; a markdown cell contributes a heading unit (foldable) and a body unit
// per segment. Only heading units carry a level, so only they end a section.
function foldUnits(cells) {
	const units = [];
	for (const cell of cells ?? []) {
		if (cell.cell_type === 'markdown') {
			for (const s of splitHeadingSegments(cell.source)) {
				if (s.level != null) units.push({ cellId: cell.id, seg: s.index, kind: 'heading', level: s.level, key: foldKey(cell.id, s.index) });
				units.push({ cellId: cell.id, seg: s.index, kind: 'body', level: null });
			}
		} else {
			units.push({ cellId: cell.id, seg: 0, kind: 'body', level: null });
		}
	}
	return units;
}

/**
 * Given the ordered cells and the set of folded heading keys, decide what the
 * notebook hides. Nested folds compose: a unit hidden by an outer fold stays
 * hidden regardless of inner state.
 *
 *   hidden — cell ids whose every unit is hidden (the renderer drops these)
 *   segs   — cellId → { headings, bodies }: segment indices hidden inside a cell
 *            that is still partly visible (an `# Intro` fold collapsing the
 *            `## Setup` written below it in the same cell)
 *   counts — fold key → number of whole cells that fold hides (the "N cells
 *            hidden" hint; in-cell content is reported by the fold cue itself)
 */
export function computeFolding(cells, foldedIds) {
	const units = foldUnits(cells);

	// Units of a cell are contiguous, so a cell is a [first,last] index range.
	const range = new Map();
	units.forEach((u, i) => {
		const r = range.get(u.cellId);
		if (r) r.last = i;
		else range.set(u.cellId, { first: i, last: i });
	});

	const hiddenUnits = new Set();
	const counts = {};
	for (let i = 0; i < units.length; i++) {
		const u = units[i];
		if (u.kind !== 'heading' || !foldedIds.has(u.key)) continue;
		let end = units.length;
		for (let j = i + 1; j < units.length; j++) {
			const v = units[j];
			if (v.kind === 'heading' && v.level <= u.level) {
				end = j;
				break;
			}
			hiddenUnits.add(j);
		}
		let cellsHidden = 0;
		for (const r of range.values()) if (r.first > i && r.last < end) cellsHidden++;
		counts[u.key] = cellsHidden;
	}

	const segs = new Map();
	units.forEach((u, i) => {
		if (!hiddenUnits.has(i)) return;
		let s = segs.get(u.cellId);
		if (!s) segs.set(u.cellId, (s = { headings: new Set(), bodies: new Set() }));
		(u.kind === 'heading' ? s.headings : s.bodies).add(u.seg);
	});

	const hidden = new Set();
	for (const [cellId, r] of range) {
		let all = true;
		for (let i = r.first; i <= r.last && all; i++) all = hiddenUnits.has(i);
		if (all) hidden.add(cellId);
	}

	return { hidden, segs, counts };
}

/**
 * The Outline's rows: every heading, nested by level, with the rows a folded
 * ancestor hides dropped. Reads the same `foldedIds` the notebook renders from,
 * so outline and notebook can never disagree about what is collapsed.
 */
export function outlineRows(cells, foldedIds, counts = {}) {
	const rows = [];
	const stack = []; // open ancestors: { level, folded }
	for (const h of outlineHeadings(cells)) {
		while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
		const hiddenByAncestor = stack.some((s) => s.folded);
		const folded = foldedIds.has(h.key);
		if (!hiddenByAncestor) {
			rows.push({ ...h, depth: stack.length, folded, hiddenCount: counts[h.key] ?? 0 });
		}
		stack.push({ level: h.level, folded: folded || hiddenByAncestor });
	}
	return rows;
}
