/**
 * Bulk cell operations over a multi-cell selection, on the REAL notebook
 * singleton against a scratch workspace.
 *
 * Two things are under test, and the second is the one that makes the batch
 * worth having at all:
 *
 *  1. CORRECTNESS - a batch delete / move / retype changes exactly the addressed
 *     cells and leaves the rest of the document alone, including when the
 *     addressed cells are scattered. (Whether those cells are MOUNTED is not a
 *     question this layer can even ask: it only sees ids, which is the whole
 *     reason the selection is a model-level set.)
 *  2. ATOMICITY - each is ONE document write. A loop over the single-cell setters
 *     serializes + fsyncs + renames the whole `.ipynb` once per cell and walks
 *     the file through N-1 intermediate states a crash could freeze it in, so the
 *     write count is pinned, not incidental.
 *
 * Each batch still emits the ORDINARY per-cell events (`cell:deleted` /
 * `cell:moved` / `cell:type`), so every open tab applies patches it already
 * understands and the batch introduces no new event shape. The move events are
 * additionally checked to REPLAY into the persisted order - that replay is what
 * a second tab does.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyMovePlan } from '../../src/lib/cellSelection';

// Count every `.ipynb` write, so "one user action, one document write" is a
// PINNED property rather than an incidental one. Hoisted (vitest lifts `vi.mock`
// above the imports, so the factory cannot close over an ordinary top-level const).
const { writes } = vi.hoisted(() => ({ writes: [] as string[] }));
vi.mock('../../src/lib/server/ipynb', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../src/lib/server/ipynb')>();
	return {
		...actual,
		writeNotebook: (path: string, doc: Parameters<typeof actual.writeNotebook>[1]) => {
			writes.push(path);
			return actual.writeNotebook(path, doc);
		}
	};
});

let WS: string;
let nbmod: typeof import('../../src/lib/server/notebook');
let events: typeof import('../../src/lib/server/events');

interface Seen {
	type: string;
	cellId?: string;
	toIndex?: number;
	cell_type?: string;
}

let seen: Seen[] = [];
let unsubscribe: (() => void) | null = null;

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-bulk-ops-'));
	process.env.CELLAR_WORKSPACE = WS;
	nbmod = await import('../../src/lib/server/notebook');
	events = await import('../../src/lib/server/events');
});

beforeEach(() => {
	seen = [];
	unsubscribe = events.subscribe((ev) => {
		seen.push(ev as unknown as Seen);
	});
});

afterEach(() => {
	unsubscribe?.();
	unsubscribe = null;
});

/** A fresh notebook of `n` code cells `a = 0 … a = n-1`; returns its path + cell ids. */
function makeNotebook(name: string, n: number): { nb: string; ids: string[] } {
	const nb = join(WS, name);
	writeFileSync(
		nb,
		JSON.stringify({
			cells: [{ cell_type: 'code', source: ['x = 0'], metadata: {}, outputs: [], execution_count: null, id: 'seed' }],
			metadata: {},
			nbformat: 4,
			nbformat_minor: 5
		})
	);
	const ids: string[] = [];
	let after: string | null = null;
	for (let i = 0; i < n; i++) {
		after = nbmod.addCell(after, 'code', nb, null, `a = ${i}`).id;
		ids.push(after);
	}
	// Drop the seed so the document is exactly the n cells we made.
	nbmod.deleteCell('seed', nb);
	seen = []; // setup events are not the batch's
	return { nb, ids };
}

const sources = (nb: string) => nbmod.listCells(nb).map((c) => c.source);
const idsOf = (nb: string) => nbmod.listCells(nb).map((c) => c.id);

/** How many `.ipynb` writes `fn` caused. */
function writeCount(fn: () => void): number {
	const before = writes.length;
	fn();
	return writes.length - before;
}

describe('deleteCells - bulk delete', () => {
	it('removes exactly the addressed cells, scattered ones included, and leaves the rest', () => {
		const { nb, ids } = makeNotebook('bulk-delete.ipynb', 6);
		const removed = nbmod.deleteCells([ids[1], ids[3], ids[4]], nb);
		expect(removed.sort()).toEqual([ids[1], ids[3], ids[4]].sort());
		expect(sources(nb)).toEqual(['a = 0', 'a = 2', 'a = 5']);
	});

	it('emits one ordinary `cell:deleted` per removed cell - no new event shape', () => {
		const { nb, ids } = makeNotebook('bulk-delete-events.ipynb', 4);
		nbmod.deleteCells([ids[0], ids[2]], nb);
		const deleted = seen.filter((e) => e.type === 'cell:deleted').map((e) => e.cellId);
		expect(deleted).toEqual([ids[0], ids[2]]);
	});

	it('ignores unknown ids rather than persisting a no-op write', () => {
		const { nb, ids } = makeNotebook('bulk-delete-unknown.ipynb', 3);
		expect(nbmod.deleteCells(['nope'], nb)).toEqual([]);
		expect(idsOf(nb)).toEqual(ids);
	});
});

describe('setCellTypes - bulk change type', () => {
	it('converts every addressed cell and clears the outputs of the ones going to markdown', () => {
		const { nb, ids } = makeNotebook('bulk-type.ipynb', 4);
		nbmod.setOutputs(ids[1], [{ output_type: 'stream', name: 'stdout', text: 'hi\n' }], nb);
		expect(nbmod.listCells(nb)[1].outputs).toHaveLength(1);

		const changed = nbmod.setCellTypes([ids[1], ids[3]], 'markdown', nb);
		expect(changed).toEqual([ids[1], ids[3]]);
		const cells = nbmod.listCells(nb);
		expect(cells.map((c) => c.cell_type)).toEqual(['code', 'markdown', 'code', 'markdown']);
		// The single-cell rule, preserved per cell: markdown carries no outputs.
		expect(cells[1].outputs).toEqual([]);
		expect(cells[0].outputs).toEqual([]);
	});

	it('drops the imports role and the export flag from a cell leaving Python', () => {
		const { nb, ids } = makeNotebook('bulk-type-roles.ipynb', 3);
		nbmod.setCellRole(ids[0], 'imports', nb);
		nbmod.setCellExport(ids[1], true, nb);
		nbmod.setCellTypes([ids[0], ids[1]], 'markdown', nb);
		const cells = nbmod.listCells(nb);
		expect(cells[0].metadata?.cellar?.role).toBeUndefined();
		expect(cells[1].metadata?.cellar?.export).toBeUndefined();
	});

	it('round-trips to SQL and back, and skips cells already of that type', () => {
		const { nb, ids } = makeNotebook('bulk-type-sql.ipynb', 3);
		expect(nbmod.setCellTypes([ids[0], ids[1]], 'sql', nb)).toEqual([ids[0], ids[1]]);
		expect(nbmod.listCells(nb)[0].metadata?.cellar?.language).toBe('sql');
		// Already SQL → nothing to change, so nothing is persisted or emitted.
		seen = [];
		expect(nbmod.setCellTypes([ids[0]], 'sql', nb)).toEqual([]);
		expect(seen.filter((e) => e.type === 'cell:type')).toHaveLength(0);
		expect(nbmod.setCellTypes([ids[0]], 'code', nb)).toEqual([ids[0]]);
		expect(nbmod.listCells(nb)[0].metadata?.cellar?.language).toBeUndefined();
	});

	it('emits one ordinary `cell:type` per changed cell', () => {
		const { nb, ids } = makeNotebook('bulk-type-events.ipynb', 3);
		nbmod.setCellTypes([ids[0], ids[2]], 'markdown', nb);
		expect(seen.filter((e) => e.type === 'cell:type').map((e) => e.cellId)).toEqual([ids[0], ids[2]]);
	});
});

describe('moveCells - bulk move', () => {
	it('slides a contiguous block as a unit', () => {
		const { nb, ids } = makeNotebook('bulk-move-block.ipynb', 5);
		nbmod.moveCells([ids[2], ids[3]], 'up', nb);
		expect(sources(nb)).toEqual(['a = 0', 'a = 2', 'a = 3', 'a = 1', 'a = 4']);
	});

	it('steps a scattered selection one place each, keeping order and gaps', () => {
		const { nb, ids } = makeNotebook('bulk-move-scattered.ipynb', 5);
		nbmod.moveCells([ids[1], ids[3]], 'down', nb);
		expect(sources(nb)).toEqual(['a = 0', 'a = 2', 'a = 1', 'a = 4', 'a = 3']);
	});

	it('is blocked - and persists nothing - when the selection is against that edge', () => {
		const { nb, ids } = makeNotebook('bulk-move-edge.ipynb', 4);
		expect(nbmod.moveCells([ids[0], ids[2]], 'up', nb)).toEqual([]);
		expect(sources(nb)).toEqual(['a = 0', 'a = 1', 'a = 2', 'a = 3']);
		expect(seen.filter((e) => e.type === 'cell:moved')).toHaveLength(0);
	});

	it('emitted `cell:moved` events REPLAY into the persisted order (what a second tab does)', () => {
		const { nb, ids } = makeNotebook('bulk-move-replay.ipynb', 6);
		const before = idsOf(nb);
		nbmod.moveCells([ids[1], ids[2], ids[4]], 'down', nb);
		const steps = seen
			.filter((e) => e.type === 'cell:moved')
			.map((e) => ({ id: e.cellId as string, toIndex: e.toIndex as number }));
		expect(steps.length).toBeGreaterThan(0);
		expect(applyMovePlan(before, steps)).toEqual(idsOf(nb));
	});

	it('ignores ids the notebook does not have', () => {
		const { nb, ids } = makeNotebook('bulk-move-unknown.ipynb', 3);
		nbmod.moveCells([ids[2], 'ghost'], 'up', nb);
		expect(sources(nb)).toEqual(['a = 0', 'a = 2', 'a = 1']);
	});
});

describe('atomicity: one user action is one document write', () => {
	it('a bulk delete of five cells writes the .ipynb ONCE, not five times', () => {
		const { nb, ids } = makeNotebook('atomic-delete.ipynb', 8);
		const batched = writeCount(() => nbmod.deleteCells(ids.slice(0, 5), nb));
		expect(batched).toBe(1);

		// …versus the loop it replaces, on an identical notebook.
		const other = makeNotebook('atomic-delete-loop.ipynb', 8);
		const looped = writeCount(() => {
			for (const id of other.ids.slice(0, 5)) nbmod.deleteCell(id, other.nb);
		});
		expect(looped).toBe(5);
	});

	it('a bulk retype of four cells writes ONCE', () => {
		const { nb, ids } = makeNotebook('atomic-type.ipynb', 6);
		expect(writeCount(() => nbmod.setCellTypes(ids.slice(0, 4), 'markdown', nb))).toBe(1);
	});

	it('a bulk move of a three-cell selection writes ONCE, however many swaps it takes', () => {
		const { nb, ids } = makeNotebook('atomic-move.ipynb', 8);
		expect(writeCount(() => nbmod.moveCells([ids[1], ids[3], ids[5]], 'down', nb))).toBe(1);
	});
});
