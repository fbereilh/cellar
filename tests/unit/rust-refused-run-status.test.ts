/**
 * A run Cellar refuses in a Rust notebook is a LIVE failure, never a leftover.
 *
 * Two refusals stop a Rust notebook's run before any code reaches a kernel: no
 * Evcxr binary, and a SQL cell (it compiles to Python). Neither has a session
 * to stamp, and a run with no session and an error output used to report
 * `error_persisted` - the label INSTRUCTIONS clause 3 tells agents to distrust as
 * a leftover from a previous session. They now report `error_refused`.
 *
 * Driven through the REAL `executeCellRun` and the REAL read tools. Neither
 * refusal asks Jupyter for anything, so no kernel layer is needed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let WS: string;
let svc: typeof import('../../src/lib/server/mcp/service');
let nbmod: typeof import('../../src/lib/server/notebook');
let runmod: typeof import('../../src/lib/server/run');

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-rust-refused-'));
	process.env.CELLAR_WORKSPACE = WS;
	// An override that names no file means "not installed", whatever PATH holds.
	process.env.CELLAR_EVCXR = join(WS, 'no-such-evcxr');
	svc = await import('../../src/lib/server/mcp/service');
	nbmod = await import('../../src/lib/server/notebook');
	runmod = await import('../../src/lib/server/run');
});

afterAll(() => {
	delete process.env.CELLAR_EVCXR;
	rmSync(WS, { recursive: true, force: true });
});

function makeNotebook(name: string, language: 'rust' | null): string {
	const nb = join(WS, name);
	writeFileSync(
		nb,
		JSON.stringify({
			cells: [
				{ cell_type: 'code', source: ['let x = 1;'], metadata: {}, outputs: [], execution_count: null, id: 'rustcell' },
				{
					cell_type: 'code',
					source: ['SELECT 1'],
					metadata: { cellar: { language: 'sql' } },
					outputs: [],
					execution_count: null,
					id: 'sqlcell'
				}
			],
			metadata: language ? { cellar: { language } } : {},
			nbformat: 4,
			nbformat_minor: 5
		})
	);
	nbmod.listCells(nb);
	return nb;
}

function flatten(node: unknown): Array<Record<string, unknown>> {
	if (Array.isArray(node)) return node.flatMap(flatten);
	if (!node || typeof node !== 'object') return [];
	const o = node as Record<string, unknown>;
	const here = typeof o.run_status === 'string' ? [o] : [];
	return [...here, ...Object.values(o).flatMap(flatten)];
}

async function statuses(nb: string, cellId: string): Promise<string[]> {
	const map = await svc.getNotebookMap(nb);
	const read = (await svc.readCells([cellId], nb)) as Array<Record<string, unknown>>;
	const fromMap = flatten(map).find((c) => typeof c.id === 'string' && cellId.startsWith(c.id as string));
	return [String(fromMap?.run_status), String(read[0]?.run_status)];
}

describe('a refused Rust run', () => {
	it('a missing Evcxr reports error_refused, not error_persisted', async () => {
		const nb = makeNotebook('missing.ipynb', 'rust');
		const res = await runmod.executeCellRun({ nb, cellId: 'rustcell', actor: 'agent', source: 'let x = 1;' });
		expect(res.status).toBe('error');
		expect(res.session).toBeNull();
		expect(res.kernelDown).toBe(false);
		expect(res.lastRun.refused).toBe(true);
		expect(await statuses(nb, 'rustcell')).toEqual(['error_refused', 'error_refused']);
	});

	it('a SQL cell reports error_refused, not error_persisted', async () => {
		const nb = makeNotebook('sql.ipynb', 'rust');
		const res = await runmod.executeCellRun({ nb, cellId: 'sqlcell', actor: 'agent', source: 'SELECT 1' });
		expect(res.status).toBe('error');
		expect(res.lastRun.refused).toBe(true);
		expect(await statuses(nb, 'sqlcell')).toEqual(['error_refused', 'error_refused']);
	});

	it('a saved error with no run in this process is still error_persisted', async () => {
		const nb = makeNotebook('saved.ipynb', 'rust');
		nbmod.setOutputs('rustcell', [{ output_type: 'error', ename: 'E', evalue: 'old', traceback: [] }], nb);
		expect(await statuses(nb, 'rustcell')).toEqual(['error_persisted', 'error_persisted']);
	});
});
