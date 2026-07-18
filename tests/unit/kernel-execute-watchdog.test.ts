/**
 * Probe-backed idle watchdog on execute() + restart force-abort of the ACTIVE run.
 *
 * `await future.done` is unbounded: a stalled websocket, an undelivered
 * execute_reply, or a dropped autorestart would leave it pending forever, so the
 * run's queue slot never frees and the notebook can never run again. The watchdog is
 * the backstop - but SILENCE IS NOT DEATH, so the idle window may not decide alone:
 * a Spark query (`spark.sql(...).toPandas()`) is one blocking call that emits NOTHING
 * until it returns, and aborting it on silence killed the user's real work. The window
 * therefore only schedules an out-of-band liveness PROBE; only its verdict aborts.
 *
 * Proven here against the REAL run-queue + REAL executeCellRun (only the Jupyter layer
 * is faked, so the whole owner→execute→finally→release path runs):
 *
 *   1. THE REGRESSION - a silent blocking cell whose kernel probes BUSY re-arms across
 *      many idle windows and returns its result. This is the captain's Spark bug;
 *      it fails against the abort-on-silence watchdog;
 *   2. proven DEATH (kernel gone from the server) still aborts - same 'idle_watchdog'
 *      reason - disposes its future and frees its slot; the notebook unwedges;
 *   3. SUSPECT (kernel reachable but not running our cell) aborts only after
 *      SUSPECT_STRIKES consecutive readings, never on one;
 *   4. INCONCLUSIVE (the probe itself fails, or never answers at all) NEVER aborts -
 *      killing requires a positive match, the instance reaper's stance - and a probe
 *      that never answers must still leave the watchdog armed to convict later;
 *   5. the LONG-CELL guarantee - a cell emitting steady output is never even probed;
 *   6. restart FORCE-ABORTS the active stuck run (clearRunQueue drops only pending);
 *   7. exactly-one release - execute() never releases the slot itself.
 *
 * The idle window is driven to 40ms via CELLAR_KERNEL_IDLE_TIMEOUT_MS so trips are
 * observable in-test; production defaults to a 30s probe interval.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const h = vi.hoisted(() => {
	let seq = 0;
	// A controllable fake shell future: `done` resolves only when the test (or the
	// fake's own driver) calls `_resolve`, and it records dispose calls.
	function makeFuture() {
		let resolveDone: (v: { content: { status: string; execution_count: number } }) => void = () => {};
		const f: {
			onIOPub: ((msg: unknown) => void) | null;
			onReply: ((msg: unknown) => void) | null;
			onStdin: ((msg: unknown) => void) | null;
			done: Promise<{ content: { status: string; execution_count: number } }>;
			dispose: ReturnType<typeof vi.fn>;
			_resolve: (status?: string) => void;
		} = {
			onIOPub: null,
			onReply: null,
			onStdin: null,
			done: undefined as unknown as Promise<{ content: { status: string; execution_count: number } }>,
			dispose: vi.fn(),
			_resolve: (status = 'ok') => resolveDone({ content: { status, execution_count: 1 } })
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
			// The websocket is healthy unless a test says otherwise.
			connectionStatus: 'connected' as string,
			commsOverSubshells: undefined as unknown,
			registerCommTarget: vi.fn(),
			statusChanged: { connect: vi.fn(), disconnect: vi.fn() },
			iopubMessage: { connect: vi.fn() },
			requestExecute: (args: { code?: string }) => {
				const code = typeof args?.code === 'string' ? args.code : '';
				// A silent, blocking cell - the shape of a Spark query / a big pandas op:
				// no output at all until it returns. It emits nothing and never replies on
				// its own; a test resolves it via h.lastHanging.
				if (code.includes('# HANG')) {
					const f = makeFuture();
					h.lastHanging = f;
					return f;
				}
				// A long, busy run: steady iopub for ~120ms (>> the 40ms idle window), then
				// completes ok. Proves the watchdog re-arms on activity and never kills it.
				if (code.includes('# STEADY')) {
					const f = makeFuture();
					h.lastSteady = f;
					let n = 0;
					const iv = setInterval(() => {
						n += 1;
						f.onIOPub?.({ header: { msg_type: 'stream' }, parent_header: {}, content: { name: 'stdout', text: `${n}\n` } });
						if (n >= 12) {
							clearInterval(iv);
							f._resolve('ok');
						}
					}, 10);
					return f;
				}
				// Everything else (kernel-init silent injections, warm-up, plain cells)
				// completes immediately.
				const f = makeFuture();
				queueMicrotask(() => f._resolve('ok'));
				return f;
			},
			restart: vi.fn(async () => {}),
			interrupt: vi.fn(async () => {}),
			shutdown: vi.fn(async () => {}),
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
		lastSteady: null as ReturnType<typeof makeFuture> | null,
		/**
		 * The out-of-band liveness probe - the Jupyter server's REST view of the kernel
		 * (`GET /api/kernels/<id>`). Each test sets `probe` to the reading it wants;
		 * `probeCalls` counts them, which is how a re-arm is observed.
		 */
		probeCalls: 0,
		probe: (() => ({ execution_state: 'busy' })) as () =>
			| { execution_state: string }
			| undefined
			| Promise<{ execution_state: string } | undefined>,
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

const NB = 'watchdog.ipynb';
const abs = () => nbmod.resolveNotebookPath(NB);

/** Mirrors `kernel.ts`'s SUSPECT_STRIKES: consecutive suspect readings needed to convict. */
const SUSPECT_STRIKES = 3;

function newCell(source: string): string {
	return nbmod.addCell(null, 'code', abs(), null, source).id;
}

/** The documented owner pattern: take the slot, run, release in finally. */
async function runViaOwner(cellId: string, source: string) {
	const nb = abs();
	const ticket = queue.enqueueRun({ nb, cellId, actor: 'user', source });
	if (ticket.duplicate) throw new Error('unreachable: fresh ticket expected');
	await ticket.wait();
	try {
		return await runmod.executeCellRun({ nb, cellId, actor: 'user', source: ticket.source() });
	} finally {
		ticket.done();
	}
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Wait until at least `n` liveness probes have run (i.e. `n` idle windows elapsed). */
async function waitForProbes(n: number) {
	const deadline = Date.now() + 4000;
	while (h.probeCalls < n && Date.now() < deadline) await sleep(10);
	if (h.probeCalls < n) throw new Error(`only ${h.probeCalls} probes after 4s, wanted ${n}`);
}

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-watchdog-'));
	process.env.CELLAR_WORKSPACE = WS;
	process.env.CELLAR_KERNEL_IDLE_TIMEOUT_MS = '40'; // tiny window so trips are observable
	process.env.CELLAR_KERNEL_PROBE_TIMEOUT_MS = '60'; // ditto for a probe that never answers
	nbmod = await import('../../src/lib/server/notebook');
	queue = await import('../../src/lib/server/run-queue');
	runmod = await import('../../src/lib/server/run');
	kernelmod = await import('../../src/lib/server/kernel');
	nbmod.createNotebook(NB, null, { focus: false });
	nbmod.setActiveNotebook(NB);
});

beforeEach(() => {
	h.probeCalls = 0;
	h.probe = () => ({ execution_state: 'busy' });
	if (h.lastKernel) h.lastKernel.connectionStatus = 'connected';
});

describe('a silent long-running cell whose kernel is alive (the Spark regression)', () => {
	it('re-arms across many idle windows and returns its result instead of aborting', async () => {
		const nb = abs();
		const c = newCell('spark.sql(q).toPandas()  # HANG');
		const runP = startRun(c, 'spark.sql(q).toPandas()  # HANG');

		// Silent for FIVE idle windows - the old watchdog aborted after one. The kernel
		// probes busy every time, so the run is re-armed and still going.
		await waitForProbes(5);
		expect(h.lastHanging!.dispose).not.toHaveBeenCalled();

		// The query finally returns: the run completes normally, with its result.
		h.lastHanging!.onIOPub?.({
			header: { msg_type: 'execute_result' },
			parent_header: {},
			content: { data: { 'text/plain': 'rows' }, metadata: {}, execution_count: 1 }
		});
		h.lastHanging!._resolve('ok');

		const res = await runP;
		expect(res.status).toBe('ok');
		expect(res.outputs.length).toBeGreaterThan(0);
		// Never force-disposed: it completed on its own.
		expect(h.lastHanging!.dispose).not.toHaveBeenCalled();
		// The slot was released exactly once, by the owner's finally.
		expect(queue.queueStateFor(nb)).toEqual({ running: null, queue: [] });
	});

	it('survives many more idle windows than any single one (no cumulative deadline)', async () => {
		const c = newCell('long  # HANG');
		const runP = startRun(c, 'long  # HANG');
		await waitForProbes(20); // 20 windows, all re-armed
		expect(h.lastHanging!.dispose).not.toHaveBeenCalled();
		h.lastHanging!._resolve('ok');
		expect((await runP).status).toBe('ok');
	});
});

describe('a provably dead kernel still aborts', () => {
	it('aborts with idle_watchdog, disposes the future, and frees the slot exactly once', async () => {
		const nb = abs();
		// The Jupyter server no longer has this kernel: shut down or culled. `undefined`
		// is how getKernelModel reports a 404 - proven death, no strikes needed.
		h.probe = () => undefined;
		const c = newCell('stuck  # HANG');
		const runP = startRun(c, 'stuck  # HANG');

		// While the run is stuck (pre-trip, pre-release) the slot is HELD: a second cell
		// queues behind it → execute() has not touched the queue.
		const c2 = newCell('y = 2');
		const probe = queue.enqueueRun({ nb, cellId: c2, actor: 'user', source: 'y = 2' });
		if (probe.duplicate) throw new Error('unreachable');
		expect(probe.queued).toBe(true);
		probe.cancel();

		const res = await runP;
		expect(res.status).toBe('error');
		const out = res.outputs[0] as unknown as Record<string, unknown>;
		expect(out.output_type).toBe('error');
		expect(out.ename).toBe('CellarError');
		// The message now names the real reason - not "no activity for Ns", which was
		// never why it fired and is exactly what misled the captain.
		expect(String(out.evalue)).toMatch(/gone from the Jupyter server/i);
		expect(String(out.evalue)).not.toMatch(/no activity for/i);
		expect(h.lastHanging!.dispose).toHaveBeenCalledTimes(1);

		// One release — by the owner's finally, not execute(): the queue is now idle.
		expect(queue.queueStateFor(nb)).toEqual({ running: null, queue: [] });

		// Unwedged: the next run on the same notebook proceeds immediately.
		const r2 = await runViaOwner(c2, 'y = 2');
		expect(r2.status).toBe('ok');
		expect(queue.queueStateFor(nb)).toEqual({ running: null, queue: [] });
	});

	it('aborts when the server reports the kernel process dead', async () => {
		h.probe = () => ({ execution_state: 'dead' });
		const c = newCell('stuck  # HANG');
		const res = await startRun(c, 'stuck  # HANG');
		expect(res.status).toBe('error');
		expect(String((res.outputs[0] as unknown as Record<string, unknown>).evalue)).toMatch(/dead/i);
		expect(queue.queueStateFor(abs())).toEqual({ running: null, queue: [] });
	});
});

describe('a suspect reading needs consecutive confirmation', () => {
	it('an undelivered reply (kernel alive but idle) aborts only after repeated readings', async () => {
		// The kernel is reachable and NOT running our cell: its reply was lost. That is
		// the transport failure the watchdog exists for - but one reading is not proof.
		h.probe = () => ({ execution_state: 'idle' });
		const c = newCell('lost-reply  # HANG');
		const runP = startRun(c, 'lost-reply  # HANG');

		// After a single suspect probe the run is still alive: no abort on one strike.
		await waitForProbes(1);
		expect(h.lastHanging!.dispose).not.toHaveBeenCalled();

		const res = await runP;
		expect(res.status).toBe('error');
		// We are connected, so we WOULD have heard the reply: the message may say so.
		expect(String((res.outputs[0] as unknown as Record<string, unknown>).evalue)).toMatch(
			/no longer running this cell - its reply was lost/i
		);
		// It took the full strike count to convict.
		expect(h.probeCalls).toBeGreaterThanOrEqual(3);
		expect(queue.queueStateFor(abs())).toEqual({ running: null, queue: [] });
	});

	it('a single suspect reading followed by a healthy one never aborts (strikes must be consecutive)', async () => {
		let n = 0;
		// Flap: every other probe is suspect, so the strikes never reach the threshold.
		h.probe = () => ({ execution_state: ++n % 2 === 0 ? 'busy' : 'idle' });
		const c = newCell('flaky  # HANG');
		const runP = startRun(c, 'flaky  # HANG');
		await waitForProbes(10);
		expect(h.lastHanging!.dispose).not.toHaveBeenCalled();
		h.lastHanging!._resolve('ok');
		expect((await runP).status).toBe('ok');
	});
});

describe('the websocket state alone never convicts a busy kernel', () => {
	it('a busy kernel whose socket is mid-reconnect re-arms and completes', async () => {
		// @jupyterlab retries 7x with backoff (~120s) before giving up, and jupyter_server's
		// buffer_offline_messages replays the buffered iopub/shell on reconnect - so a run
		// that rides the blip out really does complete. REST says busy, which is proof the
		// kernel is working, so a reconnecting socket must not kill it: that would abort
		// exactly the silent multi-hour Spark job this watchdog exists to protect.
		const c = newCell('spark-through-a-blip  # HANG');
		const runP = startRun(c, 'spark-through-a-blip  # HANG');
		await waitForProbes(1);
		h.lastKernel!.connectionStatus = 'connecting';

		// Many windows of a reconnecting socket: every one re-arms, none accrues a strike.
		await waitForProbes(10);
		expect(h.lastHanging!.dispose).not.toHaveBeenCalled();

		// The socket comes back and the query returns.
		h.lastKernel!.connectionStatus = 'connected';
		h.lastHanging!._resolve('ok');
		expect((await runP).status).toBe('ok');
		expect(queue.queueStateFor(abs())).toEqual({ running: null, queue: [] });
	});

	it('a kernel that went IDLE mid-reconnect re-arms and completes (its reply is buffered)', async () => {
		// The blip's other shape, and the nastier one: the socket drops WHILE the cell is
		// running and the cell then FINISHES during the blip. The server marks the kernel
		// idle and BUFFERS the execute_reply/iopub for replay (buffer_offline_messages),
		// so 'idle' here does NOT mean the reply was lost - it means it is already computed
		// and about to arrive. Convicting would destroy work the kernel has already done.
		h.probe = () => ({ execution_state: 'idle' });
		const c = newCell('finished-during-a-blip  # HANG');
		const runP = startRun(c, 'finished-during-a-blip  # HANG');
		await waitForProbes(1);
		h.lastKernel!.connectionStatus = 'connecting';

		// Far more windows than SUSPECT_STRIKES: a reconnecting socket never strikes, so
		// the run survives the whole ~120s @jupyterlab reconnect loop.
		await waitForProbes(10);
		expect(h.lastHanging!.dispose).not.toHaveBeenCalled();

		// The socket reconnects and the buffered reply is replayed.
		h.lastKernel!.connectionStatus = 'connected';
		h.lastHanging!._resolve('ok');
		expect((await runP).status).toBe('ok');
		expect(queue.queueStateFor(abs())).toEqual({ running: null, queue: [] });
	});

	it('a socket that gives up (disconnected) still convicts after the strike count', async () => {
		// Retries exhausted: the reply can never reach us however healthy the kernel is.
		// One of the only two readings that may accrue a strike (the other being a
		// CONNECTED socket whose kernel is not busy - covered above).
		const c = newCell('unhearable  # HANG');
		const runP = startRun(c, 'unhearable  # HANG');
		await waitForProbes(1);
		h.lastKernel!.connectionStatus = 'disconnected';

		const res = await runP;
		expect(res.status).toBe('error');
		const evalue = String((res.outputs[0] as unknown as Record<string, unknown>).evalue);
		expect(evalue).toMatch(/lost the connection to the kernel .*disconnected/i);
		// Without the socket we cannot see whether the cell is still running - and on a
		// healthy kernel it very likely is. The message must claim only what we know.
		expect(evalue).not.toMatch(/no longer running this cell|reply was lost/i);
		expect(evalue).toMatch(/restart the kernel to recover/i);
		expect(h.lastHanging!.dispose).toHaveBeenCalledTimes(1);
		expect(queue.queueStateFor(abs())).toEqual({ running: null, queue: [] });
	});

	it('a kernel gone from the server aborts on the first reading whatever the socket says', async () => {
		// The REST verdict outranks any socket state: a kernel the server no longer has is
		// proven dead even while the socket is happily reconnecting.
		h.probe = () => undefined;
		const c = newCell('gone-while-reconnecting  # HANG');
		const runP = startRun(c, 'gone-while-reconnecting  # HANG');
		await sleep(10);
		h.lastKernel!.connectionStatus = 'connecting';

		const res = await runP;
		expect(res.status).toBe('error');
		expect(String((res.outputs[0] as unknown as Record<string, unknown>).evalue)).toMatch(/gone from the Jupyter server/i);
		expect(h.probeCalls).toBe(1); // proven death needs no strikes
		expect(queue.queueStateFor(abs())).toEqual({ running: null, queue: [] });
	});
});

describe('an inconclusive probe never aborts', () => {
	it('a probe that throws leaves the run alone - killing requires a positive match', async () => {
		// The sidecar is briefly unreachable: this proves NOTHING about the kernel. A
		// false abort would destroy an hour-old cluster job; a false re-arm only delays
		// recovery of a notebook the user can restart by hand at any time.
		h.probe = () => {
			throw new Error('fetch failed');
		};
		const c = newCell('unknowable  # HANG');
		const runP = startRun(c, 'unknowable  # HANG');
		await waitForProbes(6);
		expect(h.lastHanging!.dispose).not.toHaveBeenCalled();
		h.lastHanging!._resolve('ok');
		expect((await runP).status).toBe('ok');
		expect(queue.queueStateFor(abs())).toEqual({ running: null, queue: [] });
	});

	it('a probe that NEVER answers times out as inconclusive and keeps the watchdog cycling', async () => {
		// A black-holed socket / a wedged jupyter-server accepts the connection and then
		// says nothing. `fetch` has no default timeout, so without one of our own this
		// probe would stay pending forever - and because armWatchdog() only runs once a
		// probe settles, the watchdog would be DISARMED for the rest of the run, wedging
		// the very queue slot it exists to free.
		h.probe = () => new Promise(() => {});
		const c = newCell('blackholed  # HANG');
		const runP = startRun(c, 'blackholed  # HANG');

		// It keeps cycling: probe → timeout → unknown → re-arm → probe → …
		await waitForProbes(3);
		// A hung sidecar proves nothing about the kernel, so it never aborts the run.
		expect(h.lastHanging!.dispose).not.toHaveBeenCalled();

		h.lastHanging!._resolve('ok');
		expect((await runP).status).toBe('ok');
		expect(queue.queueStateFor(abs())).toEqual({ running: null, queue: [] });
	});

	it('a failing probe NEVER convicts while the socket is still connected (the Spark guarantee)', async () => {
		// The non-negotiable case: a silent Spark query on a healthy kernel whose sidecar is
		// flaking on HTTP. We still HAVE a route to the kernel, so a failing probe is mere
		// absence of evidence - it must re-arm indefinitely, never accruing a strike.
		h.probe = () => {
			throw new Error('fetch failed');
		};
		const c = newCell('spark-with-flaky-probes  # HANG');
		const runP = startRun(c, 'spark-with-flaky-probes  # HANG');

		// Far more windows than SUSPECT_STRIKES: strikes must never accumulate here.
		await waitForProbes(SUSPECT_STRIKES * 4);
		expect(h.lastHanging!.dispose).not.toHaveBeenCalled();

		h.lastHanging!._resolve('ok');
		expect((await runP).status).toBe('ok');
		expect(queue.queueStateFor(abs())).toEqual({ running: null, queue: [] });
	});

	it('a failing probe on a DISCONNECTED socket convicts: both routes to the kernel are gone', async () => {
		// The hole this closes: a persistently wedged sidecar fails every probe, so an
		// unconditional `unknown` reset the strikes forever and the queue slot wedged
		// permanently. The websocket rides the SAME sidecar, so a failed probe AND an
		// exhausted-retries socket are two corroborating signals that we cannot hear this
		// kernel by ANY route - a positive match, which is what killing requires.
		h.probe = () => {
			throw new Error('fetch failed');
		};
		const c = newCell('wedged-sidecar  # HANG');
		const runP = startRun(c, 'wedged-sidecar  # HANG');
		await waitForProbes(1);
		h.lastKernel!.connectionStatus = 'disconnected';

		const res = await runP;
		expect(res.status).toBe('error');
		const out = res.outputs[0] as unknown as Record<string, unknown>;
		expect(out.ename).toBe('CellarError');
		const evalue = String(out.evalue);
		expect(evalue).toMatch(/cannot reach the kernel by any route/i);
		expect(evalue).toMatch(/disconnected/i);
		// Having lost BOTH routes we know LESS about the cell than ever - on a healthy
		// kernel it is very likely still executing - so this may not claim it stopped.
		expect(evalue).not.toMatch(/no longer running this cell|reply was lost/i);
		expect(evalue).toMatch(/restart the kernel to recover/i);
		expect(h.lastHanging!.dispose).toHaveBeenCalledTimes(1);
		// It convicts through the normal strike path, never on a single reading.
		expect(h.probeCalls).toBeGreaterThanOrEqual(SUSPECT_STRIKES);
		expect(queue.queueStateFor(abs())).toEqual({ running: null, queue: [] });
	});

	it('a probe that times out on a DISCONNECTED socket convicts on the same corroborated ground', async () => {
		// A black-holed sidecar (accepts the connection, then says nothing) is the same
		// unreachable-by-any-route reading as an outright failure once the socket gives up.
		h.probe = () => new Promise(() => {});
		const c = newCell('blackholed-and-disconnected  # HANG');
		const runP = startRun(c, 'blackholed-and-disconnected  # HANG');
		await waitForProbes(1);
		h.lastKernel!.connectionStatus = 'disconnected';

		const res = await runP;
		expect(res.status).toBe('error');
		const evalue = String((res.outputs[0] as unknown as Record<string, unknown>).evalue);
		expect(evalue).toMatch(/cannot reach the kernel by any route/i);
		expect(evalue).toMatch(/timed out/i);
		expect(h.lastHanging!.dispose).toHaveBeenCalledTimes(1);
		expect(queue.queueStateFor(abs())).toEqual({ running: null, queue: [] });
	});

	it('a watchdog that survived hung probes still convicts once the kernel is provably gone', async () => {
		// The regression proper: after hung probes the watchdog must still be ARMED, so a
		// later dead reading aborts exactly as it always did and frees the slot.
		const nb = abs();
		h.probe = () => new Promise(() => {});
		const c = newCell('blackholed-then-dead  # HANG');
		const runP = startRun(c, 'blackholed-then-dead  # HANG');
		await waitForProbes(3);
		expect(h.lastHanging!.dispose).not.toHaveBeenCalled();

		// The sidecar comes back and reports the kernel gone: proven death, no strikes.
		h.probe = () => undefined;

		const res = await runP;
		expect(res.status).toBe('error');
		const out = res.outputs[0] as unknown as Record<string, unknown>;
		expect(out.ename).toBe('CellarError');
		expect(String(out.evalue)).toMatch(/gone from the Jupyter server/i);
		expect(h.lastHanging!.dispose).toHaveBeenCalledTimes(1);
		expect(queue.queueStateFor(nb)).toEqual({ running: null, queue: [] });

		// Unwedged: the notebook runs again.
		const c2 = newCell('after = 1');
		expect((await runViaOwner(c2, 'after = 1')).status).toBe('ok');
	});
});

describe('long-cell safety guarantee', () => {
	it('a busy cell with steady output is NEVER killed, and is never even probed', async () => {
		const nb = abs();
		const c = newCell('train  # STEADY');
		// 12 iopub ticks at 10ms each (~120ms) >> the 40ms idle window, yet it finishes ok.
		const res = await runViaOwner(c, 'train  # STEADY');
		expect(res.status).toBe('ok');
		expect(res.outputs.length).toBeGreaterThan(0); // its streamed output survived
		// It completed normally — never force-disposed.
		expect(h.lastSteady!.dispose).not.toHaveBeenCalled();
		// Its traffic re-armed the window every time, so no probe was ever needed: the
		// probe must not fire for a cell that is visibly alive.
		expect(h.probeCalls).toBe(0);
		expect(queue.queueStateFor(nb)).toEqual({ running: null, queue: [] });
	});
});

describe('CELLAR_KERNEL_IDLE_TIMEOUT_MS=0 disables the per-run watchdog', () => {
	// The explicit escape hatch: `0` disables the per-run liveness watchdog entirely
	// (matching CELLAR_KERNEL_IDLE_TIMEOUT=0 for the culler). A silent run is then never
	// probed and never aborted - the pre-watchdog world - yet the force-abort path
	// (restart/teardown) still settles it and the slot still releases exactly once.
	it('never probes and never aborts a silent run, yet a restart still frees the slot', async () => {
		const nb = abs();
		const prev = process.env.CELLAR_KERNEL_IDLE_TIMEOUT_MS;
		process.env.CELLAR_KERNEL_IDLE_TIMEOUT_MS = '0';
		try {
			// Even proven death would abort a normal run on the first probe; with the watchdog
			// disabled, no probe ever fires, so this reading is never even taken.
			h.probe = () => undefined;
			const c = newCell('silent-forever  # HANG');
			const runP = startRun(c, 'silent-forever  # HANG');

			// Many idle windows' worth of wall-clock: no probe is ever scheduled.
			await sleep(300);
			expect(h.probeCalls).toBe(0);
			expect(h.lastHanging!.dispose).not.toHaveBeenCalled();

			// The force-abort path is untouched: a restart still settles the wedged run.
			await kernelmod.restartKernel(nb);
			const res = await runP;
			expect(res.status).toBe('error');
			expect(String((res.outputs[0] as unknown as Record<string, unknown>).evalue)).toMatch(/restart/i);
			expect(h.lastHanging!.dispose).toHaveBeenCalledTimes(1);
			// Still exactly one release, by the owner's finally.
			expect(queue.queueStateFor(nb)).toEqual({ running: null, queue: [] });
		} finally {
			process.env.CELLAR_KERNEL_IDLE_TIMEOUT_MS = prev;
		}
	});
});

describe('restart force-aborts the active run', () => {
	it('a manual restart rescues a wedged run and frees its slot', async () => {
		const nb = abs();
		const c = newCell('stuck  # HANG');
		const runP = startRun(c, 'stuck  # HANG');
		// Let the run get going, then restart: the ACTIVE future must be force-aborted
		// (this path is independent of the probe - it must keep working exactly as-is).
		await sleep(10);
		await kernelmod.restartKernel(nb);

		const res = await runP;
		expect(res.status).toBe('error');
		const out = res.outputs[0] as unknown as Record<string, unknown>;
		expect(String(out.evalue)).toMatch(/restart/i);
		expect(h.lastHanging!.dispose).toHaveBeenCalledTimes(1);
		expect(queue.queueStateFor(nb)).toEqual({ running: null, queue: [] });

		// Unwedged after the restart: the notebook runs again.
		const c2 = newCell('ok = 1');
		const r2 = await runViaOwner(c2, 'ok = 1');
		expect(r2.status).toBe('ok');
		expect(queue.queueStateFor(nb)).toEqual({ running: null, queue: [] });
	});
});
