import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Token-diet tool merge: open_notebook + create_notebook -> use_notebook, and
 * read_cell folded into read_cells. These tests prove the MERGED tools still
 * cover every mode the two originals covered — creating a new notebook AND
 * opening an existing one; reading a single cell AND several — so no capability
 * was lost when the two redundant tools were dropped from the surface.
 *
 * Exercises the real service + notebook singletons against a scratch workspace,
 * with plain non-import sources so nothing touches the kernel or the python
 * dataflow subprocess (routeImports:false).
 */

let WS: string;
let svc: typeof import('../../src/lib/server/mcp/service');
let nbmod: typeof import('../../src/lib/server/notebook');

const abs = (rel: string) => nbmod.resolveNotebookPath(rel);

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-tool-merge-'));
	process.env.CELLAR_WORKSPACE = WS;
	svc = await import('../../src/lib/server/mcp/service');
	nbmod = await import('../../src/lib/server/notebook');
});

describe('use_notebook (merged open + create)', () => {
	it('CREATES a notebook that does not exist yet', () => {
		const rel = 'brand-new.ipynb';
		expect(nbmod.notebookExists(rel)).toBe(false);
		const r = svc.useNotebook('sessCreate', rel);
		expect(r.created).toBe(true);
		expect(r.pinned).toBe(true);
		expect(r.working_notebook).toBe(rel);
		expect(nbmod.notebookExists(rel)).toBe(true);
		// And it becomes this session's working notebook.
		expect(svc.targetFor('sessCreate')).toBe(abs(rel));
	});

	it('OPENS an existing notebook without recreating it', () => {
		const rel = 'exists.ipynb';
		svc.useNotebook('sessSeed', rel); // create it once
		const r = svc.useNotebook('sessOpen', rel); // open the now-existing one
		expect(r.created).toBe(false);
		expect(r.working_notebook).toBe(rel);
		expect(svc.targetFor('sessOpen')).toBe(abs(rel));
	});

	it('defaults an omitted name to an untitled NEW notebook (old create_notebook affordance)', () => {
		const r = svc.useNotebook('sessUntitled');
		expect(r.created).toBe(true);
		expect(r.working_notebook).toBe('untitled.ipynb');
	});

	it('create_if_missing:false is open-only: opens an existing notebook', () => {
		const rel = 'open-only.ipynb';
		svc.useNotebook('sessMk', rel); // create first
		const r = svc.useNotebook('sessOpenOnly', rel, false);
		expect(r.created).toBe(false);
		expect(r.working_notebook).toBe(rel);
	});

	it('create_if_missing:false THROWS on a missing notebook (never creates)', () => {
		const rel = 'never-created.ipynb';
		expect(() => svc.useNotebook('sessNo', rel, false)).toThrow(/does not exist/i);
		expect(nbmod.notebookExists(rel)).toBe(false);
	});
});

describe('read_cells (merged single + multi read)', () => {
	it('returns ONE cell for a single id', async () => {
		const rel = 'read-one.ipynb';
		const target = svc.targetFor('r1', rel);
		svc.useNotebook('r1', rel);
		const { ids } = await svc.addCells([{ cell_type: 'code', source: 'a = 1' }], null, {
			nb: target,
			routeImports: false
		});
		const out = (await svc.readCells([ids[0]], target)) as Array<{ source: string }>;
		expect(out.length).toBe(1);
		expect(out[0].source).toBe('a = 1');
	});

	it('returns SEVERAL cells for several ids, in order', async () => {
		const rel = 'read-many.ipynb';
		const target = svc.targetFor('r2', rel);
		svc.useNotebook('r2', rel);
		const { ids } = await svc.addCells(
			[
				{ cell_type: 'code', source: 'p = 1' },
				{ cell_type: 'code', source: 'q = 2' },
				{ cell_type: 'code', source: 'r = 3' }
			],
			null,
			{ nb: target, routeImports: false }
		);
		const out = (await svc.readCells(ids, target)) as Array<{ source: string }>;
		expect(out.map((c) => c.source)).toEqual(['p = 1', 'q = 2', 'r = 3']);
	});
});
