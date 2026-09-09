/**
 * What the HOT read paths cost, where the return value cannot show it.
 *
 * Two claims live here, both about work that is invisible in the result and so can
 * only be pinned by instrumenting the boundary the work crosses: the browser-facing
 * hazard read, and `get_notebook_map`'s export-target resolution.
 *
 * ## 1. The browser-facing hazard read costs nothing for a kind the browser discards
 *
 * `mojo-main-kept` is AGENT-ONLY (`$lib/exportHazard`'s header says why) and it
 * fires on the COMMONEST `.mojo` shape - any surviving `main`. `docExportHazards`
 * asks the foreign-module question only once a hazard exists, and that question is
 * an `existsSync` + `readFileSync` of the generated module. Narrowed to the human
 * set AFTER that gate, every `getNotebook` and every `persist` of such a notebook
 * paid a file read - on the process carrying the kernel websockets and the SSE
 * fan-out - for a hazard the export bar then threw away.
 *
 * The syscall IS the subject, so `node:fs` is wrapped rather than the result
 * inspected: both paths answer `[]` for this notebook, so nothing about the RETURN
 * value can tell the ordering apart. The wrapper delegates to the real functions,
 * so every write here is a real write. It lives in its own file because that mock
 * is file-wide and the sibling `export-hazard-report.test.ts` should not carry it.
 *
 * ## 2. `get_notebook_map` adds no export-target resolution of its own
 *
 * It is the most frequently called agent read tool, and with no `export_target`
 * stored `resolveExportTarget` sweeps EVERY cell for a `#|default_exp` directive -
 * the cost that function's own header documents its `includes` pre-check as
 * bounding. Asking the doc layer AGAIN for the target's LANGUAGE added a whole
 * extra sweep to it. The map's output is identical either way, so the module
 * boundary is wrapped and the resolutions counted.
 *
 * The BASELINE is measured, never hardcoded: the map composes `getNotebook` (which
 * resolves for its own view fields) with the one resolution `display.export_target`
 * reports, so the claim is that it pays for those and nothing more. A magic number
 * would have to be re-guessed whenever either surface changes, and - the failure
 * this file already shipped once - a counter wired to a function nothing calls
 * cannot fail at all, which reports a safety that does not exist.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { moduleReads, resolves } = vi.hoisted(() => ({
	moduleReads: [] as string[],
	resolves: { n: 0 }
}));

vi.mock('node:fs', async () => {
	const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
	const readFileSync = (...args: Parameters<typeof actual.readFileSync>) => {
		moduleReads.push(String(args[0]));
		return actual.readFileSync(...args);
	};
	return { ...actual, default: { ...actual, readFileSync }, readFileSync };
});

// The doc layer's export-target RESOLUTION entry points, wrapped where the callers
// cross the module boundary. Counting `resolveExportTarget` alone would not do it:
// the accessors above it (`docExportTargetInfo`, `docExportTargetLanguage`,
// `docExportLanguage`) reach it by an INTRA-module reference the mock cannot see, so
// a caller that asked for the language would resolve the target without moving the
// count. Every one of these four performs a resolution, and every caller outside
// `export-py.ts` reaches one of them.
vi.mock('../../src/lib/server/export-py', async () => {
	const actual = await vi.importActual<typeof import('../../src/lib/server/export-py')>(
		'../../src/lib/server/export-py'
	);
	const counted = <A extends unknown[], R>(fn: (...args: A) => R) => (...args: A): R => {
		resolves.n++;
		return fn(...args);
	};
	// `docExportTargetInfo` is the one that can be HANDED an already-resolved answer
	// (`exportTargetView` does exactly that), so it is counted only when it would
	// really resolve - otherwise the counter would report a resolution that never
	// happened and the budgets below would stop meaning what they say.
	const info = (
		doc: Parameters<typeof actual.docExportTargetInfo>[0],
		resolved?: Parameters<typeof actual.docExportTargetInfo>[1]
	) => {
		if (resolved === undefined) resolves.n++;
		return actual.docExportTargetInfo(doc, resolved);
	};
	return {
		...actual,
		resolveExportTarget: counted(actual.resolveExportTarget),
		docExportTargetInfo: info,
		docExportTargetLanguage: counted(actual.docExportTargetLanguage),
		docExportLanguage: counted(actual.docExportLanguage)
	};
});

vi.mock('../../src/lib/server/dataflow', () => ({
	getNotebookStaleness: async () => ({ sid: null, cells: {} }),
	analyzeDataflow: async () => ({})
}));

let WS: string;
let nbmod: typeof import('../../src/lib/server/notebook');
let svc: typeof import('../../src/lib/server/mcp/service');

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-hazard-cost-'));
	process.env.CELLAR_WORKSPACE = WS;
	nbmod = await import('../../src/lib/server/notebook');
	svc = await import('../../src/lib/server/mcp/service');
});

/** Reads of the generated module itself, since the run() call rewrites the ipynb. */
function readsOfModule(target: string, run: () => void): string[] {
	moduleReads.length = 0;
	run();
	return moduleReads.filter((r) => r.endsWith(target));
}

describe('docHumanExportHazards narrows BEFORE the foreign-module read', () => {
	async function mojoNotebook(rel: string, source: string, target: string) {
		const nb = nbmod.resolveNotebookPath(rel);
		svc.useNotebook(`sess-${rel}`, rel);
		// The NOTEBOOK is what makes its code cells Mojo, and the target's extension
		// follows it - so the language is declared before the target is named.
		nbmod.setNotebookLanguage('mojo', nb);
		const { ids } = await svc.addCells([{ cell_type: 'code' as const, source }], null, {
			nb,
			routeImports: false
		});
		nbmod.setExportTarget(target, nb);
		nbmod.setCellExports([svc.resolveRef(nb, ids[0])], true, nb);
		return nb;
	}

	it('a kept main reaches the agent and costs the browser no module read', async () => {
		const nb = await mojoNotebook('kept.ipynb', 'def main():\n    print(1)', 'out/kept.mojo');
		// The agent surface reports it, so the kind really did fire...
		expect(nbmod.exportHazardsFor(nb).map((h) => h.kind)).toEqual(['mojo-main-kept']);
		// ...and the agent path is what pays for the foreign-module question.
		expect(readsOfModule('out/kept.mojo', () => nbmod.exportHazardsFor(nb)).length).toBeGreaterThan(0);
		// The browser shows nothing here, and gets there without touching the module.
		expect(nbmod.getNotebook(nb).exportHazards).toEqual([]);
		expect(readsOfModule('out/kept.mojo', () => nbmod.getNotebook(nb))).toEqual([]);
	});

	it('a DROPPED main is human-visible, so the browser still asks the question', async () => {
		// The mirror, so the case above cannot pass by the browser path never reading at
		// all: a kind the bar really shows must still be suppressed over a module Cellar
		// did not generate, which is exactly what that read decides.
		const nb = await mojoNotebook('dropped.ipynb', 'def main():\n    print(1)', 'out/dropped.mojo');
		const { ids } = await svc.addCells([{ cell_type: 'code' as const, source: 'def main():\n    print(2)' }], null, {
			nb,
			routeImports: false
		});
		nbmod.setCellExports([svc.resolveRef(nb, ids[0])], true, nb);
		expect(nbmod.getNotebook(nb).exportHazards.map((h) => h.kind)).toEqual(['mojo-main-dropped']);
		expect(readsOfModule('out/dropped.mojo', () => nbmod.getNotebook(nb)).length).toBeGreaterThan(0);
	});
});

describe('get_notebook_map adds no export-target resolution of its own', () => {
	async function notebook(rel: string, language: 'python' | 'mojo', source: string) {
		const nb = nbmod.resolveNotebookPath(rel);
		svc.useNotebook(`sess-${rel}`, rel);
		if (language === 'mojo') nbmod.setNotebookLanguage('mojo', nb);
		const { ids } = await svc.addCells([{ cell_type: 'code' as const, source }], null, {
			nb,
			routeImports: false
		});
		return { nb, id: svc.resolveRef(nb, ids[0]) };
	}

	/** Every leaf of the map, flattened, so a marked cell can be looked up by handle. */
	function leaves(sections: unknown[]): { id: string; export?: boolean }[] {
		return (sections as { id: string; export?: boolean; children?: unknown[] }[]).flatMap(
			function walk(n): { id: string; export?: boolean }[] {
				return [n, ...((n.children ?? []) as typeof n[]).flatMap(walk)];
			}
		);
	}

	it('adds NO resolution of its own for the language, and still reports the marks', async () => {
		// The language rides the view `getNotebook` already resolved. Asking the doc
		// layer again is what added a whole extra per-cell `default_exp` sweep to the
		// hottest read tool, so the budget is measured against the surfaces the map
		// composes rather than against a number: the view, plus the ONE resolution
		// `display.export_target` needs to report where the marks land.
		const { nb, id } = await notebook('map-cost.ipynb', 'python', 'def one():\n    return 1');
		nbmod.setExportTarget('lib/map-cost.py', nb);
		nbmod.setCellExports([id], true, nb);

		resolves.n = 0;
		nbmod.getNotebook(nb);
		const view = resolves.n;
		expect(view).toBeGreaterThan(0); // the counter is wired to something live

		resolves.n = 0;
		const map = await svc.getNotebookMap(nb);
		expect(resolves.n).toBe(view + 1);
		// ...and the answer it derived instead is the right one.
		expect(map.display.export_target).toBe('lib/map-cost.py');
		expect(leaves(map.sections).find((l) => l.id === svc.resolveRef(nb, id).slice(0, 8))?.export ?? true).toBe(true);
	});

	it('still reads the LANGUAGE, so a switch is reflected in what the map reports', async () => {
		// The half a bare call-count could not see: the value derived from the view has
		// to be the same answer the doc layer gives.
		const { nb, id } = await notebook('map-lang.ipynb', 'mojo', 'def m() -> Int:\n    return 1');
		nbmod.setExportTarget('lib/map-lang.mojo', nb);
		nbmod.setCellExports([id], true, nb);
		expect(nbmod.getNotebook(nb).exportLanguage).toBe('mojo');
		expect(leaves((await svc.getNotebookMap(nb)).sections).filter((l) => l.export === true)).toHaveLength(1);

		// Switch the NOTEBOOK to Python: the target's extension follows it, and the
		// marked cell follows too - so it stays exported, now to `lib/map-lang.py`.
		// That is the point of one setting: the mark cannot be stranded by the module
		// language moving, because the module language IS the notebook's.
		nbmod.setNotebookLanguage('python', nb);
		expect(nbmod.getExportTarget(nb)).toBe('lib/map-lang.py');
		expect(nbmod.getNotebook(nb).exportLanguage).toBe('python');
		expect(leaves((await svc.getNotebookMap(nb)).sections).filter((l) => l.export === true)).toHaveLength(1);
	});

	it('getNotebook resolves the target ONCE, language included', async () => {
		// `exportTargetView` reports FOUR things off one resolution - the base, the
		// module language, the hazards and the orphaned module - and it reads the
		// language through the shared `docExportTargetInfo` rather than re-deriving the
		// rule inline, HANDING it the `info` it already has. This is the half the map
		// budget above cannot see: it measures `getNotebook` as a baseline, so a second
		// sweep added here would simply raise the baseline and pass.
		const { nb, id } = await notebook('view-cost.ipynb', 'python', 'def one():\n    return 1');
		nbmod.setExportTarget('lib/view-cost.py', nb);
		nbmod.setCellExports([id], true, nb);

		resolves.n = 0;
		const view = nbmod.getNotebook(nb);
		expect(resolves.n).toBe(1);
		// ...and the value that one resolution produced is the right one.
		expect(view.exportLanguage).toBe('python');
		expect(view.exportResolved).toBe('lib/view-cost.py');
	});

	it('a notebook with NO target reports the language as null, never as python', async () => {
		// The honest nullable the refusal wording rests on: eligibility falls back to
		// `python`, the VIEW does not.
		const { nb } = await notebook('map-none.ipynb', 'python', 'x = 1');
		expect(nbmod.getNotebook(nb).exportLanguage).toBeNull();
		expect(nbmod.exportTargetInfoFor(nb)).toEqual({ configured: false, language: null });
	});
});
