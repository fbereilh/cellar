/**
 * MCP write-tool ergonomics: move BY HANDLE, delete in BATCH.
 *
 * Both come from real agent feedback about round-trips, and both are about the
 * SHAPE of the call, not new capability:
 *
 *  - move_cell used to take an absolute index while every other tool takes a
 *    cell handle, so moving one cell meant fetching the whole notebook map first
 *    just to learn a number. It now takes after_id/before_id (handles), with
 *    `position` kept for the caller that genuinely has an index.
 *  - deleting eight cells after a pivot was eight calls, eight persists and
 *    eight checkpoints. delete_cells takes a list.
 *
 * Drives the REAL service + notebook singletons against a scratch workspace,
 * with import-free sources (routeImports:false) so nothing touches the kernel or
 * the python dataflow subprocess.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let WS: string;
let svc: typeof import('../../src/lib/server/mcp/service');
let nbmod: typeof import('../../src/lib/server/notebook');
let events: typeof import('../../src/lib/server/events');

const abs = (rel: string) => nbmod.resolveNotebookPath(rel);

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-move-delete-'));
	process.env.CELLAR_WORKSPACE = WS;
	svc = await import('../../src/lib/server/mcp/service');
	nbmod = await import('../../src/lib/server/notebook');
	events = await import('../../src/lib/server/events');
});

/** A notebook of code cells `a = 0 … a = n-1`, returned as emitted handles. */
async function makeNotebook(name: string, n: number): Promise<{ target: string; handles: string[] }> {
	const target = abs(name);
	svc.useNotebook(`sess-${name}`, name);
	const specs = Array.from({ length: n }, (_, i) => ({ cell_type: 'code' as const, source: `a = ${i}` }));
	// The emitted ids ARE the handles an agent gets back — feed them straight in.
	const { ids } = await svc.addCells(specs, null, { nb: target, routeImports: false });
	return { target, handles: ids };
}

/** The notebook's cell sources in document order — the thing a move/delete moves. */
const sources = (target: string) => nbmod.listCells(target).map((c) => c.source);

describe('move_cell takes a handle, not just an index', () => {
	it('moves a cell AFTER another named cell — no map fetch, no index arithmetic', async () => {
		const { target, handles } = await makeNotebook('move-after.ipynb', 4);
		const [c0, , c2] = handles;

		// "put the first cell after the third" — expressible without knowing any index.
		const r = svc.moveCell(c0, { afterId: c2 }, target);
		expect(r.ok).toBe(true);
		expect(sources(target)).toEqual(['', 'a = 1', 'a = 2', 'a = 0', 'a = 3']);
		// It reports where the cell landed, so confirming costs no second read.
		expect(r.ok && r.index).toBe(3);
		expect(r.ok && r.id).toBe(c0);
	});

	it('moves a cell BEFORE another named cell, in both directions', async () => {
		const { target, handles } = await makeNotebook('move-before.ipynb', 4);
		const [c0, c1, , c3] = handles;

		// Downward: an anchor BELOW the moved cell shifts up by one once the cell is
		// lifted out — the off-by-one destIndex exists for.
		expect(svc.moveCell(c1, { beforeId: c3 }, target).ok).toBe(true);
		expect(sources(target)).toEqual(['', 'a = 0', 'a = 2', 'a = 1', 'a = 3']);

		// Upward: an anchor ABOVE keeps its index.
		expect(svc.moveCell(c3, { beforeId: c0 }, target).ok).toBe(true);
		expect(sources(target)).toEqual(['', 'a = 3', 'a = 0', 'a = 2', 'a = 1']);
	});

	it('still accepts an absolute position (unchanged back-compat path)', async () => {
		const { target, handles } = await makeNotebook('move-index.ipynb', 3);
		const r = svc.moveCell(handles[0], { position: 0 }, target);
		expect(r.ok).toBe(true);
		expect(sources(target)).toEqual(['a = 0', '', 'a = 1', 'a = 2']);
		// `position` means the index the cell ENDS UP at, which is what it reports.
		expect(r.ok && r.index).toBe(0);
	});

	it('refuses a destination it cannot act on rather than moving somewhere arbitrary', async () => {
		const { target, handles } = await makeNotebook('move-bad.ipynb', 3);
		const before = sources(target);

		// No destination at all.
		expect(svc.moveCell(handles[0], {}, target)).toMatchObject({ ok: false, error: 'no_destination' });
		// An anchor that is the moved cell itself: "after myself" has no meaning, and
		// silently treating it as a move would relocate the cell for no reason.
		expect(svc.moveCell(handles[0], { afterId: handles[0] }, target)).toMatchObject({ ok: false, error: 'same_cell' });
		// An unknown anchor.
		expect(svc.moveCell(handles[0], { afterId: 'no-such-cell' }, target)).toMatchObject({ ok: false, error: 'unknown_anchor' });
		// An unknown cell to move.
		expect(svc.moveCell('no-such-cell', { position: 0 }, target)).toMatchObject({ ok: false, error: 'not_found' });

		expect(sources(target)).toEqual(before); // nothing moved on any failure
	});
});

describe('delete_cells removes many in one call', () => {
	it('deletes a batch and leaves every other cell intact', async () => {
		const { target, handles } = await makeNotebook('delete-batch.ipynb', 8);
		// The pivot: drop five of the eight in ONE call, out of document order.
		const doomed = [handles[6], handles[1], handles[3], handles[0], handles[5]];

		const r = svc.removeCells(doomed, target);
		expect(r.ok).toBe(true);
		expect(r.ok && r.count).toBe(5);
		expect(r.ok && r.deleted).toHaveLength(5);
		expect(sources(target)).toEqual(['', 'a = 2', 'a = 4', 'a = 7']);
	});

	it('still emits one cell:deleted per cell, and lands on disk, despite being one write', async () => {
		const { target, handles } = await makeNotebook('delete-events.ipynb', 4);
		// The batch is ONE document write (see notebook.ts deleteCells), but the
		// client contract is unchanged: every open tab still gets the same per-cell
		// event it already knows how to apply — no new event shape to handle.
		const seen: string[] = [];
		const off = events.subscribe((e) => {
			const ev = e as { type: string; nb?: string; cellId?: string };
			if (ev.type === 'cell:deleted' && ev.nb === target) seen.push(ev.cellId!);
		});
		try {
			svc.removeCells([handles[0], handles[2]], target);
		} finally {
			off();
		}
		expect(seen).toHaveLength(2);
		// And the .ipynb the human's git sees really lost exactly those two cells.
		const onDisk = JSON.parse(readFileSync(target, 'utf8')) as { cells: Array<{ id: string }> };
		expect(onDisk.cells.map((c) => c.id)).toEqual(nbmod.listCells(target).map((c) => c.id));
		for (const id of seen) expect(onDisk.cells.some((c) => c.id === id)).toBe(false);
	});

	it('still deletes exactly one cell when given one id (single-cell delete unchanged)', async () => {
		const { target, handles } = await makeNotebook('delete-one.ipynb', 3);
		expect(svc.removeCells([handles[1]], target)).toMatchObject({ ok: true, count: 1 });
		expect(sources(target)).toEqual(['', 'a = 0', 'a = 2']);
	});

	it('collapses duplicate ids instead of double-deleting', async () => {
		const { target, handles } = await makeNotebook('delete-dupes.ipynb', 3);
		const r = svc.removeCells([handles[0], handles[0], handles[2]], target);
		expect(r.ok && r.count).toBe(2);
		expect(sources(target)).toEqual(['', 'a = 1']);
	});

	it('deletes NOTHING when any id is unknown — a typo cannot half-apply a batch', async () => {
		const { target, handles } = await makeNotebook('delete-bad.ipynb', 4);
		const before = sources(target);
		const r = svc.removeCells([handles[0], handles[1], 'no-such-cell', handles[2]], target);
		expect(r.ok).toBe(false);
		expect(r).toMatchObject({ missing: 'no-such-cell' });
		expect(sources(target)).toEqual(before);
		// An empty list is a refusal too, not a silent no-op success.
		expect(svc.removeCells([], target).ok).toBe(false);
	});
});
