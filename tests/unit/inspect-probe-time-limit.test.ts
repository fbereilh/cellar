/**
 * A Cellar probe has a time limit, and a stuck one never reads as the user's cell.
 *
 * The reported failure: the kernel_state probe looped forever, the next user cell
 * parked behind it on the exec lock and read "running" with no hint that Cellar's
 * own code held the kernel, and the `kernel_state` MCP call blocked for minutes.
 * The Python-side budget (see inspect-probe-hostile.test.ts) stops almost every
 * slow value. This covers the backstop behind it, in `execute()`:
 *   - past `CELLAR_INSPECT_TIMEOUT_MS` the kernel is interrupted, and a probe that
 *     surrenders ends with a message saying Cellar interrupted it;
 *   - a probe that does not surrender stops being waited on, so the caller returns,
 *     and every user run parked behind it, or started while it lasts, is refused
 *     with a message naming Cellar's probe. Its code is never sent;
 *   - once the probe ends, the kernel runs cells again;
 *   - the time-limit interrupt lands before any parked run is sent, so it can never
 *     raise KeyboardInterrupt inside the user's cell;
 *   - a forced interrupt of a stuck probe keeps refusing runs until a restart, since
 *     the kernel may still be executing the probe.
 *
 * The REAL run queue, run.ts, kernel.ts and inspect.ts run here. Only the Jupyter
 * layer is faked, the same way kernel-interrupt-stops.test.ts fakes it.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Marks the kernel_state probe's code, which the fake kernel never answers on its own. */
const PROBE_MARK = 'def _cellar_kernel_state';

const h = vi.hoisted(() => {
	type Future = {
		onIOPub: ((msg: unknown) => void) | null;
		onReply: ((msg: unknown) => void) | null;
		onStdin: ((msg: unknown) => void) | null;
		done: Promise<{ content: { status: string; execution_count: number } }>;
		dispose: () => void;
		finish: (status?: string) => void;
		msg: { header: { msg_id: string } };
	};
	let nextMsgId = 0;
	function makeFuture(): Future {
		let resolveDone: (v: { content: { status: string; execution_count: number } }) => void = () => {};
		const f: Future = {
			onIOPub: null,
			onReply: null,
			onStdin: null,
			done: new Promise((res) => {
				resolveDone = res;
			}),
			dispose: () => {},
			finish: (status = 'ok') => resolveDone({ content: { status, execution_count: 1 } }),
			msg: { header: { msg_id: `msg-${++nextMsgId}` } }
		};
		return f;
	}
	const state = {
		sentCodes: [] as string[],
		hangingProbe: null as Future | null,
		hangingUser: null as Future | null,
		kernelObeysInterrupt: false,
		interrupts: 0,
		probeEndsDuringSignal: false,
		signalDelayMs: 0,
		events: [] as string[],
		iopubListeners: new Set<(sender: unknown, msg: unknown) => void>(),
		makeFuture
	};
	function makeFakeKernel() {
		return {
			id: 'kernel-1',
			name: 'python3',
			status: 'idle' as const,
			connectionStatus: 'connected' as string,
			commsOverSubshells: undefined as unknown,
			registerCommTarget: () => {},
			statusChanged: { connect: () => {}, disconnect: () => {} },
			iopubMessage: {
				connect: (fn: (sender: unknown, msg: unknown) => void) => void state.iopubListeners.add(fn),
				disconnect: (fn: (sender: unknown, msg: unknown) => void) => void state.iopubListeners.delete(fn)
			},
			requestExecute: (args: { code?: string }) => {
				const code = typeof args?.code === 'string' ? args.code : '';
				state.sentCodes.push(code);
				state.events.push(`sent:${code}`);
				const f = makeFuture();
				if (code.includes('def _cellar_kernel_state')) {
					state.hangingProbe = f;
					return f;
				}
				if (code.includes('# LONG')) {
					state.hangingUser = f;
					return f;
				}
				queueMicrotask(() => f.finish('ok'));
				return f;
			},
			restart: async () => {},
			shutdown: async () => {},
			reconnect: async () => {},
			dispose: () => {}
		};
	}
	/** Publish an iopub `status: idle` whose parent is the request `parentMsgId`, as ipykernel does. */
	function emitIdle(parentMsgId: string) {
		const msg = { header: { msg_type: 'status' }, parent_header: { msg_id: parentMsgId }, content: { execution_state: 'idle' } };
		for (const fn of [...state.iopubListeners]) fn(null, msg);
	}
	return {
		state,
		emitIdle,
		startNew: async () => makeFakeKernel(),
		interruptKernel: async () => {
			state.interrupts += 1;
			if (state.probeEndsDuringSignal && state.hangingProbe) {
				const ending = state.hangingProbe;
				state.hangingProbe = null;
				ending.finish('ok');
			}
			if (state.signalDelayMs > 0) await new Promise((r) => setTimeout(r, state.signalDelayMs));
			state.events.push('signal-landed');
			const f = state.hangingProbe;
			if (!state.kernelObeysInterrupt || !f) return;
			state.hangingProbe = null;
			f.onIOPub?.({
				header: { msg_type: 'error' },
				parent_header: {},
				content: { ename: 'KeyboardInterrupt', evalue: '', traceback: ['KeyboardInterrupt'] }
			});
			f.finish('error');
		}
	};
});

vi.mock('@jupyterlab/services', () => ({
	KernelManager: class {
		ready = Promise.resolve();
		startNew = h.startNew;
		runningChanged = { connect: () => {} };
		running() {
			return [][Symbol.iterator]();
		}
		dispose = () => {};
	},
	ServerConnection: { makeSettings: (o: unknown) => o },
	CommsOverSubshells: { Disabled: 'disabled' },
	KernelAPI: {
		getKernelModel: async () => ({ execution_state: 'busy' }),
		interruptKernel: h.interruptKernel
	}
}));

vi.mock('../../src/lib/server/logs', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }));

let nbmod: typeof import('../../src/lib/server/notebook');
let queue: typeof import('../../src/lib/server/run-queue');
let runmod: typeof import('../../src/lib/server/run');
let inspect: typeof import('../../src/lib/server/inspect');
let kernel: typeof import('../../src/lib/server/kernel');

const NB = 'probe-limit.ipynb';
const LIMIT_MS = 150;
const GRACE_MS = 120;
const abs = () => nbmod.resolveNotebookPath(NB);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(fn: () => boolean, what: string, budgetMs = 5000) {
	const deadline = Date.now() + budgetMs;
	while (!fn() && Date.now() < deadline) await sleep(10);
	if (!fn()) throw new Error(`timed out after ${budgetMs}ms waiting for: ${what}`);
}

/** Run one user cell through the real queue, as a real owner does. */
function runCell(source: string) {
	const nb = abs();
	const cellId = nbmod.addCell(null, 'code', nb, null, source).id;
	const ticket = queue.enqueueRun({ nb, cellId, actor: 'user', source });
	if (ticket.duplicate) throw new Error('unreachable: fresh ticket expected');
	return ticket.wait().then(() =>
		runmod.executeCellRun({ nb, cellId, actor: 'user', source: ticket.source() }).finally(() => ticket.done())
	);
}

const errorText = (outputs: unknown[]) =>
	outputs.map((o) => String((o as { evalue?: unknown }).evalue ?? '')).join('\n');

beforeAll(async () => {
	process.env.CELLAR_WORKSPACE = mkdtempSync(join(tmpdir(), 'cellar-probe-limit-'));
	process.env.CELLAR_KERNEL_IDLE_TIMEOUT_MS = '60000';
	process.env.CELLAR_KERNEL_INTERRUPT_GRACE_MS = String(GRACE_MS);
	process.env.CELLAR_INSPECT_TIMEOUT_MS = String(LIMIT_MS);
	nbmod = await import('../../src/lib/server/notebook');
	queue = await import('../../src/lib/server/run-queue');
	runmod = await import('../../src/lib/server/run');
	inspect = await import('../../src/lib/server/inspect');
	kernel = await import('../../src/lib/server/kernel');
	nbmod.createNotebook(NB, null, { focus: false });
	nbmod.setActiveNotebook(NB);
	// Start the kernel with an ordinary cell, so kernel_state has one to probe.
	expect((await runCell('x = 1')).status).toBe('ok');
});

beforeEach(() => {
	h.state.hangingProbe = null;
	h.state.hangingUser = null;
	h.state.kernelObeysInterrupt = false;
	h.state.interrupts = 0;
	h.state.probeEndsDuringSignal = false;
	h.state.signalDelayMs = 0;
	h.state.events = [];
});

describe('a probe past its time limit', () => {
	it('is interrupted, and the caller hears that Cellar interrupted it', async () => {
		h.state.kernelObeysInterrupt = true;
		const t0 = Date.now();
		await expect(inspect.kernelState(abs())).rejects.toThrow(/ran past 0\.15s, so Cellar interrupted it/);
		expect(Date.now() - t0).toBeLessThan(LIMIT_MS + GRACE_MS + 1000);
		expect(h.state.interrupts).toBe(1);
		// The kernel is free: the next cell runs normally.
		expect((await runCell('y = 2')).status).toBe('ok');
	});

	it('that does not stop is no longer waited on, and no cell reads as hanging behind it', async () => {
		const probe = inspect.kernelState(abs());
		probe.catch(() => {});
		await until(() => h.state.hangingProbe != null, 'the probe to reach the kernel');
		// A user cell parks behind the probe on the exec lock.
		const parkedCode = 'parked = 1';
		const parked = runCell(parkedCode);

		// The caller returns within the limit plus the interrupt grace, never later.
		const t0 = Date.now();
		await expect(probe).rejects.toThrow(/did not stop when interrupted.*Restart the kernel/s);
		expect(Date.now() - t0).toBeLessThan(LIMIT_MS + GRACE_MS + 1000);

		// The parked cell is refused with a message naming Cellar's probe, and its code
		// never reached the kernel.
		const parkedRun = await parked;
		expect(parkedRun.status).toBe('error');
		// Stamped as refused, like the other runs Cellar declines before sending, so
		// agents read it as a live failure and the header never says it "ran".
		expect(parkedRun.lastRun.refused).toBe(true);
		expect(errorText(parkedRun.outputs)).toMatch(/Cellar's own variable inspection is still running/);
		expect(h.state.sentCodes).not.toContain(parkedCode);

		// A cell started while the probe is still stuck is refused the same way.
		const laterCode = 'later = 1';
		const later = await runCell(laterCode);
		expect(errorText(later.outputs)).toMatch(/Cellar's own variable inspection is still running/);
		expect(h.state.sentCodes).not.toContain(laterCode);

		// Once the probe finally ends, the kernel runs cells again.
		h.state.hangingProbe!.finish('ok');
		await sleep(20);
		expect((await runCell('after = 1')).status).toBe('ok');
		expect(h.state.sentCodes.some((c) => c.includes(PROBE_MARK))).toBe(true);
	});

	it('lands its interrupt before the run parked behind it is sent', async () => {
		// The probe's reply arrives while the interrupt POST is still in flight.
		h.state.probeEndsDuringSignal = true;
		h.state.signalDelayMs = 200;
		const probe = inspect.kernelState(abs());
		probe.catch(() => {});
		await until(() => h.state.hangingProbe != null, 'the probe to reach the kernel');
		const parkedCode = 'parked_during_signal = 1';
		const parked = runCell(parkedCode);
		expect((await parked).status).toBe('ok');
		await probe.catch(() => {});
		const landed = h.state.events.indexOf('signal-landed');
		const sentParked = h.state.events.indexOf(`sent:${parkedCode}`);
		expect(landed).toBeGreaterThanOrEqual(0);
		expect(sentParked).toBeGreaterThan(landed);
	});
});

describe('a user run', () => {
	it('has no time limit: a cell running past the probe limit is never interrupted', async () => {
		const run = runCell('train()  # LONG');
		await until(() => h.state.hangingUser != null, 'the user cell to reach the kernel');
		await sleep(LIMIT_MS + GRACE_MS + 100);
		expect(h.state.interrupts).toBe(0);
		h.state.hangingUser!.finish('ok');
		expect((await run).status).toBe('ok');
	});
});

describe('a stuck probe force-settled by the user\'s interrupt', () => {
	it('keeps refusing runs, since the kernel may still be running it, until a restart', async () => {
		const probe = inspect.kernelState(abs());
		probe.catch(() => {});
		await until(() => h.state.hangingProbe != null, 'the probe to reach the kernel');
		await expect(probe).rejects.toThrow(/did not stop when interrupted/);

		// The user presses Interrupt. The kernel ignores it, so Cellar force-settles the probe.
		const res = await kernel.interruptKernel(abs());
		expect(res.stopped).toBe('forced');

		const laterCode = 'after_forced = 1';
		const later = await runCell(laterCode);
		expect(later.status).toBe('error');
		expect(errorText(later.outputs)).toMatch(/Cellar's own variable inspection is still running/);
		expect(h.state.sentCodes).not.toContain(laterCode);

		// A restart replaces the process, so the kernel runs cells again.
		await kernel.restartKernel(abs());
		expect((await runCell('after_restart = 1')).status).toBe('ok');
	});

	it('runs cells again once the kernel reports the probe itself idle, and only then', async () => {
		const probe = inspect.kernelState(abs());
		probe.catch(() => {});
		await until(() => h.state.hangingProbe != null, 'the probe to reach the kernel');
		const stuckId = h.state.hangingProbe!.msg.header.msg_id;
		await expect(probe).rejects.toThrow(/did not stop when interrupted/);
		expect((await kernel.interruptKernel(abs())).stopped).toBe('forced');

		// An idle status for some other request proves nothing about the probe.
		h.emitIdle('some-other-request');
		const early = await runCell('early = 1');
		expect(errorText(early.outputs)).toMatch(/Cellar's own variable inspection is still running/);
		expect(h.state.sentCodes).not.toContain('early = 1');

		// The kernel finishes the probe and reports idle for its own request.
		h.emitIdle(stuckId);
		expect((await runCell('after_probe_idle = 1')).status).toBe('ok');
		expect(h.state.sentCodes).toContain('after_probe_idle = 1');
	});
});
