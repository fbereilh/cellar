/**
 * Cellar — diff primitives for the git change decorations (line-level in the
 * editor gutter, cell-level in the notebook).
 *
 * Pure and dependency-free so it runs in the browser: the server hands out the
 * git-HEAD *baseline* (`/api/fs/git/head`) once, and the client re-diffs the
 * live buffer against it on every change. That keeps the markers live as you
 * type without shelling out to `git` per keystroke.
 *
 * The line diff is Myers' greedy algorithm (the one `git diff` itself uses),
 * bounded so a pathological file degrades to "this whole region changed" rather
 * than hanging the editor.
 */

// Max edit distance (changed lines) we will trace. Beyond this the diff is not
// interesting for a gutter, and the trace's O(D²) memory stops being free.
const MAX_EDIT_DISTANCE = 1000;

/** Split text into lines the way CodeMirror counts them (a trailing \n adds an empty last line). */
export function splitLines(text) {
	return (text ?? '').split('\n');
}

/**
 * Myers' greedy diff over two arrays of comparable primitives.
 * Returns the edit script as `'='` (keep) / `'-'` (delete from a) / `'+'`
 * (insert from b), or `null` when the edit distance exceeds the bound.
 */
function myers(a, b) {
	const N = a.length;
	const M = b.length;
	if (!N) return new Array(M).fill('+');
	if (!M) return new Array(N).fill('-');

	const maxD = Math.min(N + M, MAX_EDIT_DISTANCE);
	const off = maxD + 1; // k ∈ [-d, d] ⊂ [-maxD, maxD] → index off+k stays in range
	const v = new Int32Array(2 * maxD + 3);
	const trace = [];

	for (let d = 0; d <= maxD; d++) {
		trace.push(Int32Array.from(v)); // state *before* iteration d — what backtrack replays
		for (let k = -d; k <= d; k += 2) {
			let x;
			if (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) x = v[off + k + 1];
			else x = v[off + k - 1] + 1;
			let y = x - k;
			while (x < N && y < M && a[x] === b[y]) {
				x++;
				y++;
			}
			v[off + k] = x;
			if (x >= N && y >= M) return backtrack(trace, off, N, M);
		}
	}
	return null; // too many changes to trace
}

/** Walk the recorded V-snapshots back from (N,M) to (0,0), emitting the edit script. */
function backtrack(trace, off, N, M) {
	let x = N;
	let y = M;
	const ops = [];
	for (let d = trace.length - 1; d > 0; d--) {
		const v = trace[d];
		const k = x - y;
		const prevK = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? k + 1 : k - 1;
		const prevX = v[off + prevK];
		const prevY = prevX - prevK;
		while (x > prevX && y > prevY) {
			ops.push('=');
			x--;
			y--;
		}
		ops.push(x === prevX ? '+' : '-');
		x = prevX;
		y = prevY;
	}
	// d === 0: whatever is left is the leading common diagonal (x === y here).
	while (x > 0 && y > 0) {
		ops.push('=');
		x--;
		y--;
	}
	return ops.reverse();
}

/**
 * Diff two line arrays into hunks `{oldStart, oldCount, newStart, newCount}`
 * (0-based, indices into the full arrays). Common prefix/suffix is trimmed
 * first, which is what makes the common "one line edited in a big file" case
 * essentially free.
 */
export function diffLines(a, b) {
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}
	if (start === endA && start === endB) return [];

	const ops = myers(a.slice(start, endA), b.slice(start, endB));
	if (!ops) {
		// Bailed out: report the whole changed region as one hunk rather than lie.
		return [{ oldStart: start, oldCount: endA - start, newStart: start, newCount: endB - start }];
	}

	const hunks = [];
	let x = 0;
	let y = 0;
	let hunk = null;
	for (const op of ops) {
		if (op === '=') {
			if (hunk) {
				hunks.push(hunk);
				hunk = null;
			}
			x++;
			y++;
			continue;
		}
		hunk ??= { oldStart: start + x, oldCount: 0, newStart: start + y, newCount: 0 };
		if (op === '-') {
			hunk.oldCount++;
			x++;
		} else {
			hunk.newCount++;
			y++;
		}
	}
	if (hunk) hunks.push(hunk);
	return hunks;
}

/**
 * Classify every line of `newText` against `oldText`, VS Code-style:
 *
 *   lines         1-based line number → 'add' | 'mod'
 *   deletedBefore 1-based line number → how many lines vanished just above it
 *   deletedAtEnd  lines that vanished off the end of the document
 */
export function lineChanges(oldText, newText) {
	const before = splitLines(oldText);
	const after = splitLines(newText);
	const lines = new Map();
	const deletedBefore = new Map();
	let deletedAtEnd = 0;

	for (const h of diffLines(before, after)) {
		if (h.newCount === 0) {
			if (h.newStart < after.length) {
				const at = h.newStart + 1;
				deletedBefore.set(at, (deletedBefore.get(at) ?? 0) + h.oldCount);
			} else {
				deletedAtEnd += h.oldCount;
			}
			continue;
		}
		const type = h.oldCount === 0 ? 'add' : 'mod';
		for (let i = 0; i < h.newCount; i++) lines.set(h.newStart + 1 + i, type);
	}
	return { lines, deletedBefore, deletedAtEnd };
}

// ---- Notebook cell-level diff ---------------------------------------------

/** No baseline / nothing changed. Frozen so callers can share one reference. */
export const NO_CELL_CHANGES = Object.freeze({ status: {}, removedBefore: {}, removedAtEnd: 0 });

/**
 * Diff a notebook's live cells against its git-HEAD cells.
 *
 * Cells are matched **by id**, not by index: Cellar owns nbformat 4.5 cell ids
 * and writes them back on every save, so an id is a stable identity across
 * inserts and reorders — index matching would paint every cell below an insert
 * as modified. A HEAD notebook without usable ids (nbformat < 4.5, or duplicate
 * ids) falls back to index matching.
 *
 * Only `source` and `cell_type` are compared. Outputs are deliberately excluded:
 * they are the noisiest part of an `.ipynb` and re-running a cell to the same
 * result should not light up the gutter. Both sides come through the same
 * normalization (`ipynb.js`'s `deserialize`, which joins nbformat's multiline
 * source arrays), so formatting noise never registers as a change.
 *
 * @param {Array<{id:string, cell_type:string, source:string}>} headCells
 * @param {Array<{id:string, cell_type:string, source:string}>} cells
 * @returns {{status: Record<string,'added'|'modified'|'moved'>, removedBefore: Record<string,number>, removedAtEnd: number}}
 */
export function notebookCellChanges(headCells, cells) {
	if (!Array.isArray(headCells) || !Array.isArray(cells)) return NO_CELL_CHANGES;
	const idsUsable =
		headCells.every((c) => c.id) &&
		cells.every((c) => c.id) &&
		new Set(headCells.map((c) => c.id)).size === headCells.length;
	return idsUsable ? matchById(headCells, cells) : matchByIndex(headCells, cells);
}

function differs(head, cell) {
	return head.source !== cell.source || head.cell_type !== cell.cell_type;
}

function matchByIndex(head, cells) {
	const status = {};
	for (let i = 0; i < cells.length; i++) {
		if (!head[i]) status[cells[i].id] = 'added';
		else if (differs(head[i], cells[i])) status[cells[i].id] = 'modified';
	}
	return { status, removedBefore: {}, removedAtEnd: Math.max(0, head.length - cells.length) };
}

function matchById(head, cells) {
	const headById = new Map(head.map((c) => [c.id, c]));
	const liveIds = new Set(cells.map((c) => c.id));

	const status = {};
	for (const cell of cells) {
		const h = headById.get(cell.id);
		if (!h) status[cell.id] = 'added';
		else if (differs(h, cell)) status[cell.id] = 'modified';
	}

	// A removed cell has no cell of its own to decorate, so its marker is anchored
	// to the next HEAD cell that survived — the place the gap now sits. Removals
	// past the last surviving cell fall off the end.
	const removedBefore = {};
	let pending = 0;
	for (const h of head) {
		if (!liveIds.has(h.id)) {
			pending++;
			continue;
		}
		if (pending) {
			removedBefore[h.id] = (removedBefore[h.id] ?? 0) + pending;
			pending = 0;
		}
	}

	// A pure reorder changes the file but no cell's content. Flag the *minimal*
	// set of cells that must move to restore HEAD's order (everything outside the
	// longest increasing subsequence of HEAD positions), so dragging one cell up
	// marks one cell, not every cell it jumped over.
	for (const id of movedIds(head, cells)) if (!status[id]) status[id] = 'moved';

	return { status, removedBefore, removedAtEnd: pending };
}

/** Ids of the common cells that are out of HEAD order (complement of the LIS). */
function movedIds(head, cells) {
	const rank = new Map(head.map((c, i) => [c.id, i]));
	const seq = cells.filter((c) => rank.has(c.id)).map((c) => ({ id: c.id, r: rank.get(c.id) }));
	if (seq.length < 2) return [];

	const tails = []; // tails[l] = index into seq of the smallest tail of an LIS of length l+1
	const prev = new Array(seq.length).fill(-1);
	for (let i = 0; i < seq.length; i++) {
		let lo = 0;
		let hi = tails.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (seq[tails[mid]].r < seq[i].r) lo = mid + 1;
			else hi = mid;
		}
		if (lo > 0) prev[i] = tails[lo - 1];
		if (lo === tails.length) tails.push(i);
		else tails[lo] = i;
	}

	const inOrder = new Set();
	for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) inOrder.add(seq[i].id);
	return seq.filter((s) => !inOrder.has(s.id)).map((s) => s.id);
}
