/**
 * Per-notebook run-status doctrine (kernel-per-notebook, Phase 2).
 *
 * Each notebook has its OWN kernel with its own session epoch, so the run-status
 * split (ok_session / error_session = ran against the live namespace vs
 * ok_persisted / error_persisted = saved output from a prior session) must be
 * judged against THAT notebook's epoch — never the user's active tab. These tests
 * drive the REAL service + notebook + run-queue + kernel manager against a scratch
 * workspace, with only the Jupyter layer faked (each `startNew` yields a distinct
 * kernel; every execute emits one `{}` stdout line so a cell has persisted output
 * and the introspection probe parses cleanly, or an error output for a `# ERR`
 * cell). Two notebooks A and B run cells; running or restarting A must never move
 * B's run-status.
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
			// Emit one output on every execute so a run leaves persisted output on the
			// cell (needed to tell ok_persisted from unrun after a restart) and the
			// namespace probe gets a parseable JSON line. A `# ERR` source raises.
			requestExecute: (args: { code?: string }) => {
				const isErr = typeof args?.code === 'string' && args.code.includes('# ERR');
				const future: { onIOPub: ((msg: unknown) => void) | null; done: Promise<unknown> } = {
					onIOPub: null,
					done: undefined as unknown as Promise<unknown>
				};
				future.done = new Promise((resolve) => {
					queueMicrotask(() => {
						if (isErr) {
							future.onIOPub?.({ header: { msg_type: 'error' }, parent_header: {}, content: { ename: 'ValueError', evalue: 'boom', traceback: ['ValueError: boom'] } });
							resolve({ content: { status: 'error', execution_count: 1 } });
						} else {
							future.onIOPub?.({ header: { msg_type: 'stream' }, parent_header: {}, content: { name: 'stdout', text: '{}' } });
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

// Staleness needs a Python subprocess for the dependency graph; stub it so the
// test is fast + deterministic, but keep the SID honest and per-notebook (it is
// exactly what getNotebookStaleness reads: currentSessionId(nb)). The run-status
// split is what we assert, and it is independent of the dependency graph.
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
let kern: typeof import('../../src/lib/server/kernel');

const A = 'nb-a.ipynb';
const B = 'nb-b.ipynb';
const absA = () => nbmod.resolveNotebookPath(A);
const absB = () => nbmod.resolveNotebookPath(B);

// Add one code cell to a notebook and run it; return its id.
async function addAndRunCell(rel: string, source: string): Promise<string> {
	const abs = nbmod.resolveNotebookPath(rel);
	const { ids } = await svc.addCells([{ cell_type: 'code', source }], null, { nb: abs, routeImports: false });
	const id = ids[0];
	await svc.runCell(id, abs);
	return id;
}

// The run_status the read tool reports for one cell of a notebook.
async function status(rel: string, id: string): Promise<{ run_status: string; ran_this_session: boolean }> {
	const r = (await svc.readCell(id, nbmod.resolveNotebookPath(rel))) as { run_status: string; ran_this_session: boolean };
	return { run_status: r.run_status, ran_this_session: r.ran_this_session };
}

let a1 = '';
let b1 = '';
let aErr = '';

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-run-status-'));
	process.env.CELLAR_WORKSPACE = WS;
	svc = await import('../../src/lib/server/mcp/service');
	nbmod = await import('../../src/lib/server/notebook');
	kern = await import('../../src/lib/server/kernel');
	// Materialize both notebooks on disk; leave the USER active tab on A to prove B
	// is judged against B's epoch and not the active one.
	nbmod.createNotebook(A, null, { focus: false });
	nbmod.createNotebook(B, null, { focus: false });
	nbmod.setActiveNotebook(A);
});

describe('per-notebook run-status doctrine', () => {
	it('a run in A marks A live against A\'s own epoch, and B against B\'s', async () => {
		a1 = await addAndRunCell(A, 'a = 1');
		b1 = await addAndRunCell(B, 'b = 1');

		// Each notebook's kernel is live with a distinct epoch.
		expect(kern.currentSessionId(absA())).not.toBeNull();
		expect(kern.currentSessionId(absB())).not.toBeNull();
		expect(kern.currentSessionId(absA())).not.toBe(kern.currentSessionId(absB()));

		// Both cells ran this session, each judged against its OWN kernel.
		expect(await status(A, a1)).toEqual({ run_status: 'ok_session', ran_this_session: true });
		expect(await status(B, b1)).toEqual({ run_status: 'ok_session', ran_this_session: true });
	});

	it('running another cell in A does not disturb B\'s run-status', async () => {
		const bBefore = kern.currentSessionId(absB());
		await addAndRunCell(A, 'a2 = 2');
		// B's epoch is untouched, and its cell is still live.
		expect(kern.currentSessionId(absB())).toBe(bBefore);
		expect(await status(B, b1)).toEqual({ run_status: 'ok_session', ran_this_session: true });
	});

	it('search_cells and get_full_output classify each notebook against its own epoch', () => {
		// search_cells samples the TARGET notebook's epoch (not the active tab, which is A).
		const inB = svc.searchCells('b = 1', 'input', absB());
		expect(inB.find((r) => r.id === b1)?.ran_this_session).toBe(true);

		const full = svc.getFullOutput(b1, 'medium', absB()) as { ran_this_session: boolean };
		expect(full.ran_this_session).toBe(true);
	});

	it('get_errors reports a live error against the notebook\'s own epoch', async () => {
		aErr = await addAndRunCell(A, 'raise ValueError("boom")  # ERR');
		const errsA = svc.getErrors(absA());
		const e = errsA.find((x) => x.id === aErr);
		expect(e).toBeTruthy();
		expect(e?.ran_this_session).toBe(true);
		expect(e?.run_status).toBe('error_session');
		// B has no errors of its own.
		expect(svc.getErrors(absB())).toEqual([]);
	});

	it('restarting A reverts ONLY A\'s cells to persisted; B stays ok_session', async () => {
		const bBefore = kern.currentSessionId(absB());
		await kern.restartKernel(absA());

		// A's cell now reads as saved-from-a-previous-session; the error becomes leftover.
		expect(await status(A, a1)).toEqual({ run_status: 'ok_persisted', ran_this_session: false });
		expect(await status(A, aErr)).toEqual({ run_status: 'error_persisted', ran_this_session: false });

		// B's kernel and run-status are completely untouched by A's restart.
		expect(kern.currentSessionId(absB())).toBe(bBefore);
		expect(await status(B, b1)).toEqual({ run_status: 'ok_session', ran_this_session: true });
	});

	it('get_notebook_map and kernel_state carry each notebook\'s own epoch', async () => {
		const mapA = (await svc.getNotebookMap(absA())) as { kernel: { session_id: number | null } };
		const mapB = (await svc.getNotebookMap(absB())) as { kernel: { session_id: number | null } };
		expect(mapA.kernel.session_id).toBe(kern.currentSessionId(absA()));
		expect(mapB.kernel.session_id).toBe(kern.currentSessionId(absB()));
		expect(mapA.kernel.session_id).not.toBe(mapB.kernel.session_id);

		const stateA = (await svc.getKernelState(absA())) as { session_id: number | null };
		const stateB = (await svc.getKernelState(absB())) as { session_id: number | null };
		expect(stateA.session_id).toBe(kern.currentSessionId(absA()));
		expect(stateB.session_id).toBe(kern.currentSessionId(absB()));
	});
});
