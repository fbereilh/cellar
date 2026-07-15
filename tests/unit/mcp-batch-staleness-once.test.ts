/**
 * Perf Tier 2: a BATCH run (run_all / run_cells / run_range / run_stale) computes
 * whole-notebook staleness ONCE, at the end — not once per cell.
 *
 * `getNotebookStaleness` is ~O(N) over the definer graph, so the old per-cell
 * pass made an N-cell batch ~O(N^2)+ of redundant JS recompute. Now each cell in a
 * batch runs with staleness SKIPPED and `runCells` takes a single post-batch
 * snapshot, deriving every cell's final stale state from it. The single-cell
 * `run_cell` path is unchanged (still its own one pass).
 *
 * These tests drive the REAL service + notebook + run-queue + kernel manager
 * against a scratch workspace, faking only the Jupyter layer (every OK cell emits
 * one stdout line; a `# ERR` cell raises) and stubbing the Python staleness
 * subprocess with a COUNTING, controllable mock so we can assert both the
 * invocation count and per-cell stale parity against that single snapshot.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
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
							future.onIOPub?.({ header: { msg_type: 'stream' }, parent_header: {}, content: { name: 'stdout', text: 'OK\n' } });
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

// A COUNTING, controllable staleness stub: `calls` is how many times a
// staleness pass ran (this is the whole point of the feature), `map` is the
// verdict we want the next pass to return (keyed by cell id).
const st = vi.hoisted(() => ({
	calls: 0,
	map: {} as Record<string, { state: string; reason?: string; upstream?: string[] }>
}));

vi.mock('../../src/lib/server/dataflow', async () => {
	const { currentSessionId } = await import('../../src/lib/server/kernel');
	return {
		getNotebookStaleness: async (nb?: string | null) => {
			st.calls++;
			return { sid: currentSessionId(nb), cells: st.map };
		},
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
let queue: typeof import('../../src/lib/server/run-queue');

const NB = 'stale-batch.ipynb';
const abs = () => nbmod.resolveNotebookPath(NB);

async function addCell(source: string): Promise<string> {
	const { ids } = await svc.addCells([{ cell_type: 'code', source }], null, { nb: abs(), routeImports: false });
	return ids[0];
}

// The service emits/accepts short HANDLES, but `getNotebookStaleness` (and our
// stub's `map`) is keyed by the FULL cell id the notebook stores. Resolve a
// handle to its full id so the stub's verdict lands on the right cell.
const fullId = (handle: string): string => svc.resolveRef(abs(), handle);

type BatchResult = { ran: number; errored: number; results: Array<Record<string, unknown>> };

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-stale-once-'));
	process.env.CELLAR_WORKSPACE = WS;
	svc = await import('../../src/lib/server/mcp/service');
	nbmod = await import('../../src/lib/server/notebook');
	queue = await import('../../src/lib/server/run-queue');
	nbmod.createNotebook(NB, null, { focus: false });
	nbmod.setActiveNotebook(NB);
});

beforeEach(() => {
	st.calls = 0;
	st.map = {};
});

describe('batch staleness is computed once, not once per cell', () => {
	it('run_all over N cells invokes getNotebookStaleness EXACTLY ONCE (not N times)', async () => {
		const ids: string[] = [];
		for (let i = 0; i < 6; i++) ids.push(await addCell(`x${i} = ${i}`));

		st.calls = 0;
		const res = (await svc.runAll(abs())) as BatchResult;

		// The batch executed several cells (the added six + the notebook's default
		// empty cell), yet ran the O(N) staleness pass just ONCE.
		expect(res.results.length).toBeGreaterThanOrEqual(6);
		expect(res.ran).toBe(res.results.length);
		expect(st.calls).toBe(1);
	});

	it('the single-cell run_cell path is unchanged — still exactly one staleness pass, still carries stale_state', async () => {
		const id = await addCell('solo = 1');
		st.map = { [fullId(id)]: { state: 'fresh' } };

		st.calls = 0;
		const r = (await svc.runCell(id, abs())) as Record<string, unknown>;

		expect(r.status).toBe('ok');
		expect(st.calls).toBe(1);
		// run_cell still surfaces its own per-run staleness verdict (stale_state is
		// always present on the single-cell path — the batch path omits it by design).
		expect(r.stale_state).toBe('fresh');
	});

	it("each cell's final stale state in the batch result matches the single end-of-batch snapshot", async () => {
		const upstream = await addCell('u = 1');
		const downstream = await addCell('d = u + 1');

		// The end-of-batch snapshot: upstream fresh, downstream still stale because
		// (say) an upstream it needs was edited but not re-run. This is the ONE view
		// the whole batch result must reflect.
		st.map = {
			[fullId(upstream)]: { state: 'fresh' },
			[fullId(downstream)]: { state: 'stale', reason: 'depends on an edited upstream (u)', upstream: [fullId(upstream)] }
		};

		st.calls = 0;
		const res = (await svc.runCells([upstream, downstream], abs())) as BatchResult;
		expect(st.calls).toBe(1); // derived from ONE snapshot, not two per-cell passes

		const up = res.results.find((r) => r.id === upstream)!;
		const down = res.results.find((r) => r.id === downstream)!;

		// A fresh cell carries no stale fields in a batch (omit-when-default).
		expect('stale' in up).toBe(false);
		expect('stale_state' in up).toBe(false);

		// The stale downstream carries exactly the snapshot's verdict — flag, reason,
		// and the upstream handle to re-run — parity with a single end-of-batch pass.
		expect(down.stale).toBe(true);
		expect(down.stale_reason).toBe('depends on an edited upstream (u)');
		expect(down.stale_upstream).toEqual([upstream]);
	});

	it('an errored cell does not abort the batch, and the single snapshot reflects post-batch state for what ran', async () => {
		const ok = await addCell('a = 1');
		const bad = await addCell('raise ValueError("boom")  # ERR');
		const after = await addCell('b = 2');

		// Post-batch snapshot: `after` is stale (it ran, but depends on the errored
		// cell whose output is unreliable). Correct end-state view of what ran.
		st.map = {
			[fullId(ok)]: { state: 'fresh' },
			[fullId(bad)]: { state: 'fresh' },
			[fullId(after)]: { state: 'stale', reason: 'depends on a cell that errored', upstream: [fullId(bad)] }
		};

		st.calls = 0;
		const res = (await svc.runCells([ok, bad, after], abs())) as BatchResult;

		// The error did not stop the batch; all three ran, staleness computed once.
		expect(res.ran).toBe(3);
		expect(res.errored).toBe(1);
		expect(st.calls).toBe(1);

		const badRec = res.results.find((r) => r.id === bad)!;
		expect(badRec.run_status).toBe('error_session');
		expect(badRec.ename).toBe('ValueError');

		const afterRec = res.results.find((r) => r.id === after)!;
		expect(afterRec.stale).toBe(true);
		expect(afterRec.stale_upstream).toEqual([bad]);
	});

	it('a batch that STOPS EARLY (a queued run cancelled) still computes staleness exactly once, over what actually ran', async () => {
		const a = await addCell('p = 1');
		const b = await addCell('q = 2');

		// Occupy this notebook's single kernel slot with a raw active ticket, so the
		// batch's first cell must QUEUE behind it.
		const blocker = queue.enqueueRun({ nb: abs(), cellId: 'blocker-cell', actor: 'user', source: 'x=1' });
		if (blocker.duplicate) throw new Error('unreachable: fresh ticket expected');
		expect(blocker.queued).toBe(false); // holds the only slot

		st.calls = 0;
		const pending = svc.runCells([a, b], abs()) as Promise<BatchResult>;
		// Let cell `a` enqueue (pending) and reach its wait, then drop the queue as a
		// restart/interrupt would — `a`'s queued run is cancelled before it executes.
		await new Promise((r) => setTimeout(r, 20));
		queue.clearRunQueue(abs(), 'kernel_restart');
		blocker.done();

		const res = await pending;

		// The batch stopped at the cancelled cell: `b` never ran, nothing executed,
		// yet the single end-of-batch staleness pass still ran exactly once.
		expect(st.calls).toBe(1);
		expect(res.ran).toBe(0);
		const aRec = res.results.find((r) => r.id === a);
		expect(aRec?.status).toBe('cancelled');
		expect(res.results.some((r) => r.id === b)).toBe(false);
	});
});
