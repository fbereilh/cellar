/**
 * The browser-facing hazard read costs nothing for a kind the browser discards.
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
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { moduleReads } = vi.hoisted(() => ({ moduleReads: [] as string[] }));

vi.mock('node:fs', async () => {
	const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
	const readFileSync = (...args: Parameters<typeof actual.readFileSync>) => {
		moduleReads.push(String(args[0]));
		return actual.readFileSync(...args);
	};
	return { ...actual, default: { ...actual, readFileSync }, readFileSync };
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
