/**
 * The HTTP run path refuses a cell that cannot execute - over the REAL route
 * handler against a scratch workspace, with no kernel involved (the refusal
 * happens BEFORE `enqueueRun`, which is the whole point).
 *
 * MCP's `run_cell` has always guarded this shape; the HTTP entry point did not,
 * so `POST /api/cells/[id]/run` handed whatever source it was given straight to
 * the Python kernel. For a raw cell (verbatim frontmatter for a downstream tool)
 * that meant a `SyntaxError` written into the cell's in-memory `outputs`, shown in
 * the UI, then silently gone on reload - `serialize` drops outputs for any
 * non-code cell. The rule is enforced at EACH entry point (this route, MCP's
 * `run_cell`, and `jupytext-actions.ts`'s `runAllCells`); `executeCellRun`, the
 * shared core, is deliberately NOT the gate, because each door owes its caller a
 * different refusal SHAPE - this route's terminal `run:refused` NDJSON frame,
 * MCP's `status:'skipped'` result - which the core has no way to speak.
 *
 * The refusal must ALSO leave the submitted source saved: pressing Mod-Enter in a
 * raw cell is an edit, and refusing to run it must never be refusing to keep it.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let WS: string;
let nbmod: typeof import('../../src/lib/server/notebook');
let queue: typeof import('../../src/lib/server/run-queue');
let POST: (evt: { params: { id: string }; request: Request }) => Promise<Response>;

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-run-refused-'));
	process.env.CELLAR_WORKSPACE = WS;
	nbmod = await import('../../src/lib/server/notebook');
	queue = await import('../../src/lib/server/run-queue');
	const mod = await import('../../src/routes/api/cells/[id]/run/+server.js');
	POST = mod.POST as unknown as typeof POST;
});

/** A notebook whose three cells are raw / markdown / code, in that order. */
function makeNotebook(name: string): { nb: string; ids: string[] } {
	const nb = join(WS, name);
	writeFileSync(
		nb,
		JSON.stringify({
			cells: [
				{ cell_type: 'raw', source: ['---\n', 'title: Post\n', '---'], metadata: {}, id: 'rawcell' },
				{ cell_type: 'markdown', source: ['# Heading'], metadata: {}, id: 'mdcell' },
				{ cell_type: 'code', source: ['a = 1'], metadata: {}, outputs: [], execution_count: null, id: 'codecell' }
			],
			metadata: {},
			nbformat: 4,
			nbformat_minor: 5
		})
	);
	return { nb, ids: nbmod.listCells(nb).map((c) => c.id) };
}

function run(id: string, nb: string, source: string): Promise<Response> {
	return POST({
		params: { id },
		request: new Request(`http://x/api/cells/${id}/run`, { method: 'POST', body: JSON.stringify({ source, nb }) })
	});
}

/** Every NDJSON frame the response body carried. */
async function frames(res: Response): Promise<Record<string, unknown>[]> {
	const text = await res.text();
	return text
		.split('\n')
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l));
}

const cellOf = (nb: string, id: string) => nbmod.listCells(nb).find((c) => c.id === id)!;

describe('POST /api/cells/[id]/run', () => {
	it('refuses a raw cell with a terminal run:refused frame, taking no queue slot', async () => {
		const { nb, ids } = makeNotebook('run-refuse-raw.ipynb');
		const res = await run(ids[0], nb, '---\ntitle: Changed\n---');

		expect(res.status).toBe(200); // the route's own idiom: accepted, did not run
		expect(res.headers.get('content-type')).toBe('application/x-ndjson');
		expect(await frames(res)).toEqual([
			{ type: 'run:refused', cellId: ids[0], reason: 'not-a-code-cell', cell_type: 'raw' }
		]);

		const cell = cellOf(nb, ids[0]);
		expect(cell.outputs ?? []).toEqual([]);
		expect(cell.metadata?.cellar?.lastRun).toBeUndefined();
		expect(queue.queueStateFor(nbmod.resolveNotebookPath(nb))).toEqual({ running: null, queue: [] });
	});

	it('saves the submitted source even though it refuses to run it', () => {
		// The refusal is about EXECUTION, never about the edit. A Mod-Enter in a raw
		// cell must not be silent data loss.
		const { nb, ids } = makeNotebook('run-refuse-saves.ipynb');
		return run(ids[0], nb, '---\ntitle: Edited\n---').then(async (res) => {
			await res.text();
			expect(cellOf(nb, ids[0]).source).toBe('---\ntitle: Edited\n---');
		});
	});

	it('refuses a markdown cell the same way - the gap was never raw-specific', async () => {
		const { nb, ids } = makeNotebook('run-refuse-md.ipynb');
		const res = await run(ids[1], nb, '# Edited');

		expect(await frames(res)).toEqual([
			{ type: 'run:refused', cellId: ids[1], reason: 'not-a-code-cell', cell_type: 'markdown' }
		]);
		expect(cellOf(nb, ids[1]).source).toBe('# Edited');
		expect(queue.queueStateFor(nbmod.resolveNotebookPath(nb))).toEqual({ running: null, queue: [] });
	});

	it('does not over-refuse: a code cell still reaches the queue', async () => {
		// No kernel here, so the run never completes - what is under test is that the
		// guard let it THROUGH to `enqueueRun`. The ticket shows up in the queue
		// snapshot the instant the stream starts; cancel it rather than awaiting a
		// kernel that does not exist.
		const { nb, ids } = makeNotebook('run-refuse-code.ipynb');
		const canonical = nbmod.resolveNotebookPath(nb);
		const res = await run(ids[2], nb, 'a = 2');
		expect(res.headers.get('content-type')).toBe('application/x-ndjson');

		const reader = res.body!.getReader();
		await reader.read(); // let the stream's `start` run far enough to claim a ticket

		const state = queue.queueStateFor(canonical);
		expect(state.running?.cellId).toBe(ids[2]);

		queue.clearRunQueue(canonical, 'test_cleanup');
		await reader.cancel();
	});
});
