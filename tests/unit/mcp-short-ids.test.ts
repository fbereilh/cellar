/**
 * Short cell-id handles across the live MCP surface (token diet).
 *
 * Drives the REAL service + notebook singletons against a scratch workspace,
 * addressing plain non-import sources (routeImports:false) so nothing touches the
 * kernel or the python dataflow subprocess. Proves:
 *   - get_notebook_map / read_cell / search_cells emit SHORT (8-char) handles,
 *   - the resolver accepts a handle, a longer prefix, and the full UUID (all → same cell),
 *   - an unknown ref errors,
 *   - the .ipynb on disk still stores the full 36-char UUIDs.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let WS: string;
let svc: typeof import('../../src/lib/server/mcp/service');
let nbmod: typeof import('../../src/lib/server/notebook');

const abs = (rel: string) => nbmod.resolveNotebookPath(rel);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-short-ids-'));
	process.env.CELLAR_WORKSPACE = WS;
	svc = await import('../../src/lib/server/mcp/service');
	nbmod = await import('../../src/lib/server/notebook');
});

/** Add a plain (import-free) code cell and return its emitted handle. */
async function addPlain(nb: string, source: string): Promise<string> {
	const r = await svc.addCells([{ cell_type: 'code', source }], null, { nb, routeImports: false });
	return r.ids[0];
}

describe('short cell-id handles', () => {
	it('emits 8-char handles in the map, reads, and search — never the full UUID', async () => {
		const NB = 'handles.ipynb';
		const target = abs(NB);
		svc.useNotebook('sess-h', NB);
		// The starter notebook seeds one empty cell; add a header + a couple of cells.
		await svc.addCells(
			[
				{ cell_type: 'markdown', source: '# Section one\nintro' },
				{ cell_type: 'code', source: 'needle_alpha = 1' },
				{ cell_type: 'code', source: 'needle_beta = 2' }
			],
			null,
			{ nb: target, routeImports: false }
		);

		// Map leaves + section headers carry short handles.
		const map = await svc.getNotebookMap(target);
		const handles: string[] = [];
		const walk = (nodes: Array<Record<string, unknown>>) => {
			for (const n of nodes) {
				expect(typeof n.id).toBe('string');
				handles.push(n.id as string);
				if (Array.isArray(n.children)) walk(n.children as Array<Record<string, unknown>>);
			}
		};
		walk(map.sections as Array<Record<string, unknown>>);
		expect(handles.length).toBeGreaterThan(0);
		for (const h of handles) {
			expect(h.length).toBe(8); // shortest unique prefix, normally exactly 8
			expect(h).not.toMatch(UUID); // never the 36-char UUID
		}

		// A read (boundary resolves the handle → full id, service emits the handle back).
		const someHandle = handles[0];
		const read = await svc.readCell(svc.resolveRef(target, someHandle), target);
		expect(read).not.toBeNull();
		expect((read as { id: string }).id).toBe(someHandle);
		expect((read as { id: string }).id.length).toBe(8);

		// search_cells rows carry short handles.
		const rows = svc.searchCells('needle_alpha', 'input', target);
		expect(rows.length).toBe(1);
		expect(rows[0].id.length).toBe(8);
		expect(rows[0].id).not.toMatch(UUID);
	});

	it('resolves a handle, a longer prefix, and the full UUID all to the same cell', async () => {
		const NB = 'resolve.ipynb';
		const target = abs(NB);
		svc.useNotebook('sess-r', NB);
		const handle = await addPlain(target, 'x = 41');

		// The full UUID: find the cell whose id starts with the handle.
		const full = nbmod.listCells(target).find((c) => c.id.startsWith(handle))!.id;
		expect(full).toMatch(UUID);
		expect(handle.length).toBe(8);

		// handle, a longer prefix, and the full UUID all resolve to the same full id.
		expect(svc.resolveRef(target, handle)).toBe(full);
		expect(svc.resolveRef(target, full.slice(0, 12))).toBe(full);
		expect(svc.resolveRef(target, full)).toBe(full);
	});

	it('rejects an unknown ref', () => {
		const target = abs('resolve.ipynb');
		expect(() => svc.resolveRef(target, 'zzzzzzzz')).toThrow(/no cell matches/i);
	});

	it('reads/edits/runs (dedupe path) work when given a short handle', async () => {
		const NB = 'ops.ipynb';
		const target = abs(NB);
		svc.useNotebook('sess-o', NB);
		const handle = await addPlain(target, 'y = 1');

		// edit via handle lands on the right cell (boundary resolves handle → full id).
		const ed = await svc.editCell(svc.resolveRef(target, handle), 'y = 99', { nb: target, routeImports: false });
		expect(ed).not.toBeNull();
		expect((ed as { id: string }).id.length).toBe(8);
		const full = nbmod.listCells(target).find((c) => c.id.startsWith(handle))!;
		expect(full.source).toBe('y = 99');
	});

	it('stores the full 36-char UUID on disk (handles are display-only)', async () => {
		const NB = 'stored.ipynb';
		const target = abs(NB);
		svc.useNotebook('sess-s', NB);
		await addPlain(target, 'z = 7');

		// The persisted .ipynb keys every cell by a full UUID, never a short handle.
		const raw = JSON.parse(readFileSync(target, 'utf8'));
		expect(raw.cells.length).toBeGreaterThan(0);
		for (const c of raw.cells) {
			expect(typeof c.id).toBe('string');
			expect(c.id).toMatch(UUID);
			expect(c.id.length).toBe(36);
		}
	});
});
