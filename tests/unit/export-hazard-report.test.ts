/**
 * The export's compile hazard, REPORTED on every surface that reports an export.
 *
 * The defect this pins: a marked cell holding `from __future__ import
 * annotations; x = 1` produces a module Python refuses to compile, and Cellar
 * said `written: true` and nothing else. The module is still written (see
 * `exportNotebookToPy`'s header for why writing beats refusing on the
 * auto-on-save path), so the whole fix lives in the report - which means every
 * surface has to carry it, and a surface that quietly did not would put the
 * silence straight back.
 *
 * `export-py-future.test.ts` owns the DETECTION (with `compile()`, and its
 * measured boundary). This file owns the WIRING: the notebook view the export bar
 * renders, the live push that gives the auto-on-save path a UI home at all, the
 * manual export result, and the agent surface - plus source guards on the two
 * Svelte halves, which vitest cannot mount (it runs without the SvelteKit plugin)
 * and which e2e is deliberately absent from CI and the no-mistakes gate for.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
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

describe('the live push - the auto-on-save export finally has a UI home', () => {
	/** Collect every `notebook:export-hazards` event published while `fn` runs. */
	async function captured(fn: () => Promise<void> | void) {
		const seen: Array<{ nb: string; hazards: unknown[] }> = [];
		const off = events.subscribe((e: Record<string, unknown>) => {
			if (e.type === 'notebook:export-hazards') seen.push(e as never);
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
		// Editing the marked cell into the hazard: the module regenerates on this save,
		// so the bar must learn about it without the user touching the export button.
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

	it('carries no originId, so the tab that typed renders it too', async () => {
		// DERIVED state, not an echo of one tab's action: an `originId` here would be
		// echo-suppressed by exactly the tab that just created the hazard.
		const { target, cell } = await notebookWith('push-origin.ipynb', 'X = 1');
		const seen: Array<Record<string, unknown>> = [];
		const off = events.subscribe((e: Record<string, unknown>) => {
			if (e.type === 'notebook:export-hazards') seen.push(e);
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

describe('the two Svelte halves (source guards - vitest cannot mount them)', () => {
	const read = (rel: string) => readFileSync(new URL(`../../src/${rel}`, import.meta.url), 'utf8');

	it('the export bar renders the hazard, ranked below an unresolvable target', () => {
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

	it('neither manual-export surface reports a broken module as a plain success', () => {
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

	it('LiveNotebook seeds the hazards on load AND applies the live event', () => {
		const src = read('lib/LiveNotebook.svelte');
		expect(src).toContain('body.notebook.exportHazards');
		expect(src).toContain("ev.type === 'notebook:export-hazards'");
		// The event must reach `applyStructuralEvent` at all: the dispatcher routes by
		// an explicit list, so an unlisted `notebook:*` type falls through to the RUN
		// handler and is silently dropped.
		expect(src).toContain("pe.type === 'notebook:export-hazards'");
	});
});
