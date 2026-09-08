/**
 * `PATCH /api/cells/[id]` applies `source` BEFORE `export`, over the REAL route
 * handler against a scratch workspace.
 *
 * Not a style point about field order. `setCellExport` READS the cell's source
 * twice over, so a body carrying both fields is answered from the wrong text when
 * `export` runs first:
 *
 *   - it decides its `export-directive-owns-cell` 409 from
 *     `exportDirectiveOwnsCell(cell)`, i.e. from the source this very request is
 *     about to replace;
 *   - and marking a cell REGENERATES the `.py` module, so the module is built from
 *     the pre-edit source - a state that never existed on disk.
 *
 * This regressed once already: #101 added the two `export-target-section` e2e cases
 * that assert the module holds the source from the same PATCH, and #102 moved the
 * `export` block above `source` to get its refusal ordering, which broke both.
 * Playwright runs in NEITHER CI nor the no-mistakes gate, so that landed green and
 * stayed red until a full local run. This file is the pin that fails in the gate
 * instead - which is the whole reason it exists at the unit level.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let WS: string;
let nbmod: typeof import('../../src/lib/server/notebook');
let PATCH: (evt: { params: { id: string }; request: Request }) => Promise<Response>;

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-patch-order-'));
	process.env.CELLAR_WORKSPACE = WS;
	nbmod = await import('../../src/lib/server/notebook');
	PATCH = (await import('../../src/routes/api/cells/[id]/+server.js')).PATCH as unknown as typeof PATCH;
});

/** A one-cell notebook with an export target, and the ids to drive it with. */
function notebook(name: string, module: string): { nb: string; id: string; modulePath: string } {
	nbmod.createNotebook(name, null, { focus: false });
	nbmod.setExportTarget(module, name);
	const id = nbmod.listCells(name)[0].id;
	return { nb: name, id, modulePath: join(WS, module) };
}

function patch(id: string, body: Record<string, unknown>): Promise<Response> {
	return PATCH({
		params: { id },
		request: new Request('http://x/api/cells/' + id, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		})
	});
}

describe('a body carrying source AND export', () => {
	it('writes a module holding THAT source, not the one it replaced', async () => {
		const { nb, id, modulePath } = notebook('patch-order.ipynb', 'lib/patch_order.py');
		const res = await patch(id, { source: 'def first():\n    return 1', export: true, nb });
		expect(res.status).toBe(200);
		// With `export` first the module was generated from the cell's PREVIOUS
		// (empty) source, so it came out as a bare header plus `__all__ = []`.
		const module = readFileSync(modulePath, 'utf8');
		expect(module).toContain('def first():');
		expect(module).toContain("__all__ = ['first']");
	});

	it('judges the directive refusal against the source being STORED', async () => {
		// The 409 says "the source owns this mark". Read from the source the request
		// is about to overwrite, it answers about text that is on its way out - so a
		// PATCH that REMOVES the directive and unmarks in one go was refused for a
		// directive the stored cell no longer has.
		const { nb, id } = notebook('patch-order-directive.ipynb', 'lib/patch_order_directive.py');
		const marked = await patch(id, { source: '#| export\ndef kept():\n    return 2', nb });
		expect(marked.status).toBe(200);
		// While the directive IS the stored source, an unmark is refused - unchanged.
		const refused = await patch(id, { export: false, nb });
		expect(refused.status).toBe(409);
		expect(await refused.json()).toMatchObject({ reason: 'export-directive-owns-cell' });
		// Removing it in the SAME body is accepted, because the refusal now reads the
		// source that will be stored.
		const cleared = await patch(id, { source: 'def kept():\n    return 2', export: false, nb });
		expect(cleared.status).toBe(200);
		expect(nbmod.listCells(nb)[0].source).toBe('def kept():\n    return 2');
	});

	it('keeps a refused body’s SOURCE - text the user typed is not lost to an unrelated flag', async () => {
		// The stated cost of the order, asserted so it is a decision rather than a
		// side effect: `export` still refuses, and the source above it still lands.
		const { nb, id } = notebook('patch-order-cost.ipynb', 'lib/patch_order_cost.py');
		await patch(id, { source: 'x = 1', nb });
		const res = await patch(id, { source: '#| export\ndef owned():\n    return 3', export: false, nb });
		expect(res.status).toBe(409);
		expect(nbmod.listCells(nb)[0].source).toBe('#| export\ndef owned():\n    return 3');
	});
});
