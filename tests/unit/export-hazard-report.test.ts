/**
 * The export's compile hazard, REPORTED on every surface that reports an export.
 *
 * The defect this pins: a marked cell holding `from __future__ import
 * annotations; x = 1` produces a module Python refuses to compile, and Cellar
 * said `written: true` and nothing else. The module is still written (see
 * `exportNotebookToPy`'s header for why writing beats refusing on the
 * paths that regenerate as a consequence of another call), so the whole fix lives
 * in the report - which means every surface has to carry it, and a surface that quietly did not would put the
 * silence straight back.
 *
 * `export-py-future.test.ts` owns the DETECTION (with `compile()`, and its
 * measured boundary). This file owns the WIRING: the notebook view the export bar
 * renders, the live push that lets the bar warn BEFORE the user exports, the
 * manual export result, and the agent surface - plus SOURCE-SHAPE guards on the
 * two Svelte halves, which prove only that the markup has the expected shape (see
 * that block's own header; their behaviour lives in
 * `tests/e2e/export-target-section.spec.ts`).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../src/lib/server/dataflow', () => ({
	getNotebookStaleness: async () => ({ sid: null, cells: {} }),
	analyzeDataflow: async () => ({})
}));

const JOINED = 'from __future__ import annotations; x = 1';

let WS: string;
let nbmod: typeof import('../../src/lib/server/notebook');
let events: typeof import('../../src/lib/server/events');
let svc: typeof import('../../src/lib/server/mcp/service');

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-export-hazard-'));
	process.env.CELLAR_WORKSPACE = WS;
	nbmod = await import('../../src/lib/server/notebook');
	events = await import('../../src/lib/server/events');
	svc = await import('../../src/lib/server/mcp/service');
});

const abs = (rel: string) => nbmod.resolveNotebookPath(rel);

/**
 * A notebook with one code cell holding `source`, a target, and (unless told
 * otherwise) that cell marked for export. Returns its absolute path.
 */
async function notebookWith(name: string, source: string, opts: { target?: string | null; mark?: boolean } = {}) {
	const target = abs(name);
	svc.useNotebook(`sess-${name}`, name);
	const { ids } = await svc.addCells([{ cell_type: 'code', source }], null, { nb: target, routeImports: false });
	// `addCells` reports agent HANDLES (id prefixes); the document ops take full ids.
	const cell = svc.resolveRef(target, ids[0]);
	if (opts.target !== null) nbmod.setExportTarget(opts.target ?? `out/${name.replace('.ipynb', '')}.py`, target);
	if (opts.mark !== false) nbmod.setCellExports([cell], true, target);
	return { target, cell };
}

describe('the notebook view carries the hazard (what the export bar renders)', () => {
	it('reports it for a marked cell that makes the module uncompilable', async () => {
		const { target } = await notebookWith('view.ipynb', JOINED);
		const view = nbmod.getNotebook(target);
		expect(view.exportHazards).toHaveLength(1);
		expect(view.exportHazards[0].kind).toBe('future-import-joined');
		expect(view.exportHazards[0].message).toContain('line of its own');
	});

	it('reports NOTHING for an ordinary marked cell', async () => {
		const { target } = await notebookWith('view-clean.ipynb', 'def f():\n    return 1');
		expect(nbmod.getNotebook(target).exportHazards).toEqual([]);
	});

	it('reports NOTHING while the cell is not marked - the module does not hold it', async () => {
		const { target } = await notebookWith('view-unmarked.ipynb', JOINED, { mark: false });
		expect(nbmod.getNotebook(target).exportHazards).toEqual([]);
	});

	it('reports NOTHING with no target at all - there is no module to be about', async () => {
		const { target } = await notebookWith('view-untargeted.ipynb', JOINED, { target: null });
		expect(nbmod.getNotebook(target).exportHazards).toEqual([]);
	});
});

describe('the live push - a hazard or a moved target reaches the bar without a reload', () => {
	/** Collect every `notebook:export-derived` event published while `fn` runs. */
	async function captured(fn: () => Promise<void> | void) {
		const seen: Array<{ nb: string; hazards: unknown[]; resolved: string | null; resolveError: string | null }> = [];
		const off = events.subscribe((e: Record<string, unknown>) => {
			if (e.type === 'notebook:export-derived') seen.push(e as never);
		});
		try {
			await fn();
		} finally {
			off();
		}
		return seen;
	}

	it('publishes when a save first makes the module uncompilable, and clears it when fixed', async () => {
		const { target, cell } = await notebookWith('push.ipynb', 'X = 1');
		// Editing the marked cell into the hazard. A hazard is a fact about the MARKED
		// CELLS, so a save creates one even though a save no longer exports - and the
		// bar must learn about it BEFORE the user presses the export button.
		const appeared = await captured(() => {
			nbmod.setSource(cell, JOINED, target);
		});
		expect(appeared).toHaveLength(1);
		expect(appeared[0].nb).toBe(target);
		expect(appeared[0].hazards).toHaveLength(1);

		// ...and it goes away again on the save that fixes it. A warning that only
		// ever appears is a warning nobody can clear.
		const cleared = await captured(() => {
			nbmod.setSource(cell, 'from __future__ import annotations\nx = 1', target);
		});
		expect(cleared).toHaveLength(1);
		expect(cleared[0].hazards).toEqual([]);
	});

	it('publishes NOTHING when the hazards did not change', async () => {
		// Every keystroke autosaves, so an unconditional publish would fan a redundant
		// event to every tab on a notebook that exports nothing at all.
		const { target, cell } = await notebookWith('push-quiet.ipynb', 'X = 1');
		const quiet = await captured(() => {
			nbmod.setSource(cell, 'X = 2', target);
			nbmod.setSource(cell, 'X = 3', target);
		});
		expect(quiet).toEqual([]);

		// Nor while the hazard STAYS - the bar already says it.
		nbmod.setSource(cell, JOINED, target);
		const stable = await captured(() => {
			nbmod.setSource(cell, `${JOINED}\ny = 2`, target);
		});
		expect(stable).toEqual([]);
	});

	it('clears a hazard the notebook arrived from disk with, without a reload', async () => {
		// The regression: `loadDoc` never persists, so a notebook OPENED on a hazard has
		// broadcast nothing yet. Its browser seed comes from `getNotebook`, and the
		// user's FIX is then the first persist since load. Compared with the unset key
		// coerced to `''`, that save looked like a no-op and published nothing, so the
		// bar went on saying the module will not import after it had been repaired.
		// The existing case above cannot see this: it CREATES the hazard first, so the
		// clearing save always follows a publish that recorded the key.
		const name = 'reopened.ipynb';
		writeFileSync(
			join(WS, name),
			JSON.stringify({
				cells: [
					{
						cell_type: 'code',
						source: [JOINED],
						metadata: { cellar: { export: true } },
						outputs: [],
						execution_count: null,
						id: 'joined-cell'
					}
				],
				metadata: { cellar: { export_target: 'out/reopened.py' } },
				nbformat: 4,
				nbformat_minor: 5
			})
		);
		const target = abs(name);

		// The seed the export bar renders on load - no save has happened yet.
		expect(nbmod.getNotebook(target).exportHazards).toHaveLength(1);

		const cleared = await captured(() => {
			nbmod.setSource('joined-cell', 'from __future__ import annotations\nx = 1', target);
		});
		expect(cleared).toHaveLength(1);
		expect(cleared[0].nb).toBe(target);
		expect(cleared[0].hazards).toEqual([]);
		expect(nbmod.getNotebook(target).exportHazards).toEqual([]);
	});

	it('clears a misplaced-`#|default_exp` error on the SOURCE EDIT that fixes it', async () => {
		// The regression: `exportResolved`/`exportResolveError` were written only by
		// `load()` and by `notebook:export-target`, which only the SETTERS emit - so a
		// user who followed the message and moved the line to the top of its cell kept
		// reading it until a reload, i.e. the fix appeared to have failed. The remedy
		// the message names is a source edit, so the per-persist push has to carry the
		// resolution too.
		const name = 'misplaced.ipynb';
		writeFileSync(
			join(WS, name),
			JSON.stringify({
				cells: [
					{ cell_type: 'code', source: ['x = 1\n', '#| default_exp lib.late'], metadata: {}, outputs: [], execution_count: null, id: 'dir-cell' },
					{ cell_type: 'code', source: ['Y = 2'], metadata: { cellar: { export: true } }, outputs: [], execution_count: null, id: 'marked-cell' }
				],
				metadata: {},
				nbformat: 4,
				nbformat_minor: 5
			})
		);
		const target = abs(name);

		// The seed the export bar renders on load: no target, and the reason why.
		const seed = nbmod.getNotebook(target);
		expect(seed.exportResolved).toBeNull();
		expect(seed.exportResolveError).toContain('LEADING directive block');

		// Now do exactly what the message prescribes.
		const fixed = await captured(() => {
			nbmod.setSource('dir-cell', '#| default_exp lib.late\nx = 1', target);
		});
		expect(fixed).toHaveLength(1);
		expect(fixed[0].nb).toBe(target);
		expect(fixed[0].resolveError).toBeNull();
		expect(fixed[0].resolved).toBe('lib/late.py');
		// ...and the read agrees, so a later reload cannot contradict the push.
		expect(nbmod.getNotebook(target).exportResolveError).toBeNull();

		// It works in the other direction too - breaking it again re-announces.
		const broken = await captured(() => {
			nbmod.setSource('dir-cell', 'x = 1\n#| default_exp lib.late', target);
		});
		expect(broken).toHaveLength(1);
		expect(broken[0].resolved).toBeNull();
		expect(broken[0].resolveError).toContain('LEADING directive block');
	});

	it('publishes the resolution alone, never the STORED target the setter owns', async () => {
		// The stored `export_target`/`export_base` move only through the setters, whose
		// own `notebook:export-target` event carries an `originId`. This push is
		// un-suppressed and fires INSIDE that setter's persist, so carrying them here
		// would clobber a field the user may have typed on since.
		const { target, cell } = await notebookWith('push-fields.ipynb', 'X = 1');
		const seen = await captured(() => {
			nbmod.setSource(cell, JOINED, target);
		});
		expect(seen).toHaveLength(1);
		expect(seen[0]).not.toHaveProperty('target');
		expect(seen[0]).not.toHaveProperty('base');
	});

	it('carries no originId, so the tab that typed renders it too', async () => {
		// DERIVED state, not an echo of one tab's action: an `originId` here would be
		// echo-suppressed by exactly the tab that just created the hazard.
		const { target, cell } = await notebookWith('push-origin.ipynb', 'X = 1');
		const seen: Array<Record<string, unknown>> = [];
		const off = events.subscribe((e: Record<string, unknown>) => {
			if (e.type === 'notebook:export-derived') seen.push(e);
		});
		nbmod.setSource(cell, JOINED, target, 'tab-1');
		off();
		expect(seen).toHaveLength(1);
		expect(seen[0].originId ?? null).toBeNull();
	});
});

describe('the manual export result', () => {
	it('reports the hazard beside a module it really wrote', async () => {
		const { target } = await notebookWith('manual.ipynb', JOINED);
		const res = nbmod.exportPy(target);
		expect(res.written || res.reason === 'unchanged').toBe(true);
		expect(res.hazards).toHaveLength(1);
		// The module is on disk, and it is the broken one.
		expect(readFileSync(join(WS, res.target!), 'utf8')).toContain(JOINED);
	});

	it('reports none for a healthy export', async () => {
		const { target } = await notebookWith('manual-clean.ipynb', 'def f():\n    return 1');
		expect(nbmod.exportPy(target).hazards).toEqual([]);
	});
});

describe('the agent surface', () => {
	it('set_cell_export reports a module it wrote that will not import', async () => {
		const target = abs('agent.ipynb');
		svc.useNotebook('sess-agent', 'agent.ipynb');
		const { ids } = await svc.addCells([{ cell_type: 'code', source: JOINED }], null, {
			nb: target,
			routeImports: false
		});
		nbmod.setExportTarget('out/agent.py', target);

		const r = svc.setCellExport([ids[0]], true, target);
		expect(r.ok).toBe(true);
		// `warning`, never `reason`: the two say opposite things about the same file,
		// and an agent acting on the wrong one would stop believing the file exists.
		expect(r.ok && r.module?.warning).toContain('will not import');
		expect(r.ok && r.module?.warning).toContain('out/agent.py');
		expect(r.ok && r.module?.regenerated).toBe(true);
		expect(r.ok && r.module?.reason).toBeUndefined();
	});

	it('set_export_target reports it too - it regenerates the same module', async () => {
		// The target is often named AFTER the cells are marked, so this path can be the
		// one that first writes the broken module. Reporting on only one of the two
		// export write tools would leave that agent with a clean result.
		const target = abs('agent-target.ipynb');
		svc.useNotebook('sess-agent-target', 'agent-target.ipynb');
		const { ids } = await svc.addCells([{ cell_type: 'code', source: JOINED }], null, {
			nb: target,
			routeImports: false
		});
		nbmod.setCellExports([svc.resolveRef(target, ids[0])], true, target);

		// The success shape carries no `ok` - it is the target fields plus, only when
		// there is something to say, `module`.
		const r = svc.setExportTarget('out/agent-target.py', target) as { module?: { warning?: string } };
		expect(r.module?.warning).toContain('will not import');
		expect(r.module?.warning).toContain('out/agent-target.py');
	});

	it('says nothing at all for a healthy export', async () => {
		const target = abs('agent-clean.ipynb');
		svc.useNotebook('sess-agent-clean', 'agent-clean.ipynb');
		const { ids } = await svc.addCells([{ cell_type: 'code', source: 'def f():\n    return 1' }], null, {
			nb: target,
			routeImports: false
		});
		nbmod.setExportTarget('out/agent-clean.py', target);
		const r = svc.setCellExport([ids[0]], true, target);
		expect(r.ok && r.module).toBeUndefined();
	});
});

/**
 * A hazard says the module WAS WRITTEN and will not import. Over a write the
 * clobber guard declined, that claim is simply false - so the foreign-module
 * question is asked FIRST, and it is asked in ONE place (`docExportHazards`), which
 * is what stops the export bar and MCP from describing one document differently.
 *
 * Newly reachable: reading nbdev's `#| export` means an established nbdev repo now
 * reaches the module write on every save, and its module carries nbdev's OWN
 * header, so the guard declines there routinely.
 */
describe('a module Cellar did NOT write cannot carry a hazard about it', () => {
	/** Plant a file at `rel` that Cellar's clobber guard will refuse to overwrite. */
	function plantForeign(rel: string) {
		mkdirSync(join(WS, 'out'), { recursive: true });
		writeFileSync(join(WS, rel), '# AUTOGENERATED BY nbdev! DO NOT EDIT!\nprint("theirs")\n');
	}

	it('the export bar reports no hazard while a foreign file occupies the target', async () => {
		const { target } = await notebookWith('foreign-view.ipynb', JOINED, { target: 'out/foreign-view.py' });
		// Before: the marks alone decided, so the bar asserted a broken module.
		expect(nbmod.getNotebook(target).exportHazards).toHaveLength(1);

		plantForeign('out/foreign-view.py');
		expect(nbmod.getNotebook(target).exportHazards).toEqual([]);
		// ...and the exporter really does decline, which is what makes the claim false.
		expect(nbmod.exportPy(target)).toMatchObject({ written: false, reason: 'foreign-module', hazards: [] });
		// The foreign file is untouched - the guard is unchanged, only the reporting is.
		expect(readFileSync(join(WS, 'out/foreign-view.py'), 'utf8')).toContain('theirs');
	});

	it('still reports the hazard over a module Cellar generated, and over none at all', async () => {
		// The suppression must be narrow: an absent module and a Cellar-generated one
		// are both writable, so the hazard describes a file that really is (or is about
		// to be) there.
		const { target } = await notebookWith('own-module.ipynb', JOINED, { target: 'out/own-module.py' });
		// Marking already ran the auto-export, so OUR module is on disk holding the
		// hazard - the case the warning is FOR.
		const res = nbmod.exportPy(target);
		expect(res.written || res.reason === 'unchanged').toBe(true);
		expect(readFileSync(join(WS, 'out/own-module.py'), 'utf8')).toContain('AUTOGENERATED BY CELLAR');
		expect(nbmod.getNotebook(target).exportHazards).toHaveLength(1);

		// ...and with NOTHING on disk at all it still stands: an absent module is
		// writable, so the marks really do describe the file that is about to appear.
		const { target: fresh } = await notebookWith('own-none.ipynb', JOINED, { target: 'out/own-none.py' });
		unlinkSync(join(WS, 'out/own-none.py'));
		expect(nbmod.getNotebook(fresh).exportHazards).toHaveLength(1);
	});

	it('an EMPTY file at the target is not foreign, so the hazard still stands', async () => {
		// The write site overwrites an empty file (pre-creating the module with `touch`
		// is an ordinary workflow), so suppressing here would explain a refusal that
		// never happens.
		const { target } = await notebookWith('empty-target.ipynb', JOINED, { target: 'out/empty-target.py' });
		mkdirSync(join(WS, 'out'), { recursive: true });
		writeFileSync(join(WS, 'out/empty-target.py'), '   \n');
		expect(nbmod.getNotebook(target).exportHazards).toHaveLength(1);
	});

	it('the agent surface agrees: the foreign refusal, never the will-not-import warning', async () => {
		const target = abs('agent-foreign.ipynb');
		svc.useNotebook('sess-agent-foreign', 'agent-foreign.ipynb');
		const { ids } = await svc.addCells([{ cell_type: 'code', source: JOINED }], null, {
			nb: target,
			routeImports: false
		});
		nbmod.setExportTarget('out/agent-foreign.py', target);
		plantForeign('out/agent-foreign.py');

		const r = svc.setCellExport([ids[0]], true, target);
		expect(r.ok).toBe(true);
		expect(r.ok && r.module?.regenerated).toBe(false);
		expect(r.ok && r.module?.reason).toContain('was not generated by Cellar');
		expect(r.ok && r.module?.warning).toBeUndefined();

		// And the OTHER export write tool describes the same document the same way.
		const t = svc.setExportTarget('out/agent-foreign.py', target) as {
			module?: { warning?: string; reason?: string };
		};
		expect(t.module?.reason).toContain('was not generated by Cellar');
		expect(t.module?.warning).toBeUndefined();
	});
});

/**
 * SOURCE-SHAPE guards - NOT behavioural coverage.
 *
 * These read component text and assert that the expected markup and branches are
 * PRESENT and in the expected order. They prove SHAPE and nothing more: an
 * inverted `{:else if}` condition, a branch that can never be reached, or a
 * wrongly-derived value would all still pass, and a reformat would fail them for
 * no defect at all.
 *
 * They are kept because they are the only CI-VISIBLE evidence these surfaces
 * exist: vitest here runs without the SvelteKit plugin, so the components cannot
 * be mounted, and Playwright e2e is deliberately absent from both CI and the
 * no-mistakes gate - so a rule left only as a template expression could be
 * deleted and merge green. Same precedent as `defaultProfileNoticeApplies` and
 * `databricks-upload-card.test.ts`.
 *
 * The BEHAVIOUR of every rule below is exercised by
 * `tests/e2e/export-target-section.spec.ts`, in its test "a module that will not
 * import says so in the bar, live, and clears when fixed".
 */
describe('the two Svelte halves - source SHAPE guards, not behaviour', () => {
	const read = (rel: string) => readFileSync(new URL(`../../src/${rel}`, import.meta.url), 'utf8');

	it('the export bar markup carries the hazard arm, ordered below an unresolvable target', () => {
		const src = read('lib/Notebook.svelte');
		expect(src).toContain('data-testid="export-hazard"');
		expect(src).toContain('exportHazards[0].message');
		// The warning chain shows ONE arm. `exportResolveError` means no module was
		// written at all, so it outranks this; this outranks the code-root warning,
		// which is about the kernel not reaching a module that is otherwise fine.
		const chain = src.slice(src.indexOf('{#if exportResolveError}'), src.indexOf('data-testid="export-resolved"'));
		expect(chain.indexOf('exportResolveError')).toBeLessThan(chain.indexOf('exportHazards.length'));
		expect(chain.indexOf('exportHazards.length')).toBeLessThan(chain.indexOf('importWarning'));
	});

	it('both manual-export surfaces branch on hazards ahead of the success wording', () => {
		// `doExport`'s feedback line and the shell's notice are the two places a manual
		// export is spoken. Both branch on hazards BEFORE the success wording.
		const nb = read('lib/Notebook.svelte');
		const fn = nb.slice(nb.indexOf('async function doExport()'), nb.indexOf('</script>'));
		expect(fn).toContain('r.hazards?.length');
		expect(fn.indexOf('r.hazards?.length')).toBeLessThan(fn.indexOf('exportFeedback = `Exported'));

		const page = read('routes/+page.svelte');
		const notice = page.slice(page.indexOf('async function exportPy()'), page.indexOf('// Toggle the active notebook'));
		expect(notice).toContain('r.hazards?.length');
		expect(notice.indexOf('r.hazards?.length')).toBeLessThan(notice.indexOf('showNotice(`Exported'));
	});

	it('LiveNotebook mentions the load seed and the live event in its dispatcher', () => {
		const src = read('lib/LiveNotebook.svelte');
		expect(src).toContain('body.notebook.exportHazards');
		expect(src).toContain("ev.type === 'notebook:export-derived'");
		// The event must reach `applyStructuralEvent` at all: the dispatcher routes by
		// an explicit list, so an unlisted `notebook:*` type falls through to the RUN
		// handler and is silently dropped.
		expect(src).toContain("pe.type === 'notebook:export-derived'");
	});
});
