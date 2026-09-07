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
 * ## 2. `get_notebook_map` resolves the export target ONCE
 *
 * It is the most frequently called agent read tool, and with no `export_target`
 * stored `resolveExportTarget` sweeps EVERY cell for a `#|default_exp` directive -
 * the cost that function's own header documents its `includes` pre-check as
 * bounding. Asking the doc layer a second time for the target's LANGUAGE doubled
 * that sweep on it. The map's output is identical either way, so the module
 * boundary is wrapped and the call counted.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { moduleReads, langCalls } = vi.hoisted(() => ({
	moduleReads: [] as string[],
	langCalls: { n: 0 }
}));

vi.mock('node:fs', async () => {
	const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
	const readFileSync = (...args: Parameters<typeof actual.readFileSync>) => {
		moduleReads.push(String(args[0]));
		return actual.readFileSync(...args);
	};
	return { ...actual, default: { ...actual, readFileSync }, readFileSync };
});

vi.mock('../../src/lib/server/notebook', async () => {
	const actual = await vi.importActual<typeof import('../../src/lib/server/notebook')>(
		'../../src/lib/server/notebook'
	);
	return {
		...actual,
		exportTargetLanguageFor: (nb?: string | null) => {
			langCalls.n++;
			return actual.exportTargetLanguageFor(nb);
		}
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
		const { ids } = await svc.addCells([{ cell_type: 'mojo' as const, source }], null, {
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
		const { ids } = await svc.addCells([{ cell_type: 'mojo' as const, source: 'def main():\n    print(2)' }], null, {
			nb,
			routeImports: false
		});
		nbmod.setCellExports([svc.resolveRef(nb, ids[0])], true, nb);
		expect(nbmod.getNotebook(nb).exportHazards.map((h) => h.kind)).toEqual(['mojo-main-dropped']);
		expect(readsOfModule('out/dropped.mojo', () => nbmod.getNotebook(nb)).length).toBeGreaterThan(0);
	});
});

describe('get_notebook_map resolves the export target once', () => {
	async function notebook(rel: string, cellType: 'code' | 'mojo', source: string) {
		const nb = nbmod.resolveNotebookPath(rel);
		svc.useNotebook(`sess-${rel}`, rel);
		const { ids } = await svc.addCells([{ cell_type: cellType, source }], null, {
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

	it('asks the doc layer for the language ZERO extra times, and still reports the marks', async () => {
		// The language rides the view `getNotebook` already resolved, so this tool
		// resolves the target exactly once. A second `exportTargetLanguageFor(nb)` call
		// is what doubled the per-cell `default_exp` sweep on the hottest read tool.
		const { nb, id } = await notebook('map-cost.ipynb', 'code', 'def one():\n    return 1');
		nbmod.setExportTarget('lib/map-cost.py', nb);
		nbmod.setCellExports([id], true, nb);

		langCalls.n = 0;
		const map = await svc.getNotebookMap(nb);
		expect(langCalls.n).toBe(0);
		// ...and the answer it derived instead is the right one.
		expect(map.display.export_target).toBe('lib/map-cost.py');
		expect(leaves(map.sections).find((l) => l.id === svc.resolveRef(nb, id).slice(0, 8))?.export ?? true).toBe(true);
	});

	it('still reads the LANGUAGE, so a cell in the other language is not reported exported', async () => {
		// The half a bare call-count could not see: the value derived from the view has
		// to be the same answer the doc layer gives, or `export: true` would appear on a
		// cell the module leaves out.
		const { nb, id } = await notebook('map-lang.ipynb', 'mojo', 'def m() -> Int:\n    return 1');
		nbmod.setExportTarget('lib/map-lang.mojo', nb);
		nbmod.setCellExports([id], true, nb);
		expect(nbmod.getNotebook(nb).exportLanguage).toBe('mojo');
		const marked = leaves((await svc.getNotebookMap(nb)).sections).filter((l) => l.export === true);
		expect(marked).toHaveLength(1);

		// Repoint at a `.py` module: the same cell contributes nothing to it now, so
		// the map must stop reporting it as exported.
		nbmod.setExportTarget('lib/map-lang.py', nb);
		expect(nbmod.getNotebook(nb).exportLanguage).toBe('python');
		expect(leaves((await svc.getNotebookMap(nb)).sections).filter((l) => l.export === true)).toEqual([]);
	});

	it('a notebook with NO target reports the language as null, never as python', async () => {
		// The honest nullable the refusal wording rests on: eligibility falls back to
		// `python`, the VIEW does not.
		const { nb } = await notebook('map-none.ipynb', 'code', 'x = 1');
		expect(nbmod.getNotebook(nb).exportLanguage).toBeNull();
		expect(nbmod.exportTargetLanguageFor(nb)).toBeNull();
	});
});
