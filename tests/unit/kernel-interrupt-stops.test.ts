/**
 * "Stop means stop" - interrupt must END the run, not merely signal the kernel.
 *
 * SIGINT is a REQUEST. An ordinary python cell obeys it in milliseconds (measured
 * against a real kernel: ~100ms), but the RUN only ends when the kernel sends its
 * `execute_reply`, and there are two ordinary ways for that never to happen:
 *
 *   F1 - the kernel is signalled and the running work does not surrender, so
 *        `future.done` never settles. The idle watchdog deliberately will NOT rescue
 *        this: it probes the kernel, sees a genuinely BUSY one, and re-arms forever,
 *        because silence is exactly what a healthy 3-hour Spark job looks like.
 *
 *   F2 - the user's cell never reached the kernel at all. It holds the run queue's
 *        `running` slot and has emitted `run:start` (so the cell reads RUNNING) while
 *        parked on the per-kernel exec lock behind an INTERNAL execute. That is the
 *        Spark-specific one, and it is a session FAILURE that triggers it: a failed
 *        session makes the Databricks panel's status poll fire `autoReconnect`, whose
 *        `CONNECT_CODE` legitimately holds the lock for MINUTES while a cold cluster
 *        starts. The user re-runs their cell, it parks, and before this fix it was
 *        reachable by NOTHING - no longer in the queue's `pending` (so `clearRunQueue`
 *        could not see it), not yet in `activeRuns` (so `abortActiveRuns` could not
 *        either). Only Databricks work runs kernel ops that long, which is why the bug
 *        reads as "especially on spark cells".
 *
 * In both, the old implementation signalled, returned `ok`, and never checked - so the
 * cell read "running" forever while the tool reported success. Proven here against the
 * REAL run-queue + REAL executeCellRun + REAL kernel.ts (only the Jupyter layer is
 * faked, so the whole owner -> execute -> finally -> release path runs).
 *
 * The grace window is driven to 120ms via CELLAR_KERNEL_INTERRUPT_GRACE_MS so the
 * escalation is observable in-test; production defaults to 5s.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const h = vi.hoisted(() => {
	let seq = 0;
	function makeFuture() {
		let resolveDone: (v: { content: { status: string; execution_count: number } }) => void = () => {};
		// A future is LIVE from the moment `requestExecute` mints it until it settles or
		// is disposed - i.e. exactly while its `requestExecute` is on the wire. `maxLive`
		// is therefore the concurrency the exec lock is supposed to be holding at 1.
		h.live += 1;
		h.maxLive = Math.max(h.maxLive, h.live);
		let closed = false;
		const close = () => {
			if (closed) return;
			closed = true;
			h.live -= 1;
		};
		const f: {
			onIOPub: ((msg: unknown) => void) | null;
			onReply: ((msg: unknown) => void) | null;
			onStdin: ((msg: unknown) => void) | null;
			done: Promise<{ content: { status: string; execution_count: number } }>;
			dispose: ReturnType<typeof vi.fn>;
			_resolve: (status?: string) => void;
			code: string;
		} = {
			onIOPub: null,
			onReply: null,
			onStdin: null,
			done: undefined as unknown as Promise<{ content: { status: string; execution_count: number } }>,
			dispose: vi.fn(() => close()),
			_resolve: (status = 'ok') => {
				close();
				resolveDone({ content: { status, execution_count: 1 } });
			},
			code: ''
		};
		f.done = new Promise((res) => {
			resolveDone = res;
		});
		return f;
	}

	function makeFakeKernel() {
		seq += 1;
		const k = {
			id: `kernel-${seq}`,
			name: 'python3',
			status: 'idle' as const,
			connectionStatus: 'connected' as string,
			commsOverSubshells: undefined as unknown,
			registerCommTarget: vi.fn(),
			statusChanged: { connect: vi.fn(), disconnect: vi.fn() },
			iopubMessage: { connect: vi.fn() },
			requestExecute: (args: { code?: string }) => {
				const code = typeof args?.code === 'string' ? args.code : '';
				// A silent blocking cell that never replies on its own - the shape of a
				// Spark query. A test ends it via h.lastHanging, or the fake's interrupt
				// does when `h.kernelObeysInterrupt` is set.
				if (code.includes('# HANG')) {
					const f = makeFuture();
					f.code = code;
					h.lastHanging = f;
					h.hanging.push(f);
					return f;
				}
				const f = makeFuture();
				f.code = code;
				queueMicrotask(() => f._resolve('ok'));
				return f;
			},
			restart: vi.fn(async () => {}),
			/**
			 * The kernel's answer to SIGINT. Default: it does NOT surrender (F1's kernel,
			 * and the shape reproduced live against a real kernel whose cell swallows the
			 * KeyboardInterrupt). Set `h.kernelObeysInterrupt` for the ordinary cell that
			 * does obey, which must keep taking the graceful path.
			 */
			interrupt: vi.fn(async () => {
				if (!h.kernelObeysInterrupt) return;
				for (const f of h.hanging.splice(0)) {
					f.onIOPub?.({
						header: { msg_type: 'error' },
						parent_header: {},
						content: { ename: 'KeyboardInterrupt', evalue: '', traceback: ['KeyboardInterrupt'] }
					});
					f._resolve('error');
				}
			}),
			shutdown: vi.fn(async () => {}),
			reconnect: vi.fn(async () => {
				k.connectionStatus = 'connected';
			}),
			dispose: vi.fn()
		};
		h.lastKernel = k;
		return k;
	}

	return {
		makeFakeKernel,
		startNew: vi.fn(async () => makeFakeKernel()),
		lastKernel: null as ReturnType<typeof makeFakeKernel> | null,
		lastHanging: null as ReturnType<typeof makeFuture> | null,
		hanging: [] as ReturnType<typeof makeFuture>[],
		kernelObeysInterrupt: false,
		live: 0,
		maxLive: 0,
		probeCalls: 0,
		// A kernel that is genuinely BUSY: this is what makes the idle watchdog re-arm
		// rather than rescue the run, which is why interrupt has to.
		probe: (() => ({ execution_state: 'busy' })) as () => { execution_state: string } | undefined,
		getKernelModel: vi.fn(async () => {
			h.probeCalls += 1;
			return h.probe();
		})
	};
});

vi.mock('@jupyterlab/services', () => ({
	KernelManager: class {
		ready = Promise.resolve();
		startNew = h.startNew;
		runningChanged = { connect: vi.fn() };
		running() {
			return [][Symbol.iterator]();
		}
		dispose = vi.fn();
	},
	ServerConnection: { makeSettings: (o: unknown) => o },
	CommsOverSubshells: { Disabled: 'disabled' },
	KernelAPI: { getKernelModel: h.getKernelModel }
}));

vi.mock('../../src/lib/server/logs', () => ({
	logInfo: vi.fn(),
	logWarn: vi.fn(),
	logError: vi.fn()
}));

let WS: string;
let nbmod: typeof import('../../src/lib/server/notebook');
let queue: typeof import('../../src/lib/server/run-queue');
let runmod: typeof import('../../src/lib/server/run');
let kernelmod: typeof import('../../src/lib/server/kernel');

const NB = 'interrupt.ipynb';
const abs = () => nbmod.resolveNotebookPath(NB);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The grace window this suite runs with, mirrored from the env below. */
const GRACE_MS = 120;

function newCell(source: string): string {
	return nbmod.addCell(null, 'code', abs(), null, source).id;
}

/** Start a run without awaiting it, holding its ticket like a real owner does. */
function startRun(cellId: string, source: string) {
	const nb = abs();
	const ticket = queue.enqueueRun({ nb, cellId, actor: 'user', source });
	if (ticket.duplicate) throw new Error('unreachable: fresh ticket expected');
	return ticket.wait().then(() =>
		runmod.executeCellRun({ nb, cellId, actor: 'user', source: ticket.source() }).finally(() => ticket.done())
	);
}

/** Wait until `fn` holds, or fail with a message naming what never happened. */
async function until(fn: () => boolean, what: string, budgetMs = 5000) {
	const deadline = Date.now() + budgetMs;
	while (!fn() && Date.now() < deadline) await sleep(10);
	if (!fn()) throw new Error(`timed out after ${budgetMs}ms waiting for: ${what}`);
}

/** The single error output a force-settled run reports. */
function soleError(outputs: unknown[]): Record<string, unknown> {
	expect(outputs.length).toBe(1);
	return outputs[0] as Record<string, unknown>;
}

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-interrupt-'));
	process.env.CELLAR_WORKSPACE = WS;
	// A long idle window: this suite is about INTERRUPT, and the watchdog must never
	// be what rescues these runs - if it were, the tests would pass without the fix.
	process.env.CELLAR_KERNEL_IDLE_TIMEOUT_MS = '60000';
	process.env.CELLAR_KERNEL_INTERRUPT_GRACE_MS = String(GRACE_MS);
	nbmod = await import('../../src/lib/server/notebook');
	queue = await import('../../src/lib/server/run-queue');
	runmod = await import('../../src/lib/server/run');
	kernelmod = await import('../../src/lib/server/kernel');
	nbmod.createNotebook(NB, null, { focus: false });
	nbmod.setActiveNotebook(NB);
});

beforeEach(() => {
	h.probeCalls = 0;
	h.hanging = [];
	// Reset the handle too: left stale from a previous test, `until(lastHanging)`
	// returns before this test's run has reached the kernel at all.
	h.lastHanging = null;
	h.kernelObeysInterrupt = false;
	h.maxLive = h.live; // measure only what THIS test puts on the wire
	h.probe = () => ({ execution_state: 'busy' });
	if (h.lastKernel) h.lastKernel.connectionStatus = 'connected';
});

describe('F1: the kernel is signalled and does not surrender', () => {
	it('force-settles the run, frees the slot, and never claims the kernel stopped', async () => {
		const nb = abs();
		const c = newCell('spark.sql(q).toPandas()  # HANG');
		const runP = startRun(c, 'spark.sql(q).toPandas()  # HANG');
		await until(() => h.lastHanging != null, 'the run to reach the kernel');
		expect(queue.queueStateFor(nb).running?.cellId).toBe(c);

		const res = await kernelmod.interruptKernel(nb);

		// THE REGRESSION: before the fix the run never settled - this await hung until
		// the test's own timeout - and the queue slot stayed held forever.
		const run = await runP;
		expect(res.stopped).toBe('forced');
		expect(run.status).toBe('error');
		expect(queue.queueStateFor(nb)).toEqual({ running: null, queue: [] });
		// The abandoned future is disposed so its handlers detach.
		expect(h.lastHanging!.dispose).toHaveBeenCalled();

		// HONESTY: the interrupt did not observe a stop, so the message may not assert
		// one. It says Cellar stopped waiting, that the kernel may still be running the
		// code, and names the one action that is guaranteed to end it.
		const err = soleError(run.outputs);
		const evalue = String(err.evalue);
		expect(evalue).toMatch(/did not respond to the interrupt/i);
		expect(evalue).toMatch(/may still be executing/i);
		expect(evalue).toMatch(/restart/i);
		// It must NOT claim a restart happened - that is a different reason's sentence,
		// and asserting a cause this path never established is the defect the watchdog's
		// old "no activity for 900s" message is remembered for.
		expect(evalue).not.toMatch(/the kernel was restarted/i);
	});

	it('a SECOND run afterwards is accepted - the notebook is usable again', async () => {
		const nb = abs();
		const stuck = newCell('stuck  # HANG');
		const stuckP = startRun(stuck, 'stuck  # HANG');
		await until(() => h.lastHanging != null, 'the stuck run to reach the kernel');
		await kernelmod.interruptKernel(nb);
		await stuckP;

		const c2 = newCell('y = 2');
		const res = await (async () => {
			const ticket = queue.enqueueRun({ nb, cellId: c2, actor: 'user', source: 'y = 2' });
			if (ticket.duplicate) throw new Error('unreachable: fresh ticket expected');
			await ticket.wait();
			try {
				return await runmod.executeCellRun({ nb, cellId: c2, actor: 'user', source: 'y = 2' });
			} finally {
				ticket.done();
			}
		})();
		expect(res.status).toBe('ok');
		expect(queue.queueStateFor(nb)).toEqual({ running: null, queue: [] });
	});
});

describe('F2: the cell never reached the kernel (parked on the exec lock)', () => {
	it('settles a run parked behind a long internal Databricks op', async () => {
		const nb = abs();
		// Warm the kernel so its startup injections are done and cannot be confused
		// with the lock holder below.
		const warm = newCell('warm = 1');
		await startRun(warm, 'warm = 1');

		// The lock holder: an INTERNAL execute that never finishes - `runInKernel`'s
		// shape for CONNECT_CODE while a cold cluster starts.
		let internalSettled = false;
		const internalP = kernelmod
			.execute(nb, 'CONNECT_CODE  # HANG', () => {}, { internal: true })
			.catch(() => {})
			.finally(() => {
				internalSettled = true;
			});
		await until(() => h.lastHanging != null, 'the internal op to take the kernel');
		const holder = h.lastHanging!;

		// The user re-runs their cell. It takes the queue's running slot and emits
		// run:start (the cell reads RUNNING), then parks on the exec lock.
		const c = newCell('df.show()  # HANG');
		let userSettled = false;
		const userP = startRun(c, 'df.show()  # HANG').finally(() => {
			userSettled = true;
		});
		await until(() => queue.queueStateFor(nb).running?.cellId === c, 'the user run to hold the slot');
		expect(userSettled).toBe(false);
		// It genuinely never reached the kernel: the only hanging future is the holder's.
		expect(h.lastHanging).toBe(holder);

		const res = await kernelmod.interruptKernel(nb);

		// THE REGRESSION: before the fix nothing could settle this run - it was in
		// neither the queue's `pending` nor `activeRuns` - so it read "running" forever.
		const run = await userP;
		expect(res.stopped).toBe('forced');
		expect(run.status).toBe('error');
		expect(queue.queueStateFor(nb)).toEqual({ running: null, queue: [] });

		// The internal holder is settled by the same escalation, so the kernel is not
		// left permanently claimed either.
		await until(() => internalSettled, 'the internal lock holder to settle');
		await internalP;
	});

	it('never lets two executes overlap - an aborted parked run defers its chain release', async () => {
		const nb = abs();
		// The lock holder: an internal op the kernel is genuinely executing.
		const holderP = kernelmod.execute(nb, 'HOLDER  # HANG', () => {}, { internal: true }).catch(() => {});
		await until(() => h.lastHanging != null, 'the holder to take the kernel');

		// A user run parks behind it, and more work queues behind that.
		const parked = newCell('parked  # HANG');
		const parkedP = startRun(parked, 'parked  # HANG').catch(() => {});
		await until(() => queue.queueStateFor(nb).running?.cellId === parked, 'the parked run to hold the slot');
		const thirdP = kernelmod.execute(nb, 'THIRD', () => {}).catch(() => {});

		// The interrupt aborts BOTH the parked run and the internal holder - which is
		// what unwedges the notebook - and the parked one is aborted while its
		// predecessor's `requestExecute` is still on the wire. Releasing its chain node
		// there and then (rather than when its turn would have come) would let the next
		// execute overlap the holder's: the collision that makes @jupyterlab mis-pair
		// the interleaved idle/reply and wedges a run's `future.done` forever.
		await kernelmod.interruptKernel(nb);
		await Promise.all([parkedP, holderP, thirdP]);

		expect(h.maxLive).toBe(1);
		expect(queue.queueStateFor(nb)).toEqual({ running: null, queue: [] });
	});
});

describe('the graceful path is preserved', () => {
	it('a kernel that DOES surrender keeps its own output and is never force-aborted', async () => {
		const nb = abs();
		h.kernelObeysInterrupt = true;
		const c = newCell('time.sleep(60)  # HANG');
		const runP = startRun(c, 'time.sleep(60)  # HANG');
		await until(() => h.lastHanging != null, 'the run to reach the kernel');
		const future = h.lastHanging!;

		const res = await kernelmod.interruptKernel(nb);
		const run = await runP;

		// The kernel ended the run itself, so the result says so - never 'forced'.
		expect(res.stopped).toBe('kernel');
		// Its own KeyboardInterrupt is what the cell shows; Cellar synthesized nothing.
		const err = soleError(run.outputs);
		expect(err.ename).toBe('KeyboardInterrupt');
		// Not force-disposed: it completed through the normal path.
		expect(future.dispose).not.toHaveBeenCalled();
		expect(queue.queueStateFor(nb)).toEqual({ running: null, queue: [] });
	});

	it('returns promptly rather than waiting out the grace window', async () => {
		const nb = abs();
		h.kernelObeysInterrupt = true;
		const c = newCell('quick  # HANG');
		const runP = startRun(c, 'quick  # HANG');
		await until(() => h.lastHanging != null, 'the run to reach the kernel');

		const t0 = Date.now();
		const res = await kernelmod.interruptKernel(nb);
		const elapsed = Date.now() - t0;
		await runP;

		expect(res.stopped).toBe('kernel');
		// The poll returns the moment the run ends, so the ordinary interrupt pays a
		// tick, not the whole window.
		expect(elapsed).toBeLessThan(GRACE_MS);
	});

	it('an interrupt with nothing running reports idle and aborts nothing', async () => {
		const nb = abs();
		await startRun(newCell('z = 1'), 'z = 1');
		const res = await kernelmod.interruptKernel(nb);
		expect(res.stopped).toBe('idle');
		expect(queue.queueStateFor(nb)).toEqual({ running: null, queue: [] });
	});
});

describe("the tool's other promise: queued runs are dropped", () => {
	it('drops every pending run and settles the running one', async () => {
		const nb = abs();
		const running = newCell('blocking  # HANG');
		const runP = startRun(running, 'blocking  # HANG');
		await until(() => h.lastHanging != null, 'the run to reach the kernel');

		// Two more cells queue behind it.
		const q1 = newCell('a = 1');
		const q2 = newCell('b = 2');
		const t1 = queue.enqueueRun({ nb, cellId: q1, actor: 'user', source: 'a = 1' });
		const t2 = queue.enqueueRun({ nb, cellId: q2, actor: 'user', source: 'b = 2' });
		if (t1.duplicate || t2.duplicate) throw new Error('unreachable: fresh tickets expected');
		const dropped: string[] = [];
		const reasonOf = (e: unknown) => {
			const err = e as { reason?: string; name?: string };
			return err?.reason ?? err?.name;
		};
		t1.wait().catch((e: unknown) => dropped.push(`q1:${reasonOf(e)}`));
		t2.wait().catch((e: unknown) => dropped.push(`q2:${reasonOf(e)}`));
		await until(() => queue.queueStateFor(nb).queue.length === 2, 'both cells to queue');

		await kernelmod.interruptKernel(nb);
		await runP;

		await until(() => dropped.length === 2, 'both queued runs to be cancelled');
		expect(dropped.sort()).toEqual(['q1:kernel_interrupt', 'q2:kernel_interrupt']);
		expect(queue.queueStateFor(nb)).toEqual({ running: null, queue: [] });
	});
});
