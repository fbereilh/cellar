/**
 * nbdev's `#| export` directive as a source of a cell's export mark, end to end
 * through the REAL document layer, the REAL exporter and the REAL agent surface.
 *
 * The reported gap: `isExportCell` read only `metadata.cellar.export`, so opening a
 * genuine nbdev notebook Cellar saw ZERO exported cells where nbdev sees several -
 * and marking any cell then wrote a module that did not describe the notebook
 * (scout report section 5.2).
 *
 * ## The two decisions this suite pins, and why they are decisions
 *
 * **1. Which source wins.** Neither can express a NEGATION - nbdev's `#| export` is
 * presence-only, and Cellar's flag is too (the setter DELETES the key rather than
 * storing `false`, and `isExportCell` is a strict `=== true`). So nbdev's
 * comments-beat-metadata rule, Cellar's metadata-first rule and a plain union are
 * the SAME function on values that can occur, and a cell is exported if either says
 * so. Both directions are asserted here so a future edit cannot quietly pick one.
 *
 * **2. Marking stays metadata-only.** Toggling export in Cellar never writes a `#|`
 * line into the user's source - source is code the kernel runs and git diffs, and
 * the whole reason the flag lives in `metadata.cellar` is that clean-on-save keeps
 * it byte-for-byte. The consequence is that a directive-marked cell cannot be
 * UNMARKED from Cellar, and every surface has to say so rather than report a change
 * the notebook did not take: the doc setter, the PATCH route and MCP each refuse by
 * name, and the `.ipynb` is asserted BYTE-IDENTICAL across the attempt.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let WS: string;
let nbmod: typeof import('../../src/lib/server/notebook');
let expy: typeof import('../../src/lib/server/export-py');
let svc: typeof import('../../src/lib/server/mcp/service');
let role: typeof import('../../src/lib/exportRole');
let patchRoute: typeof import('../../src/routes/api/cells/[id]/+server.js');

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-nbdev-export-'));
	process.env.CELLAR_WORKSPACE = WS;
	nbmod = await import('../../src/lib/server/notebook');
	expy = await import('../../src/lib/server/export-py');
	svc = await import('../../src/lib/server/mcp/service');
	role = await import('../../src/lib/exportRole');
	patchRoute = await import('../../src/routes/api/cells/[id]/+server.js');
});

type CellSpec = { id: string; source: string; type?: string; cellar?: Record<string, unknown> };

/**
 * A notebook written BY HAND, so the doc layer meets exactly the artifact nbdev (or
 * another tool) produced - never one this build's own setter shaped.
 */
function writeNb(rel: string, cells: CellSpec[], nbCellar?: Record<string, unknown>) {
	const abs = join(WS, rel);
	writeFileSync(
		abs,
		JSON.stringify({
			cells: cells.map((c) => ({
				id: c.id,
				cell_type: c.type ?? 'code',
				source: c.source.split(/(?<=\n)/),
				metadata: c.cellar ? { cellar: c.cellar } : {},
				...(c.type === 'markdown' ? {} : { outputs: [], execution_count: null })
			})),
			metadata: nbCellar ? { cellar: nbCellar } : {},
			nbformat: 4,
			nbformat_minor: 5
		})
	);
	return abs;
}

async function patch(id: string, body: Record<string, unknown>) {
	return patchRoute.PATCH({
		params: { id },
		request: new Request('http://x', { method: 'PATCH', body: JSON.stringify(body) })
	} as never);
}

let seq = 0;
let NB: string;
beforeEach(() => {
	NB = `nb${seq++}.ipynb`;
});

describe('a `#| export` directive marks a cell', () => {
	it('is seen by the shared identity, with no metadata anywhere', () => {
		writeNb(NB, [
			{ id: 'a', source: '#| export\ndef marked(): return 1' },
			{ id: 'b', source: 'def unmarked(): return 2' }
		]);
		const cells = nbmod.listCells(NB);
		expect(role.isExportCell(cells[0])).toBe(true);
		expect(role.hasExportDirective(cells[0])).toBe(true);
		expect(role.isExportCell(cells[1])).toBe(false);
		expect(role.exportCellCount(cells)).toBe(1);
	});

	it('builds the module from directive-marked cells', () => {
		writeNb(
			NB,
			[
				{ id: 'a', source: '#| export\ndef marked(): return 1' },
				{ id: 'b', source: 'def unmarked(): return 2' },
				{ id: 'c', source: '#|export\nCONST = 3' }
			],
			{ export_target: 'lib/mod.py' }
		);
		const res = nbmod.exportPy(NB);
		expect(res).toMatchObject({ written: true, count: 2, target: 'lib/mod.py' });
		const text = readFileSync(join(WS, 'lib/mod.py'), 'utf8');
		expect(text).toContain('def marked()');
		expect(text).toContain('CONST = 3');
		expect(text).not.toContain('def unmarked()');
		expect(text).toContain("__all__ = ['marked', 'CONST']");
	});

	it('agrees with nbdev about which export-family names count', () => {
		// `exporti`/`exports`/`exportd` are each a DIFFERENT directive name, so the
		// exact-name test excludes them; a VALUED `#| export other` names a SECOND
		// module in nbdev, which Cellar's one-target-per-notebook model cannot express,
		// so it is not a mark for this notebook's own module either. Under-recognising
		// omits a cell; MIS-recognising writes the wrong source into a file git tracks.
		writeNb(NB, [
			{ id: 'a', source: '#| exporti\ndef i(): pass' },
			{ id: 'b', source: '#| exports\ndef s(): pass' },
			{ id: 'c', source: '#| exportd\ndef d(): pass' },
			{ id: 'e', source: '#| export other\ndef o(): pass' },
			{ id: 'f', source: '#| export\ndef yes(): pass' }
		]);
		const cells = nbmod.listCells(NB);
		expect(cells.map((c) => role.isExportCell(c))).toEqual([false, false, false, false, true]);
	});

	it('ignores a directive nbdev would ignore: after code, and on a non-code cell', () => {
		writeNb(NB, [
			{ id: 'a', source: 'x = 1\n#| export\ndef late(): pass' },
			{ id: 'b', type: 'markdown', source: '#| export\nnot python' },
			{ id: 'c', source: '#| export\ndef ok(): pass', cellar: { language: 'sql' } }
		]);
		const cells = nbmod.listCells(NB);
		expect(cells.map((c) => role.isExportCell(c))).toEqual([false, false, false]);
	});
});

describe('the two mark sources cannot disagree', () => {
	it('either alone marks the cell, and both together are the same answer', () => {
		writeNb(NB, [
			{ id: 'a', source: '#| export\ndef d(): pass' },
			{ id: 'b', source: 'def m(): pass', cellar: { export: true } },
			{ id: 'c', source: '#| export\ndef both(): pass', cellar: { export: true } },
			{ id: 'd', source: 'def none(): pass' }
		]);
		expect(nbmod.listCells(NB).map((c) => role.isExportCell(c))).toEqual([true, true, true, false]);
	});

	it('a hand-edited `export: false` beside a directive still exports', () => {
		// `isExportCell` is a strict `=== true`, so an explicit false already reads the
		// same as absent - which is exactly why neither source can NEGATE the other and
		// why the precedence question has no reachable disagreement to settle.
		writeNb(NB, [{ id: 'a', source: '#| export\ndef d(): pass', cellar: { export: false } }]);
		expect(role.isExportCell(nbmod.listCells(NB)[0])).toBe(true);
	});
});

describe('a directive-marked cell cannot be unmarked from Cellar', () => {
	it('the doc setter refuses BY NAME and writes nothing', () => {
		const abs = writeNb(NB, [{ id: 'a', source: '#| export\ndef d(): pass' }]);
		const before = readFileSync(abs, 'utf8');
		expect(nbmod.setCellExport('a', false, NB)).toEqual({
			ok: false,
			reason: 'export-directive-owns-cell'
		});
		expect(readFileSync(abs, 'utf8')).toBe(before);
		expect(role.isExportCell(nbmod.listCells(NB)[0])).toBe(true);
	});

	it('MARKING one is an honest no-op: it already exports, and nothing is written', () => {
		const abs = writeNb(NB, [{ id: 'a', source: '#| export\ndef d(): pass' }]);
		const before = readFileSync(abs, 'utf8');
		expect(nbmod.setCellExport('a', true, NB)).toEqual({ ok: true });
		expect(readFileSync(abs, 'utf8')).toBe(before);
	});

	it('the batch setter skips it in both directions, changing nothing', () => {
		writeNb(NB, [
			{ id: 'a', source: '#| export\ndef d(): pass' },
			{ id: 'b', source: 'def m(): pass', cellar: { export: true } }
		]);
		// The ordinary cell still unmarks; the directive one is simply not in `changed`.
		expect(nbmod.setCellExports(['a', 'b'], false, NB)).toEqual(['b']);
		expect(nbmod.listCells(NB).map((c) => role.isExportCell(c))).toEqual([true, false]);
	});

	it('the PATCH route reports it as 409, and leaves its siblings reporting as they did', async () => {
		writeNb(NB, [
			{ id: 'a', source: '#| export\ndef d(): pass' },
			{ id: 'b', source: 'def m(): pass' }
		]);
		const refused = await patch('a', { export: false, nb: NB });
		expect(refused.status).toBe(409);
		expect(await refused.json()).toEqual({ ok: false, reason: 'export-directive-owns-cell' });

		// The scope stays exactly where it was: a missing cell and an ineligible one are
		// still silent, because widening the sibling setters is a separate change.
		expect((await patch('no-such-cell', { export: true, nb: NB })).status).toBe(200);
		expect((await patch('b', { export: true, nb: NB })).status).toBe(200);
		expect(role.isExportCell(nbmod.listCells(NB)[1])).toBe(true);
	});

	it('MCP refuses all-or-nothing, naming the handle the agent supplied', () => {
		writeNb(NB, [
			{ id: 'aaaaaaaa-1111-4111-8111-111111111111', source: '#| export\ndef d(): pass' },
			{ id: 'bbbbbbbb-2222-4222-8222-222222222222', source: 'def m(): pass', cellar: { export: true } }
		]);
		const r = svc.setCellExport(
			['bbbbbbbb-2222-4222-8222-222222222222', 'aaaaaaaa-1111-4111-8111-111111111111'],
			false,
			NB
		);
		expect(r).toEqual({ ok: false, exportDirective: 'aaaaaaaa-1111-4111-8111-111111111111' });
		// All-or-nothing: the sibling in the same batch was NOT unmarked.
		expect(nbmod.listCells(NB).map((c) => role.isExportCell(c))).toEqual([true, true]);
	});

	it('does NOT claim to own an INELIGIBLE cell, so a stale flag there still clears', () => {
		// The refusal is a claim about `isExportCell`, which is eligibility-gated: on a
		// markdown/SQL/raw cell the exporter ignores the `#| export` line entirely, so
		// such a cell is NOT exported and reporting the directive as owning it would
		// refuse to clear a flag a hand-edited `.ipynb` really does carry - telling the
		// caller the cell is in a module it was never in.
		const MD = 'mmmmmmmm-1111-4111-8111-111111111111';
		const SQL = 'ssssssss-2222-4222-8222-222222222222';
		const RAW = 'rrrrrrrr-3333-4333-8333-333333333333';
		writeNb(NB, [
			{ id: MD, type: 'markdown', source: '#| export\nprose', cellar: { export: true } },
			{ id: SQL, source: '#| export\nselect 1', cellar: { language: 'sql', export: true } },
			{ id: RAW, type: 'raw', source: '#| export\nfrontmatter', cellar: { export: true } }
		]);
		// None of them is exported in the first place - the shared identity says so.
		expect(nbmod.listCells(NB).map((c) => role.isExportCell(c))).toEqual([false, false, false]);

		// The doc setter unmarks each rather than refusing...
		expect(nbmod.setCellExport(MD, false, NB)).toEqual({ ok: true });
		// ...the batch setter reports it as genuinely CHANGED (it cleared the flag)...
		expect(nbmod.setCellExports([SQL], false, NB)).toEqual([SQL]);
		// ...and MCP unmarks rather than reporting the handle as directive-owned.
		expect(svc.setCellExport([RAW], false, NB)).toMatchObject({ ok: true, count: 1 });

		// Every stale flag is gone from the document.
		expect(nbmod.listCells(NB).map((c) => c.metadata?.cellar?.export)).toEqual([
			undefined,
			undefined,
			undefined
		]);
	});

	it('an ineligible cell with the directive still cannot be MARKED', () => {
		// The other half of the same gate: unmarking one is honest bookkeeping, marking
		// one is a lie the exporter would ignore, so it is refused exactly as before.
		const MD = 'mmmmmmmm-4444-4444-8444-444444444444';
		writeNb(NB, [{ id: MD, type: 'markdown', source: '#| export\nprose' }]);
		expect(nbmod.setCellExport(MD, true, NB)).toEqual({ ok: false, reason: 'not-code' });
		expect(svc.setCellExport([MD], true, NB)).toEqual({ ok: false, notCode: MD });
		expect(nbmod.listCells(NB)[0].metadata?.cellar?.export).toBeUndefined();
	});

	it('MCP still MARKS a batch containing one, since marking is already satisfied', () => {
		writeNb(NB, [
			{ id: 'aaaaaaaa-1111-4111-8111-111111111111', source: '#| export\ndef d(): pass' },
			{ id: 'bbbbbbbb-2222-4222-8222-222222222222', source: 'def m(): pass' }
		]);
		const r = svc.setCellExport(
			['aaaaaaaa-1111-4111-8111-111111111111', 'bbbbbbbb-2222-4222-8222-222222222222'],
			true,
			NB
		);
		expect(r).toMatchObject({ ok: true, count: 2 });
		expect(nbmod.listCells(NB).map((c) => role.isExportCell(c))).toEqual([true, true]);
	});
});

describe('the agent map reports a directive-marked cell as exported', () => {
	it('carries export:true for it, exactly as for a metadata-marked one', async () => {
		writeNb(
			NB,
			[
				{ id: 'aaaaaaaa-1111-4111-8111-111111111111', source: '#| export\ndef d(): pass' },
				{ id: 'bbbbbbbb-2222-4222-8222-222222222222', source: 'def plain(): pass' }
			],
			{ export_target: 'lib/agent.py' }
		);
		const map = await svc.getNotebookMap(NB);
		const leaves = JSON.stringify(map);
		expect(leaves).toContain('"export":true');
		// ...and the module the map describes is really the one on disk.
		expect(nbmod.exportPy(NB)).toMatchObject({ written: true, count: 1 });
		expect(existsSync(join(WS, 'lib/agent.py'))).toBe(true);
	});
});
