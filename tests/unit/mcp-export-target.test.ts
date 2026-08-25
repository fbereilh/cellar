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
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

// A notebook write that FAILS (a read-only checkout, EACCES, ENOSPC), so the one
// throw `setExportTarget` has after it mutates is observable without touching the
// real filesystem's permissions.
const disk = vi.hoisted(() => ({ failFor: null as string | null }));
vi.mock('../../src/lib/server/ipynb', async (importOriginal) => {
	const real = await importOriginal<typeof import('../../src/lib/server/ipynb')>();
	return {
		...real,
		writeNotebook: (path: string, doc: Parameters<typeof real.writeNotebook>[1]) => {
			if (disk.failFor && path.endsWith(disk.failFor))
				throw new Error('ENOSPC: no space left on device, write');
			return real.writeNotebook(path, doc);
		}
	};
});

let WS: string;
let svc: typeof import('../../src/lib/server/mcp/service');
let nbmod: typeof import('../../src/lib/server/notebook');
let events: typeof import('../../src/lib/server/events');

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-mcp-export-target-'));
	mkdirSync(join(WS, 'sub'), { recursive: true });
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

		// The map reports the same value; all three surfaces resolve through the one
		// `exportTargetFields`, so they cannot drift (which is why the tool description
		// does not spend words restating what the map's own description already says).
		expect((await svc.getNotebookMap(target)).display).toMatchObject({
			export_target: 'lib/fromcell.py',
			export_target_source: 'default_exp'
		});
	});

	it('keeps its registration description compact, with every claim an agent acts on', () => {
		const src = readFileSync(new URL('../../src/lib/server/mcp/server.ts', import.meta.url), 'utf8');
		const line = src.slice(src.indexOf("registerTool('set_export_target'")).split('\n')[0];

		// The claims an agent acts on: what clearing does and does not reach, that the
		// module is rewritten only while a cell stays marked (and how a failed write is
		// reported), the refusals this path can hit, and the flag that tells a clearable
		// SETTING from a non-clearable cell directive.
		expect(line).toMatch(/clears the SETTING/);
		expect(line).toMatch(/#\|default_exp` directive in a cell is NOT/);
		expect(line).toMatch(/while a cell stays marked/);
		// The `module` field reports TWO things and the description must name both: a
		// write that failed, and a module that was written and will not import.
		expect(line).toMatch(/module/);
		expect(line).toMatch(/failed/);
		expect(line).toMatch(/will not import/);
		expect(line).toMatch(/outside the workspace/);
		expect(line).toMatch(/text notebook/);
		expect(line).toMatch(/export_target_source/);

		// The same mechanical bound its pair `set_cell_export` carries: a description is
		// paid on EVERY session, so an honesty correction has to be bought by cutting
		// words rather than by growing what every session is billed for. Asserted on the
		// registration literal, so a restatement can never creep back in unnoticed.
		const desc = line.match(/description: '(.*?)', inputSchema/);
		expect(desc, 'the description stays a single-quoted one-line literal').toBeTruthy();
		expect(desc![1].length).toBeLessThan(700);
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
		const res = await call();
		expect(res.status).toBe(400);
		expect(nbmod.getExportTarget(target)).toBe(null);
		expect(py.writes).toEqual([]);
	});

	/**
	 * The AGENT surface of the base-inheritance rule: an omitted `base` keeps the
	 * one the document stores, so echoing a reported path back cannot silently
	 * re-anchor it - which would drop `export_base` from the committed .ipynb and
	 * move the generated module, leaving the old file behind.
	 */
	it('set_export_target with no base keeps the notebook\'s stored base', async () => {
		svc.useNotebook('sessInherit', 'sub/inherit.ipynb');
		const nb = svc.targetFor('sessInherit');
		expect(svc.setExportTarget('helpers.py', nb, 'notebook')).toMatchObject({
			export_target: 'sub/helpers.py',
			export_base: 'notebook',
			export_path: 'helpers.py'
		});

		// The reported path handed back WITHOUT a base: the base survives, and the
		// module stays the same file rather than moving to the workspace root.
		expect(svc.setExportTarget('helpers.py', nb)).toMatchObject({
			export_target: 'sub/helpers.py',
			export_base: 'notebook',
			export_path: 'helpers.py'
		});
		expect(nbmod.getExportTargetState(nb)).toMatchObject({ base: 'notebook', target: 'helpers.py' });

		// An EXPLICIT base still re-anchors, workspace included.
		expect(svc.setExportTarget('sub/helpers.py', nb, 'workspace')).toEqual({
			export_target: 'sub/helpers.py'
		});
		expect(nbmod.getExportTargetState(nb).base).toBe('workspace');
	});

	/**
	 * A notebook that stores no base is the legacy shape, and an omitted base must
	 * leave it exactly that: workspace-relative, with no key minted.
	 */
	it('mints no base key for a notebook that stores none', () => {
		svc.useNotebook('sessLegacyBase', 'legacy-base.ipynb');
		const nb = svc.targetFor('sessLegacyBase');
		expect(svc.setExportTarget('lib/legacy.py', nb)).toEqual({ export_target: 'lib/legacy.py' });
		const cellar = JSON.parse(readFileSync(nb, 'utf8')).metadata.cellar;
		expect(cellar.export_target).toBe('lib/legacy.py');
		expect('export_base' in cellar).toBe(false);
	});

	/**
	 * The route's refusal reply is the ONLY thing that can correct the tab's field
	 * and base select, so it must describe the document by the SAME rule the setter
	 * reports it by. A second, route-local reading of the base answered a refusal
	 * and a success with two different readings of one document - they diverge for a
	 * document carrying `export_base` with no `export_target` (a hand edit), where
	 * the route resolved nothing and fell back to `workspace` while the setter reads
	 * the key that is really there.
	 */
	it('a refusal and a success describe one document by ONE rule', async () => {
		const { POST } = await import('../../src/routes/api/notebooks/export-py/+server.js');
		const post = POST as unknown as (e: { request: Request }) => Promise<Response>;
		const rel = 'sub/one-rule.ipynb';
		writeFileSync(
			nbmod.resolveNotebookPath(rel),
			JSON.stringify({
				cells: [{ id: 'aaaa1111', cell_type: 'code', source: ['x = 1'], metadata: {}, outputs: [], execution_count: null }],
				metadata: { cellar: { export_base: 'notebook' } },
				nbformat: 4,
				nbformat_minor: 5
			})
		);

		const refused = await post({
			request: new Request('http://x/api/notebooks/export-py', {
				method: 'POST',
				body: JSON.stringify({ op: 'set-target', target: 'nope', base: 'notebook', path: rel })
			})
		});
		expect(refused.status).toBe(400);
		const refusedBody = (await refused.json()) as Record<string, unknown>;

		// The SAME reading the doc layer reports, and the same one the success path
		// answers with a moment later.
		expect(refusedBody.base).toBe(nbmod.getExportTargetState(rel).base);
		const ok = await post({
			request: new Request('http://x/api/notebooks/export-py', {
				method: 'POST',
				body: JSON.stringify({ op: 'set-target', target: 'kept.py', base: 'notebook', path: rel })
			})
		});
		expect(ok.status).toBe(200);
		expect(((await ok.json()) as Record<string, unknown>).base).toBe(refusedBody.base);
	});

	it('the UI route also refuses a target that is not a .py module', async () => {
		const { POST } = await import('../../src/routes/api/notebooks/export-py/+server.js');
		const nb = svc.targetFor('sessRoutePy');
		// The exporter WRITES to this path, so an ordinary source file named here would
		// be overwritten the moment a cell is marked - the human's input reaches the
		// same setter an agent does, so it takes the same refusal.
		const res = await (POST as unknown as (e: { request: Request }) => Promise<Response>)({
			request: new Request('http://x/api/notebooks/export-py', {
				method: 'POST',
				body: JSON.stringify({ op: 'set-target', target: 'src/app.ts' })
			})
		});
		expect(res.status).toBe(400);
		expect(nbmod.getExportTarget(nb)).toBe(null);
	});

	/**
	 * A refusal must tell the tab what the document HOLDS, because that is what its
	 * input goes back to. Answering with a bare message forced the client to remember
	 * a baseline of its own, and keeping that in step with the server needed a rule
	 * per failure mode - each of which had its own hole.
	 */
	it('every set-target reply reports the target the document holds', async () => {
		const { POST } = await import('../../src/routes/api/notebooks/export-py/+server.js');
		const post = POST as unknown as (e: { request: Request }) => Promise<Response>;
		svc.useNotebook('sessHeld', 'held-target.ipynb');
		const nb = svc.targetFor('sessHeld');
		await svc.addCells([{ cell_type: 'code', source: 'h = 1' }], null, { nb, routeImports: false });
		const call = (target: string) =>
			post({
				request: new Request('http://x/api/notebooks/export-py', {
					method: 'POST',
					body: JSON.stringify({ op: 'set-target', target, path: 'held-target.ipynb' })
				})
			});

		expect(await (await call('lib/held.py')).json()).toEqual({
			ok: true,
			target: 'lib/held.py',
			base: 'workspace',
			resolved: 'lib/held.py',
			resolveError: null
		});
		// Refused, and the reply names the target still in force - so the field reverts to
		// what the server really holds rather than to whatever it last remembered.
		const refused = await call('src/app.ts');
		expect(refused.status).toBe(400);
		expect(await refused.json()).toMatchObject({
			ok: false,
			target: 'lib/held.py',
			message: expect.stringMatching(/not a \.py file/)
		});
		expect(nbmod.getExportTarget(nb)).toBe('lib/held.py');
	});
});

/**
 * A write endpoint must report the value it PERSISTED, never the one it was handed.
 * `setExportTarget` normalizes an absolute in-workspace path to its relative form,
 * and the initiating tab echo-suppresses its own `notebook:export-target`, so a
 * route answering with the raw request left the input showing an absolute path the
 * document does not hold - with nothing to correct it short of a reload.
 */
describe('the stored value is what is reported back', () => {
	it('the UI route answers with the normalized target, not the request', async () => {
		const { POST } = await import('../../src/routes/api/notebooks/export-py/+server.js');
		svc.useNotebook('sessStored', 'stored-target.ipynb');
		const nb = svc.targetFor('sessStored');
		await svc.addCells([{ cell_type: 'code', source: 'x = 1' }], null, { nb, routeImports: false });

		const res = await (POST as unknown as (e: { request: Request }) => Promise<Response>)({
			request: new Request('http://x/api/notebooks/export-py', {
				method: 'POST',
				body: JSON.stringify({
					op: 'set-target',
					target: join(WS, 'lib', 'stored.py'),
					path: 'stored-target.ipynb'
				})
			})
		});
		expect(await res.json()).toEqual({
			ok: true,
			target: 'lib/stored.py',
			base: 'workspace',
			resolved: 'lib/stored.py',
			resolveError: null
		});
		expect(nbmod.getExportTarget(nb)).toBe('lib/stored.py');
	});

	it('and clearing reports the null it stored', async () => {
		const { POST } = await import('../../src/routes/api/notebooks/export-py/+server.js');
		const res = await (POST as unknown as (e: { request: Request }) => Promise<Response>)({
			request: new Request('http://x/api/notebooks/export-py', {
				method: 'POST',
				body: JSON.stringify({ op: 'set-target', target: '  ', path: 'stored-target.ipynb' })
			})
		});
		expect(await res.json()).toEqual({
			ok: true,
			target: null,
			base: 'workspace',
			resolved: null,
			resolveError: null
		});
		expect(nbmod.getExportTarget(svc.targetFor('sessStored'))).toBeNull();
	});

	it('the MCP result reports it too (it reads the effective target back)', async () => {
		svc.useNotebook('sessStoredMcp', 'stored-target-mcp.ipynb');
		const nb = svc.targetFor('sessStoredMcp');
		await svc.addCells([{ cell_type: 'code', source: 'y = 1' }], null, { nb, routeImports: false });
		expect(svc.setExportTarget(join(WS, 'lib', 'mcp-stored.py'), nb)).toEqual({
			export_target: 'lib/mcp-stored.py'
		});
		expect(nbmod.getExportTarget(nb)).toBe('lib/mcp-stored.py');
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
		// The revert target comes from the SERVER's own reply, never from a remembered
		// baseline (see the no-shadow-state block below).
		expect(fn).toMatch(/exportTarget = held/);
		expect(fn).toMatch(/onNotice\?\./);
	});

	it('guards the revert against the field moving on', () => {
		// A refusal for a value the field no longer holds must not yank the caret back.
		expect(fn).toMatch(/exportTarget !== next/);
	});

	it('treats an unreachable server as NOT committed, and a superseded write as neither', () => {
		const commitFn = src.slice(
			src.indexOf('async function commitExportTarget'),
			src.indexOf('async function setNumberingLevel')
		);
		// The regression: `if (!res) return true` reported a request that never landed a
		// verdict as a success, so the field kept a path the server may never have stored
		// while `confirmedExportTarget` still held the old one - and the export then ran
		// on to report a success against THAT old target.
		expect(commitFn).not.toMatch(/if \(!res\) return true/);
		expect(commitFn).toMatch(/return 'unreachable';/);
		expect(commitFn).toMatch(/could not be reached/);
		// Five outcomes, not a boolean.
		expect(commitFn).toMatch(/Promise<TargetCommit>/);
		expect(commitFn).toMatch(/return 'committed';/);
		expect(commitFn).toMatch(/return 'refused';/);
		// The field moving on is neither a refusal nor a failure - touch nothing - and it
		// is decided BEFORE anything is written back, the success path included.
		expect(commitFn.indexOf("return 'superseded';")).toBeLessThan(commitFn.indexOf('exportTarget = held'));
	});

	it('adopts the value the SERVER stored, not the one it sent', () => {
		const commitFn = src.slice(
			src.indexOf('async function commitExportTarget'),
			src.indexOf('async function setNumberingLevel')
		);
		// The server normalizes an absolute in-workspace path, and this tab
		// echo-suppresses its own `notebook:export-target`, so keeping the SENT value
		// left the input showing a path the document does not hold.
		const ok = commitFn.slice(commitFn.indexOf('if (res?.ok)'), commitFn.indexOf("return 'committed';"));
		expect(ok).toMatch(/exportTarget = held/);
		expect(ok).not.toMatch(/exportTarget = next/);
	});

	it('commits ONCE PER EDIT, and puts the field back to what the SERVER reports', () => {
		// The input's DOM value is state-driven, so writing per keystroke made every
		// character of a refused path 400, revert the field and move the caret - and the
		// debounce + generation guard + pending mirror stacked to contain that were
		// themselves a race. One commit per `change` leaves none of that machinery.
		expect(fn).not.toMatch(/setTimeout/);
		expect(fn).not.toMatch(/exportTargetSeq/);
		expect(fn).not.toMatch(/pendingExportTarget/);
		// No pending-value mirror HERE: the field itself is the pending value, and the
		// only thing that reads it back is the unload flush in `Notebook.svelte` below.
		expect(src).not.toMatch(/flushExportTarget/);
		expect(fn).not.toMatch(/const previous = exportTarget/);

		const nbSrc = readFileSync(join(process.cwd(), 'src/lib/Notebook.svelte'), 'utf8');
		expect(nbSrc).toMatch(/onchange=\{onExportTargetCommit\}/);
		expect(nbSrc).not.toMatch(/oninput=\{onExportTarget/);
	});

	it('flushes a target typed but never committed on pagehide, and NEVER on teardown', () => {
		// `change` is not reliably delivered before unload, so a value typed and then
		// reloaded (or tab-closed) on was simply lost - the same sub-commit window
		// `Cell.svelte` flushes on `pagehide`, and the same idiom.
		const nbSrc = readFileSync(join(process.cwd(), 'src/lib/Notebook.svelte'), 'utf8');
		const flush = nbSrc.slice(
			nbSrc.indexOf('function flushExportTarget'),
			nbSrc.indexOf('</script>')
		);
		expect(flush, 'flushExportTarget should exist in Notebook.svelte').not.toBe('');
		// It reads the LIVE field, and writes only when it diverges from the model - so
		// the per-edit commit model is unchanged and a committed value writes nothing.
		expect(flush).toMatch(/el\.value === \(exportTarget \?\? ''\)/);
		expect(flush).toMatch(/addEventListener\('pagehide'/);
		expect(flush).toMatch(/removeEventListener\('pagehide'/);
		// But NOT on teardown, unlike Cell.svelte's: `LiveNotebook` renders this component
		// behind an `{:else if fetching}` gate, so EVERY `load()` refetch destroys it - an
		// SSE reconnect, a seq gap from an agent's edit, `notebook:restored`, a refused
		// bulk op. A teardown commit therefore fired mid-edit from a background event the
		// user never caused, refusing a half-typed path (or silently persisting one that
		// happened to parse). Losing an uncommitted value to a refetch is the better half.
		const effect = flush.slice(flush.indexOf('$effect('));
		const teardown = effect.slice(effect.indexOf('return () =>'));
		expect(teardown).not.toMatch(/flushExportTarget\(/);
		// LiveNotebook really does re-mount it on every refetch, which is what makes the
		// teardown an unreliable proxy for an unmount.
		expect(src).toMatch(/\{:else if fetching\}/);
		expect(src.slice(src.indexOf('async function load'))).toMatch(/fetching = true;/);
		expect(nbSrc).toMatch(/bind:this=\{exportTargetEl\}/);

		// And the unload path must SURVIVE the page going away: the write goes out with
		// `keepalive`, like Cell.svelte's unload edit flush (this body is one path, far
		// under the ~64KB cap that rules keepalive out for ordinary saves).
		expect(flush).toMatch(/flushExportTarget\(true\)/);
		const commitFn = src.slice(
			src.indexOf('async function commitExportTarget'),
			src.indexOf('async function setNumberingLevel')
		);
		expect(commitFn).toMatch(/keepalive/);
	});

	it('awaits an in-flight target write before the export button posts, and aborts on a refused one', () => {
		// Pressing the button blurs the input, which commits the edit - but that POST is
		// still on the wire, so without the await a freshly typed target exported against
		// the previous one while the field visibly showed the new.
		const exportFn = src.slice(src.indexOf('async function exportPy'), src.indexOf('UNDO_LIMIT'));
		expect(exportFn).toMatch(/const pending = exportTargetCommit;/);
		expect(exportFn).toMatch(/await pending\.catch/);
		// A commit that did NOT land aborts: that path was never (verifiably) stored, so
		// exporting on would run against the previous/absent target and its outcome would
		// REPLACE that commit's own reason on the single nonce-keyed notice channel.
		expect(exportFn).toMatch(/if \(outcome === 'refused' \|\| outcome === 'unreachable'\) return null;/);
		// A merely SUPERSEDED commit is not an abort - nothing was refused, so aborting
		// made the button a dead control that issued no request and said nothing.
		expect(exportFn).not.toMatch(/'superseded'/);
		// The promise is consumed, so one refusal cannot mute every later export.
		expect(exportFn).toMatch(/exportTargetCommit = null;/);
		// And it DROPS ITSELF once it settles, so the abort belongs to the
		// blur-then-click interaction and nothing else: a settled refusal left here
		// aborted the NEXT export - one that would have run fine - with no message at
		// all, since that export never issued a request to report on.
		expect(fn).toMatch(/commit\.then\(drop, drop\)/);
		expect(fn).toMatch(/if \(exportTargetCommit === commit\) exportTargetCommit = null;/);
		// The commit reports refusal rather than swallowing it.
		const commitFn = src.slice(src.indexOf('async function commitExportTarget'), src.indexOf('async function setNumberingLevel'));
		expect(commitFn).toMatch(/Promise<TargetCommit>/);
		expect(commitFn).toMatch(/return 'refused';/);
		// And the manual export reports the SERVER's reason (the clobber / non-.py
		// refusals exist for their message; "Export failed." names no cause).
		expect(exportFn).toMatch(/onNotice\?\./);

		// The navbar entry point must not REPLACE that reason with a generic string -
		// one nonce-keyed notice channel, so the last write wins.
		const shell = readFileSync(join(process.cwd(), 'src/routes/+page.svelte'), 'utf8');
		const shellStart = shell.indexOf('async function exportPy');
		const shellExport = shell.slice(shellStart, shell.indexOf('function toggleHideAllCode', shellStart));
		expect(shellExport).toMatch(/if \(!r\) return;/);
		expect(shellExport).not.toMatch(/Export to \.py failed/);
		// Nor ERASE it before it has been read: opening the app menu blurs the target
		// input, so its `change` commit has usually already SETTLED and posted its
		// refusal by the time the item is clicked - a pre-emptive clear then wiped a
		// message this action had not yet replaced (the in-flight case survived it only
		// by accident of ordering). Every branch below ends in exactly one message.
		expect(shellExport).not.toMatch(/clearNotice\(\)/);
	});
});

/**
 * A refused PATH and a failed WRITE are different facts with different remedies,
 * and the doc layer validates BEFORE it mutates - so the only throw left after the
 * mutation is the notebook write. Reporting that as an invalid path sends the
 * caller to fix a path that was never wrong, over a change the live document DID
 * take. They are told apart by TYPE (`InvalidExportTargetError`), never by matching
 * the message text.
 */
describe('a refused path and a failed write are told apart', () => {
	it('a path refusal is `invalid`, and the document is left untouched', async () => {
		svc.useNotebook('sessRefuse', 'refuse-target.ipynb');
		const nb = svc.targetFor('sessRefuse');
		await svc.addCells([{ cell_type: 'code', source: 'z = 1' }], null, { nb, routeImports: false });
		svc.setExportTarget('lib/kept.py', nb);

		const escaping = svc.setExportTarget('../outside.py', nb);
		expect(escaping).toMatchObject({ ok: false, invalid: expect.stringMatching(/escapes workspace/) });
		expect(escaping).not.toHaveProperty('writeFailed');

		const notPy = svc.setExportTarget('src/app.ts', nb);
		expect(notPy).toMatchObject({ ok: false, invalid: expect.stringMatching(/not a \.py file/) });
		expect(notPy).not.toHaveProperty('writeFailed');

		// Validation runs before the mutation, so a refusal changes nothing.
		expect(nbmod.getExportTarget(nb)).toBe('lib/kept.py');
	});

	it('a failed notebook write is `writeFailed`, over a target the document HOLDS', async () => {
		svc.useNotebook('sessDisk', 'disk-target.ipynb');
		const nb = svc.targetFor('sessDisk');
		await svc.addCells([{ cell_type: 'code', source: 'w = 1' }], null, { nb, routeImports: false });

		disk.failFor = 'disk-target.ipynb';
		try {
			const r = svc.setExportTarget('lib/disk.py', nb);
			// NOT an `invalid`: the MCP layer renders that as "the export target must be a
			// workspace-relative .py path", a remedy for a problem that did not occur.
			expect(r).not.toHaveProperty('invalid');
			expect(r).toMatchObject({ ok: false, writeFailed: expect.stringMatching(/ENOSPC/) });
		} finally {
			disk.failFor = null;
		}
		// The path was accepted: the live document carries it and writes it with the
		// notebook's next successful save.
		expect(nbmod.getExportTarget(nb)).toBe('lib/disk.py');
	});

	it('the MCP handler renders the two differently (source guard)', () => {
		const src = readFileSync(new URL('../../src/lib/server/mcp/server.ts', import.meta.url), 'utf8');
		const handler = src.slice(
			src.indexOf("registerTool('set_export_target'"),
			src.indexOf('// --- execute ---')
		);
		expect(handler).toMatch(/'invalid' in r/);
		expect(handler).toMatch(/'writeFailed' in r/);
		const writeBranch = handler.slice(handler.indexOf("'writeFailed' in r"));
		expect(writeBranch.split('\n')[0]).not.toMatch(/must be a workspace-relative \.py path/);
		expect(writeBranch).toMatch(/could not be saved/);
	});

	it('the UI route answers a failed write apart from a refusal, and the client keeps the value', async () => {
		const { POST } = await import('../../src/routes/api/notebooks/export-py/+server.js');
		const post = POST as unknown as (e: { request: Request }) => Promise<Response>;
		svc.useNotebook('sessDiskRoute', 'disk-route.ipynb');
		const nb = svc.targetFor('sessDiskRoute');
		await svc.addCells([{ cell_type: 'code', source: 'v = 1' }], null, { nb, routeImports: false });

		const call = (target: string) =>
			post({
				request: new Request('http://x/api/notebooks/export-py', {
					method: 'POST',
					body: JSON.stringify({ op: 'set-target', target, path: 'disk-route.ipynb' })
				})
			});

		// A path REFUSAL keeps today's 400 (the client reverts and says to fix the path).
		expect((await call('src/app.ts')).status).toBe(400);

		disk.failFor = 'disk-route.ipynb';
		let res: Response;
		try {
			res = await call('lib/disk-route.py');
		} finally {
			disk.failFor = null;
		}
		// NOT a 400: the setter validates before it mutates, so this is the notebook write
		// failing over a path that was never wrong - reported as 400 the tab reverted the
		// field and told the user the target was not set, over a change that DID take.
		expect(res.status).toBe(500);
		expect(await res.json()).toMatchObject({
			ok: false,
			writeFailed: expect.stringMatching(/ENOSPC/),
			// The path was accepted, so the target it reports as held is the NEW one - the
			// field keeps it and cannot diverge from the document.
			target: 'lib/disk-route.py'
		});
		expect(nbmod.getExportTarget(nb)).toBe('lib/disk-route.py');

		// The client half: a failed write keeps the field (the document holds it) and only
		// says so, while the 400 above still reverts. vitest runs without the SvelteKit
		// plugin, so `LiveNotebook.svelte` cannot be mounted - pinned against the source.
		const live = readFileSync(join(process.cwd(), 'src/lib/LiveNotebook.svelte'), 'utf8');
		const commitFn = live.slice(
			live.indexOf('async function commitExportTarget'),
			live.indexOf('async function setNumberingLevel')
		);
		const writeBranch = commitFn.slice(commitFn.indexOf('if (failure)'), commitFn.indexOf("return 'writeFailed';"));
		expect(writeBranch, 'a failed write should have its own branch').not.toBe('');
		expect(writeBranch).toMatch(/accepted but not saved/);
		// Decided by the FLAG the route sets, never by the status code: any OTHER 5xx (a
		// proxy 502/503, an HTML error page) landed no verdict at all, so reporting it as
		// accepted left the field claiming a value the server may never have received -
		// the false acceptance the `unreachable` branch exists to prevent, reached through
		// the other door.
		expect(commitFn).not.toMatch(/status >= 500/);
		expect(commitFn).toMatch(/body\?\.writeFailed/);
	});

	it('a failed BASE write answers the same way, and carries no message to fall back on', async () => {
		// The re-expression is the OTHER write this route serves, and it mutates before
		// it persists too - so the same split applies. What makes reading `message`
		// alone actively wrong here is that this reply has none: a client that decides
		// by the message denies a change the document really took and blames a server
		// that answered.
		const { POST } = await import('../../src/routes/api/notebooks/export-py/+server.js');
		const post = POST as unknown as (e: { request: Request }) => Promise<Response>;
		svc.useNotebook('sessDiskBase', 'sub/disk-base.ipynb');
		const nb = svc.targetFor('sessDiskBase');
		await svc.addCells([{ cell_type: 'code', source: 'v = 1' }], null, { nb, routeImports: false });

		const call = (payload: Record<string, unknown>) =>
			post({
				request: new Request('http://x/api/notebooks/export-py', {
					method: 'POST',
					body: JSON.stringify({ path: 'sub/disk-base.ipynb', ...payload })
				})
			});

		expect((await call({ op: 'set-target', target: 'lib/disk-base.py' })).status).toBe(200);

		disk.failFor = 'disk-base.ipynb';
		let res: Response;
		try {
			res = await call({ op: 'set-base', base: 'notebook' });
		} finally {
			disk.failFor = null;
		}
		expect(res.status).toBe(500);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toMatchObject({
			ok: false,
			writeFailed: expect.stringMatching(/ENOSPC/),
			// The document HOLDS the re-expressed target under the new base - the select
			// and the input keep it, and the next successful save writes it.
			base: 'notebook',
			target: '../lib/disk-base.py'
		});
		expect(body).not.toHaveProperty('message');
		expect(nbmod.getExportTargetState(nb)).toMatchObject({
			base: 'notebook',
			target: '../lib/disk-base.py'
		});

		// The client half of THIS rule, pinned the way its sibling above is: e2e is
		// absent from CI and from the no-mistakes gate, so a regression in the base
		// write's wording would otherwise merge green.
		const live = readFileSync(join(process.cwd(), 'src/lib/LiveNotebook.svelte'), 'utf8');
		const baseFn = live.slice(
			live.indexOf('async function setExportBaseValue'),
			live.indexOf('async function exportPy')
		);
		expect(baseFn, 'setExportBaseValue should still exist').not.toBe('');
		// Decided by the FLAG, never the status code, and worded as an acceptance...
		expect(baseFn).toMatch(/body\?\.writeFailed/);
		expect(baseFn).toMatch(/accepted but not saved/);
		expect(baseFn).not.toMatch(/status >= 500/);
		// ...while the unreachable wording survives for a reply that landed no verdict.
		expect(baseFn).toMatch(/could not be reached/);
	});

	it('a malformed field is a clean refusal, never an accepted-but-unsaved write', async () => {
		// `body` is untyped JSON and both fields reach a `.trim()` in the setter, so a
		// non-string used to throw a bare TypeError - not the typed refusal - and the
		// route answered 500 `writeFailed` over a document nothing had mutated. Since
		// `exportPy` deliberately does not abort on `writeFailed`, a later export then
		// ran against the OLD target and reported success.
		const { POST } = await import('../../src/routes/api/notebooks/export-py/+server.js');
		const post = POST as unknown as (e: { request: Request }) => Promise<Response>;
		svc.useNotebook('sessBadField', 'bad-field.ipynb');
		const nb = svc.targetFor('sessBadField');
		await svc.addCells([{ cell_type: 'code', source: 'v = 1' }], null, { nb, routeImports: false });

		const call = (payload: Record<string, unknown>) =>
			post({
				request: new Request('http://x/api/notebooks/export-py', {
					method: 'POST',
					body: JSON.stringify({ path: 'bad-field.ipynb', ...payload })
				})
			});

		expect((await call({ op: 'set-target', target: 'lib/keep.py' })).status).toBe(200);

		for (const payload of [
			{ op: 'set-target', target: 'lib/other.py', base: 5 },
			{ op: 'set-target', target: 'lib/other.py', base: true },
			{ op: 'set-target', target: 7 },
			{ op: 'set-target', target: ['lib/other.py'] },
			{ op: 'set-base', base: { git: true } }
		]) {
			const label = JSON.stringify(payload);
			const res = await call(payload);
			expect(res.status, label).toBe(400);
			const refused = (await res.json()) as Record<string, unknown>;
			expect(refused, label).not.toHaveProperty('writeFailed');
			expect(refused.message, label).toEqual(expect.any(String));
		}

		// Nothing was mutated by any of them: the refusal describes the document the
		// notebook still holds, which is what the tab's field and select go back to.
		expect(nbmod.getExportTargetState(nb)).toMatchObject({
			target: 'lib/keep.py',
			base: 'workspace'
		});
	});

	it('an OMITTED field keeps its meaning, so the guard refuses only a malformed one', async () => {
		// The other half of the boundary rule, and the reason a non-string may not be
		// coerced: absence is MEANINGFUL on both fields - `base` inherits the stored
		// one, `target` clears - so coercing a malformed value to null would silently
		// perform one of those instead of refusing.
		const { POST } = await import('../../src/routes/api/notebooks/export-py/+server.js');
		const post = POST as unknown as (e: { request: Request }) => Promise<Response>;
		svc.useNotebook('sessOmit', 'sub/omit-field.ipynb');
		const nb = svc.targetFor('sessOmit');
		await svc.addCells([{ cell_type: 'code', source: 'v = 1' }], null, { nb, routeImports: false });

		const call = (payload: Record<string, unknown>) =>
			post({
				request: new Request('http://x/api/notebooks/export-py', {
					method: 'POST',
					body: JSON.stringify({ path: 'sub/omit-field.ipynb', ...payload })
				})
			});

		expect((await call({ op: 'set-target', target: 'helpers.py', base: 'notebook' })).status).toBe(200);
		// Omitted base: the stored `notebook` base is INHERITED, not reset to workspace.
		expect((await call({ op: 'set-target', target: 'other.py' })).status).toBe(200);
		expect(nbmod.getExportTargetState(nb)).toMatchObject({
			target: 'other.py',
			base: 'notebook'
		});
		// Omitted target: still a CLEAR, which deletes both keys under any base.
		expect((await call({ op: 'set-target' })).status).toBe(200);
		expect(nbmod.getExportTargetState(nb)).toMatchObject({ target: null, base: 'workspace' });
	});
});

/**
 * The tab keeps NO copy of the server's target. Two of them (the last confirmed
 * value and the last sent one) each needed a rule to stay agreeing, and every rule
 * had a hole: a failed write left them describing different paths, so retyping the
 * previous one wrote nothing while the server kept the newer; and a background
 * refetch resolving inside a commit window seeded them staler than the write in
 * flight. Every reply states what the document holds, so there is nothing to
 * reconcile - pinned against the source, since vitest cannot mount the component.
 */
describe('the client mirrors no server state (source guard)', () => {
	const live = readFileSync(join(process.cwd(), 'src/lib/LiveNotebook.svelte'), 'utf8');

	it('keeps neither a confirmed nor a sent baseline', () => {
		expect(live).not.toMatch(/confirmedExportTarget/);
		expect(live).not.toMatch(/sentExportTarget/);
	});

	it('has no skip-check, so a value can always be committed again', () => {
		// The `next === sentExportTarget` early return made a retry of the same path a
		// no-op - which, after a failed write, was the only way back to a saved state. A
		// redundant identical POST is the accepted price: the setter is idempotent.
		const fn = live.slice(
			live.indexOf('function setExportTargetValue'),
			live.indexOf('async function commitExportTarget')
		);
		expect(fn).not.toMatch(/if \(next === /);
		expect(fn).toMatch(/commitExportTarget\(target, next, keepalive\)/);
	});

	it('load() and the SSE event just show what the server returned', () => {
		// Nothing for a refetch to seed staler than an in-flight commit.
		const load = live.slice(live.indexOf('async function load'), live.indexOf('loadFolds();'));
		expect(load).toMatch(/exportTarget = body\.notebook\.exportTarget \?\? null;/);
		expect(load.split('exportTarget')).toHaveLength(3); // exactly the one assignment
		const ev = live.slice(live.indexOf("ev.type === 'notebook:export-target'"));
		expect(ev.slice(0, ev.indexOf('} else if'))).toMatch(/^[^]*exportTarget = ev\.target;\s*$/);
	});

	it('reads the reply ONCE and takes the held target from it', () => {
		const commitFn = live.slice(
			live.indexOf('async function commitExportTarget'),
			live.indexOf('async function setNumberingLevel')
		);
		expect(commitFn.match(/\.json\(\)/g) ?? []).toHaveLength(1);
		expect(commitFn).toMatch(/'target' in body/);
		// A reply we cannot read as either outcome must not claim the target took.
		const unknown = commitFn.slice(commitFn.lastIndexOf('onNotice?.('));
		expect(unknown).toMatch(/not saved/);
		expect(unknown).not.toMatch(/accepted/);
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
