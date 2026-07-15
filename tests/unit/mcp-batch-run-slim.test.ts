/**
 * Token-diet #3: compact BATCH-RUN result payloads (run_all / run_cells /
 * run_range / run_stale).
 *
 * A batch run used to echo every cell's FULL summarized output — a ~20-cell
 * run_all cost ~2.5-5k tokens. Now it returns `{ ran, errored, results }` where
 * each OK cell collapses to a status line (id + run_status + non-default
 * staleness, NO inlined output) and only an ERRORED cell carries its full
 * ename/evalue/traceback. Capability is preserved: any OK cell's full output is
 * still one `get_full_output(id)` call away, and the single-cell run_cell path is
 * untouched.
 *
 * Drives the REAL service + notebook + run-queue + kernel manager against a
 * scratch workspace, with only the Jupyter layer faked (every execute emits one
 * stdout line so a cell has persisted output; a `# ERR` cell raises).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const h = vi.hoisted(() => {
	let seq = 0;
	function makeFakeKernel() {
		seq += 1;
		return {
			id: `kernel-${seq}`,
			name: 'python3',
			status: 'idle' as const,
			registerCommTarget: vi.fn(),
			statusChanged: { connect: vi.fn(), disconnect: vi.fn() },
			iopubMessage: { connect: vi.fn() },
			// Non-error cells emit a distinctive stdout line so we can prove the batch
			// result does NOT inline it but get_full_output CAN retrieve it. A `# ERR`
			// cell raises with a traceback.
			requestExecute: (args: { code?: string }) => {
				const isErr = typeof args?.code === 'string' && args.code.includes('# ERR');
				const future: { onIOPub: ((msg: unknown) => void) | null; done: Promise<unknown> } = {
					onIOPub: null,
					done: undefined as unknown as Promise<unknown>
				};
				future.done = new Promise((resolve) => {
					queueMicrotask(() => {
						if (isErr) {
							future.onIOPub?.({ header: { msg_type: 'error' }, parent_header: {}, content: { ename: 'ValueError', evalue: 'boom', traceback: ['Traceback (most recent call last):', 'ValueError: boom'] } });
							resolve({ content: { status: 'error', execution_count: 1 } });
						} else {
							future.onIOPub?.({ header: { msg_type: 'stream' }, parent_header: {}, content: { name: 'stdout', text: 'RICH_STDOUT_MARKER\n' } });
							resolve({ content: { status: 'ok', execution_count: 1 } });
						}
					});
				});
				return future;
			},
			restart: vi.fn(async () => {}),
			interrupt: vi.fn(async () => {}),
			shutdown: vi.fn(async () => {})
		};
	}
	return { startNew: vi.fn(async () => makeFakeKernel()) };
});

vi.mock('@jupyterlab/services', () => ({
	KernelManager: class {
		ready = Promise.resolve();
		startNew = h.startNew;
		dispose = vi.fn();
	},
	ServerConnection: { makeSettings: (o: unknown) => o }
}));

// Staleness needs a Python subprocess; stub it (SID stays honest + per-notebook).
vi.mock('../../src/lib/server/dataflow', async () => {
	const { currentSessionId } = await import('../../src/lib/server/kernel');
	return {
		getNotebookStaleness: async (nb?: string | null) => ({ sid: currentSessionId(nb), cells: {} }),
		analyzeDataflow: async () => ({})
	};
});

vi.mock('../../src/lib/server/logs', () => ({
	logInfo: vi.fn(),
	logWarn: vi.fn(),
	logError: vi.fn()
}));

let WS: string;
let svc: typeof import('../../src/lib/server/mcp/service');
let nbmod: typeof import('../../src/lib/server/notebook');

const NB = 'batch.ipynb';
const abs = () => nbmod.resolveNotebookPath(NB);

// Add one code cell (no import routing, no run) and return its id.
async function addCell(source: string): Promise<string> {
	const { ids } = await svc.addCells([{ cell_type: 'code', source }], null, { nb: abs(), routeImports: false });
	return ids[0];
}

type BatchResult = { ran: number; errored: number; results: Array<Record<string, unknown>> };

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-batch-slim-'));
	process.env.CELLAR_WORKSPACE = WS;
	svc = await import('../../src/lib/server/mcp/service');
	nbmod = await import('../../src/lib/server/notebook');
	nbmod.createNotebook(NB, null, { focus: false });
	nbmod.setActiveNotebook(NB);
});

describe('compact batch-run result payloads', () => {
	it('all-OK run_all returns compact per-cell status with NO inlined outputs', async () => {
		const ids: string[] = [];
		for (let i = 0; i < 6; i++) ids.push(await addCell(`x${i} = ${i}`));

		const res = (await svc.runAll(abs())) as BatchResult;

		// Top-level summary the agent needs. (A fresh notebook carries one default
		// empty code cell, so run_all executes it too — assert the invariant, not a
		// magic count: every result executed, none errored.)
		expect(res.ran).toBe(res.results.length);
		expect(res.errored).toBe(0);
		expect(res.results.length).toBeGreaterThanOrEqual(6);

		for (const rec of res.results) {
			expect(rec.run_status).toBe('ok_session');
			// The single biggest saving: OK cells do NOT inline their output.
			expect('outputs' in rec).toBe(false);
			expect('traceback' in rec).toBe(false);
			// A discoverable marker that there is something to fetch.
			expect(rec.has_output).toBe(true);
		}
		// Every cell we added is present as a compact status line.
		for (const id of ids) expect(res.results.some((r) => r.id === id)).toBe(true);

		// And it is genuinely compact JSON (what the MCP layer sends).
		const json = JSON.stringify(res);
		expect(json).not.toContain('RICH_STDOUT_MARKER');
		// A ~6-cell batch stays small; a full-output echo would be far larger.
		expect(json.length).toBeLessThan(700);
	});

	it('an OK cell\'s full output is still retrievable via get_full_output after a batch run', async () => {
		const id = await addCell('y = 42');
		const res = (await svc.runCells([id], abs())) as BatchResult;
		const rec = res.results.find((r) => r.id === id)!;
		expect(rec.run_status).toBe('ok_session');
		expect('outputs' in rec).toBe(false); // not inlined in the batch

		// ...but one call away, in full.
		const full = svc.getFullOutput(id, 'medium', abs()) as { outputs: Array<{ text?: string }> };
		const stdout = full.outputs.find((o) => typeof o.text === 'string' && o.text.includes('RICH_STDOUT_MARKER'));
		expect(stdout).toBeTruthy();
	});

	it('a batch with one error returns the full traceback for the erroring cell ONLY', async () => {
		const ok1 = await addCell('a = 1');
		const bad = await addCell('raise ValueError("boom")  # ERR');
		const ok2 = await addCell('b = 2');

		const res = (await svc.runCells([ok1, bad, ok2], abs())) as BatchResult;
		expect(res.ran).toBe(3);
		expect(res.errored).toBe(1);

		const okRec1 = res.results.find((r) => r.id === ok1)!;
		const badRec = res.results.find((r) => r.id === bad)!;
		const okRec2 = res.results.find((r) => r.id === ok2)!;

		// OK cells: status line only, no error detail.
		for (const ok of [okRec1, okRec2]) {
			expect(ok.run_status).toBe('ok_session');
			expect('ename' in ok).toBe(false);
			expect('traceback' in ok).toBe(false);
			expect('outputs' in ok).toBe(false);
		}

		// The errored cell carries actionable detail inline.
		expect(badRec.run_status).toBe('error_session');
		expect(badRec.ename).toBe('ValueError');
		expect(badRec.evalue).toBe('boom');
		expect(typeof badRec.traceback).toBe('string');
		expect(String(badRec.traceback)).toContain('ValueError: boom');
	});

	it('run_stale returns {ran, errored, results} with NO duplicate ran:[ids] echo', async () => {
		const res = (await svc.runStale(abs())) as BatchResult;
		// `ran` is now a COUNT, not an id array.
		expect(typeof res.ran).toBe('number');
		expect(Array.isArray((res as unknown as { ran: unknown }).ran)).toBe(false);
		expect(Array.isArray(res.results)).toBe(true);
		// With the dataflow stub reporting nothing stale, there is nothing to run.
		expect(res.ran).toBe(0);
		expect(res.results).toHaveLength(0);
	});

	it('run_range returns the compact shape (and an empty summary for a bad range)', async () => {
		const empty = (await svc.runRange('nope-a', 'nope-b', abs())) as BatchResult;
		expect(empty).toEqual({ ran: 0, errored: 0, results: [] });
	});
});
