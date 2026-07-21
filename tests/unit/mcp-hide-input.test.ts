/**
 * Per-cell `hide_input` over MCP: read (via get_notebook_map) + set (set_hide_input).
 *
 * This closes the half-feature left by the notebook-level report view: report view
 * (hide_all_code) is a default, but a per-cell `cellar.hide_input` ALWAYS wins over
 * it, so an agent that turns report view on could not tell that a cell the human
 * (or the agent) kept explicitly shown is still showing its code. These tests pin
 * the whole contract: the setter is tri-state (force hide / force show / clear),
 * it respects the `hide_input ?? hide_all_code` precedence, the map surfaces both
 * the effective `code_hidden` and the explicit `hide_input`, it round-trips through
 * `metadata.cellar` (clean-on-save), it emits the `cell:hide-input` SSE event, and
 * it honors per-session notebook targeting - and NOTHING touches a cell's source.
 *
 * Drives the real service + notebook singletons against a scratch workspace,
 * stubbing only the Python staleness subprocess (get_notebook_map awaits it).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../src/lib/server/dataflow', () => ({
	getNotebookStaleness: async () => ({ sid: null, cells: {} }),
	analyzeDataflow: async () => ({})
}));

let WS: string;
let svc: typeof import('../../src/lib/server/mcp/service');
let nbmod: typeof import('../../src/lib/server/notebook');
let events: typeof import('../../src/lib/server/events');

/** Every leaf (non-section node) of the map, keyed by its handle id. */
type Leaf = { id: string; type: string; code_hidden?: boolean; hide_input?: boolean; children?: unknown[] };
function leavesById(map: { sections: unknown[] }): Record<string, Leaf> {
	const out: Record<string, Leaf> = {};
	const walk = (nodes: unknown[]) => {
		for (const n of nodes) {
			const l = n as Leaf;
			if (l.children) walk(l.children);
			else out[l.id] = l;
		}
	};
	walk(map.sections);
	return out;
}

let ids: string[]; // handles for [code0, markdown1, code2]

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-mcp-hideinput-'));
	process.env.CELLAR_WORKSPACE = WS;
	svc = await import('../../src/lib/server/mcp/service');
	nbmod = await import('../../src/lib/server/notebook');
	events = await import('../../src/lib/server/events');

	svc.useNotebook('sessA', 'report.ipynb');
	const nb = svc.targetFor('sessA');
	const { ids: added } = await svc.addCells(
		[
			{ cell_type: 'code', source: 'x = 1' },
			{ cell_type: 'markdown', source: 'Just some notes.' },
			{ cell_type: 'code', source: 'y = 2' }
		],
		null,
		{ nb, routeImports: false }
	);
	ids = added;
});

describe('set_hide_input return value', () => {
	it('force-hides a cell and reports the resolved precedence', () => {
		const nb = svc.targetFor('sessA');
		const res = svc.setHideInput(ids[0], true, nb);
		expect(res).toEqual({ ok: true, hide_input: true, code_hidden: true, report_view: false });
		svc.setHideInput(ids[0], null, nb); // reset
	});

	it('force-shows a cell even under report view (per-cell wins)', () => {
		const nb = svc.targetFor('sessA');
		svc.setReportView(true, nb);
		// No override: the cell follows report view and is hidden.
		expect(svc.setHideInput(ids[0], null, nb)).toEqual({
			ok: true,
			hide_input: null,
			code_hidden: true,
			report_view: true
		});
		// Explicit false: shown, despite report view being on.
		expect(svc.setHideInput(ids[0], false, nb)).toEqual({
			ok: true,
			hide_input: false,
			code_hidden: false,
			report_view: true
		});
		svc.setReportView(false, nb);
		svc.setHideInput(ids[0], null, nb);
	});

	it('refuses a markdown cell (no code to hide)', () => {
		const nb = svc.targetFor('sessA');
		expect(svc.setHideInput(ids[1], true, nb)).toEqual({ ok: false });
		// The markdown cell gained no hide_input metadata.
		const cell = nbmod.listCells(nb).find((c) => c.cell_type === 'markdown')!;
		expect(cell.metadata?.cellar?.hide_input).toBeUndefined();
	});
});

describe('get_notebook_map surfaces per-cell hide state', () => {
	it('reports effective code_hidden and the explicit hide_input, compactly', async () => {
		const nb = svc.targetFor('sessA');
		// Report view OFF, one cell force-hidden, the other left at default.
		svc.setHideInput(ids[0], true, nb);
		svc.setHideInput(ids[2], null, nb);
		let leaves = leavesById(await svc.getNotebookMap(nb));

		expect(leaves[ids[0]].code_hidden).toBe(true);
		expect(leaves[ids[0]].hide_input).toBe(true);
		// A cell following the (off) default carries neither field: code is shown.
		expect(leaves[ids[2]].code_hidden).toBeUndefined();
		expect(leaves[ids[2]].hide_input).toBeUndefined();
		// A markdown leaf never carries the code fields.
		expect(leaves[ids[1]].code_hidden).toBeUndefined();
		expect(leaves[ids[1]].hide_input).toBeUndefined();

		// Report view ON, one cell kept explicitly shown: the agent can spot it.
		svc.setHideInput(ids[0], null, nb);
		svc.setHideInput(ids[2], false, nb);
		svc.setReportView(true, nb);
		leaves = leavesById(await svc.getNotebookMap(nb));
		// Default cell is now effectively hidden with no explicit override.
		expect(leaves[ids[0]].code_hidden).toBe(true);
		expect(leaves[ids[0]].hide_input).toBeUndefined();
		// The kept-shown cell: hide_input:false present, code_hidden absent.
		expect(leaves[ids[2]].code_hidden).toBeUndefined();
		expect(leaves[ids[2]].hide_input).toBe(false);

		svc.setReportView(false, nb);
		svc.setHideInput(ids[0], null, nb);
		svc.setHideInput(ids[2], null, nb);
	});
});

describe('SSE parity', () => {
	it('setting hide_input emits a cell:hide-input event for the UI', () => {
		const nb = svc.targetFor('sessA');
		const seen: Array<Record<string, unknown>> = [];
		const off = events.subscribe((e) => {
			if ((e as { type?: string }).type === 'cell:hide-input') seen.push(e as Record<string, unknown>);
		});
		svc.setHideInput(ids[0], true, nb);
		svc.setHideInput(ids[0], null, nb);
		off();

		expect(seen).toHaveLength(2);
		expect(seen[0]).toMatchObject({ type: 'cell:hide-input', nb, hidden: true });
		// Clearing carries hidden:null so the browser drops back to the default.
		expect(seen[1]).toMatchObject({ type: 'cell:hide-input', nb, hidden: null });
	});
});

describe('persistence (clean-on-save)', () => {
	it('round-trips through metadata.cellar and clears the key rather than storing false', () => {
		const nb = svc.targetFor('sessA');
		const before = nbmod.listCells(nb).map((c) => c.source);

		svc.setHideInput(ids[0], true, nb);
		let disk = JSON.parse(readFileSync(nb, 'utf8'));
		let code0 = disk.cells.find((c: { source: string }) => String(c.source) === 'x = 1');
		expect(code0.metadata.cellar.hide_input).toBe(true);

		svc.setHideInput(ids[0], false, nb);
		disk = JSON.parse(readFileSync(nb, 'utf8'));
		code0 = disk.cells.find((c: { source: string }) => String(c.source) === 'x = 1');
		expect(code0.metadata.cellar.hide_input).toBe(false);

		// Clearing removes the key entirely (keeps the .ipynb minimal).
		svc.setHideInput(ids[0], null, nb);
		disk = JSON.parse(readFileSync(nb, 'utf8'));
		code0 = disk.cells.find((c: { source: string }) => String(c.source) === 'x = 1');
		expect(code0.metadata.cellar?.hide_input).toBeUndefined();

		// Display-only: no cell's source ever changed.
		expect(nbmod.listCells(nb).map((c) => c.source)).toEqual(before);
	});
});

describe('per-session notebook targeting', () => {
	it('an explicit notebook overrides the session pin for one call', async () => {
		svc.useNotebook('sessB', 'other.ipynb');
		const A = svc.targetFor('sessA');
		const B = svc.targetFor('sessB');
		expect(A).not.toBe(B);

		const { ids: bIds } = await svc.addCells([{ cell_type: 'code', source: 'z = 3' }], null, {
			nb: B,
			routeImports: false
		});

		// Set on A's cell; B untouched.
		svc.setHideInput(ids[0], true, A);
		expect(nbmod.listCells(B).find((c) => c.source === 'z = 3')!.metadata?.cellar?.hide_input).toBeUndefined();

		// An explicit per-call notebook wins for that call, leaving A's pin alone.
		svc.setHideInput(bIds[0], true, svc.targetFor('sessA', 'other.ipynb'));
		expect(nbmod.listCells(B).find((c) => c.source === 'z = 3')!.metadata?.cellar?.hide_input).toBe(true);
		expect(svc.targetFor('sessA')).toBe(A);

		svc.setHideInput(ids[0], null, A);
	});
});
