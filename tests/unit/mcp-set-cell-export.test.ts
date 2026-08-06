/**
 * MCP `set_cell_export`: choosing WHICH cells become the nbdev-style `.py` module.
 *
 * `set_export_target` already let an agent name the module and cellar already
 * regenerated it on every save, but `metadata.cellar.export` - the flag that says
 * which cells go IN it - was settable only in the UI, so the agent-side export
 * flow had no middle. This is that half, in `delete_cells`' shape: batch,
 * handle-addressed, all-or-nothing.
 *
 * The contracts worth pinning are the ones a wrong guess would silently break:
 * only a CODE cell can be marked (marking a markdown cell would record a flag
 * `isExportCell` ignores, so an agent would be told a cell is in a module it is
 * not), a refused batch writes NOTHING, the batch is ONE document write and ONE
 * `.py` regeneration rather than one per cell, an idempotent re-mark rewrites
 * nothing at all, and the marked state is READABLE over MCP so the mark → target
 * → module loop can be driven end to end.
 *
 * Drives the REAL service + notebook + export-py singletons against a scratch
 * workspace, with import-free sources (routeImports:false) so nothing touches the
 * kernel or the python dataflow subprocess.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

vi.mock('../../src/lib/server/dataflow', () => ({
	getNotebookStaleness: async () => ({ sid: null, cells: {} }),
	analyzeDataflow: async () => ({})
}));

// A `.py` text notebook without the python toolchain: the reader yields two code
// cells and the writer only RECORDS, so "did this path spend a jupytext write"
// is observable.
const py = vi.hoisted(() => ({ writes: [] as string[] }));
vi.mock('../../src/lib/server/jupytext', async (importOriginal) => {
	const real = await importOriginal<typeof import('../../src/lib/server/jupytext')>();
	return {
		...real,
		readPyNotebook: () => ({
			format: 'percent',
			cells: [0, 1].map((i) => ({ id: null, cell_type: 'code', source: `a = ${i}`, outputs: [], metadata: {} }))
		}),
		writePyNotebook: (path: string) => {
			py.writes.push(path);
		}
	};
});

// The REAL exporter, wrapped only to count how often a write path regenerates the
// module - the cost claim a per-cell loop would break.
const exp = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../../src/lib/server/export-py', async (importOriginal) => {
	const real = await importOriginal<typeof import('../../src/lib/server/export-py')>();
	return {
		...real,
		exportNotebookToPy: (doc: Parameters<typeof real.exportNotebookToPy>[0]) => {
			exp.calls++;
			return real.exportNotebookToPy(doc);
		}
	};
});

let WS: string;
let svc: typeof import('../../src/lib/server/mcp/service');
let nbmod: typeof import('../../src/lib/server/notebook');
let events: typeof import('../../src/lib/server/events');
let srv: typeof import('../../src/lib/server/mcp/server');

const abs = (rel: string) => nbmod.resolveNotebookPath(rel);

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-set-cell-export-'));
	process.env.CELLAR_WORKSPACE = WS;
	svc = await import('../../src/lib/server/mcp/service');
	nbmod = await import('../../src/lib/server/notebook');
	events = await import('../../src/lib/server/events');
	srv = await import('../../src/lib/server/mcp/server');
});

/**
 * A notebook holding two code cells and one markdown cell (in that order after
 * the empty starter cell a new notebook is created with). Returns the emitted
 * handles - what an agent actually gets back and feeds to this tool.
 */
async function makeNotebook(name: string): Promise<{ target: string; code: string[]; md: string }> {
	const target = abs(name);
	svc.useNotebook(`sess-${name}`, name);
	const { ids } = await svc.addCells(
		[
			{ cell_type: 'code', source: 'def one():\n    return 1' },
			{ cell_type: 'code', source: 'def two():\n    return 2' },
			{ cell_type: 'markdown', source: '# Notes' }
		],
		null,
		{ nb: target, routeImports: false }
	);
	return { target, code: [ids[0], ids[1]], md: ids[2] };
}

/** Is this cell (by handle) marked for export in the live document? */
const marked = (target: string, handle: string) =>
	nbmod.getCell(svc.resolveRef(target, handle), target)?.metadata?.cellar?.export === true;

describe('set_cell_export marks and unmarks code cells', () => {
	it('marks the named cells and reports the resulting state', async () => {
		const { target, code } = await makeNotebook('mark.ipynb');
		const r = svc.setCellExport([code[0]], true, target);

		expect(r).toMatchObject({ ok: true, count: 1 });
		expect(r.ok && r.exported).toEqual([code[0]]);
		expect(marked(target, code[0])).toBe(true);
		expect(marked(target, code[1])).toBe(false);
	});

	it('marks several cells in one call and unmarks them again', async () => {
		const { target, code } = await makeNotebook('mark-many.ipynb');
		expect(svc.setCellExport(code, true, target)).toMatchObject({ ok: true, count: 2 });
		expect(code.every((h) => marked(target, h))).toBe(true);

		const off = svc.setCellExport(code, false, target);
		expect(off).toMatchObject({ ok: true, count: 2 });
		expect(code.some((h) => marked(target, h))).toBe(false);
	});

	it('collapses duplicate ids instead of reporting the cell twice', async () => {
		const { target, code } = await makeNotebook('mark-dupes.ipynb');
		const r = svc.setCellExport([code[0], code[0], code[1]], true, target);
		expect(r.ok && r.exported).toEqual([code[0], code[1]]);
		expect(r.ok && r.count).toBe(2);
	});

	it('reports the resulting state on a re-mark, and rewrites nothing', async () => {
		const { target, code } = await makeNotebook('mark-idempotent.ipynb');
		svc.setCellExport(code, true, target);
		const before = readFileSync(target, 'utf8');

		// A no-op batch must not read as a failure (an empty list would), and must
		// not touch the document: zero git diff, no `.py` mtime churn.
		exp.calls = 0;
		const seen: unknown[] = [];
		const off = events.subscribe((e) => {
			if ((e as { type?: string }).type === 'cell:export') seen.push(e);
		});
		const again = svc.setCellExport(code, true, target);
		off();

		expect(again).toMatchObject({ ok: true, count: 2 });
		expect(again.ok && again.exported).toEqual(code);
		expect(readFileSync(target, 'utf8')).toBe(before);
		expect(seen).toHaveLength(0);
		expect(exp.calls).toBe(0);
	});

	it('emits one cell:export event per changed cell, for the UI badge', async () => {
		const { target, code } = await makeNotebook('mark-events.ipynb');
		const seen: Record<string, unknown>[] = [];
		const off = events.subscribe((e) => {
			if ((e as { type?: string }).type === 'cell:export') seen.push(e as Record<string, unknown>);
		});
		svc.setCellExport(code, true, target);
		off();

		expect(seen).toHaveLength(2);
		expect(seen[0]).toMatchObject({ type: 'cell:export', nb: target, exported: true });
		expect(seen.map((e) => e.cellId)).toEqual(code.map((h) => svc.resolveRef(target, h)));
	});

	it('is ONE document write and ONE module regeneration for the whole batch', async () => {
		const { target, code } = await makeNotebook('mark-one-write.ipynb');
		svc.setExportTarget('lib/batch.py', target);
		exp.calls = 0;
		svc.setCellExport(code, true, target);
		// A loop over the single-cell form would persist - and regenerate the `.py` -
		// once per cell, walking both files through every intermediate state.
		expect(exp.calls).toBe(1);
	});
});

describe('only code cells can be exported', () => {
	it('refuses to mark a markdown cell, naming it, and marks nothing in that batch', async () => {
		const { target, code, md } = await makeNotebook('mark-md.ipynb');
		const r = svc.setCellExport([code[0], md], true, target);

		expect(r).toEqual({ ok: false, notCode: md });
		// All-or-nothing: the code cell listed BEFORE the offender is untouched, so a
		// half-marked module can never be built from a refused call.
		expect(marked(target, code[0])).toBe(false);
	});

	it('refuses to mark a SQL cell, which is an nbformat code cell', async () => {
		const { target, code } = await makeNotebook('mark-sql.ipynb');
		svc.setType(code[1], 'sql', target);
		svc.setExportTarget('lib/sql-guard.py', target);

		// A SQL cell IS `cell_type:'code'` (tagged cellar.language='sql'), so a
		// nbformat-type test admits one and its raw SQL is concatenated into a module
		// git tracks - invalid Python in a committed file.
		const r = svc.setCellExport([code[1]], true, target);
		expect(r).toEqual({ ok: false, notCode: code[1] });
		expect(marked(target, code[1])).toBe(false);

		svc.setCellExport([code[0]], true, target);
		expect(readFileSync(join(WS, 'lib/sql-guard.py'), 'utf8')).toContain('def one():');
	});

	it('refuses an nbformat raw cell, which the logical type alone reads as code', () => {
		// `ipynb.ts` passes an externally-authored `raw` cell through untouched, and
		// `logicalCellType` maps everything non-markdown to 'code' - so the guard is the
		// STRICT `isLogicalCellType`, or a raw cell's contents reach the module.
		const target = abs('mark-raw.ipynb');
		writeFileSync(
			target,
			JSON.stringify({
				nbformat: 4,
				nbformat_minor: 5,
				metadata: {},
				cells: [
					{ id: 'py-cell', cell_type: 'code', source: ['def one():\n', '    return 1'], metadata: {}, outputs: [], execution_count: null },
					{ id: 'raw-cell', cell_type: 'raw', source: ['not python at all'], metadata: {} }
				]
			})
		);
		const cells = nbmod.listCells(target);
		expect(cells[1].cell_type).toBe('raw');

		expect(svc.setCellExport([cells[1].id], true, target)).toEqual({ ok: false, notCode: cells[1].id });
		expect(nbmod.getCell(cells[1].id, target)?.metadata?.cellar?.export).toBeUndefined();
	});

	it('never writes a SQL cell into the module even if the flag is already on it', async () => {
		const { target, code } = await makeNotebook('sql-stale-flag.ipynb');
		const sqlId = svc.resolveRef(target, code[1]);
		// The SOURCE goes through the document: `getCell` hands back a projection
		// whose `source` is a copied string, so assigning it changes nothing and the
		// module assertion below would pass vacuously against the original `def two`.
		nbmod.setSource(sqlId, 'SELECT 1', target);
		const sql = nbmod.getCell(sqlId, target)!;
		sql.metadata = sql.metadata ?? {};
		sql.metadata.cellar = { ...(sql.metadata.cellar ?? {}), language: 'sql' };
		// A hand-edited .ipynb (or a flag predating the guard) can carry it anyway.
		sql.metadata.cellar.export = true;
		expect(nbmod.getCell(sqlId, target)?.source).toBe('SELECT 1');

		svc.setExportTarget('lib/sql-stale.py', target);
		svc.setCellExport([code[0]], true, target);
		const module = readFileSync(join(WS, 'lib/sql-stale.py'), 'utf8');
		// `isExportCell` is the ONE identity the exporter, the badge and the agent map
		// all read, so a stale flag is inert everywhere rather than only at the setter.
		expect(module).toContain('def one():');
		expect(module).not.toContain('SELECT 1');

		const map = await svc.getNotebookMap(target);
		const flat = (map.sections as { id: string; export?: boolean; children?: unknown[] }[]).flatMap(
			function walk(n): { id: string; export?: boolean }[] {
				return [n, ...((n.children ?? []) as typeof n[]).flatMap(walk)];
			}
		);
		expect(flat.find((n) => n.id === code[0])?.export).toBe(true);
		expect(flat.find((n) => n.id === code[1])?.export).toBeUndefined();
	});

	it('unmarks any cell, which is how a stale flag is cleared', async () => {
		const { target, code, md } = await makeNotebook('unmark-md.ipynb');
		// A hand-edited .ipynb can carry the flag on a non-code cell; `isExportCell`
		// ignores it, but asking for it to be gone must still work.
		const mdCell = nbmod.getCell(svc.resolveRef(target, md), target)!;
		mdCell.metadata = mdCell.metadata ?? {};
		mdCell.metadata.cellar = { ...(mdCell.metadata.cellar ?? {}), export: true };

		expect(svc.setCellExport([md, code[0]], false, target)).toMatchObject({ ok: true, count: 2 });
		expect(marked(target, md)).toBe(false);
	});
});

describe('addressing is all-or-nothing', () => {
	it('marks nothing when any handle is unknown', async () => {
		const { target, code } = await makeNotebook('mark-bad-handle.ipynb');
		const r = svc.setCellExport([code[0], 'deadbeef-no-such-cell'], true, target);

		expect(r).toEqual({ ok: false, missing: 'deadbeef-no-such-cell' });
		expect(marked(target, code[0])).toBe(false);
	});

	it('refuses an empty batch rather than silently succeeding', async () => {
		const { target } = await makeNotebook('mark-empty.ipynb');
		expect(svc.setCellExport([], true, target)).toEqual({ ok: false, missing: null });
	});

	it('a cell hidden from the agent reads as not found, and is never exported', async () => {
		const { target, code } = await makeNotebook('mark-hidden.ipynb');
		svc.setCellVisibility(code[1], true, target);

		// Marking copies a cell's SOURCE into a file the agent can open, so this
		// follows the READ tools (hidden ⇒ not found), not delete_cells (which
		// discloses nothing). All-or-nothing still applies to the rest of the batch.
		expect(svc.setCellExport([code[0], code[1]], true, target)).toEqual({ ok: false, missing: code[1] });
		expect(marked(target, code[0])).toBe(false);
		expect(marked(target, code[1])).toBe(false);
	});
});

describe('a .py text notebook is refused up front', () => {
	it('stores nothing, spends no jupytext write, and names the cause', async () => {
		const target = abs('text-export.py');
		writeFileSync(target, '# %%\na = 0\n\n# %%\na = 1\n');
		const cells = nbmod.listCells(target);
		py.writes.length = 0;
		exp.calls = 0;

		// A `.py` notebook carries no cellar cell metadata, so the flag could never be
		// stored and `autoExportPy` generates no module - persisting would only spend a
		// blocking jupytext rewrite to produce byte-identical bytes while claiming a
		// mark that does not exist.
		const r = svc.setCellExport([cells[0].id], true, target);
		expect(r).toEqual({ ok: false, refused: 'py-notebook' });
		expect(py.writes).toEqual([]);
		expect(exp.calls).toBe(0);
		expect(nbmod.getCell(cells[0].id, target)?.metadata?.cellar?.export).toBeUndefined();
	});

	it('does not spend a jupytext write on the doc-layer path either', () => {
		const target = abs('text-export-doc.py');
		writeFileSync(target, '# %%\na = 0\n\n# %%\na = 1\n');
		const cells = nbmod.listCells(target);
		py.writes.length = 0;

		const seen: string[] = [];
		const off = events.subscribe((e) => {
			const ev = e as { type: string; nb?: string; cellId?: string };
			if (ev.type === 'cell:export' && ev.nb === target) seen.push(ev.cellId!);
		});
		try {
			// The UI PATCH route reaches this directly, so the guard belongs here too -
			// but the EVENTS must still fire, or an open tab keeps the stale badge.
			nbmod.setCellExports([cells[0].id], true, target);
		} finally {
			off();
		}
		expect(py.writes).toEqual([]);
		expect(seen).toEqual([cells[0].id]);
	});
});

describe('the generated module follows the marks', () => {
	it('regenerates the .py to hold exactly the marked cells, in document order', async () => {
		const { target, code } = await makeNotebook('module.ipynb');
		svc.setExportTarget('lib/mod.py', target);
		const py = join(WS, 'lib/mod.py');
		// No cell marked yet ⇒ nothing to write.
		expect(existsSync(py)).toBe(false);

		svc.setCellExport([code[1]], true, target);
		expect(readFileSync(py, 'utf8')).toContain('def two():');
		expect(readFileSync(py, 'utf8')).not.toContain('def one():');

		svc.setCellExport([code[0]], true, target);
		const both = readFileSync(py, 'utf8');
		expect(both.indexOf('def one():')).toBeLessThan(both.indexOf('def two():'));
		expect(both).toContain("__all__ = ['one', 'two']");

		// Unmarking regenerates the module WITHOUT that cell.
		const partial = svc.setCellExport([code[1]], false, target);
		expect(readFileSync(py, 'utf8')).not.toContain('def two():');
		// A regeneration DID happen, so no warning is attached - an ordinary call pays
		// no tokens for the honesty field.
		expect(partial.ok && 'module' in partial).toBe(false);
	});

	it('says so when unmarking the LAST cell leaves the old module on disk', async () => {
		const { target, code } = await makeNotebook('module-last-unmark.ipynb');
		svc.setExportTarget('lib/last.py', target);
		const py = join(WS, 'lib/last.py');
		svc.setCellExport([code[0]], true, target);
		const generated = readFileSync(py, 'utf8');
		expect(generated).toContain('def one():');

		// `exportNotebookToPy` returns early with `no-cells`, so it neither rewrites nor
		// removes the file: `import lib.last` still resolves the symbol just unmarked.
		// Deleting a git-tracked, nbdev-committed module is out of scope, so the RESULT
		// must not claim a regeneration that did not happen.
		const r = svc.setCellExport([code[0]], false, target);
		expect(r).toMatchObject({ ok: true, count: 1, export_target: 'lib/last.py' });
		expect(r.ok ? r.module : null).toMatchObject({ regenerated: false });
		expect(r.ok ? r.module?.reason : '').toContain('lib/last.py');
		expect(r.ok ? r.module?.reason : '').toContain('left on disk');
		expect(readFileSync(py, 'utf8')).toBe(generated);
	});

	it('does not claim a module was left on disk when none was ever generated', async () => {
		const { target, code } = await makeNotebook('module-never-built.ipynb');
		svc.setExportTarget('lib/never.py', target);

		// The gate is "a target, and nothing marked" - which is ALSO true here, where
		// no cell was EVER marked. Inviting the agent to delete a file that does not
		// exist is the same assert-more-than-was-verified defect with the sign flipped.
		const r = svc.setCellExport([code[0]], false, target);
		expect(existsSync(join(WS, 'lib/never.py'))).toBe(false);
		expect(r.ok ? r.module : null).toMatchObject({ regenerated: false });
		expect(r.ok ? r.module?.reason : '').toContain('no module was generated');
		expect(r.ok ? r.module?.reason : '').not.toContain('left on disk');
		expect(r.ok ? r.module?.reason : '').not.toContain('by hand');
	});

	it('never calls a HAND-WRITTEN file at the target the module left on disk', async () => {
		const { target, code } = await makeNotebook('module-handwritten.ipynb');
		mkdirSync(join(WS, 'lib'), { recursive: true });
		const py = join(WS, 'lib/mine.py');
		const handWritten = 'def keep_me():\n    return 1\n';
		writeFileSync(py, handWritten);
		svc.setExportTarget('lib/mine.py', target);

		// The setter only requires a `.py` path inside the workspace, so the target may
		// name the user's OWN source file. "Remove it by hand if it should be gone" would
		// then invite deleting exactly the file the clobber guard exists to protect.
		const r = svc.setCellExport([code[0]], false, target);
		expect(r.ok ? r.module?.reason : '').toContain('no module was generated');
		expect(r.ok ? r.module?.reason : '').not.toContain('left on disk');
		expect(r.ok ? r.module?.reason : '').not.toContain('by hand');
		expect(readFileSync(py, 'utf8')).toBe(handWritten);
	});

	it('carries no module warning when there is no target to regenerate', async () => {
		const { target, code } = await makeNotebook('module-no-target.ipynb');
		svc.setCellExport([code[0]], true, target);
		// Nothing was generated, so nothing is stale - the warning is about a module
		// left BEHIND, not about the absent target (`export_target:null` says that).
		const r = svc.setCellExport([code[0]], false, target);
		expect(r).toMatchObject({ ok: true, export_target: null });
		expect(r.ok && 'module' in r).toBe(false);
	});

	it('reports a `#|default_exp` directive target, and warns about its module too', async () => {
		const { target, code } = await makeNotebook('module-directive.ipynb');
		// The nbdev-native spelling: no notebook-level setting, the target lives in a
		// cell. `resolveTarget` honors it, so the marks DO build a module - reading the
		// metadata alone reported `export_target:null` ("my marks land nowhere") and,
		// because the warning short-circuits on a null target, silenced it entirely.
		nbmod.setSource(svc.resolveRef(target, code[1]), '#|default_exp lib.directive', target);

		const on = svc.setCellExport([code[0]], true, target);
		expect(on).toMatchObject({
			ok: true,
			export_target: 'lib/directive.py',
			// Flagged so it is never read as the notebook SETTING: a directive lives in
			// a cell, so `set_export_target(null)` cannot clear it.
			export_target_source: 'default_exp'
		});
		const py = join(WS, 'lib/directive.py');
		expect(readFileSync(py, 'utf8')).toContain('def one():');

		const off = svc.setCellExport([code[0]], false, target);
		expect(off.ok ? off.module : null).toMatchObject({ regenerated: false });
		expect(off.ok ? off.module?.reason : '').toContain('lib/directive.py');
		expect(readFileSync(py, 'utf8')).toContain('def one():');

		const map = await svc.getNotebookMap(target);
		expect(map.display).toMatchObject({
			export_target: 'lib/directive.py',
			export_target_source: 'default_exp'
		});
	});

	it('flags no source for an ordinary notebook-level target', async () => {
		const { target, code } = await makeNotebook('module-plain-target.ipynb');
		svc.setExportTarget('lib/plain.py', target);
		const r = svc.setCellExport([code[0]], true, target);
		// The marker is conditional, so the ordinary call pays no tokens for it.
		expect(r).toMatchObject({ ok: true, export_target: 'lib/plain.py' });
		expect(r.ok && 'export_target_source' in r).toBe(false);
		expect('export_target_source' in (await svc.getNotebookMap(target)).display).toBe(false);
	});

	it('reports the ADDRESSED cells on an unmark, which are now OUT of the module', async () => {
		const { target, code } = await makeNotebook('unmark-reports.ipynb');
		svc.setExportTarget('lib/unmark.py', target);
		svc.setCellExport(code, true, target);

		const off = svc.setCellExport([code[0]], false, target);
		// `exported` names the cells that now carry the REQUESTED value - here the one
		// that is no longer in the module. The description says so, because the field
		// name alone reads the other way round.
		expect(off.ok && off.exported).toEqual([code[0]]);
		expect(marked(target, code[0])).toBe(false);
		const module = readFileSync(join(WS, 'lib/unmark.py'), 'utf8');
		expect(module).not.toContain('def one():');
		expect(module).toContain('def two():');
	});

	it('marks fine with no target set, and the module appears once one is', async () => {
		const { target, code } = await makeNotebook('module-later.ipynb');
		expect(svc.setCellExport(code, true, target)).toMatchObject({ ok: true, count: 2 });
		// Honest about where the marks land: no target ⇒ nothing was written.
		const r = svc.setCellExport(code, true, target);
		expect(r.ok && r.export_target).toBe(null);

		svc.setExportTarget('lib/later.py', target);
		expect(readFileSync(join(WS, 'lib/later.py'), 'utf8')).toContain('def one():');
	});
});

describe('a regeneration that FAILED is reported, never read as a success', () => {
	/**
	 * The other half of the honesty contract, and the one an agent cannot see any
	 * other way: `autoExportPy` swallows the throw so a bad target can never break
	 * the notebook save, and `module` is CONDITIONAL - so its absence is what says
	 * the module was written. A target whose parent is a FILE (the same shape as an
	 * EACCES or an ENOSPC) leaves the module unwritten; there is no MCP export tool
	 * through which the agent could ever learn that.
	 */
	it('says the module could not be written, and names why', async () => {
		const { target, code } = await makeNotebook('module-unwritable.ipynb');
		// A regular file where the module's PARENT DIRECTORY would have to be, so
		// `mkdirSync` throws ENOTDIR/EEXIST on a real filesystem.
		writeFileSync(join(WS, 'blocked'), 'not a directory\n');
		svc.setExportTarget('blocked/mod.py', target);

		const r = svc.setCellExport([code[0]], true, target);
		expect(r).toMatchObject({ ok: true, export_target: 'blocked/mod.py' });
		expect(r.ok ? r.module : null).toMatchObject({ regenerated: false });
		expect(r.ok ? r.module?.reason : '').toContain('could not be written');
		expect(r.ok ? r.module?.reason : '').toContain('blocked/mod.py');
		// The flag itself still landed - the notebook write is unaffected.
		expect(marked(target, code[0])).toBe(true);
		expect(existsSync(join(WS, 'blocked/mod.py'))).toBe(false);
	});

	it('stops reporting it once a regeneration succeeds', async () => {
		const { target, code } = await makeNotebook('module-recovers.ipynb');
		writeFileSync(join(WS, 'blocked2'), 'not a directory\n');
		svc.setExportTarget('blocked2/mod.py', target);
		const failed = svc.setCellExport([code[0]], true, target);
		expect(failed.ok && 'module' in failed).toBe(true);

		// Repointed at a writable path: the record is refreshed by the very persist
		// that succeeds, so a stale failure can never outlive its cause.
		svc.setExportTarget('lib/recovered.py', target);
		const r = svc.setCellExport([code[1]], true, target);
		expect(r.ok && 'module' in r).toBe(false);
		expect(readFileSync(join(WS, 'lib/recovered.py'), 'utf8')).toContain('def one():');
	});

	it('set_export_target reports a failed write too, but not "nothing is marked"', async () => {
		const { target, code } = await makeNotebook('target-unwritable.ipynb');
		// Naming a target BEFORE marking anything is the normal first step of the
		// flow, so that state is not a warning - it restates what the caller just did.
		expect(svc.setExportTarget('lib/quiet.py', target)).toEqual({ export_target: 'lib/quiet.py' });

		svc.setCellExport([code[0]], true, target);
		writeFileSync(join(WS, 'blocked3'), 'not a directory\n');
		const r = svc.setExportTarget('blocked3/mod.py', target);
		expect('module' in r && r.module).toMatchObject({ regenerated: false });
	});

	it('refuses a target that escapes the workspace where it is SET', async () => {
		const { target } = await makeNotebook('target-escape.ipynb');
		// Stored, it would sit in the metadata generating nothing on every later
		// save while the call reported it set. Refused, the caller has a value to fix.
		const r = svc.setExportTarget('../outside.py', target);
		expect('invalid' in r && r.ok).toBe(false);
		expect(nbmod.getExportTarget(target)).toBe(null);
		expect(() => nbmod.setExportTarget('/etc/passwd.py', target)).toThrow(/escapes workspace/);
		expect(nbmod.getExportTarget(target)).toBe(null);
	});

	/**
	 * The exporter WRITES to this path, and this tool is what completes the chain: an
	 * agent could name any workspace file and then mark a cell, destroying it in one
	 * turn. The field is documented as the nbdev module path, so refusing a non-`.py`
	 * one rejects nothing legitimate.
	 */
	it('refuses a target that is not a .py module', async () => {
		const { target, code } = await makeNotebook('target-not-py.ipynb');
		writeFileSync(join(WS, 'precious.ts'), 'export const keep = 1;\n');

		const r = svc.setExportTarget('precious.ts', target);
		expect('invalid' in r && r.ok).toBe(false);
		expect('invalid' in r ? r.invalid : '').toMatch(/not a \.py file/);
		expect(nbmod.getExportTarget(target)).toBe(null);

		// And the chain the refusal breaks: marking a cell cannot reach that file.
		svc.setCellExport([code[0]], true, target);
		expect(readFileSync(join(WS, 'precious.ts'), 'utf8')).toBe('export const keep = 1;\n');
	});

	/**
	 * The second half of that guard, for the path that never passes the setter: a
	 * `#|default_exp` directive resolves straight to a target, and a `.py` path may
	 * perfectly well be a hand-written module. Every generated module opens with the
	 * header, so a file without one is not ours to replace.
	 */
	it('refuses to overwrite a .py file it did not generate, and reports why', async () => {
		const { target, code } = await makeNotebook('target-clobber.ipynb');
		const handwritten = 'def precious():\n    return "do not lose me"\n';
		writeFileSync(join(WS, 'handwritten.py'), handwritten);
		svc.setExportTarget('handwritten.py', target);

		const r = svc.setCellExport([code[0]], true, target);
		expect(readFileSync(join(WS, 'handwritten.py'), 'utf8')).toBe(handwritten);
		expect(r).toMatchObject({ ok: true, export_target: 'handwritten.py' });
		expect(r.ok ? r.module : null).toMatchObject({ regenerated: false });
		expect(r.ok ? r.module?.reason : '').toMatch(/refusing to overwrite/);
		// The manual button surfaces the same refusal directly rather than swallowing it.
		expect(() => nbmod.exportPy(target)).toThrow(/refusing to overwrite/);
		// A module Cellar DID generate is still rewritten in place.
		svc.setExportTarget('lib/ours.py', target);
		expect(readFileSync(join(WS, 'lib/ours.py'), 'utf8')).toContain('def one():');
		svc.setCellExport([code[1]], true, target);
		expect(readFileSync(join(WS, 'lib/ours.py'), 'utf8')).toContain('def two():');
	});

	/**
	 * The guard protects CONTENT, and an empty file has none. Pre-creating the module
	 * (`touch utils.py`, the explorer's "New file") before naming the target is an
	 * ordinary workflow, and refusing it stopped the module regenerating on EVERY
	 * later save through a path no UI surface reads - a permanent silent dead end.
	 */
	it('overwrites an EMPTY file at the target rather than refusing it', async () => {
		const { target, code } = await makeNotebook('target-empty.ipynb');
		writeFileSync(join(WS, 'touched.py'), '');
		writeFileSync(join(WS, 'blank.py'), '\n  \n');
		svc.setExportTarget('touched.py', target);

		const r = svc.setCellExport([code[0]], true, target);
		expect(r.ok && 'module' in r).toBe(false); // nothing to report - it was written
		expect(nbmod.lastExportError(target)).toBe(null);
		expect(readFileSync(join(WS, 'touched.py'), 'utf8')).toContain('def one():');

		// Whitespace only is the same case (a "New file" that was saved once).
		svc.setExportTarget('blank.py', target);
		expect(readFileSync(join(WS, 'blank.py'), 'utf8')).toContain('def one():');
		expect(nbmod.lastExportError(target)).toBe(null);
	});

	/**
	 * `lastExportError` is doc state THIS PROCESS may never have written: an idempotent
	 * call (every addressed cell already at the requested value) skips the persist, so
	 * on a freshly opened doc - or after the module is deleted/replaced outside Cellar -
	 * the record is null, no field is emitted, and under the conditional contract that
	 * absence reads as a module that WAS regenerated. The no-write path therefore
	 * decides from the DISK, through the same provenance predicate.
	 */
	it('an idempotent call that wrote nothing reports a module missing from disk', async () => {
		const { target, code } = await makeNotebook('module-gone.ipynb');
		svc.setExportTarget('lib/gone.py', target);
		expect(svc.setCellExport([code[0]], true, target).ok).toBe(true);
		expect(nbmod.lastExportError(target)).toBe(null);

		// Re-marking an already-marked cell changes nothing, so nothing persists and
		// nothing regenerates - only the disk can answer whether the module is there.
		const still = svc.setCellExport([code[0]], true, target);
		expect(still.ok && 'module' in still).toBe(false);

		unlinkSync(join(WS, 'lib/gone.py'));
		const after = svc.setCellExport([code[0]], true, target);
		expect(after.ok ? after.module : null).toMatchObject({ regenerated: false });
		expect(after.ok ? after.module?.reason : '').toContain('lib/gone.py');
		expect(after.ok ? after.module?.reason : '').toContain('wrote none');
		// It reports STATE, never a claim that these marks were dropped.
		expect(after.ok ? after.module?.reason : '').not.toContain('no cell is marked');

		// A call that really does write is unaffected - it regenerates the module.
		const wrote = svc.setCellExport([code[1]], true, target);
		expect(wrote.ok && 'module' in wrote).toBe(false);
		expect(readFileSync(join(WS, 'lib/gone.py'), 'utf8')).toContain('def two():');
	});

	/**
	 * `exportPy` writes without going through `persist`, so it never refreshed the
	 * record `autoExportPy` keeps. Left standing, a failure the user then FIXED and
	 * resolved with the manual button was still reported by the next idempotent
	 * `set_cell_export` - which skips the persist that would have cleared it.
	 */
	it('a successful manual export clears a recorded failure', async () => {
		const { target, code } = await makeNotebook('manual-clears.ipynb');
		writeFileSync(join(WS, 'blocked4'), 'not a directory\n');
		svc.setExportTarget('blocked4/mod.py', target);
		expect(svc.setCellExport([code[0]], true, target).ok && nbmod.lastExportError(target)).toBeTruthy();

		// The user clears the obstruction on disk and clicks "Export to .py". No
		// persist runs, so only this path can bring the record back in step.
		unlinkSync(join(WS, 'blocked4'));
		expect(nbmod.exportPy(target)).toMatchObject({ written: true });
		expect(nbmod.lastExportError(target)).toBe(null);
		// An idempotent call (already marked) persists nothing, so it can only read
		// the record back - and it must no longer claim a failure that is over.
		const again = svc.setCellExport([code[0]], true, target);
		expect(again.ok && 'module' in again).toBe(false);
	});

	/**
	 * The same record in the other direction, and the more dangerous one: with the
	 * last save successful the record is null, so a manual export that FAILS and
	 * records nothing leaves the doc asserting the module is fine - and the next
	 * idempotent `set_cell_export` skips the persist that would refresh it, emitting
	 * no `module` field at all, which under the conditional contract reads as a
	 * module that WAS regenerated.
	 */
	it('a failed manual export records why, so a later idempotent call still reports it', async () => {
		const { target, code } = await makeNotebook('manual-records.ipynb');
		svc.setExportTarget('lib/records.py', target);
		expect(svc.setCellExport([code[0]], true, target).ok).toBe(true);
		expect(nbmod.lastExportError(target)).toBe(null);

		// The module is replaced on disk by a hand-written file. Nothing persists, so
		// only the manual button can discover it - and it must write down what it hit.
		writeFileSync(join(WS, 'lib/records.py'), 'def mine():\n    return 1\n');
		expect(() => nbmod.exportPy(target)).toThrow(/refusing to overwrite/);
		expect(nbmod.lastExportError(target)).toMatch(/refusing to overwrite/);

		const again = svc.setCellExport([code[0]], true, target);
		expect(again.ok ? again.module : null).toMatchObject({ regenerated: false });
		expect(again.ok ? again.module?.reason : '').toMatch(/refusing to overwrite/);
	});
});


describe('persistence and the read surface', () => {
	it('round-trips through metadata.cellar.export on disk', async () => {
		const { target, code } = await makeNotebook('persist.ipynb');
		svc.setCellExport([code[0]], true, target);
		const disk = JSON.parse(readFileSync(target, 'utf8'));
		const cell = disk.cells.find((c: { source: string[] }) => c.source.join('').includes('def one()'));
		expect(cell.metadata.cellar.export).toBe(true);

		svc.setCellExport([code[0]], false, target);
		const after = JSON.parse(readFileSync(target, 'utf8'));
		const cleared = after.cells.find((c: { source: string[] }) => c.source.join('').includes('def one()'));
		// Cleared by REMOVING the key, not by persisting `false`.
		expect(cleared.metadata.cellar?.export).toBeUndefined();
	});

	it('get_notebook_map reports each marked cell as export:true, and only those', async () => {
		const { target, code } = await makeNotebook('map.ipynb');
		svc.setExportTarget('lib/map.py', target);
		svc.setCellExport([code[0]], true, target);

		const map = await svc.getNotebookMap(target);
		const leaves = JSON.stringify(map.sections);
		expect(map.display.export_target).toBe('lib/map.py');

		const flat = (map.sections as { id: string; export?: boolean; children?: unknown[] }[]).flatMap(
			function walk(n): { id: string; export?: boolean }[] {
				return [n, ...((n.children ?? []) as typeof n[]).flatMap(walk)];
			}
		);
		const byHandle = (h: string) => flat.find((n) => n.id === h);
		expect(byHandle(code[0])?.export).toBe(true);
		// Compact: absent (not `false`) on every unmarked cell, so a notebook that
		// exports nothing pays no tokens for the field.
		expect(byHandle(code[1])?.export).toBeUndefined();
		expect(leaves).toContain('"export":true');
	});
});

describe('at the wire: the tool is really callable', () => {
	/** A real MCP client talking to the real registrations over an in-memory pair. */
	async function connect() {
		const server = new McpServer({ name: 'cellar-test', version: '0.0.0' });
		srv.registerTools(server);
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		(serverTransport as { sessionId?: string }).sessionId = 'wire-export';
		const client = new Client({ name: 'test-agent', version: '0.0.0' });
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
		return client;
	}
	type CallResult = { content: { type: string; text?: string }[]; isError?: boolean };
	const body = (r: CallResult) => r.content.find((c) => c.type === 'text')?.text ?? '';

	it('marks by short handle over the real registration, and refuses a markdown cell', async () => {
		const rel = 'wire.ipynb';
		const { target, code, md } = await makeNotebook(rel);
		const client = await connect();
		svc.setExportTarget('lib/wire.py', target);

		// Short handles are what an agent actually holds (get_notebook_map emits them).
		const ok = (await client.callTool({
			name: 'set_cell_export',
			arguments: { ids: [code[0].slice(0, 8)], export: true, notebook: rel }
		})) as CallResult;
		expect(ok.isError).toBeFalsy();
		expect(JSON.parse(body(ok))).toMatchObject({ ok: true, count: 1, export_target: 'lib/wire.py' });
		expect(readFileSync(join(WS, 'lib/wire.py'), 'utf8')).toContain('def one():');

		const bad = (await client.callTool({
			name: 'set_cell_export',
			arguments: { ids: [md], export: true, notebook: rel }
		})) as CallResult;
		expect(bad.isError).toBe(true);
		expect(body(bad)).toContain('not a Python code cell');
	});

	it('names the handle the agent supplied, not the UUID it resolved to', async () => {
		const rel = 'wire-handle.ipynb';
		const { md } = await makeNotebook(rel);
		const client = await connect();
		const short = md.slice(0, 8);

		const bad = (await client.callTool({
			name: 'set_cell_export',
			arguments: { ids: [short], export: true, notebook: rel }
		})) as CallResult;
		// An id the model cannot find anywhere in its own call reads as the tool
		// answering about some other cell (`set_hide_input`/`delete_cells` echo the ref).
		expect(bad.isError).toBe(true);
		expect(body(bad)).toContain(`cell ${short} is not a Python code cell`);
	});

	it('refuses a .py text notebook by naming the cause, not as a missing cell', async () => {
		const rel = 'wire-text.py';
		const target = abs(rel);
		writeFileSync(target, '# %%\na = 0\n\n# %%\na = 1\n');
		const cells = nbmod.listCells(target);
		const client = await connect();

		const r = (await client.callTool({
			name: 'set_cell_export',
			arguments: { ids: [cells[0].id], export: true, notebook: rel }
		})) as CallResult;
		expect(r.isError).toBe(true);
		expect(body(r)).toContain('.py text notebook');
		expect(body(r)).not.toContain('not found');
	});
});

describe('the tool registration', () => {
	it('describes the batch, the code-cell rule and the regeneration, and stays compact', () => {
		const src = readFileSync(new URL('../../src/lib/server/mcp/server.ts', import.meta.url), 'utf8');
		const line = src.slice(src.indexOf("registerTool('set_cell_export'")).split('\n')[0];

		// A tool description is paid on EVERY session, so it is a cost - but the
		// claims an agent acts on must be there: that it is a batch, that only code
		// cells qualify (a silent no-op would be the damaging alternative), and that
		// the module is regenerated.
		expect(line).toMatch(/ONE OR SEVERAL/);
		expect(line).toMatch(/[Cc]ode cells? can be exported|Only CODE cells/);
		expect(line).toMatch(/[Rr]egenerates/);
		expect(line).toMatch(/set_export_target/);
		// The regeneration claim must stay CONDITIONAL: unmarking the last marked cell
		// writes nothing, so an unqualified "regenerates immediately" is false exactly
		// where an agent most needs the truth.
		expect(line).not.toMatch(/[Rr]egenerates the `\.py` immediately/);
		expect(line).toMatch(/module\.regenerated:false/);
		// `exported` names the ADDRESSED cells, which on export:false are the ones NOT
		// in the module - the field name alone reads the other way round.
		expect(line).toMatch(/REQUESTED value/);
		// The mechanical bound `clear_outputs` set: an honesty correction here has to
		// be paid for by cutting words, not by growing what every session is billed.
		const desc = line.match(/description: '(.*?)', inputSchema/);
		expect(desc, 'the description stays a single-quoted one-line literal').toBeTruthy();
		expect(desc![1].length).toBeLessThan(700);
	});

	it('keeps INSTRUCTIONS clause 5 free of the unconditional regeneration claim', () => {
		const src = readFileSync(new URL('../../src/lib/server/mcp/server.ts', import.meta.url), 'utf8');
		const clause = src.slice(src.indexOf('EXPORT TARGET is the notebook'), src.indexOf('6. DECLARE YOUR WORKING NOTEBOOK'));
		expect(clause).toBeTruthy();

		// INSTRUCTIONS is delivered once at connect, BEFORE any tool schema, so an
		// unconditional promise here contradicts the descriptions it frames - the very
		// claim both of them had to drop.
		expect(clause).not.toMatch(/regenerate the\s+module immediately/);
		expect(clause).toMatch(/stays? marked/);
		expect(clause).toMatch(/set_cell_export/);
	});
});
