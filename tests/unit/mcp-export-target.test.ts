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
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../src/lib/server/dataflow', () => ({
	getNotebookStaleness: async () => ({ sid: null, cells: {} }),
	analyzeDataflow: async () => ({})
}));

// A `.py` text notebook without the python toolchain: the reader yields a code
// cell and the writer only RECORDS, so "did this path spend a jupytext write" is
// observable.
const py = vi.hoisted(() => ({ writes: [] as string[] }));
vi.mock('../../src/lib/server/jupytext', async (importOriginal) => {
	const real = await importOriginal<typeof import('../../src/lib/server/jupytext')>();
	return {
		...real,
		readPyNotebook: () => ({
			format: 'percent',
			cells: [{ id: null, cell_type: 'code', source: 'a = 0', outputs: [], metadata: {} }]
		}),
		writePyNotebook: (path: string) => {
			py.writes.push(path);
		}
	};
});

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

	it('reports the EFFECTIVE target, so clearing does not hide a `#|default_exp` cell', async () => {
		const nb = svc.targetFor('sessDirective');
		svc.useNotebook('sessDirective', 'directive-nb.ipynb');
		const target = svc.targetFor('sessDirective');
		await svc.addCells([{ cell_type: 'code', source: '#|default_exp lib.fromcell' }], null, {
			nb: target,
			routeImports: false
		});
		expect(nb).not.toBe(target);

		// The setting wins while it is there, and is reported plainly.
		expect(svc.setExportTarget('lib/explicit.py', target)).toEqual({
			export_target: 'lib/explicit.py'
		});

		// Clearing it does NOT untarget the notebook: the directive lives in a cell,
		// and the exporter still resolves it - so a bare `export_target:null` here
		// would read as "nothing is targeted" while a module keeps being generated.
		// The flag is what stops the answer being mistaken for the notebook SETTING.
		expect(svc.setExportTarget(null, target)).toEqual({
			export_target: 'lib/fromcell.py',
			export_target_source: 'default_exp'
		});
		expect(nbmod.getExportTarget(target)).toBeNull();

		// The description promises this is the same value the map reports; all three
		// surfaces resolve through the one `exportTargetFields`, so they cannot drift.
		expect((await svc.getNotebookMap(target)).display).toMatchObject({
			export_target: 'lib/fromcell.py',
			export_target_source: 'default_exp'
		});
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

describe('a .py text notebook is refused, like its pair set_cell_export', () => {
	it('stores nothing and spends no jupytext write', () => {
		const target = nbmod.resolveNotebookPath('text-target.py');
		writeFileSync(target, '# %%\na = 0\n');
		py.writes.length = 0;

		// Such a doc is written through jupytext (which stores no cellar metadata) and
		// `autoExportPy` skips it, so a target set here survives neither a reload nor a
		// regeneration. Accepting it while set_cell_export refuses would leave an agent
		// holding a target for a module that can never be built.
		expect(svc.setExportTarget('lib/text.py', target)).toEqual({ ok: false, refused: 'py-notebook' });
		expect(nbmod.getExportTarget(target)).toBe(null);
		expect(py.writes).toEqual([]);
	});

	it('the UI route refuses it through the SAME predicate, with an actionable 400', async () => {
		const { POST } = await import('../../src/routes/api/notebooks/export-py/+server.js');
		const target = nbmod.resolveNotebookPath('text-target-route.py');
		writeFileSync(target, '# %%\na = 0\n');
		py.writes.length = 0;

		// The human's own target input reaches this route, not MCP - so without the
		// same refusal the UI showed a target that survives neither a reload nor a
		// regeneration, the very gap the agent-side check closed.
		const call = () =>
			(POST as unknown as (e: { request: Request }) => Promise<Response>)({
				request: new Request('http://x/api/notebooks/export-py', {
					method: 'POST',
					body: JSON.stringify({ op: 'set-target', target: 'lib/text.py', path: 'text-target-route.py' })
				})
			});
		await expect(call()).rejects.toMatchObject({ status: 400 });
		expect(nbmod.getExportTarget(target)).toBe(null);
		expect(py.writes).toEqual([]);
	});

	it('the UI route also refuses a target that is not a .py module', async () => {
		const { POST } = await import('../../src/routes/api/notebooks/export-py/+server.js');
		const nb = svc.targetFor('sessRoutePy');
		// The exporter WRITES to this path, so an ordinary source file named here would
		// be overwritten the moment a cell is marked - the human's input reaches the
		// same setter an agent does, so it takes the same refusal.
		await expect(
			(POST as unknown as (e: { request: Request }) => Promise<Response>)({
				request: new Request('http://x/api/notebooks/export-py', {
					method: 'POST',
					body: JSON.stringify({ op: 'set-target', target: 'src/app.ts' })
				})
			})
		).rejects.toMatchObject({ status: 400 });
		expect(nbmod.getExportTarget(nb)).toBe(null);
	});
});

describe('the client half of that refusal (source guard)', () => {
	// vitest runs without the SvelteKit plugin, so `LiveNotebook.svelte` cannot be
	// mounted here; the properties below are what turn the route's 400 into something
	// the human sees, so they are pinned against the source instead.
	const src = readFileSync(join(process.cwd(), 'src/lib/LiveNotebook.svelte'), 'utf8');
	const fn = src.slice(
		src.indexOf('function setExportTargetValue'),
		src.indexOf('async function setNumberingLevel')
	);

	it('reads the response, reverts the optimistic value and says why', () => {
		expect(fn, 'setExportTargetValue should still exist').not.toBe('');
		// A swallowing `.catch(() => {})` with no `res.ok` read is the regression: the
		// input keeps a rejected path while the metadata holds nothing.
		expect(fn).not.toMatch(/\.catch\(\(\)\s*=>\s*\{\}\)/);
		expect(fn).toMatch(/res\?\.ok/);
		expect(fn).toMatch(/exportTarget = confirmedExportTarget/);
		expect(fn).toMatch(/onNotice\?\./);
	});

	it('guards the revert against a newer write, and against the field moving on', () => {
		// Responses are unordered, so a refusal resolving after a newer write must
		// neither revert that newer value nor speak for it - and a refusal for a value
		// the field no longer holds must not yank the caret back either.
		expect(fn).toMatch(/const seq = \+\+exportTargetSeq/);
		expect(fn).toMatch(/seq !== exportTargetSeq/);
		expect(fn).toMatch(/exportTarget !== next/);
	});

	it('debounces the write and reverts to the SERVER-confirmed value', () => {
		// The input fires one request per keystroke and its DOM value is state-driven,
		// so an undebounced write made every keystroke of a refused path 400, revert the
		// field, move the caret and raise another notice. And `previous` was the previous
		// OPTIMISTIC value - itself never stored under consecutive refusals - so the
		// field settled on a path the server had rejected.
		expect(fn).toMatch(/clearTimeout\(exportTargetTimer\)/);
		expect(fn).toMatch(/setTimeout\(.*commitExportTarget/);
		expect(fn).not.toMatch(/const previous = exportTarget/);
		// The baseline is only ever written where the server states it.
		const writes = src.match(/confirmedExportTarget = /g) ?? [];
		expect(writes.length).toBe(3); // load, the SSE event, a confirmed write
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
