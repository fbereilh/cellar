/**
 * A MOJO NOTEBOOK inside a REAL document: the destructive import-sweep regression,
 * the clean-on-save round trip, and the `.py` text-notebook refusal.
 *
 * The language is the NOTEBOOK's (`metadata.cellar.language`), so these tests
 * switch the DOCUMENT and then assert about its ordinary code cells - there is no
 * per-cell tag to set, which is itself half of what they pin.
 *
 * THE DESTRUCTIVE REGRESSION, measured on the real code before the language
 * existed: `consolidateImports` selected cells whose LOGICAL type is `code`, and
 * Mojo source falls into that bucket - so the sweep LIFTED `from std.time import
 * sleep` out of the Mojo cell into the Python imports cell and RAN it. Both halves
 * break at once: the Mojo cell no longer compiles, and the imports cell raises
 * `ModuleNotFoundError: No module named 'std'` from then on. The same
 * `routeImports` path runs on nearly every agent `add_cell`/`edit_cell`, so an
 * agent writing Mojo would trigger it constantly. It is silent in both directions.
 *
 * The kernel is out of scope (the imports cell RUNS when something moved), so
 * `executeCellRun` is stubbed exactly as `imports-consolidate-scope.test.ts` does -
 * what is under test is which cells the sweep rewrites.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	MOJO_LANGUAGE,
	TEXT_NOTEBOOK_MOJO_MESSAGE,
	TextNotebookLanguageError
} from '../../src/lib/cellLanguage';

const { writeGate } = vi.hoisted(() => ({ writeGate: { failAt: null as string | null } }));

/**
 * The one thing that can throw out of `setNotebookLanguage` AFTER it has mutated
 * the live document: the `persist`. It is a disk failure (EACCES/ENOSPC, a
 * read-only checkout), so it is induced at the atomic writer rather than by
 * chmod'ing a directory - which is silently a no-op for root and so would report
 * a safety that does not exist in a container.
 */
vi.mock('../../src/lib/server/atomic-write', async () => {
	const actual = await vi.importActual<typeof import('../../src/lib/server/atomic-write')>(
		'../../src/lib/server/atomic-write'
	);
	return {
		...actual,
		atomicWriteFileSync: (path: string, data: string) => {
			if (writeGate.failAt && path === writeGate.failAt)
				throw new Error("EACCES: permission denied, open '" + path + "'");
			return actual.atomicWriteFileSync(path, data);
		}
	};
});

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

/**
 * Write a notebook whose LANGUAGE is `language` ('mojo' persists the key; 'python'
 * writes none, which is the permanent spelling of the default).
 */
function makeNotebook(
	name: string,
	cells: Array<{ source: string; cellar?: Record<string, unknown> }>,
	language?: string
): string {
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
			metadata: language ? { cellar: { language } } : {},
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

describe('THE DESTRUCTIVE REGRESSION: the imports sweep never touches a Mojo notebook', () => {
	it('leaves a Mojo notebook byte-identical while a PYTHON notebook is still swept', async () => {
		const mojoNb = makeNotebook(
			'sweep-mojo.ipynb',
			[{ source: MOJO_SOURCE }, { source: 'from std.time import now\n\ndef main():\n    print(now())\n' }],
			MOJO_LANGUAGE
		);
		const before = nbmod.listCells(mojoNb).map((c) => c.source);
		const res = await imports.consolidateImports(mojoNb);
		// Not one character moved, and no imports cell was conjured for a notebook
		// whose "imports" are Mojo ones the Python kernel could never run.
		expect(res.changed).toBe(false);
		expect(res.imports_cell_id).toBeNull();
		expect(nbmod.listCells(mojoNb).map((c) => c.source)).toEqual(before);
		expect(nbmod.listCells(mojoNb).some((c) => c.metadata?.cellar?.role === 'imports')).toBe(false);

		// CONTROL: the SAME sweep over a PYTHON notebook still lifts, so this is a
		// notebook-scoped exclusion rather than consolidate being switched off.
		const pyNb = makeNotebook('sweep-py.ipynb', [{ source: 'import os\nprint(os.getcwd())' }]);
		const pyRes = await imports.consolidateImports(pyNb);
		expect(pyRes.changed).toBe(true);
		expect(pyRes.added).toEqual(['import os']);
		expect(nbmod.listCells(pyNb).find((c) => c.id === 'cell0')?.source).toBe('print(os.getcwd())');
	});

	it('never ADOPTS a Mojo notebook\'s first cell as the imports cell', async () => {
		const nb = makeNotebook(
			'adopt.ipynb',
			[{ source: 'from std.time import sleep' }, { source: 'def main():\n    print(1)\n' }],
			MOJO_LANGUAGE
		);
		await imports.consolidateImports(nb);
		const cells = nbmod.listCells(nb);
		expect(cells.some((c) => c.metadata?.cellar?.role === 'imports')).toBe(false);
		expect(cells.find((c) => c.id === 'cell0')?.source).toBe('from std.time import sleep');
	});

	it('agent import ROUTING skips a Mojo notebook too - the same sweep, run per agent write', async () => {
		// `routeImports` is the low-level path `add_cell` / `add_cells` /
		// `add_and_run` / `edit_cell` all run, so an agent writing Mojo would otherwise
		// trigger the mutilation on nearly every call. The guard is at its ENTRY, which
		// is what covers every caller at once.
		const nb = makeNotebook('route.ipynb', [{ source: 'def main():\n    print(1)\n' }], MOJO_LANGUAGE);
		const svc = await import('../../src/lib/server/mcp/service');
		const added = await svc.addCells([{ cell_type: 'code', source: MOJO_SOURCE }], undefined, { routeImports: true, nb });
		const created = nbmod.listCells(nb).find((c) => c.id.startsWith(added.ids[0]));
		expect(created?.source).toBe(MOJO_SOURCE);
		// Nothing was lifted, and no imports cell was created for it.
		expect(added.imports ?? null).toBeNull();
		expect(nbmod.listCells(nb).some((c) => c.metadata?.cellar?.role === 'imports')).toBe(false);

		// CONTROL: the same call into a PYTHON notebook still routes.
		const pyNb = makeNotebook('route-py.ipynb', [{ source: 'x = 1' }]);
		const py = await svc.addCells([{ cell_type: 'code', source: 'import json\nprint(json)' }], undefined, { routeImports: true, nb: pyNb });
		expect(py.imports?.added).toEqual(['import json']);
	});
});

describe('the notebook language survives clean-on-save, and touches no cell', () => {
	it('persists as ONE notebook-level key and reloads as mojo', () => {
		const nb = join(WS, 'roundtrip.ipynb');
		nbmod.createNotebook('roundtrip.ipynb');
		const created = nbmod.addCell(null, 'code', nb, null, MOJO_SOURCE);
		expect(nbmod.setNotebookLanguage('mojo', nb)).toBe('mojo');

		const onDisk = JSON.parse(readFileSync(nb, 'utf8')) as {
			nbformat: number;
			metadata: { cellar?: { language?: string } };
			cells: Array<{ cell_type: string; source: string[]; metadata?: { cellar?: Record<string, unknown> } }>;
		};
		expect(onDisk.nbformat).toBe(4);
		expect(onDisk.metadata.cellar?.language).toBe('mojo');
		// NO CELL was touched: the language is read from the notebook, never copied
		// down, so there is no second spelling to fall out of step.
		const written = onDisk.cells.find((c) => c.source.join('') === MOJO_SOURCE);
		expect(written?.cell_type).toBe('code');
		expect(written?.metadata?.cellar?.language).toBeUndefined();
		expect(Object.keys(written as object).sort()).toEqual(['cell_type', 'execution_count', 'id', 'metadata', 'outputs', 'source']);

		// A RELOAD from those bytes reads it back (the key rides the `cellar`
		// namespace clean-on-save preserves whole).
		nbmod.dropDocs(nb);
		expect(nbmod.getNotebookLanguage(nb)).toBe('mojo');
		expect(nbmod.getNotebook(nb).language).toBe('mojo');
		expect(nbmod.listCells(nb).find((c) => c.id === created.id)?.source).toBe(MOJO_SOURCE);
	});

	it('switching BACK to python leaves nothing stale - the key is DELETED, not set to python', () => {
		const nb = join(WS, 'roundtrip2.ipynb');
		nbmod.createNotebook('roundtrip2.ipynb');
		nbmod.addCell(null, 'code', nb, null, 'x = 1');
		const pristine = readFileSync(nb, 'utf8');
		nbmod.setNotebookLanguage('mojo', nb);
		expect(readFileSync(nb, 'utf8')).not.toBe(pristine);
		expect(nbmod.setNotebookLanguage('python', nb)).toBe('python');
		// Byte-identical to the notebook that never switched: absence is the one
		// spelling of the default, so there is no migration and no residue.
		expect(readFileSync(nb, 'utf8')).toBe(pristine);
		const meta = JSON.parse(readFileSync(nb, 'utf8')).metadata;
		expect(meta.cellar?.language).toBeUndefined();
		expect(nbmod.getNotebookLanguage(nb)).toBe('python');
	});

	it('a re-save is byte-identical, so the language adds no git churn', () => {
		const nb = join(WS, 'idem.ipynb');
		nbmod.createNotebook('idem.ipynb');
		const created = nbmod.addCell(null, 'code', nb, null, MOJO_SOURCE);
		nbmod.setNotebookLanguage('mojo', nb);
		const first = readFileSync(nb, 'utf8');
		nbmod.setSource(created.id, MOJO_SOURCE, nb); // same text ⇒ same bytes
		expect(readFileSync(nb, 'utf8')).toBe(first);
		expect(nbmod.setNotebookLanguage('mojo', nb)).toBe('mojo'); // idempotent
		expect(readFileSync(nb, 'utf8')).toBe(first);
	});

	it('leaves markdown, raw, sql and chat cells untouched across a switch', () => {
		const nb = join(WS, 'others.ipynb');
		nbmod.createNotebook('others.ipynb');
		const md = nbmod.addCell(null, 'markdown', nb, null, '# Heading');
		const raw = nbmod.addCell(md.id, 'raw', nb, null, '---\ntitle: x\n---');
		const sql = nbmod.addCell(raw.id, 'sql', nb, null, 'select 1');
		const chat = nbmod.addCell(sql.id, 'chat', nb, null, 'why?');
		const before = nbmod.listCells(nb).map((c) => ({ id: c.id, t: c.cell_type, m: JSON.stringify(c.metadata), s: c.source }));
		nbmod.setNotebookLanguage('mojo', nb);
		const after = nbmod.listCells(nb).map((c) => ({ id: c.id, t: c.cell_type, m: JSON.stringify(c.metadata), s: c.source }));
		expect(after).toEqual(before);
		// ...and they still read as the types they are.
		expect(nbmod.listCells(nb).map((c) => c.cell_type)).toEqual(['code', 'markdown', 'raw', 'code', 'code']);
		expect(nbmod.listCells(nb).find((c) => c.id === chat.id)?.metadata?.cellar?.language).toBe('chat');
	});
});

describe('a .py TEXT notebook cannot BE a Mojo notebook', () => {
	it('REFUSES setNotebookLanguage(mojo) and writes nothing', () => {
		expect(() => nbmod.setNotebookLanguage('mojo', PY)).toThrow(TextNotebookLanguageError);
		expect(() => nbmod.setNotebookLanguage('mojo', PY)).toThrow(/\.py notebook cannot be a Mojo notebook/i);
		expect(() => nbmod.setNotebookLanguage('mojo', PY)).toThrow(/rebuilt from its CELLS/);
		expect(nbmod.getNotebookLanguage(PY)).toBe('python');
		expect(readFileSync(PY, 'utf8')).toBe(PY_BYTES);
	});

	it('carries the reason code the routes report', () => {
		try {
			nbmod.setNotebookLanguage('mojo', PY);
			throw new Error('expected a refusal');
		} catch (err) {
			expect(err).toBeInstanceOf(TextNotebookLanguageError);
			expect((err as TextNotebookLanguageError).reason).toBe('mojo-in-py-notebook');
			expect((err as TextNotebookLanguageError).message).toBe(TEXT_NOTEBOOK_MOJO_MESSAGE);
		}
	});

	it('still ALLOWS python there - clearing can only ever remove state', () => {
		expect(nbmod.setNotebookLanguage('python', PY)).toBe('python');
		expect(readFileSync(PY, 'utf8')).toBe(PY_BYTES);
	});

	it('refuses an unknown language on any notebook rather than guessing', () => {
		const nb = join(WS, 'bad-lang.ipynb');
		nbmod.createNotebook('bad-lang.ipynb');
		for (const bad of ['Mojo', 'python3', 'zig', '']) {
			expect(() => nbmod.setNotebookLanguage(bad, nb)).toThrow(/unknown notebook language/i);
		}
		expect(nbmod.getNotebookLanguage(nb)).toBe('python');
	});
});

describe('the REST route reports the language refusal in the shape the browser resyncs on', () => {
	let POST: (evt: { request: Request }) => Promise<Response>;

	beforeAll(async () => {
		POST = (await import('../../src/routes/api/notebooks/language/+server.js')).POST as unknown as typeof POST;
	});

	it('answers 400 carrying the reason and the shared message for a .py notebook', async () => {
		const res = await POST({
			request: new Request('http://x/api/notebooks/language', {
				method: 'POST',
				body: JSON.stringify({ language: 'mojo', path: PY })
			})
		});
		expect(res.status).toBe(400);
		const payload = await res.json();
		expect(payload.ok).toBe(false);
		expect(payload.reason).toBe('mojo-in-py-notebook');
		expect(payload.message).toBe(TEXT_NOTEBOOK_MOJO_MESSAGE);
	});

	it('ACCEPTS mojo on an .ipynb, and reports the export target back with it', async () => {
		const nb = join(WS, 'routes.ipynb');
		nbmod.createNotebook('routes.ipynb');
		nbmod.setExportTarget('utils.py', nb);
		const res = await POST({
			request: new Request('http://x/api/notebooks/language', {
				method: 'POST',
				body: JSON.stringify({ language: 'mojo', path: nb })
			})
		});
		expect(res.status).toBe(200);
		const payload = await res.json();
		expect(payload.language).toBe('mojo');
		// The target FOLLOWED the language, and the reply says so - an agent or a tab
		// holding `utils.py` has to learn it is now `utils.mojo`.
		expect(payload.exportTarget.target).toBe('utils.mojo');
	});

	it('refuses an unknown language with `bad-language` rather than the .py reason', async () => {
		const nb = join(WS, 'routes.ipynb');
		const res = await POST({
			request: new Request('http://x/api/notebooks/language', {
				method: 'POST',
				body: JSON.stringify({ language: 'zig', path: nb })
			})
		});
		expect(res.status).toBe(400);
		expect((await res.json()).reason).toBe('bad-language');
	});
});

describe('the SYMBOL tools ask the notebook language too, so no fabricated symbol reaches an agent', () => {
	// The real `ast`/`symtable` probe (python3, stdlib only) - a fixture cannot show
	// this, because the whole point is that the probe answers CONFIDENTLY for Mojo
	// that happens to parse as Python.
	it('find_symbol reports NO definer for a Mojo `main`, while a Python notebook still resolves one', async () => {
		const svc = await import('../../src/lib/server/mcp/service');
		const mojoNb = makeNotebook(
			'symbols-mojo.ipynb',
			[{ source: 'def main():\n    print("hi")\n' }, { source: 'main()' }],
			MOJO_LANGUAGE
		);
		const found = await svc.findSymbol('main', mojoNb);
		expect(found.defined_in).toEqual([]);
		expect(found.used_in).toEqual([]);

		// CONTROL: the identical source in a PYTHON notebook still resolves, so the
		// empty answer above is the notebook's language and not a broken probe.
		const pyNb = makeNotebook('symbols-py.ipynb', [
			{ source: 'def main():\n    print("hi")\n' },
			{ source: 'main()' }
		]);
		const pyFound = await svc.findSymbol('main', pyNb);
		expect(pyFound.defined_in.length).toBe(1);
		expect(pyFound.used_in.length).toBe(1);
	});

	it('cell_impact reports NO dependents in a Mojo notebook, and still does in a Python one', async () => {
		const svc = await import('../../src/lib/server/mcp/service');
		const mojoNb = makeNotebook(
			'impact-mojo.ipynb',
			[{ source: 'def main():\n    print("hi")\n' }, { source: 'main()' }],
			MOJO_LANGUAGE
		);
		const cells = nbmod.listCells(mojoNb);
		const impact = await svc.cellImpact(cells[0].id, mojoNb);
		expect(impact.dependents).toEqual([]);
		expect(impact.depends_on).toEqual([]);

		const pyNb = makeNotebook('impact-py.ipynb', [
			{ source: 'def main():\n    print("hi")\n' },
			{ source: 'main()' }
		]);
		const pyCells = nbmod.listCells(pyNb);
		const pyImpact = await svc.cellImpact(pyCells[0].id, pyNb);
		expect(pyImpact.dependents.length).toBe(1);
	});
});

describe('the FIRST notebook-level setting a notebook ever takes keeps its kernelspec', () => {
	it('materializes the default metadata, so the canonical notebook is not silently stripped', () => {
		// `loadDoc` materializes the canonical notebook IN MEMORY with `metadata:
		// undefined` when the file does not exist, and `serialize` writes `doc.metadata
		// ?? defaultMetadata()` - so a setter that seeded a bare `{}` made that fallback
		// stop applying and the first setting a user ever chose deleted the kernelspec
		// from the file it created.
		const canonical = join(WS, 'notebook.ipynb');
		expect(nbmod.setNotebookLanguage('mojo', canonical)).toBe('mojo');
		const onDisk = JSON.parse(readFileSync(canonical, 'utf8')) as {
			metadata: { kernelspec?: { name?: string }; cellar?: { language?: string } };
		};
		expect(onDisk.metadata.kernelspec?.name).toBe('python3');
		expect(onDisk.metadata.cellar?.language).toBe('mojo');

		// ...and clearing back to python prunes the namespace WITHOUT taking the
		// kernelspec with it: the two halves of `notebookCellar` are independent.
		nbmod.setNotebookLanguage('python', canonical);
		const cleared = JSON.parse(readFileSync(canonical, 'utf8')) as {
			metadata: { kernelspec?: { name?: string }; cellar?: unknown };
		};
		expect(cleared.metadata.kernelspec?.name).toBe('python3');
		expect(cleared.metadata.cellar).toBeUndefined();
	});
});

describe('the route tells a REFUSED language from a FAILED WRITE, so the UI can never say Python over a Mojo document', () => {
	let POST: (evt: { request: Request }) => Promise<Response>;

	beforeAll(async () => {
		POST = (await import('../../src/routes/api/notebooks/language/+server.js')).POST as unknown as typeof POST;
	});

	const post = (body: unknown) =>
		POST({
			request: new Request('http://x/api/notebooks/language', {
				method: 'POST',
				body: JSON.stringify(body)
			})
		});

	it('answers 500 + writeFailed + the HELD language when only the SAVE failed', async () => {
		const nb = join(WS, 'writefail.ipynb');
		nbmod.createNotebook('writefail.ipynb');
		nbmod.addCell(null, 'code', nb, null, 'x = 1');
		const before = readFileSync(nb, 'utf8');

		writeGate.failAt = nb;
		let payload: Record<string, unknown>;
		let status: number;
		try {
			const res = await post({ language: 'mojo', path: nb });
			status = res.status;
			payload = await res.json();
		} finally {
			writeGate.failAt = null;
		}

		// NOT the refusal shape: the live document ACCEPTED the language (every code
		// cell in it now compiles as Mojo), and only the save failed.
		expect(status).toBe(500);
		expect(payload.ok).toBe(false);
		expect(payload.reason).toBeUndefined();
		expect(typeof payload.writeFailed).toBe('string');
		// The HELD value, so the select adopts what the document really holds rather
		// than reverting to a Python it no longer is.
		expect(payload.language).toBe('mojo');
		expect(nbmod.getNotebookLanguage(nb)).toBe('mojo');
		// Disk really did not take it - which is what makes the two facts different.
		expect(readFileSync(nb, 'utf8')).toBe(before);
	});

	it('still answers the 400 REFUSAL shape when nothing was mutated', async () => {
		// The control: same route, same failure-looking outcome, opposite meaning -
		// the document is untouched and the select must go back to what it holds.
		const res = await post({ language: 'zig', path: join(WS, 'writefail.ipynb') });
		expect(res.status).toBe(400);
		const payload = await res.json();
		expect(payload.reason).toBe('bad-language');
		expect(payload.writeFailed).toBeUndefined();
		expect(payload.language).toBe('mojo'); // unchanged by the refusal
	});

	it('reports the held language on the .py refusal too, so every reply settles the select', async () => {
		const res = await post({ language: 'mojo', path: PY });
		expect(res.status).toBe(400);
		const payload = await res.json();
		expect(payload.reason).toBe('mojo-in-py-notebook');
		expect(payload.language).toBe('python');
	});
});
