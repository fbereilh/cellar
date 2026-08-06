/**
 * CODE ROOTS on the MCP surface: `list_roots`, `use_notebook(root)`, and the
 * `root` the notebook map reports.
 *
 * The governing rule is that an agent that never mentions a root sees exactly
 * today's behavior, so the "no roots anywhere" and "never declared" cases are
 * asserted as carefully as the feature itself. Everything runs against the REAL
 * service + notebook singletons on a scratch workspace; only the Python
 * staleness subprocess is stubbed (the map awaits it).
 *
 * No kernel exists in these tests, so a root change frees none — which is the
 * honest result to report. The teardown pairing itself is
 * `notebook-root-restart.test.ts`.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../src/lib/server/dataflow', () => ({
	getNotebookStaleness: async () => ({ sid: null, cells: {} }),
	analyzeDataflow: async () => ({})
}));

let WS: string;
let svc: typeof import('../../src/lib/server/mcp/service');
let nbmod: typeof import('../../src/lib/server/notebook');

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-mcp-root-'));
	process.env.CELLAR_WORKSPACE = WS;
	mkdirSync(join(WS, 'roots', 'pr-482'), { recursive: true });
	mkdirSync(join(WS, 'roots', 'baseline'), { recursive: true });
	svc = await import('../../src/lib/server/mcp/service');
	nbmod = await import('../../src/lib/server/notebook');
});

describe('list_roots', () => {
	it('enumerates the workspace roots with the notebooks pointing at them', async () => {
		svc.useNotebook('sessList', 'reviewer.ipynb');
		const nb = svc.targetFor('sessList');
		await svc.setNotebookRoot('roots/pr-482', nb);
		const res = await svc.listRoots('sessList');
		expect(res.workspace).toBe(WS);
		expect(res.working_notebook).toBe('reviewer.ipynb');
		expect(res.working_root).toBe('roots/pr-482');
		expect(res.roots.map((r) => r.path)).toEqual(['roots/baseline', 'roots/pr-482']);
		const pr = res.roots.find((r) => r.path === 'roots/pr-482');
		expect(pr?.exists).toBe(true);
		expect(pr?.notebooks).toEqual(['reviewer.ipynb']);
		await svc.setNotebookRoot(null, nb);
	});

	it('a workspace with no roots reports an empty list and says so', async () => {
		const bare = mkdtempSync(join(tmpdir(), 'cellar-mcp-noroots-'));
		const prev = process.env.CELLAR_WORKSPACE;
		process.env.CELLAR_WORKSPACE = bare;
		try {
			// Pin a notebook IN the bare workspace: `list_roots` reports the working
			// notebook's own root, so it must be one this workspace actually holds.
			svc.useNotebook('sessBare', 'lonely.ipynb');
			const res = await svc.listRoots('sessBare');
			expect(res.working_root).toBeNull();
			expect(res.roots).toEqual([]);
			// The note must state the default, not merely be empty: an agent reading
			// "no roots" has to know that means every notebook runs at the workspace.
			expect(res.note).toMatch(/every notebook runs at the workspace root/i);
		} finally {
			process.env.CELLAR_WORKSPACE = prev;
		}
	});
});

describe('use_notebook + root', () => {
	it('omitting root leaves the declaration alone (today’s behavior)', async () => {
		const opened = svc.useNotebook('sessPlain', 'plain.ipynb');
		expect(opened.root).toBeNull();
		const map = await svc.getNotebookMap(svc.targetFor('sessPlain'));
		expect(map.root).toBeNull();
	});

	it('declares a root, and get_notebook_map reports it', async () => {
		const opened = svc.useNotebook('sessRoot', 'rooted.ipynb');
		const change = await svc.setNotebookRoot('roots/pr-482', opened.path);
		expect(change).toMatchObject({ root: 'roots/pr-482', root_changed: true });
		const map = await svc.getNotebookMap(opened.path);
		expect(map.root).toBe('roots/pr-482');
		// The declaration lives in the notebook, so re-opening reports the same root.
		expect(svc.useNotebook('sessRoot2', 'rooted.ipynb').root).toBe('roots/pr-482');
	});

	it('clearing with "" returns the notebook to the workspace root', async () => {
		const opened = svc.useNotebook('sessClear', 'rooted.ipynb');
		await svc.setNotebookRoot('roots/baseline', opened.path);
		const change = await svc.setNotebookRoot('', opened.path);
		expect(change).toMatchObject({ root: null, root_changed: true });
		expect((await svc.getNotebookMap(opened.path)).root).toBeNull();
	});

	it('re-declaring the same root reports no change (no namespace cost)', async () => {
		const opened = svc.useNotebook('sessSame', 'same.ipynb');
		await svc.setNotebookRoot('roots/pr-482', opened.path);
		const again = await svc.setNotebookRoot('roots/pr-482', opened.path);
		expect(again).toEqual({ root: 'roots/pr-482', root_changed: false });
		await svc.setNotebookRoot('', opened.path);
	});

	it('REFUSES a root outside the workspace, naming the rule', async () => {
		const opened = svc.useNotebook('sessBad', 'bad.ipynb');
		await expect(svc.setNotebookRoot('../escape', opened.path)).rejects.toThrow(/inside the workspace/i);
		await expect(svc.setNotebookRoot('/etc', opened.path)).rejects.toThrow(/workspace-relative/i);
		await expect(svc.setNotebookRoot('roots/nope', opened.path)).rejects.toThrow(/does not exist/i);
		expect(nbmod.getNotebookRoot(opened.path)).toBeNull();
	});

	it('two sessions work two roots in one instance, independently', async () => {
		const a = svc.useNotebook('sessA', 'a.ipynb');
		const b = svc.useNotebook('sessB', 'b.ipynb');
		await svc.setNotebookRoot('roots/pr-482', a.path);
		await svc.setNotebookRoot('roots/baseline', b.path);
		expect((await svc.getNotebookMap(a.path)).root).toBe('roots/pr-482');
		expect((await svc.getNotebookMap(b.path)).root).toBe('roots/baseline');
		const listed = await svc.listRoots('sessA');
		expect(listed.working_root).toBe('roots/pr-482');
		expect(listed.roots.find((r) => r.path === 'roots/baseline')?.notebooks).toContain('b.ipynb');
	});
});
