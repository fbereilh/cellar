/**
 * A CHAT cell on a `.py` (jupytext / Databricks source) notebook: REFUSED,
 * never silently degraded - the raw precedent, applied to the fifth logical
 * type through the SAME `assertCanHoldType` guard.
 *
 * Such a notebook is rebuilt from its CELLS on every save and carries neither
 * `cellar` cell metadata nor outputs, so `cellar.language = 'chat'` AND the
 * persisted reply would live only in memory: after a reload the cell is a
 * RUNNABLE Python cell holding English prose (SyntaxError on run) and the AI
 * reply is gone for good - worse than the raw case, since no re-run reproduces
 * a model reply.
 *
 * The jupytext bridge is stubbed exactly as in `raw-cell-py-notebook.test.ts`:
 * reading a real `.py` notebook shells out to the project venv's python, and
 * what is under test is the notebook layer's rule, not the converter.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TEXT_NOTEBOOK_CHAT_MESSAGE, TextNotebookCellTypeError, isPyUnsupportedType } from '../../src/lib/cellLanguage';

const PY_BYTES = '# Databricks notebook source\nprint(1)\n\n# COMMAND ----------\n\nprint(2)\n';

vi.mock('../../src/lib/server/jupytext', async () => {
	const actual = await vi.importActual<typeof import('../../src/lib/server/jupytext')>(
		'../../src/lib/server/jupytext'
	);
	return {
		...actual,
		readPyNotebook: () => ({
			format: 'databricks',
			cells: [
				{ id: null, cell_type: 'code', source: 'print(1)', outputs: [], metadata: {} },
				{ id: null, cell_type: 'code', source: 'print(2)', outputs: [], metadata: {} }
			]
		}),
		// The REAL writer's coercion, reproduced: no metadata, no outputs. This is
		// the degrade being refused.
		writePyNotebook: (path: string, cells: { cell_type: string; source: string }[]) => {
			writeFileSync(path, cells.map((c) => c.source).join('\n\n# COMMAND ----------\n\n') + '\n');
		}
	};
});

let WS: string;
let nbmod: typeof import('../../src/lib/server/notebook');
let PY: string;
let IPYNB: string;

const pyIds = () => nbmod.listCells(PY).map((c) => c.id);

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-chat-py-'));
	process.env.CELLAR_WORKSPACE = WS;
	PY = join(WS, 'dbx.py');
	writeFileSync(PY, PY_BYTES);
	nbmod = await import('../../src/lib/server/notebook');
	IPYNB = nbmod.createNotebook('normal.ipynb').path;
});

describe('the shared rule names both types a .py notebook cannot hold', () => {
	it('raw and chat are refused; every other logical type is not', () => {
		expect(isPyUnsupportedType('raw')).toBe(true);
		expect(isPyUnsupportedType('chat')).toBe(true);
		for (const t of ['code', 'sql', 'markdown']) expect(isPyUnsupportedType(t)).toBe(false);
	});
});

describe('a .py notebook cannot hold a chat cell', () => {
	it('REFUSES setCellType(chat), naming the REPLY it would lose - and writes nothing', () => {
		const id = pyIds()[0];
		expect(() => nbmod.setCellType(id, 'chat', PY)).toThrow(TextNotebookCellTypeError);
		expect(() => nbmod.setCellType(id, 'chat', PY)).toThrow(/\.py notebook cannot hold a chat cell/i);
		expect(() => nbmod.setCellType(id, 'chat', PY)).toThrow(/rebuilt from its CELLS/);
		expect(() => nbmod.setCellType(id, 'chat', PY)).toThrow(/reply would be gone/i);
		expect(() => nbmod.setCellType(id, 'chat', PY)).toThrow(/convert it to \.ipynb/i);
		// Refused BEFORE any mutation.
		expect(nbmod.listCells(PY)[0].metadata?.cellar?.language).toBeUndefined();
		expect(readFileSync(PY, 'utf8')).toBe(PY_BYTES);
	});

	it('the refusal carries its OWN reason code, distinct from the raw one', () => {
		const id = pyIds()[0];
		try {
			nbmod.setCellType(id, 'chat', PY);
			throw new Error('expected a refusal');
		} catch (err) {
			expect(err).toBeInstanceOf(TextNotebookCellTypeError);
			expect((err as TextNotebookCellTypeError).cellType).toBe('chat');
			expect((err as TextNotebookCellTypeError).reason).toBe('chat-in-py-notebook');
			expect((err as TextNotebookCellTypeError).message).toBe(TEXT_NOTEBOOK_CHAT_MESSAGE);
		}
	});

	it('refuses the BULK retype for the whole batch - nothing is converted', () => {
		expect(() => nbmod.setCellTypes(pyIds(), 'chat', PY)).toThrow(TextNotebookCellTypeError);
		expect(nbmod.listCells(PY).every((c) => c.metadata?.cellar?.language !== 'chat')).toBe(true);
	});

	it('refuses BOTH creators, so no add path routes around the convert path', () => {
		const before = pyIds().length;
		expect(() => nbmod.addCell(null, 'chat', PY)).toThrow(TextNotebookCellTypeError);
		expect(() => nbmod.addCellAt(0, 'chat', PY)).toThrow(TextNotebookCellTypeError);
		expect(pyIds().length).toBe(before);
	});

	it('leaves every OTHER conversion allowed, and CLEARING back to code untouched', () => {
		const id = pyIds()[0];
		for (const type of ['markdown', 'sql', 'code'] as const) nbmod.setCellType(id, type, PY);
		expect(nbmod.listCells(PY)[0].cell_type).toBe('code');
		expect(nbmod.listCells(PY)[0].metadata?.cellar?.language).toBeUndefined();
	});
});

describe('the REST route reports the chat refusal in the shape the browser resyncs on', () => {
	let PATCH: (evt: { params: { id: string }; request: Request }) => Promise<Response>;
	let ADD: (evt: { request: Request }) => Promise<Response>;

	beforeAll(async () => {
		PATCH = (await import('../../src/routes/api/cells/[id]/+server.js')).PATCH as unknown as typeof PATCH;
		ADD = (await import('../../src/routes/api/cells/+server.js')).POST as unknown as typeof ADD;
	});

	it('PATCH and POST answer 400 carrying the chat reason and the shared message', async () => {
		const id = pyIds()[0];
		const responses = await Promise.all([
			PATCH({
				params: { id },
				request: new Request(`http://x/api/cells/${id}`, { method: 'PATCH', body: JSON.stringify({ cell_type: 'chat', nb: PY }) })
			}),
			ADD({
				request: new Request('http://x/api/cells', { method: 'POST', body: JSON.stringify({ afterId: id, cellType: 'chat', nb: PY }) })
			})
		]);
		for (const res of responses) {
			expect(res.status).toBe(400);
			const payload = await res.json();
			expect(payload.reason).toBe('chat-in-py-notebook');
			expect(payload.message).toBe(TEXT_NOTEBOOK_CHAT_MESSAGE);
		}
		expect(nbmod.listCells(PY).every((c) => c.metadata?.cellar?.language !== 'chat')).toBe(true);
	});
});

describe('an .ipynb notebook is completely unaffected', () => {
	it('creates and converts a chat cell, and the tag survives to disk', () => {
		const created = nbmod.addCell(null, 'chat', IPYNB);
		expect(created.metadata?.cellar?.language).toBe('chat');
		const first = nbmod.listCells(IPYNB)[0].id;
		nbmod.setCellType(first, 'chat', IPYNB);
		expect(nbmod.listCells(IPYNB)[0].metadata?.cellar?.language).toBe('chat');
		const onDisk = JSON.parse(readFileSync(IPYNB, 'utf8')) as { cells: Array<{ metadata?: { cellar?: { language?: string } } }> };
		expect(onDisk.cells.some((c) => c.metadata?.cellar?.language === 'chat')).toBe(true);
	});
});
