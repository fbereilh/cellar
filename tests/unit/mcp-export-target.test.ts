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
		expect(line).toMatch(/#\|default_exp` directive written in a cell is NOT/);
		expect(line).toMatch(/while a cell stays marked/);
		expect(line).toMatch(/module\.regenerated:false/);
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
		// Four outcomes, not a boolean: the baseline advances on exactly one of them.
		expect(commitFn).toMatch(/Promise<TargetCommit>/);
		expect(commitFn).toMatch(/return 'committed';/);
		expect(commitFn).toMatch(/return 'refused';/);
		// The field moving on is neither a refusal nor a failure - touch nothing - and it
		// is decided BEFORE either revert.
		expect(commitFn.indexOf("return 'superseded';")).toBeLessThan(
			commitFn.indexOf('exportTarget = confirmedExportTarget')
		);
	});

	it('commits ONCE PER EDIT, and reverts to the SERVER-confirmed value', () => {
		// The input's DOM value is state-driven, so writing per keystroke made every
		// character of a refused path 400, revert the field and move the caret - and the
		// debounce + generation guard + pending mirror stacked to contain that were
		// themselves a race. One commit per `change` leaves none of that machinery.
		expect(fn).not.toMatch(/setTimeout/);
		expect(fn).not.toMatch(/exportTargetSeq/);
		expect(fn).not.toMatch(/pendingExportTarget/);
		expect(src).not.toMatch(/flushExportTarget/);
		expect(fn).not.toMatch(/const previous = exportTarget/);
		// The baseline is only ever written where the server states it.
		const writes = src.match(/confirmedExportTarget = /g) ?? [];
		expect(writes.length).toBe(3); // load, the SSE event, a confirmed write

		const nbSrc = readFileSync(join(process.cwd(), 'src/lib/Notebook.svelte'), 'utf8');
		expect(nbSrc).toMatch(/onchange=\{onExportTargetCommit\}/);
		expect(nbSrc).not.toMatch(/oninput=\{onExportTarget/);
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
