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
				// A send that fails before any future exists - a dead/dying kernel. The run
				// is over before it ever ran, so it must leave no abort handle behind.
				if (code.includes('# THROW')) throw new Error('requestExecute failed');
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
				// The seam is path-INDEPENDENT: whichever call the production code makes to
				// signal, a failing sidecar fails it the same way. Without this the "never
				// resolves" case could only ever be driven through one of them.
				if (h.interruptSignalFails === 'hang') return new Promise<void>(() => {});
				if (h.interruptSignalFails) throw new Error('Kernel is dead');
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
		startNew: vi.fn(async () => {
			// A sidecar that cannot be reached at all - the ONE thing `kernel_unavailable`
			// is allowed to mean. `execute()` throws before it ever has a kernel in hand.
			if (h.startFails) throw new Error('sidecar unreachable');
			return makeFakeKernel();
		}),
		startFails: false,
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
		}),
		// `POST /api/kernels/<id>/interrupt` - the REAL delivery path, so the two ways
		// it can fail the caller are drivable: it REJECTS (a dead kernel, a refused or
		// failed POST) and it never resolves (a black-holed sidecar that accepts the
		// connection and then says nothing). Neither may stop the escalation.
		interruptSignalFails: false as boolean | 'hang',
		interruptKernel: vi.fn(async (_id: string, settings?: { init?: { signal?: AbortSignal } }) => {
			if (h.interruptSignalFails === 'hang') {
				// Settle only when the caller CANCELS, so a test that never cancels hangs -
				// which is what proves the bound is real rather than incidental.
				const signal = settings?.init?.signal;
				await new Promise<void>((_, reject) => {
					signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
				});
				return;
			}
			if (h.interruptSignalFails) throw new Error('Kernel is dead');
			await h.lastKernel?.interrupt();
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
	KernelAPI: { getKernelModel: h.getKernelModel, interruptKernel: h.interruptKernel }
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
/** The bound on the interrupt REST POST, likewise mirrored from the env below. */
const SIGNAL_TIMEOUT_MS = 80;

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
	process.env.CELLAR_KERNEL_INTERRUPT_SIGNAL_TIMEOUT_MS = String(SIGNAL_TIMEOUT_MS);
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
	h.startFails = false;
	h.interruptSignalFails = false;
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

describe('the escalation does not depend on the signal that is failing', () => {
	it('a signal that THROWS still ends the run and frees the slot', async () => {
		const nb = abs();
		const c = newCell('stuck  # HANG');
		const runP = startRun(c, 'stuck  # HANG');
		await until(() => h.lastHanging != null, 'the run to reach the kernel');
		// @jupyterlab rejects outright for a kernel it believes is dead, and for any
		// failed REST POST.
		h.interruptSignalFails = true;

		// THE REGRESSION: `await kernel.interrupt()` gated the whole escalation, so this
		// rejected out of interruptKernel and the run was never force-settled - the cell
		// read RUNNING forever while the UI's bare catch showed nothing.
		const res = await kernelmod.interruptKernel(nb);
		const run = await runP;

		expect(res.stopped).toBe('forced_no_signal');
		expect(run.status).toBe('error');
		expect(queue.queueStateFor(nb)).toEqual({ running: null, queue: [] });

		// HONESTY: the kernel was never asked, so the message may not say it failed to
		// answer - that is a claim about a request that was never sent.
		const evalue = String(soleError(run.outputs).evalue);
		expect(evalue).toMatch(/could not deliver the interrupt/i);
		expect(evalue).toMatch(/may still be executing/i);
		expect(evalue).not.toMatch(/did not respond/i);
	});

	it('a signal that never resolves is cancelled, and the run still ends', async () => {
		const nb = abs();
		const c = newCell('wedged  # HANG');
		const runP = startRun(c, 'wedged  # HANG');
		await until(() => h.lastHanging != null, 'the run to reach the kernel');
		// A black-holed sidecar: it accepts the connection and then says nothing. The
		// fake settles only on CANCEL, so this hangs forever unless the bound is real.
		h.interruptSignalFails = 'hang';

		const started = Date.now();
		const res = await kernelmod.interruptKernel(nb);
		const run = await runP;

		expect(res.stopped).toBe('forced_no_signal');
		expect(run.status).toBe('error');
		expect(queue.queueStateFor(nb)).toEqual({ running: null, queue: [] });
		// Bounded by the signal timeout, and NOT additive with the grace window: nothing
		// was asked, so there is no surrender to wait for.
		expect(Date.now() - started).toBeLessThan(SIGNAL_TIMEOUT_MS + GRACE_MS);
		expect(String(soleError(run.outputs).evalue)).toMatch(/could not deliver the interrupt/i);
	});

	it('an undeliverable signal with nothing running still reports idle', async () => {
		const nb = abs();
		await kernelmod.execute(nb, 'warm3 = 1', () => {});
		h.interruptSignalFails = true;
		const res = await kernelmod.interruptKernel(nb);
		// A failed signal is not, by itself, something stopped.
		expect(res.stopped).toBe('idle');
	});
});

describe("a force-settled run is not reported as a kernel that could not be reached", () => {
	it('an aborted PARKED run (F2) carries no kernel_unavailable', async () => {
		const nb = abs();
		// The lock holder, so the user's run parks and never reaches the kernel - the
		// shape whose `execute()` throws with the session epoch still unstamped.
		const holderP = kernelmod.execute(nb, 'HOLDER  # HANG', () => {}, { internal: true }).catch(() => {});
		await until(() => h.lastHanging != null, 'the holder to take the kernel');

		const c = newCell('df.show()  # HANG');
		const userP = startRun(c, 'df.show()  # HANG');
		await until(() => queue.queueStateFor(nb).running?.cellId === c, 'the user run to hold the slot');

		await kernelmod.interruptKernel(nb);
		const run = await userP;
		await holderP;

		expect(run.status).toBe('error');
		// THE REGRESSION: the run threw with `session` null (the `kernel` event is emitted
		// only after the exec lock, and this run never got there), so the kernel-down
		// inference fired - asserting an unreachable kernel over one that was alive and
		// busy, and dropping the cell into `error_persisted`, which agents are told to
		// distrust as leftover from a previous session.
		expect(run.kernelDown).toBe(false);
		expect(run.lastRun.kernel_unavailable).toBeUndefined();
		expect(nbmod.getCell(c, nb)?.metadata?.cellar?.lastRun?.kernel_unavailable).toBeUndefined();
	});

	it('a genuinely unreachable sidecar still reports kernel_unavailable', async () => {
		const nb = abs();
		await kernelmod.shutdownKernel(nb);
		h.startFails = true;
		const c = newCell('x = 1');
		const run = await startRun(c, 'x = 1');
		expect(run.status).toBe('error');
		expect(run.kernelDown).toBe(true);
		expect(run.lastRun.kernel_unavailable).toBe(true);
	});
});

describe('a force-abort is never reported as a kernel surrender', () => {
	it('a SECOND overlapping interrupt does not claim the kernel stopped', async () => {
		const nb = abs();
		const c = newCell('stuck  # HANG');
		const runP = startRun(c, 'stuck  # HANG');
		await until(() => h.lastHanging != null, 'the run to reach the kernel');

		// The cell reads RUNNING for the whole grace window, so a user clicking stop
		// twice - or a stop click plus an agent's interrupt_kernel - is ordinary.
		const [first, second] = await Promise.all([kernelmod.interruptKernel(nb), kernelmod.interruptKernel(nb)]);
		const run = await runP;

		expect(run.status).toBe('error');
		// THE REGRESSION: the loser inferred `kernel` purely from the watched run having
		// LEFT activeRuns, which the winner's force-abort had just done - so it reported
		// a clean kernel stop for a run nothing ever stopped.
		expect(first.stopped).toBe('forced');
		expect(second.stopped).toBe('forced');
	});

	it('a kernel that DOES answer still reports a genuine surrender', async () => {
		const nb = abs();
		h.kernelObeysInterrupt = true;
		const c = newCell('sleep  # HANG');
		const runP = startRun(c, 'sleep  # HANG');
		await until(() => h.lastHanging != null, 'the run to reach the kernel');
		const res = await kernelmod.interruptKernel(nb);
		await runP;
		expect(res.stopped).toBe('kernel');
	});
});

describe('an abort message names only what its reason establishes', () => {
	it('a SHUTDOWN says the kernel is gone, never that it was restarted', async () => {
		const nb = abs();
		const c = newCell('long  # HANG');
		const runP = startRun(c, 'long  # HANG');
		await until(() => h.lastHanging != null, 'the run to reach the kernel');

		await kernelmod.shutdownKernel(nb);
		const run = await runP;

		const evalue = String(soleError(run.outputs).evalue);
		expect(evalue).toMatch(/kernel this run was waiting on is gone/i);
		// A shutdown, a cull and a notebook delete are not restarts; claiming one is the
		// same assert-more-than-was-observed defect the interrupt message exists to end.
		expect(evalue).not.toMatch(/was restarted/i);
	});

	it('a RESTART still says the kernel was restarted', async () => {
		const nb = abs();
		const c = newCell('long2  # HANG');
		const runP = startRun(c, 'long2  # HANG');
		await until(() => h.lastHanging != null, 'the run to reach the kernel');

		await kernelmod.restartKernel(nb);
		const run = await runP;

		expect(String(soleError(run.outputs).evalue)).toBe('Run aborted: the kernel was restarted.');
	});
});

describe('an interrupt settles exactly the runs it signalled', () => {
	it('leaves a run that STARTS during the grace window alone', async () => {
		const nb = abs();
		const c = newCell('stuck  # HANG');
		const runP = startRun(c, 'stuck  # HANG');
		await until(() => h.lastHanging != null, 'the run to reach the kernel');
		const signalled = h.lastKernel!.interrupt.mock.calls.length;

		const interruptP = kernelmod.interruptKernel(nb);
		// Past this point the interrupt has signalled and snapshotted what it owns.
		await until(() => h.lastKernel!.interrupt.mock.calls.length > signalled, 'the kernel to be signalled');

		// A LATER execute - the shape of a Databricks status poll firing mid-window.
		// It parks behind the stuck run, so it is live in `activeRuns` at the deadline.
		const laterP = kernelmod.execute(nb, 'later = 1', () => {});

		const res = await interruptP;
		const run = await runP;
		expect(res.stopped).toBe('forced');
		expect(run.status).toBe('error');

		// THE REGRESSION: aborting whatever happened to be registered AT THE DEADLINE
		// killed this one too - work nobody asked to stop, settled with a message about
		// an interrupt it was never the subject of.
		const reply = await laterP;
		expect(reply.status).toBe('ok');
		expect(queue.queueStateFor(nb)).toEqual({ running: null, queue: [] });
	});

	it('a send that throws leaves no abort handle, so a later interrupt still reports idle', async () => {
		const nb = abs();
		// Warm the kernel first so the failing send is the only thing this test adds.
		await kernelmod.execute(nb, 'warm2 = 1', () => {});
		await expect(kernelmod.execute(nb, 'boom  # THROW', () => {})).rejects.toThrow(/requestExecute failed/);

		// THE REGRESSION: that run's handle stayed in `activeRuns` forever, so every
		// LATER interrupt on this kernel saw a run that can never end - reporting
		// `forced` (and force-aborting runs that were fine) with nothing running at all.
		const res = await kernelmod.interruptKernel(nb);
		expect(res.stopped).toBe('idle');

		// And the kernel is still usable: the failed send released the exec lock.
		const reply = await kernelmod.execute(nb, 'after = 1', () => {});
		expect(reply.status).toBe('ok');
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

		// Widen the window for THIS test only. The rest of the suite runs at 120ms so
		// the escalation is observable, but that is far too tight to be the yardstick
		// for "returned promptly": under the full suite's own parallelism a correct
		// poll's timers legitimately drift, and asserting against 120ms would report
		// that drift as the interrupt having waited out the window. A wide window makes
		// the assertion mean what it says - it did NOT wait for the grace - with margin
		// that only a genuine regression can cross, and it costs nothing here because
		// the graceful path returns as soon as the run ends rather than on the window.
		const wide = 3000;
		process.env.CELLAR_KERNEL_INTERRUPT_GRACE_MS = String(wide);
		let elapsed: number;
		let res: Awaited<ReturnType<typeof kernelmod.interruptKernel>>;
		try {
			const t0 = Date.now();
			res = await kernelmod.interruptKernel(nb);
			elapsed = Date.now() - t0;
		} finally {
			process.env.CELLAR_KERNEL_INTERRUPT_GRACE_MS = String(GRACE_MS);
		}
		await runP;

		expect(res.stopped).toBe('kernel');
		// The poll returns the moment the run ends, so the ordinary interrupt pays a
		// tick, not the whole window.
		expect(elapsed).toBeLessThan(wide);
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
