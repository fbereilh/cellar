/**
 * A RAW cell on a `.py` (jupytext / Databricks source) notebook: REFUSED, never
 * silently degraded.
 *
 * Such a notebook is rebuilt from its CELLS on every save — `writePyNotebook`
 * coerces every `cell_type` to markdown|code, and `readPyNotebook` coerces again
 * on read — so a raw cell would live only in memory while disk held a `code`
 * cell. After a reload the frontmatter would sit in a cell with a Run button, the
 * exact silent degrade a first-class raw type exists to prevent, and worse from
 * MARKDOWN, whose prose would lose its markers on the way too.
 *
 * The rule therefore lives at EVERY doc-layer WRITER that can put `raw` into a
 * document (`assertCanHoldType`: the two that convert a cell and the two that
 * create one), so the type menu, the `r` chord, the bulk route, the REST routes
 * and every MCP add / convert tool are covered by ONE rule rather than by a check
 * each could forget.
 * Everything else is untouched: any other conversion on a `.py` notebook, and
 * every raw cell in an `.ipynb`.
 *
 * The jupytext bridge is stubbed (`notebook-root-py.test.ts`'s precedent):
 * reading a real `.py` notebook shells out to the project venv's python, and what
 * is under test is the notebook layer's rule, not the converter.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TEXT_NOTEBOOK_RAW_MESSAGE, TextNotebookCellTypeError } from '../../src/lib/cellLanguage';

const PY_BYTES = '# Databricks notebook source\nprint(1)\n\n# COMMAND ----------\n\nprint(2)\n';

vi.mock('../../src/lib/server/jupytext', async () => {
	const actual = await vi.importActual<typeof import('../../src/lib/server/jupytext')>(
		'../../src/lib/server/jupytext'
	);
	return {
		...actual,
		// Two code cells, without python. `jpFormat` is what the notebook layer keys
		// the refusal off, and it is set from this.
		readPyNotebook: () => ({
			format: 'databricks',
			cells: [
				{ id: null, cell_type: 'code', source: 'print(1)', outputs: [], metadata: {} },
				{ id: null, cell_type: 'code', source: 'print(2)', outputs: [], metadata: {} }
			]
		}),
		// The REAL writer's coercion, reproduced: this is the degrade being refused.
		writePyNotebook: (path: string, cells: { cell_type: string; source: string }[]) => {
			writeFileSync(
				path,
				cells.map((c) => `# ${c.cell_type === 'markdown' ? 'MAGIC %md' : 'CODE'}\n${c.source}`).join('\n\n# COMMAND ----------\n\n') + '\n'
			);
		}
	};
});

let WS: string;
let nbmod: typeof import('../../src/lib/server/notebook');
let svc: typeof import('../../src/lib/server/mcp/service');
let PY: string;
let IPYNB: string;

/** The two cells of the stubbed `.py` notebook, in document order. */
const pyIds = () => nbmod.listCells(PY).map((c) => c.id);

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-raw-py-'));
	process.env.CELLAR_WORKSPACE = WS;
	PY = join(WS, 'dbx.py');
	writeFileSync(PY, PY_BYTES);
	nbmod = await import('../../src/lib/server/notebook');
	svc = await import('../../src/lib/server/mcp/service');
	IPYNB = nbmod.createNotebook('normal.ipynb').path;
});

describe('a .py notebook cannot hold a raw cell', () => {
	it('REFUSES setCellType(raw), naming the cause — and writes nothing', () => {
		const id = pyIds()[0];
		expect(() => nbmod.setCellType(id, 'raw', PY)).toThrow(TextNotebookCellTypeError);
		expect(() => nbmod.setCellType(id, 'raw', PY)).toThrow(/\.py notebook cannot hold a raw cell/i);
		// The message states the REAL cause (rebuilt from its cells) and the fix.
		expect(() => nbmod.setCellType(id, 'raw', PY)).toThrow(/rebuilt from its CELLS/);
		expect(() => nbmod.setCellType(id, 'raw', PY)).toThrow(/convert it to \.ipynb/i);
		// Refused BEFORE any mutation: the cell is untouched and the file is the text
		// notebook it was, not a rewritten one.
		expect(nbmod.listCells(PY)[0].cell_type).toBe('code');
		expect(readFileSync(PY, 'utf8')).toBe(PY_BYTES);
	});

	it('refuses a raw conversion of a MARKDOWN cell too (its prose would become code)', () => {
		const id = pyIds()[1];
		nbmod.setCellType(id, 'markdown', PY);
		expect(nbmod.listCells(PY)[1].cell_type).toBe('markdown');
		expect(() => nbmod.setCellType(id, 'raw', PY)).toThrow(/raw cell/i);
		expect(nbmod.listCells(PY)[1].cell_type).toBe('markdown');
		nbmod.setCellType(id, 'code', PY); // put it back for the tests below
	});

	it('leaves EVERY OTHER conversion allowed on a .py notebook', () => {
		const id = pyIds()[0];
		for (const type of ['markdown', 'sql', 'code'] as const) {
			nbmod.setCellType(id, type, PY);
		}
		expect(nbmod.listCells(PY)[0].cell_type).toBe('code');
	});

	it('refuses a BULK retype for the whole batch — nothing is converted', () => {
		const ids = pyIds();
		expect(() => nbmod.setCellTypes(ids, 'raw', PY)).toThrow(TextNotebookCellTypeError);
		// Not one cell half-retyped, and no `changed` list a client could read as a
		// legitimate skip.
		expect(nbmod.listCells(PY).map((c) => c.cell_type)).toEqual(['code', 'code']);
	});

	it('refuses CREATING one (addCell), so the add path cannot route around the convert path', () => {
		const before = pyIds().length;
		expect(() => nbmod.addCell(null, 'raw', PY)).toThrow(TextNotebookCellTypeError);
		expect(pyIds().length).toBe(before);
		// The types it CAN hold still add.
		nbmod.addCell(null, 'markdown', PY);
		expect(pyIds().length).toBe(before + 1);
	});

	it('refuses the OTHER creator too (addCellAt), so the guard holds by construction', () => {
		// Its only caller passes 'code' today, so this is unreachable in practice - but
		// `assertCanHoldType` claims to sit at every writer, and a second creator that
		// merely happens not to be asked for raw is not that claim.
		const before = pyIds().length;
		expect(() => nbmod.addCellAt(0, 'raw', PY)).toThrow(TextNotebookCellTypeError);
		expect(pyIds().length).toBe(before);
		nbmod.addCellAt(0, 'code', PY);
		expect(pyIds().length).toBe(before + 1);
	});
});

describe('the MCP surface reports the refusal instead of a bare ok', () => {
	it('set_cell_type raw comes back refused, with the shared message', () => {
		const id = pyIds()[0];
		const r = svc.setType(id, 'raw', PY);
		expect(r.ok).toBe(false);
		expect(r).toMatchObject({ refused: TEXT_NOTEBOOK_RAW_MESSAGE });
		expect(nbmod.listCells(PY)[0].cell_type).toBe('code');
	});

	it('set_cell_type still converts to every other type on a .py notebook', () => {
		const id = pyIds()[0];
		expect(svc.setType(id, 'markdown', PY).ok).toBe(true);
		expect(nbmod.listCells(PY)[0].cell_type).toBe('markdown');
		expect(svc.setType(id, 'code', PY).ok).toBe(true);
	});

	it('set_cell_type on an id that does not exist is still a miss, not a refusal', () => {
		const r = svc.setType('00000000-0000-4000-8000-000000000000', 'code', PY);
		expect(r).toEqual({ ok: false, missing: true });
	});

	it('add_cells refuses a raw spec for the WHOLE batch, before anything is written', async () => {
		const before = pyIds();
		await expect(
			svc.addCells([{ cell_type: 'code', source: 'x = 1' }, { cell_type: 'raw', source: '---\ntitle: t\n---' }], null, { nb: PY })
		).rejects.toThrow(TextNotebookCellTypeError);
		// All-or-nothing: the leading code spec did not land either.
		expect(pyIds()).toEqual(before);
	});
});

describe('the REST routes report the refusal in the shape the browser resyncs on', () => {
	let PATCH: (evt: { params: { id: string }; request: Request }) => Promise<Response>;
	let ADD: (evt: { request: Request }) => Promise<Response>;
	let BULK: (evt: { request: Request }) => Promise<Response>;

	beforeAll(async () => {
		PATCH = (await import('../../src/routes/api/cells/[id]/+server.js')).PATCH as unknown as typeof PATCH;
		ADD = (await import('../../src/routes/api/cells/+server.js')).POST as unknown as typeof ADD;
		BULK = (await import('../../src/routes/api/cells/bulk/+server.js')).POST as unknown as typeof BULK;
	});

	const body = (url: string, payload: unknown) => new Request(url, { method: 'POST', body: JSON.stringify(payload) });

	it('PATCH, POST and the bulk retype all answer 400 with the same named reason', async () => {
		const id = pyIds()[0];
		const calls: Promise<Response>[] = [
			PATCH({
				params: { id },
				request: new Request(`http://x/api/cells/${id}`, { method: 'PATCH', body: JSON.stringify({ cell_type: 'raw', nb: PY }) })
			}),
			ADD({ request: body('http://x/api/cells', { afterId: id, cellType: 'raw', nb: PY }) }),
			BULK({ request: body('http://x/api/cells/bulk', { op: 'type', ids: pyIds(), cellType: 'raw', nb: PY }) })
		];
		for (const call of calls) {
			const res = await call;
			expect(res.status).toBe(400);
			const payload = await res.json();
			// One reason code, so the client maps all three to ONE notice - and the
			// message is the shared one, not a per-route paraphrase.
			expect(payload.reason).toBe('raw-in-py-notebook');
			expect(payload.message).toBe(TEXT_NOTEBOOK_RAW_MESSAGE);
		}
		expect(nbmod.listCells(PY).every((c) => c.cell_type !== 'raw')).toBe(true);
	});

	it('PATCH writes NO other field of a body whose raw conversion it refuses', async () => {
		const id = pyIds()[0];
		const before = nbmod.listCells(PY)[0].source;
		const res = await PATCH({
			params: { id },
			request: new Request(`http://x/api/cells/${id}`, {
				method: 'PATCH',
				body: JSON.stringify({ source: 'clobbered = 1', cell_type: 'raw', nb: PY })
			})
		});
		expect(res.status).toBe(400);
		expect(nbmod.listCells(PY)[0].source).toBe(before);
	});

	it('a refusal is not a 500: nothing escapes as an unhandled throw', async () => {
		const id = pyIds()[0];
		const res = await BULK({ request: body('http://x/api/cells/bulk', { op: 'type', ids: [id], cellType: 'raw', nb: PY }) });
		expect(res.status).toBe(400);
		// And the refused batch reports no `changed` list a client could read as a
		// legitimate skip.
		expect(await res.json()).not.toHaveProperty('changed');
	});
});

describe('an .ipynb notebook is completely unaffected', () => {
	it('creates, converts and persists a raw cell exactly as before', () => {
		const created = nbmod.addCell(null, 'raw', IPYNB);
		expect(created.cell_type).toBe('raw');
		const first = nbmod.listCells(IPYNB)[0].id;
		nbmod.setCellType(first, 'raw', IPYNB);
		expect(nbmod.listCells(IPYNB)[0].cell_type).toBe('raw');
		nbmod.setCellTypes([first], 'code', IPYNB);
		expect(nbmod.listCells(IPYNB)[0].cell_type).toBe('code');
		// On disk too — the refusal is about `.py`, not about raw.
		expect(JSON.parse(readFileSync(IPYNB, 'utf8')).cells.some((c: { cell_type: string }) => c.cell_type === 'raw')).toBe(true);
	});

	it('lets an agent add a raw cell through the MCP path', async () => {
		const r = await svc.addCells([{ cell_type: 'raw', source: '---\ntitle: t\n---' }], null, { nb: IPYNB });
		expect(r.ids.length).toBe(1);
	});
});

/**
 * The BROWSER half, as source guards: vitest runs without the SvelteKit plugin,
 * so these components cannot be mounted here, and e2e is deliberately absent from
 * CI and the gate - each of these rules is one expression wide, and losing it
 * silently puts back a control that offers a conversion the server refuses.
 */
describe('the client half (source guards)', () => {
	const read = (rel: string) => readFileSync(new URL(`../../src/lib/${rel}`, import.meta.url), 'utf8');

	it('Cell.svelte renders NO Raw entry in the type menu of a .py notebook', () => {
		const src = read('Cell.svelte');
		// The menu iterates the FILTERED list, and the filter drops every type a .py
		// notebook cannot hold (raw, chat) - by ASKING the shared `offersCellType`
		// rule, whose meaning is executed in `add-chat-cell-controls.test.ts`.
		expect(src).toMatch(/\{#each typeOptions as opt\}/);
		expect(src).toMatch(/ALL_TYPE_OPTIONS\.filter\(\(o\) => offersCellType\(o\.v, isPy\)\)/);
		// The unfiltered list is never rendered directly.
		expect(src).not.toMatch(/\{#each ALL_TYPE_OPTIONS/);
	});

	it('LiveNotebook.svelte SAYS why a raw conversion did nothing, on every path that offers one', () => {
		const src = read('LiveNotebook.svelte');
		// The optimistic mirror of `assertCanHoldType`, in ONE predicate.
		expect(src).toMatch(/function refuseUnsupportedType\(cellType: LogicalCellType\): boolean \{[\s\S]*?offersCellType\(cellType, isPy\)/);
		// The single-cell setter AND the multi-cell batch (`r`, the palette) consult
		// it - a keystroke that sends no request disables no control, so a silent
		// return reads as a dead key.
		expect(src).toMatch(/async function setType\(id: string, cellType: LogicalCellType\) \{\s*\n\s*if \(refuseUnsupportedType\(cellType\)\) return;/);
		expect(src).toMatch(/if \(refuseUnsupportedType\(cellType\)\) return;\s*\n\s*\/\/ A cell already of the target type/);
		expect(src).toMatch(/if \(isPy && entries\.some\(\(e\) => e\.cell_type === 'raw'\)\) return noticeUnsupportedType\('raw'\)/);
		// And a refusal this tab did not predict is still surfaced + resynced: the
		// route emits no `cell:type`, and this tab would echo-suppress it anyway.
		expect(src).toMatch(/PY_UNSUPPORTED_TYPES\.find\(\(t\) => textNotebookTypeReason\(t\) === reason\)[\s\S]*?noticeUnsupportedType\(refused\)/);
		expect(src).toMatch(/if \(!res \|\| !res\.ok\) \{\s*\n\s*await noticeRefusal\(res\);\s*\n\s*await load\(\);/);
	});
});

describe('NO path can leave a .py notebook holding a degraded raw cell', () => {
	it('every writer refuses, so the persisted file never sees cell_type raw', () => {
		const id = pyIds()[0];
		for (const write of [
			() => nbmod.setCellType(id, 'raw', PY),
			() => nbmod.setCellTypes(pyIds(), 'raw', PY),
			() => nbmod.addCell(id, 'raw', PY),
			() => nbmod.addCellAt(0, 'raw', PY)
		]) {
			expect(write).toThrow(TextNotebookCellTypeError);
		}
		expect(nbmod.listCells(PY).every((c) => c.cell_type !== 'raw')).toBe(true);
		expect(readFileSync(PY, 'utf8')).not.toMatch(/raw/i);
	});
});
