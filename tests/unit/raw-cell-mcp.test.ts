/**
 * The AGENT surface for nbformat `raw` cells, over the REAL service + notebook
 * singletons against a scratch workspace.
 *
 * An agent can now create and convert a raw cell, and the four write tools speak
 * the same vocabulary - but the load-bearing half is what raw cells must NOT do,
 * because every one of those is a way to hand an agent a false result:
 *
 *  - `run_cell` reports `skipped` and names RAW as the reason, so an agent is not
 *    left guessing why its call did nothing, and nothing is enqueued.
 *  - import routing never lifts an `import` line out of verbatim text.
 *  - the read tools report `type: "raw"` with no run status and no output.
 *
 * Sources are import-free (or explicitly `routeImports:false`) wherever routing
 * is not the subject, so nothing touches the kernel or the python dataflow
 * subprocess.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let WS: string;
let svc: typeof import('../../src/lib/server/mcp/service');
let nbmod: typeof import('../../src/lib/server/notebook');
let queue: typeof import('../../src/lib/server/run-queue');

const abs = (rel: string) => nbmod.resolveNotebookPath(rel);
const FRONTMATTER = '---\ntitle: Post\n---';

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-raw-mcp-'));
	process.env.CELLAR_WORKSPACE = WS;
	svc = await import('../../src/lib/server/mcp/service');
	nbmod = await import('../../src/lib/server/notebook');
	queue = await import('../../src/lib/server/run-queue');
});

/** An empty-ish notebook this session is pinned to. */
function open(name: string): string {
	const target = abs(name);
	svc.useNotebook(`sess-${name}`, name);
	return target;
}

const cells = (nb: string) => nbmod.listCells(nb);
/** The tools emit HANDLES (an id prefix), so look a cell up the way an agent's id reads. */
const byHandle = (nb: string, handle: string) => cells(nb).find((c) => c.id.startsWith(handle))!;

describe('creating and converting', () => {
	it('creates a raw cell whose source is kept verbatim', async () => {
		const nb = open('mcp-raw-add.ipynb');
		const { ids } = await svc.addCells([{ cell_type: 'raw', source: FRONTMATTER }], null, {
			nb,
			routeImports: false
		});
		const cell = byHandle(nb, ids[0]);
		expect(cell.cell_type).toBe('raw');
		expect(cell.source).toBe(FRONTMATTER);
		// And it reaches disk as a raw cell, which is the entire point of the type.
		const written = JSON.parse(readFileSync(nb, 'utf8'));
		expect(written.cells.find((c: { id: string }) => c.id.startsWith(ids[0])).cell_type).toBe('raw');
	});

	it('converts a code cell to raw and back', async () => {
		const nb = open('mcp-raw-settype.ipynb');
		const { ids } = await svc.addCells([{ cell_type: 'code', source: 'a = 1' }], null, { nb, routeImports: false });
		expect(svc.setType(ids[0], 'raw', nb).ok).toBe(true);
		expect(byHandle(nb, ids[0]).cell_type).toBe('raw');
		expect(svc.setType(ids[0], 'code', nb).ok).toBe(true);
		expect(byHandle(nb, ids[0]).cell_type).toBe('code');
	});
});

describe('running', () => {
	it('skips a raw cell, naming raw as the reason, and enqueues nothing', async () => {
		const nb = open('mcp-raw-run.ipynb');
		const { ids } = await svc.addCells([{ cell_type: 'raw', source: FRONTMATTER }], null, { nb, routeImports: false });

		const res = await svc.runCell(ids[0], nb);
		expect(res!.status).toBe('skipped');
		// The note must SAY raw. "not a code cell" leaves an agent guessing whether
		// it addressed the wrong cell.
		expect(String(res!.note)).toMatch(/raw/i);

		const cell = byHandle(nb, ids[0]);
		expect(cell.outputs ?? []).toEqual([]);
		expect(cell.metadata?.cellar?.lastRun).toBeUndefined();
		expect(queue.queueStateFor(nb)).toEqual({ running: null, queue: [] });
	});

	it('creates but does not run a raw cell through add_and_run', async () => {
		const nb = open('mcp-raw-addandrun.ipynb');
		const res = await svc.addAndRun({ source: FRONTMATTER, cellType: 'raw', nb, routeImports: false });
		expect(res.status).toBe('skipped');
		expect(String(res.note)).toMatch(/raw/i);
		const cell = cells(nb).find((c) => c.source === FRONTMATTER)!;
		expect(cell).toBeTruthy();
		expect(cell.cell_type).toBe('raw');
		expect(cell.outputs ?? []).toEqual([]);
	});
});

describe('import routing', () => {
	it('never lifts an import out of a raw cell, and creates no imports cell', async () => {
		// `routeOne` guards on the LOGICAL type being 'code'. A raw cell's `import os`
		// is verbatim text a downstream tool reads - moving it would corrupt it.
		const nb = open('mcp-raw-routing.ipynb');
		const before = cells(nb).length;
		const { ids } = await svc.addCells([{ cell_type: 'raw', source: 'import os\n' }], null, {
			nb,
			routeImports: true
		});
		const cell = byHandle(nb, ids[0]);
		expect(cell.source).toBe('import os\n');
		expect(cells(nb).length).toBe(before + 1); // no imports cell was minted
		expect(cells(nb).some((c) => c.metadata?.cellar?.role === 'imports')).toBe(false);

		// Editing it is the same rule through the other door.
		await svc.editCell(ids[0], 'import sys\nimport os\n', { nb, routeImports: true });
		expect(byHandle(nb, ids[0]).source).toBe('import sys\nimport os\n');
		expect(cells(nb).some((c) => c.metadata?.cellar?.role === 'imports')).toBe(false);
	});
});

describe('read tools', () => {
	it('reports type raw, with no run status and no output fields', async () => {
		const nb = open('mcp-raw-read.ipynb');
		const { ids } = await svc.addCells([{ cell_type: 'raw', source: FRONTMATTER }], null, { nb, routeImports: false });

		const read = await svc.readCells([ids[0]], nb);
		const one = (Array.isArray(read) ? read[0] : (read as { cells: unknown[] }).cells[0]) as Record<string, unknown>;
		expect(one.type).toBe('raw');
		expect(one.run_status).toBe('n/a');
		expect(one.ran_this_session).toBeFalsy();
		expect(one.has_output).toBeFalsy();
		// Report view is a code-cell concern; a raw cell has no input to hide.
		expect(one.code_hidden).toBeUndefined();
		expect(one.hide_input).toBeUndefined();

		const map = (await svc.getNotebookMap(nb)) as unknown as { sections?: unknown };
		expect(JSON.stringify(map)).toContain('"raw"');
	});
});

describe('the tool schemas', () => {
	// Three of four enums updated is a silent hole: an agent told by INSTRUCTIONS
	// that raw exists gets a schema error from whichever tool was missed. Cheap
	// insurance, read off the source the way `mcp-clear-outputs.test.ts` reads its
	// description bound.
	it('offers raw in every cell_type enum, and says so in the doctrine', () => {
		const src = readFileSync(new URL('../../src/lib/server/mcp/server.ts', import.meta.url), 'utf8');
		const enums = src.match(/z\.enum\(\['code', 'sql', 'markdown'[^)]*\)/g) ?? [];
		expect(enums.length).toBe(4);
		for (const e of enums) expect(e).toContain("'raw'");
		// The doctrine clause an agent reads before it ever calls one of them.
		expect(src).toContain('11. RAW CELLS ARE VERBATIM TEXT.');
		expect(src).toMatch(/run_cell on a raw cell returns status "skipped"/);
	});
});
