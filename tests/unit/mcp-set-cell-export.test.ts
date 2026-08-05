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
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

vi.mock('../../src/lib/server/dataflow', () => ({
	getNotebookStaleness: async () => ({ sid: null, cells: {} }),
	analyzeDataflow: async () => ({})
}));

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
		svc.setCellExport([code[1]], false, target);
		expect(readFileSync(py, 'utf8')).not.toContain('def two():');
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
		expect(body(bad)).toContain('not a code cell');
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
		// The mechanical bound `clear_outputs` set: an honesty correction here has to
		// be paid for by cutting words, not by growing what every session is billed.
		const desc = line.match(/description: '(.*?)', inputSchema/);
		expect(desc, 'the description stays a single-quoted one-line literal').toBeTruthy();
		expect(desc![1].length).toBeLessThan(700);
	});
});
