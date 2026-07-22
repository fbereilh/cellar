import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Notebook-model basics against the real server-owned document (`notebook.ts`):
 * stable cell IDs, add/move/delete, and duplicate-ID re-keying on load. The
 * module reads its workspace from `CELLAR_WORKSPACE` at call time, so we point
 * it at a scratch dir and address every op by an explicit notebook path (the
 * module keeps a `docs` Map keyed by absolute path, so distinct filenames keep
 * the tests isolated). Mutations persist to that scratch dir — never the repo.
 */

let WS: string;
// Imported lazily after CELLAR_WORKSPACE is set so the module's first workspace
// read resolves to the scratch dir.
let nb: typeof import('../../src/lib/server/notebook');

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-nb-'));
	process.env.CELLAR_WORKSPACE = WS;
	nb = await import('../../src/lib/server/notebook');
});

describe('cell ids are stable and unique', () => {
	it('mints a distinct id per cell and preserves it across edit/move', () => {
		const path = 'ids.ipynb';
		nb.createNotebook(path);
		const a = nb.addCell(null, 'code', path, null, 'a = 1');
		const b = nb.addCell(a.id, 'code', path, null, 'b = 2');
		expect(a.id).not.toBe(b.id);

		// Editing and moving must never regenerate an id (spec §3).
		nb.setSource(a.id, 'a = 11', path);
		nb.moveCell(b.id, 'up', path);
		const ids = nb.listCells(path).map((c) => c.id);
		expect(ids).toContain(a.id);
		expect(ids).toContain(b.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe('add / move / delete', () => {
	it('adds after a given cell, moves, and deletes in order', () => {
		const path = 'ops.ipynb';
		nb.createNotebook(path); // seeds one empty code cell
		const seed = nb.listCells(path)[0];

		const c1 = nb.addCell(seed.id, 'code', path, null, 'one');
		const c2 = nb.addCell(c1.id, 'markdown', path, null, '# two');
		let order = nb.listCells(path).map((c) => c.id);
		expect(order).toEqual([seed.id, c1.id, c2.id]);

		// Move c2 to the top (index 0) and confirm.
		nb.moveCellTo(c2.id, 0, path);
		order = nb.listCells(path).map((c) => c.id);
		expect(order).toEqual([c2.id, seed.id, c1.id]);

		// Delete the middle cell.
		nb.deleteCell(seed.id, path);
		order = nb.listCells(path).map((c) => c.id);
		expect(order).toEqual([c2.id, c1.id]);
	});

	it('inserts a cell at an absolute index (between cells), ids stay stable', () => {
		const path = 'insert.ipynb';
		nb.createNotebook(path); // seeds one empty code cell
		const seed = nb.listCells(path)[0];
		const last = nb.addCell(seed.id, 'code', path, null, 'last');
		expect(nb.listCells(path).map((c) => c.id)).toEqual([seed.id, last.id]);

		// Insert BETWEEN the two existing cells (index 1), not appended.
		const mid = nb.addCellAt(1, 'code', path, null, 'middle');
		const order = nb.listCells(path).map((c) => c.id);
		expect(order).toEqual([seed.id, mid.id, last.id]);
		// A fresh, distinct id; the existing ids are untouched.
		expect(new Set(order).size).toBe(3);
		expect(mid.id).not.toBe(seed.id);
		expect(mid.id).not.toBe(last.id);

		// Insert at the very top (index 0) and at the very end (clamped past length).
		const top = nb.addCellAt(0, 'markdown', path, null, '# top');
		const end = nb.addCellAt(999, 'code', path, null, 'end');
		expect(nb.listCells(path).map((c) => c.id)).toEqual([top.id, seed.id, mid.id, last.id, end.id]);
		// The inserted sources survive to disk in position.
		expect(nb.getCell(mid.id, path)?.source).toBe('middle');
		expect(nb.getCell(top.id, path)?.cell_type).toBe('markdown');
	});

	it('reflects an edit in the persisted document', () => {
		const path = 'edit.ipynb';
		nb.createNotebook(path);
		const c = nb.addCell(null, 'code', path, null, 'first');
		nb.setSource(c.id, 'second', path);
		expect(nb.getCell(c.id, path)?.source).toBe('second');
		// And it hit disk (clean-on-save).
		const raw = JSON.parse(readFileSync(join(WS, path), 'utf8'));
		const onDisk = raw.cells.find((x: any) => x.id === c.id);
		expect(onDisk.source.join('')).toBe('second');
	});
});

describe('duplicate-ID re-keying on load', () => {
	it('re-keys colliding and missing ids so every cell is unique', () => {
		const path = join(WS, 'dupes.ipynb');
		// A foreign notebook with two cells sharing an id and one with none.
		writeFileSync(
			path,
			JSON.stringify({
				nbformat: 4,
				nbformat_minor: 5,
				metadata: { kernelspec: { name: 'python3', display_name: 'python3' } },
				cells: [
					{ cell_type: 'code', id: 'dup', source: ['a'], outputs: [], metadata: {} },
					{ cell_type: 'code', id: 'dup', source: ['b'], outputs: [], metadata: {} },
					{ cell_type: 'code', source: ['c'], outputs: [], metadata: {} }
				]
			})
		);
		const cells = nb.listCells(path);
		const ids = cells.map((c) => c.id);
		expect(ids).toHaveLength(3);
		expect(new Set(ids).size).toBe(3); // all unique after re-keying
		expect(ids.every((id) => id && id.length > 0)).toBe(true);
	});
});

describe('setOutputsLive keeps the live doc current without persisting', () => {
	it('reflects streamed outputs in memory but writes nothing to disk', () => {
		const path = 'live-outputs.ipynb';
		nb.createNotebook(path);
		const cell = nb.listCells(path)[0];
		const abs = join(WS, path);
		const before = readFileSync(abs, 'utf8');

		const outputs = [{ output_type: 'stream' as const, name: 'stdout', text: 'streaming...' }];
		nb.setOutputsLive(cell.id, outputs, path);

		// The in-memory doc (what GET /api/notebooks -> getNotebook reads) is current,
		// so a mid-run load() returns the last-flushed outputs rather than empty.
		expect(nb.getCell(cell.id, path)?.outputs).toEqual(outputs);
		// But nothing was persisted: disk is untouched until run:end (setOutputs).
		expect(readFileSync(abs, 'utf8')).toBe(before);
	});
});

describe('loading never writes an uninvited file', () => {
	it('opening a non-existent default notebook drops no file on disk', async () => {
		// A bare workspace with no notebook.ipynb: getDefaultNotebook materializes
		// the shape in memory but must not create the file.
		const bareWs = mkdtempSync(join(tmpdir(), 'cellar-bare-'));
		process.env.CELLAR_WORKSPACE = bareWs;
		const view = nb.getDefaultNotebook();
		expect(view.cells.length).toBeGreaterThan(0);
		expect(existsSync(join(bareWs, 'notebook.ipynb'))).toBe(false);
		process.env.CELLAR_WORKSPACE = WS; // restore for any later tests
	});
});
