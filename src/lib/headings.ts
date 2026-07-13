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

import type { Cell } from '$lib/server/types';

/** The minimal cell shape these helpers read; `Cell`/`CellView` are assignable. */
type HeadingCell = { id: string; cell_type: string; source: string };

/** One segment of a split markdown source (`level` null = the leading non-heading run). */
export interface HeadingSegment {
	index: number;
	level: number | null;
	title: string | null;
	heading: string;
	body: string;
}

/** A heading occurrence, in document order. */
export interface OutlineHeading {
	key: string;
	cellId: string;
	level: number;
	title: string | null;
}

/** An Outline row: a heading plus its render state. */
export interface OutlineRow extends OutlineHeading {
	depth: number;
	folded: boolean;
	hiddenCount: number;
}

/** Per-cell hidden segment indices inside a still-visible cell. */
export interface FoldSegs {
	headings: Set<number>;
	bodies: Set<number>;
}

/** What the notebook hides for a given set of folded heading keys. */
export interface Folding {
	hidden: Set<string>;
	segs: Map<string, FoldSegs>;
	counts: Record<string, number>;
}

const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s{0,3}(```|~~~)/;

/** Fold-state key for the heading at `segIndex` of cell `cellId`. */
export function foldKey(cellId: string, segIndex: number): string {
	return segIndex === 0 ? cellId : `${cellId}#${segIndex}`;
}

/** The cell a fold key addresses. */
export function cellIdOfKey(key: string): string {
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
export function splitHeadingSegments(source: string | null | undefined): HeadingSegment[] {
	const segs: HeadingSegment[] = [];
	let level: number | null = null;
	let title: string | null = null;
	let heading = '';
	let body: string[] = [];
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
export function headerLevel(cell: HeadingCell | null | undefined): number | null {
	if (!cell || cell.cell_type !== 'markdown') return null;
	return splitHeadingSegments(cell.source)[0]?.level ?? null;
}

// A heading line's leading `#`s and the whitespace around them. The `#`s are
// optional, so the indentation of a plain (or code) line is stripped too - a
// heading never carries the indentation of the line it was made from.
const HEADING_PREFIX = /^\s*(?:#{1,6}[ \t]*)?/;

/**
 * `source` rewritten so its first non-empty line is an H`level` heading: the
 * line's existing heading prefix (if any) is replaced, so pressing 2 after 1
 * demotes rather than nesting. Everything below the first line is untouched.
 * The inverse of `headerLevel`, which reads that same first non-empty line off
 * the cell's leading segment.
 */
export function withHeadingLevel(source: string | null | undefined, level: number): string {
	const hashes = '#'.repeat(Math.min(Math.max(level, 1), 6));
	const lines = String(source ?? '').split('\n');
	const i = lines.findIndex((l) => l.trim() !== '');
	if (i < 0) return `${hashes} `; // an empty cell becomes an empty heading to type into
	lines[i] = `${hashes} ${lines[i].replace(HEADING_PREFIX, '')}`;
	return lines.join('\n');
}

/** Every heading in the notebook, in document order (the Outline's rows). */
export function outlineHeadings(cells: readonly HeadingCell[] | null | undefined): OutlineHeading[] {
	const out: OutlineHeading[] = [];
	for (const cell of cells ?? []) {
		if (cell.cell_type !== 'markdown') continue;
		for (const s of splitHeadingSegments(cell.source)) {
			if (s.level != null) out.push({ key: foldKey(cell.id, s.index), cellId: cell.id, level: s.level, title: s.title });
		}
	}
	return out;
}

/**
 * Display prefix for a computed heading number. A flat number keeps the classic
 * trailing period (`1.` → `1. Header`, matching the captain's example); a dotted
 * hierarchical number reads cleaner without it (`1.2` → `1.2 Header`).
 */
export function headingNumberPrefix(number: string): string {
	return number.includes('.') ? `${number} ` : `${number}. `;
}

/**
 * Compute the display-only auto-number for every heading occurrence, in document
 * order. Numbering is hierarchical over the *enabled* levels only:
 *   - only H2 enabled → flat `1`, `2`, `3`
 *   - H1+H2 enabled  → `1`, `1.1`, `1.2`, `2`, … (a deeper counter resets when a
 *     higher enabled level increments)
 * Disabled levels get no number and never consume a counter (they are skipped in
 * the hierarchy). Returns a foldKey → number string map (e.g. `"1"`, `"2.3"`);
 * a heading whose level is disabled is simply absent. Pure + deterministic, so
 * add/remove/reorder/level-change re-derives live and the `.ipynb` is untouched.
 */
export function computeHeadingNumbers(
	headings: readonly OutlineHeading[] | null | undefined,
	enabledLevels: ReadonlySet<number> | null | undefined
): Record<string, string> {
	const out: Record<string, string> = {};
	// The enabled levels, ordered shallow→deep; a level's index is its counter slot.
	const levels = [...(enabledLevels ?? [])].filter((l) => l >= 1 && l <= 6).sort((a, b) => a - b);
	if (!levels.length) return out;
	const slotOf = new Map(levels.map((l, i) => [l, i]));
	const counters = new Array(levels.length).fill(0);
	for (const h of headings ?? []) {
		const slot = slotOf.get(h.level);
		if (slot === undefined) continue; // disabled level: no number, no counter effect
		counters[slot]++;
		for (let i = slot + 1; i < counters.length; i++) counters[i] = 0;
		const parts = counters.slice(0, slot + 1);
		// A deeper heading appearing before any of its parents leaves leading zeros
		// (parent never incremented); drop them so an orphan `## Foo` reads `1`, not `0.1`.
		let start = 0;
		while (start < parts.length - 1 && parts[start] === 0) start++;
		out[h.key] = parts.slice(start).join('.');
	}
	return out;
}

// A heading line's leading `#`s + text, for re-rendering a numbered heading.
const HEADING_LINE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;

/**
 * A heading source line rewritten so the rendered heading shows its auto-number:
 * `## Header` + `"1"` → `## 1. Header`. Display-only - the caller renders this,
 * never persists it, so the cell's real markdown source is untouched. Returns the
 * line unchanged when there is no number or the line isn't a heading.
 */
export function numberHeadingLine(headingLine: string, number: string | undefined): string {
	if (!number) return headingLine;
	const m = HEADING_LINE.exec(headingLine);
	if (!m) return headingLine;
	return `${m[1]} ${headingNumberPrefix(number)}${m[2]}`;
}

// A single fold unit: a foldable heading (carries a level + key) or a body run.
type FoldUnit =
	| { cellId: string; seg: number; kind: 'heading'; level: number; key: string }
	| { cellId: string; seg: number; kind: 'body'; level: null };

// The notebook flattened to fold *units*, in document order. A code cell is one
// unit; a markdown cell contributes a heading unit (foldable) and a body unit
// per segment. Only heading units carry a level, so only they end a section.
function foldUnits(cells: readonly HeadingCell[] | null | undefined): FoldUnit[] {
	const units: FoldUnit[] = [];
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
export function computeFolding(cells: readonly HeadingCell[] | null | undefined, foldedIds: Set<string>): Folding {
	const units = foldUnits(cells);

	// Units of a cell are contiguous, so a cell is a [first,last] index range.
	const range = new Map<string, { first: number; last: number }>();
	units.forEach((u, i) => {
		const r = range.get(u.cellId);
		if (r) r.last = i;
		else range.set(u.cellId, { first: i, last: i });
	});

	const hiddenUnits = new Set<number>();
	const counts: Record<string, number> = {};
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

	const segs = new Map<string, FoldSegs>();
	units.forEach((u, i) => {
		if (!hiddenUnits.has(i)) return;
		let s = segs.get(u.cellId);
		if (!s) segs.set(u.cellId, (s = { headings: new Set<number>(), bodies: new Set<number>() }));
		(u.kind === 'heading' ? s.headings : s.bodies).add(u.seg);
	});

	const hidden = new Set<string>();
	for (const [cellId, r] of range) {
		let all = true;
		for (let i = r.first; i <= r.last && all; i++) all = hiddenUnits.has(i);
		if (all) hidden.add(cellId);
	}

	return { hidden, segs, counts };
}

/** Per-heading execution state derived from the live kernel run-queue. */
export interface SectionRunState {
	/** foldKeys whose section contains the currently-running cell. */
	running: Set<string>;
	/** foldKey → number of queued cells in that section. */
	queued: Record<string, number>;
}

/**
 * Map the live run-queue onto heading sections, for the Outline's running/queued
 * indicators. A section runs from its heading until the next heading of the same
 * or higher level, so a code cell belongs to every heading currently *open* above
 * it (its nearest heading and that heading's ancestors) - which is why a running
 * cell lights up its whole ancestor chain, and a collapsed parent still shows a
 * descendant is executing. Only code cells run, so markdown cells only open/close
 * sections; they never carry run state themselves.
 *
 *   running — foldKeys whose section contains `runningId`
 *   queued  — foldKey → count of `queuedIds` cells in that section (running cell
 *             excluded by the caller's queue snapshot, which never lists it)
 */
export function sectionRunState(
	cells: readonly HeadingCell[] | null | undefined,
	runningId: string | null | undefined,
	queuedIds: ReadonlySet<string> | null | undefined
): SectionRunState {
	const running = new Set<string>();
	const queued: Record<string, number> = {};
	const stack: { level: number; key: string }[] = []; // open heading occurrences above the cursor
	for (const cell of cells ?? []) {
		if (cell.cell_type === 'markdown') {
			for (const s of splitHeadingSegments(cell.source)) {
				if (s.level == null) continue;
				while (stack.length && stack[stack.length - 1].level >= s.level) stack.pop();
				stack.push({ level: s.level, key: foldKey(cell.id, s.index) });
			}
			continue;
		}
		if (runningId && cell.id === runningId) for (const h of stack) running.add(h.key);
		if (queuedIds?.has(cell.id)) for (const h of stack) queued[h.key] = (queued[h.key] ?? 0) + 1;
	}
	return { running, queued };
}

/**
 * The Outline's rows: every heading, nested by level, with the rows a folded
 * ancestor hides dropped. Reads the same `foldedIds` the notebook renders from,
 * so outline and notebook can never disagree about what is collapsed.
 */
export function outlineRows(
	cells: readonly HeadingCell[] | null | undefined,
	foldedIds: Set<string>,
	counts: Record<string, number> = {}
): OutlineRow[] {
	const rows: OutlineRow[] = [];
	const stack: { level: number; folded: boolean }[] = []; // open ancestors
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
