/**
 * A mojo cell inside a REAL document: the destructive import-sweep regression, the
 * clean-on-save round trip, and the `.py` text-notebook refusal.
 *
 * THE DESTRUCTIVE REGRESSION, measured on the real code before the type existed:
 * `consolidateImports` selected cells whose LOGICAL type is `code`, and a Mojo cell
 * fell into that bucket - so the sweep LIFTED `from std.time import sleep` out of
 * the Mojo cell into the Python imports cell and RAN it. Both halves break at once:
 * the Mojo cell no longer compiles, and the imports cell raises
 * `ModuleNotFoundError: No module named 'std'` from then on. The same `routeImports`
 * path runs on nearly every agent `add_cell`/`edit_cell`, so an agent writing Mojo
 * would trigger it constantly. It is silent in both directions.
 *
 * The kernel is out of scope (the imports cell RUNS when something moved), so
 * `executeCellRun` is stubbed exactly as `imports-consolidate-scope.test.ts` does -
 * what is under test is which cells the sweep rewrites.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MOJO_LANGUAGE, TEXT_NOTEBOOK_MOJO_MESSAGE, TextNotebookCellTypeError } from '../../src/lib/cellLanguage';

vi.mock('../../src/lib/server/run', () => ({
	executeCellRun: vi.fn(async () => ({
		outputs: [],
		status: 'ok',
		session: 1,
		kernelDown: false,
		lastRun: { at: 0, durationMs: 0, actor: 'user', status: 'ok', session: 1 }
	})),
	clearOutputsForQueue: () => {}
}));

const PY_BYTES = '# Databricks notebook source\nprint(1)\n\n# COMMAND ----------\n\nprint(2)\n';

vi.mock('../../src/lib/server/jupytext', async () => {
	const actual = await vi.importActual<typeof import('../../src/lib/server/jupytext')>('../../src/lib/server/jupytext');
	return {
		...actual,
		readPyNotebook: () => ({
			format: 'databricks',
			cells: [
				{ id: null, cell_type: 'code', source: 'print(1)', outputs: [], metadata: {} },
				{ id: null, cell_type: 'code', source: 'print(2)', outputs: [], metadata: {} }
			]
		}),
		// The REAL writer's coercion, reproduced: no metadata, no outputs. That loss is
		// exactly why a `mojo` tag on a .py notebook is refused rather than stored.
		writePyNotebook: (path: string, cells: { cell_type: string; source: string }[]) => {
			writeFileSync(path, cells.map((c) => c.source).join('\n\n# COMMAND ----------\n\n') + '\n');
		}
	};
});

/** Mojo whose import line is the one the sweep used to steal. */
const MOJO_SOURCE = 'from std.time import sleep\n\ndef main():\n    sleep(1.0)\n    print("done")\n';

let WS: string;
let nbmod: typeof import('../../src/lib/server/notebook');
let imports: typeof import('../../src/lib/server/imports-cell');
let PY: string;

function makeNotebook(name: string, cells: Array<{ source: string; cellar?: Record<string, unknown> }>): string {
	const nb = join(WS, name);
	writeFileSync(
		nb,
		JSON.stringify({
			cells: cells.map((c, i) => ({
				cell_type: 'code',
				source: [c.source],
				metadata: { cellar: c.cellar ?? {} },
				outputs: [],
				execution_count: null,
				id: `cell${i}`
			})),
			metadata: {},
			nbformat: 4,
			nbformat_minor: 5
		})
	);
	return nb;
}

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-mojo-doc-'));
	process.env.CELLAR_WORKSPACE = WS;
	PY = join(WS, 'dbx.py');
	writeFileSync(PY, PY_BYTES);
	nbmod = await import('../../src/lib/server/notebook');
	imports = await import('../../src/lib/server/imports-cell');
});

describe('THE DESTRUCTIVE REGRESSION: the imports sweep never touches a mojo cell', () => {
	it('leaves the Mojo source byte-identical while still lifting the PYTHON import beside it', async () => {
		const nb = makeNotebook('sweep.ipynb', [
			{ source: 'import os\nprint(os.getcwd())' },
			{ source: MOJO_SOURCE, cellar: { language: MOJO_LANGUAGE } }
		]);
		const res = await imports.consolidateImports(nb);
		expect(res.changed).toBe(true);
		const by = Object.fromEntries(nbmod.listCells(nb).map((c) => [c.id, c]));
		// Not one character of the Mojo cell moved.
		expect(by.cell1.source).toBe(MOJO_SOURCE);
		expect(by.cell1.metadata?.cellar?.language).toBe(MOJO_LANGUAGE);
		// The python cell WAS swept, so the exclusion is not a blanket no-op.
		expect(by.cell0.source).toBe('print(os.getcwd())');
		// And `from std.time import sleep` never reached the imports cell, which Cellar RUNS.
		expect(res.added).toEqual(['import os']);
		const importsCell = nbmod.listCells(nb).find((c) => c.metadata?.cellar?.role === 'imports');
		expect(importsCell?.source).toContain('import os');
		expect(importsCell?.source).not.toContain('std.time');
	});

	it('a mojo cell that is nothing but imports is never ADOPTED as the imports cell', async () => {
		const nb = makeNotebook('adopt.ipynb', [
			{ source: 'from std.time import sleep', cellar: { language: MOJO_LANGUAGE } },
			{ source: 'import numpy as np\nnp.zeros(1)' }
		]);
		await imports.consolidateImports(nb);
		const cells = nbmod.listCells(nb);
		const importsCell = cells.find((c) => c.metadata?.cellar?.role === 'imports');
		expect(importsCell).toBeDefined();
		expect(importsCell?.id).not.toBe('cell0');
		expect(importsCell?.metadata?.cellar?.language).toBeUndefined();
		expect(cells.find((c) => c.id === 'cell0')?.source).toBe('from std.time import sleep');
	});

	it('a notebook whose only import-looking lines are Mojo is a genuine no-op', async () => {
		const nb = makeNotebook('mojo-only.ipynb', [
			{ source: MOJO_SOURCE, cellar: { language: MOJO_LANGUAGE } },
			{ source: 'x = 1' }
		]);
		const before = nbmod.listCells(nb).map((c) => c.source);
		const res = await imports.consolidateImports(nb);
		expect(res.changed).toBe(false);
		expect(res.imports_cell_id).toBeNull();
		expect(nbmod.listCells(nb).map((c) => c.source)).toEqual(before);
	});

	it('agent import ROUTING skips a mojo cell too - the same sweep, run per agent write', async () => {
		// `routeOne` (mcp/service.ts) is the gate: `routeImports` is the low-level
		// tokenizer and is deliberately type-blind, so the LOGICAL type has to reach it
		// from the caller. That is the path `add_cell` / `add_cells` / `add_and_run` /
		// `edit_cell` all run, so an agent writing Mojo would otherwise trigger the
		// mutilation on nearly every call.
		const nb = makeNotebook('route.ipynb', [{ source: 'import os\nx = 1' }]);
		const svc = await import('../../src/lib/server/mcp/service');
		const added = await svc.addCells([{ cell_type: 'mojo', source: MOJO_SOURCE }], undefined, { routeImports: true, nb });
		const created = nbmod.listCells(nb).find((c) => c.id.startsWith(added.ids[0]));
		expect(created?.metadata?.cellar?.language).toBe(MOJO_LANGUAGE);
		expect(created?.source).toBe(MOJO_SOURCE);
		// Nothing was lifted, and no imports cell was created for it.
		expect(added.imports ?? null).toBeNull();
		expect(nbmod.listCells(nb).every((c) => !(c.source ?? '').includes('std.time') || c.id === created?.id)).toBe(true);

		// CONTROL: the same call with a PYTHON cell still routes, so this is a
		// type-scoped exclusion rather than routing being switched off.
		const py = await svc.addCells([{ cell_type: 'code', source: 'import json\nprint(json)' }], undefined, { routeImports: true, nb });
		expect(py.imports?.added).toEqual(['import json']);
	});
});

describe('a mojo cell survives clean-on-save byte-sane, and stays a plain nbformat code cell', () => {
	it('persists as cell_type "code" carrying cellar.language, and reloads as mojo', () => {
		const nb = join(WS, 'roundtrip.ipynb');
		nbmod.createNotebook('roundtrip.ipynb');
		const created = nbmod.addCell(null, 'mojo', nb, null, MOJO_SOURCE);
		expect(created.metadata?.cellar?.language).toBe(MOJO_LANGUAGE);

		// On disk: a plain code cell any Jupyter/nbdev/jupytext consumer opens.
		const onDisk = JSON.parse(readFileSync(nb, 'utf8')) as {
			nbformat: number;
			cells: Array<{ cell_type: string; source: string[]; metadata?: { cellar?: { language?: string } } }>;
		};
		expect(onDisk.nbformat).toBe(4);
		const written = onDisk.cells.find((c) => c.metadata?.cellar?.language === MOJO_LANGUAGE);
		expect(written).toBeDefined();
		expect(written?.cell_type).toBe('code');
		expect(written?.source.join('')).toBe(MOJO_SOURCE);
		// Nothing outside nbformat's own vocabulary was invented for it.
		expect(Object.keys(written as object).sort()).toEqual(['cell_type', 'execution_count', 'id', 'metadata', 'outputs', 'source']);

		// And a RELOAD from those bytes reads it back as mojo (the tag rides the
		// `cellar` namespace clean-on-save preserves whole).
		nbmod.dropDocs(nb);
		expect(nbmod.listCells(nb).find((c) => c.id === created.id)?.metadata?.cellar?.language).toBe(MOJO_LANGUAGE);
	});

	it('a re-save is byte-identical, so a mojo cell adds no git churn', () => {
		const nb = join(WS, 'idem.ipynb');
		nbmod.createNotebook('idem.ipynb');
		const created = nbmod.addCell(null, 'mojo', nb, null, MOJO_SOURCE);
		const first = readFileSync(nb, 'utf8');
		nbmod.setSource(created.id, MOJO_SOURCE, nb); // same text ⇒ same bytes
		expect(readFileSync(nb, 'utf8')).toBe(first);
	});

	it('converting AWAY from mojo drops the tag, the imports role and the export flag', () => {
		const nb = join(WS, 'convert.ipynb');
		nbmod.createNotebook('convert.ipynb');
		const created = nbmod.addCell(null, 'code', nb, null, 'x = 1');
		nbmod.setCellRole(created.id, 'imports', nb);
		nbmod.setCellExports([created.id], true, nb);
		expect(nbmod.listCells(nb).find((c) => c.id === created.id)?.metadata?.cellar?.export).toBe(true);
		// Becoming mojo strips both: neither may sit on a cell holding no Python.
		nbmod.setCellType(created.id, 'mojo', nb);
		const asMojo = nbmod.listCells(nb).find((c) => c.id === created.id);
		expect(asMojo?.metadata?.cellar?.language).toBe(MOJO_LANGUAGE);
		expect(asMojo?.metadata?.cellar?.role).toBeUndefined();
		expect(asMojo?.metadata?.cellar?.export).toBeUndefined();
		// ...and back to code clears the tag entirely.
		nbmod.setCellType(created.id, 'code', nb);
		expect(nbmod.listCells(nb).find((c) => c.id === created.id)?.metadata?.cellar?.language).toBeUndefined();
	});
});

describe('a .py TEXT notebook cannot hold a mojo cell', () => {
	const pyIds = () => nbmod.listCells(PY).map((c) => c.id);

	it('REFUSES setCellType(mojo) and writes nothing', () => {
		const id = pyIds()[0];
		expect(() => nbmod.setCellType(id, 'mojo', PY)).toThrow(TextNotebookCellTypeError);
		expect(() => nbmod.setCellType(id, 'mojo', PY)).toThrow(/\.py notebook cannot hold a Mojo cell/i);
		expect(() => nbmod.setCellType(id, 'mojo', PY)).toThrow(/rebuilt from its CELLS/);
		expect(nbmod.listCells(PY)[0].metadata?.cellar?.language).toBeUndefined();
		expect(readFileSync(PY, 'utf8')).toBe(PY_BYTES);
	});

	it('carries its OWN reason code, distinct from raw and chat', () => {
		try {
			nbmod.setCellType(pyIds()[0], 'mojo', PY);
			throw new Error('expected a refusal');
		} catch (err) {
			expect(err).toBeInstanceOf(TextNotebookCellTypeError);
			expect((err as TextNotebookCellTypeError).cellType).toBe('mojo');
			expect((err as TextNotebookCellTypeError).reason).toBe('mojo-in-py-notebook');
			expect((err as TextNotebookCellTypeError).message).toBe(TEXT_NOTEBOOK_MOJO_MESSAGE);
		}
	});

	it('refuses every WRITER: both creators, the bulk retype, and a SEEDED cellar namespace', () => {
		const before = pyIds().length;
		expect(() => nbmod.addCell(null, 'mojo', PY)).toThrow(TextNotebookCellTypeError);
		expect(() => nbmod.addCellAt(0, 'mojo', PY)).toThrow(TextNotebookCellTypeError);
		expect(() => nbmod.setCellTypes(pyIds(), 'mojo', PY)).toThrow(TextNotebookCellTypeError);
		// The tag can ride the namespace instead of the argument, so the guard must ask
		// the BUILT cell - otherwise this is the door around every check above.
		expect(() => nbmod.addCell(null, 'code', PY, null, MOJO_SOURCE, { language: MOJO_LANGUAGE })).toThrow(TextNotebookCellTypeError);
		expect(pyIds().length).toBe(before);
		expect(nbmod.listCells(PY).every((c) => c.metadata?.cellar?.language !== MOJO_LANGUAGE)).toBe(true);
	});

	it('leaves every OTHER conversion on that notebook allowed', () => {
		const id = pyIds()[0];
		for (const type of ['markdown', 'sql', 'code'] as const) nbmod.setCellType(id, type, PY);
		expect(nbmod.listCells(PY)[0].cell_type).toBe('code');
	});
});

describe('the REST routes report the mojo refusal in the shape the browser resyncs on', () => {
	let PATCH: (evt: { params: { id: string }; request: Request }) => Promise<Response>;
	let ADD: (evt: { request: Request }) => Promise<Response>;
	let BULK: (evt: { request: Request }) => Promise<Response>;

	beforeAll(async () => {
		PATCH = (await import('../../src/routes/api/cells/[id]/+server.js')).PATCH as unknown as typeof PATCH;
		ADD = (await import('../../src/routes/api/cells/+server.js')).POST as unknown as typeof ADD;
		BULK = (await import('../../src/routes/api/cells/bulk/+server.js')).POST as unknown as typeof BULK;
	});

	it('PATCH and POST answer 400 carrying the mojo reason and the shared message', async () => {
		const id = nbmod.listCells(PY)[0].id;
		const responses = await Promise.all([
			PATCH({ params: { id }, request: new Request(`http://x/api/cells/${id}`, { method: 'PATCH', body: JSON.stringify({ cell_type: 'mojo', nb: PY }) }) }),
			ADD({ request: new Request('http://x/api/cells', { method: 'POST', body: JSON.stringify({ afterId: id, cellType: 'mojo', nb: PY }) }) }),
			BULK({ request: new Request('http://x/api/cells/bulk', { method: 'POST', body: JSON.stringify({ op: 'type', ids: [id], cellType: 'mojo', nb: PY }) }) })
		]);
		for (const res of responses) {
			expect(res.status).toBe(400);
			const payload = await res.json();
			expect(payload.reason).toBe('mojo-in-py-notebook');
			expect(payload.message).toBe(TEXT_NOTEBOOK_MOJO_MESSAGE);
		}
	});

	it('ACCEPTS mojo as a cell_type on an .ipynb notebook, through every route', async () => {
		const nb = join(WS, 'routes.ipynb');
		nbmod.createNotebook('routes.ipynb');
		const res = await ADD({
			request: new Request('http://x/api/cells', { method: 'POST', body: JSON.stringify({ cellType: 'mojo', nb, source: MOJO_SOURCE }) })
		});
		expect(res.status).toBe(200);
		const { cell } = await res.json();
		expect(cell.cell_type).toBe('code');
		expect(cell.metadata?.cellar?.language).toBe(MOJO_LANGUAGE);
	});
});
