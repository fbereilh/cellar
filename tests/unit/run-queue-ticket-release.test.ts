/**
 * The run-queue slot (ticket) must be released on EVERY exit path of the MCP
 * `run_cell` flow — success, a handled cancel, and (the bug this guards) an
 * UNEXPECTED throw in the pre-wait gap between taking the ticket and entering the
 * guarded `await`.
 *
 * Before the fix, `clearOutputsForQueue` (or any synchronous fault) between
 * `enqueueRun` and the guarded execution skipped `ticket.done()`: the slot stayed
 * `active` forever and every later run on THAT notebook waited behind it — a
 * permanently wedged queue. The fix puts the whole post-acquire body under one
 * `try { … } finally { ticket.done() }`; `release` is idempotent per entry, so the
 * extra `done()` on the already-handled cancel path is a harmless no-op and never
 * over-releases.
 *
 * Two layers, both here:
 *   1. Drive the REAL service `runCell` against a scratch workspace with only the
 *      Jupyter layer faked, injecting a one-shot throw into `clearOutputsForQueue`,
 *      to prove the notebook recovers (next run proceeds) rather than wedging, that
 *      an error mid-flight frees exactly its OWN slot without disturbing an active
 *      run (concurrency stays at 1, never N+1), and that a normal run drains to a
 *      clean queue (one acquire, one release).
 *   2. A pure run-queue check that `release()` is idempotent — double-`done()` never
 *      double-advances the FIFO nor frees a phantom extra slot.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A one-shot fault we can arm from a test: the NEXT clearOutputsForQueue throws.
const rh = vi.hoisted(() => ({ throwNextClear: false }));

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

// Staleness needs a Python subprocess; stub it (keeps the session id honest).
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

// Partial-mock the run core so `clearOutputsForQueue` (the pre-wait step that can
// fault) is controllable, while `executeCellRun` stays REAL so a run truly executes.
vi.mock('../../src/lib/server/run', async (importActual) => {
	const actual = await importActual<typeof import('../../src/lib/server/run')>();
	return {
		...actual,
		clearOutputsForQueue: (args: Parameters<typeof actual.clearOutputsForQueue>[0]) => {
			if (rh.throwNextClear) {
				rh.throwNextClear = false;
				throw new Error('injected pre-wait fault');
			}
			return actual.clearOutputsForQueue(args);
		}
	};
});

let WS: string;
let svc: typeof import('../../src/lib/server/mcp/service');
let nbmod: typeof import('../../src/lib/server/notebook');
let queue: typeof import('../../src/lib/server/run-queue');

const NB = 'wedge.ipynb';
const abs = () => nbmod.resolveNotebookPath(NB);

async function addCell(source: string): Promise<string> {
	const { ids } = await svc.addCells([{ cell_type: 'code', source }], null, { nb: abs(), routeImports: false });
	return ids[0];
}

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-wedge-'));
	process.env.CELLAR_WORKSPACE = WS;
	svc = await import('../../src/lib/server/mcp/service');
	nbmod = await import('../../src/lib/server/notebook');
	queue = await import('../../src/lib/server/run-queue');
	nbmod.createNotebook(NB, null, { focus: false });
	nbmod.setActiveNotebook(NB);
});

beforeEach(() => {
	rh.throwNextClear = false;
});

describe('MCP run_cell releases its queue slot on every exit path', () => {
	it('a throw in the pre-wait gap frees the slot — the notebook is not wedged', async () => {
		const a = await addCell('a = 1');
		const b = await addCell('b = 2');

		// Arm the one-shot fault: the next run throws AFTER taking its ticket, in the
		// pre-wait gap where the leak used to happen.
		rh.throwNextClear = true;
		await expect(svc.runCell(a, abs())).rejects.toThrow('injected pre-wait fault');

		// The slot was released despite the throw: no wedged active run, empty FIFO.
		expect(queue.queueStateFor(abs())).toEqual({ running: null, queue: [] });

		// The NEXT run on the SAME notebook proceeds — the queue recovered, not wedged.
		const res = (await svc.runCell(b, abs())) as { status: string; ran_this_session: boolean };
		expect(res.status).toBe('ok');
		expect(res.ran_this_session).toBe(true);
		expect(queue.queueStateFor(abs())).toEqual({ running: null, queue: [] });

		// And the cell that faulted can itself run once the queue has recovered.
		const again = (await svc.runCell(a, abs())) as { status: string };
		expect(again.status).toBe('ok');
		expect(queue.queueStateFor(abs())).toEqual({ running: null, queue: [] });
	});

	it('an error mid-flight releases ONLY its own slot, never disturbing an active run (concurrency stays 1, not N+1)', async () => {
		const b = await addCell('c = 3');

		// Simulate a slow run already holding this notebook's kernel: a raw active
		// ticket that we control, so the run_cell below must queue BEHIND it.
		const active = queue.enqueueRun({ nb: abs(), cellId: 'in-flight-cell', actor: 'user', source: 'x=1' });
		if (active.duplicate) throw new Error('unreachable: fresh ticket expected');
		expect(active.queued).toBe(false); // it holds the (only) slot

		// This run enqueues behind `active`, then faults in the pre-wait gap. Its
		// `finally` must release ONLY its own pending entry — `active` stays the sole
		// running slot; the queue never promotes a second run to run concurrently.
		rh.throwNextClear = true;
		await expect(svc.runCell(b, abs())).rejects.toThrow('injected pre-wait fault');

		const state = queue.queueStateFor(abs());
		expect(state.running?.cellId).toBe('in-flight-cell'); // still exactly one active
		expect(state.queue).toEqual([]); // the faulted run's slot was reclaimed, none left

		// Draining the active run leaves the notebook fully idle — no leaked slot.
		active.done();
		expect(queue.queueStateFor(abs())).toEqual({ running: null, queue: [] });
	});

	it('a normal run acquires and releases exactly one slot (drains to a clean queue)', async () => {
		const c = await addCell('d = 4');
		const res = (await svc.runCell(c, abs())) as { status: string };
		expect(res.status).toBe('ok');
		// Exactly one release: the FIFO is empty and pruned, ready for the next run.
		expect(queue.queueStateFor(abs())).toEqual({ running: null, queue: [] });

		// Immediately runnable again — proves the prior run did not early-release or
		// leave a half-open slot.
		const res2 = (await svc.runCell(c, abs())) as { status: string };
		expect(res2.status).toBe('ok');
		expect(queue.queueStateFor(abs())).toEqual({ running: null, queue: [] });
	});
});

describe('run-queue release() is idempotent (the property the fix leans on)', () => {
	it('double done() never double-advances the FIFO nor frees a phantom slot', () => {
		const NBX = '/ws/idem.ipynb';
		const a = queue.enqueueRun({ nb: NBX, cellId: 'a' });
		const b = queue.enqueueRun({ nb: NBX, cellId: 'b' }); // pending behind a
		if (a.duplicate || b.duplicate) throw new Error('unreachable');
		expect(b.queued).toBe(true);

		a.done(); // promotes b to the single active slot
		expect(queue.queueStateFor(NBX).running?.cellId).toBe('b');
		expect(queue.queueStateFor(NBX).queue).toEqual([]);

		a.done(); // idempotent: must NOT re-promote or open a second active slot
		expect(queue.queueStateFor(NBX).running?.cellId).toBe('b');
		expect(queue.queueStateFor(NBX).queue).toEqual([]);

		b.done();
		expect(queue.queueStateFor(NBX)).toEqual({ running: null, queue: [] });
		// A late, redundant release on a fully-drained entry is still a safe no-op.
		b.done();
		expect(queue.queueStateFor(NBX)).toEqual({ running: null, queue: [] });
	});
});
