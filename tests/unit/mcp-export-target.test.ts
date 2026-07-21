/**
 * The notebook-level EXPORT TARGET over MCP (read + set).
 *
 * `export_target` is the notebook's nbdev-style `#|default_exp`: the
 * workspace-relative `.py` module the cells marked for export are written to. It
 * was the last notebook-level `cellar` setting still invisible to the agent (after
 * header numbering, report view, and per-cell hide_input). These tests pin the
 * whole contract: the setter persists into `metadata.cellar.export_target`,
 * round-trips clean-on-save (zero git diff on a re-set, keys removed on clear), the
 * read surface (get_notebook_map's `display` block) reports it, it respects
 * per-session notebook targeting, and it emits the `notebook:export-target` SSE
 * event for the UI.
 *
 * They drive the real service + notebook singletons against a scratch workspace,
 * stubbing only the Python staleness subprocess (get_notebook_map awaits it) so no
 * kernel or subprocess is involved.
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

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-mcp-export-target-'));
	process.env.CELLAR_WORKSPACE = WS;
	svc = await import('../../src/lib/server/mcp/service');
	nbmod = await import('../../src/lib/server/notebook');
	events = await import('../../src/lib/server/events');

	svc.useNotebook('sessA', 'lib-nb.ipynb');
	const nb = svc.targetFor('sessA');
	await svc.addCells(
		[
			{ cell_type: 'markdown', source: '# Library' },
			{ cell_type: 'code', source: 'def helper():\n    return 1' }
		],
		null,
		{ nb, routeImports: false }
	);
});

describe('set_export_target', () => {
	it('sets a target and get_notebook_map reports it in the display block', async () => {
		const nb = svc.targetFor('sessA');
		expect(svc.setExportTarget('lib/foo.py', nb)).toEqual({ export_target: 'lib/foo.py' });
		expect(nbmod.getExportTarget(nb)).toBe('lib/foo.py');

		const map = await svc.getNotebookMap(nb);
		expect(map.display.export_target).toBe('lib/foo.py');
	});

	it('trims whitespace and reports the stored value', () => {
		const nb = svc.targetFor('sessA');
		expect(svc.setExportTarget('  lib/bar.py  ', nb)).toEqual({ export_target: 'lib/bar.py' });
		expect(nbmod.getExportTarget(nb)).toBe('lib/bar.py');
	});

	it('clears with null and with an empty string, and the map reports it null', async () => {
		const nb = svc.targetFor('sessA');
		svc.setExportTarget('lib/foo.py', nb);
		expect(svc.setExportTarget(null, nb)).toEqual({ export_target: null });
		expect(nbmod.getExportTarget(nb)).toBeNull();
		expect((await svc.getNotebookMap(nb)).display.export_target).toBeNull();

		svc.setExportTarget('lib/foo.py', nb);
		expect(svc.setExportTarget('   ', nb)).toEqual({ export_target: null });
		expect(nbmod.getExportTarget(nb)).toBeNull();
	});
});

describe('per-session notebook targeting', () => {
	it('each session sets ITS OWN notebook, and an explicit notebook overrides for one call', () => {
		svc.useNotebook('sessB', 'other-nb.ipynb');
		const A = svc.targetFor('sessA');
		const B = svc.targetFor('sessB');
		expect(A).not.toBe(B);

		svc.setExportTarget('a/mod.py', A);
		expect(nbmod.getExportTarget(B)).toBeNull();

		svc.setExportTarget('b/mod.py', B);
		expect(nbmod.getExportTarget(A)).toBe('a/mod.py'); // A untouched by B's call

		// The user focusing B must not redirect session A's target.
		nbmod.setActiveNotebook('other-nb.ipynb');
		svc.setExportTarget('a/mod2.py', svc.targetFor('sessA'));
		expect(nbmod.getExportTarget(A)).toBe('a/mod2.py');
		expect(nbmod.getExportTarget(B)).toBe('b/mod.py');

		// An explicit per-call notebook wins for that call only, leaving the pin alone.
		svc.setExportTarget('b/mod3.py', svc.targetFor('sessA', 'other-nb.ipynb'));
		expect(nbmod.getExportTarget(B)).toBe('b/mod3.py');
		expect(svc.targetFor('sessA')).toBe(A);

		svc.setExportTarget(null, A);
		svc.setExportTarget(null, B);
	});
});

describe('persistence', () => {
	it('round-trips through metadata.cellar.export_target and re-set is byte-identical', () => {
		const nb = svc.targetFor('sessA');
		svc.setExportTarget('lib/foo.py', nb);
		const disk = JSON.parse(readFileSync(nb, 'utf8'));
		expect(disk.metadata.cellar.export_target).toBe('lib/foo.py');

		const first = readFileSync(nb, 'utf8');
		svc.setExportTarget('lib/foo.py', nb); // same value again -> zero git diff
		expect(readFileSync(nb, 'utf8')).toBe(first);
	});

	it('clearing removes the key rather than persisting an empty string', () => {
		const nb = svc.targetFor('sessA');
		svc.setExportTarget(null, nb);
		const disk = JSON.parse(readFileSync(nb, 'utf8'));
		expect(disk.metadata.cellar?.export_target).toBeUndefined();
	});
});

describe('SSE', () => {
	it('setting the export target emits a notebook:export-target event for the UI', () => {
		const nb = svc.targetFor('sessA');
		const seen: Record<string, unknown>[] = [];
		const off = events.subscribe((e) => {
			if ((e as { type?: string }).type === 'notebook:export-target')
				seen.push(e as Record<string, unknown>);
		});
		svc.setExportTarget('lib/baz.py', nb);
		svc.setExportTarget(null, nb);
		off();
		expect(seen[0]).toMatchObject({ type: 'notebook:export-target', nb, target: 'lib/baz.py' });
		expect(seen[1]).toMatchObject({ type: 'notebook:export-target', nb, target: null });
	});
});
