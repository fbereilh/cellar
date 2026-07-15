/**
 * Idle watchdog on execute() + restart force-abort of the ACTIVE run.
 *
 * `await future.done` was unbounded: a stalled websocket, an undelivered
 * execute_reply, or a dropped autorestart left it pending forever, so the run's
 * queue slot never freed and the notebook could never run again. Two guards, both
 * proven here against the REAL run-queue + REAL executeCellRun (only the Jupyter
 * layer is faked, so the whole owner→execute→finally→release path runs):
 *
 *   1. an IDLE watchdog — a run whose kernel goes SILENT (no iopub, no status, no
 *      reply) for the idle window aborts, disposes its future, and (via the owner's
 *      finally) frees its slot; the next run on that notebook then proceeds;
 *   2. the LONG-CELL guarantee — a run whose kernel keeps emitting output is NEVER
 *      killed, however far past the idle window it runs (the watchdog re-arms on
 *      every message);
 *   3. restart FORCE-ABORTS the active stuck run (clearRunQueue drops only pending),
 *      so a manual restart rescues a wedged run;
 *   4. exactly-one release — execute() never releases the slot itself; only the
 *      owner's finally does (proven by the queue staying held until ticket.done()).
 *
 * The idle window is driven to 40ms via CELLAR_KERNEL_IDLE_TIMEOUT_MS so the trip
 * is observable in-test; production defaults to a generous 15 minutes.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
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
		return {
			id: `kernel-${seq}`,
			name: 'python3',
			status: 'idle' as const,
			commsOverSubshells: undefined as unknown,
			registerCommTarget: vi.fn(),
			statusChanged: { connect: vi.fn(), disconnect: vi.fn() },
			iopubMessage: { connect: vi.fn() },
			requestExecute: (args: { code?: string }) => {
				const code = typeof args?.code === 'string' ? args.code : '';
				// A run that never emits and never replies — a truly silent stall.
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
	}

	return {
		makeFakeKernel,
		startNew: vi.fn(async () => makeFakeKernel()),
		lastHanging: null as ReturnType<typeof makeFuture> | null,
		lastSteady: null as ReturnType<typeof makeFuture> | null
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
	CommsOverSubshells: { Disabled: 'disabled' }
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

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-watchdog-'));
	process.env.CELLAR_WORKSPACE = WS;
	process.env.CELLAR_KERNEL_IDLE_TIMEOUT_MS = '40'; // tiny window so the trip is observable
	nbmod = await import('../../src/lib/server/notebook');
	queue = await import('../../src/lib/server/run-queue');
	runmod = await import('../../src/lib/server/run');
	kernelmod = await import('../../src/lib/server/kernel');
	nbmod.createNotebook(NB, null, { focus: false });
	nbmod.setActiveNotebook(NB);
});

describe('idle watchdog trips a silent stall', () => {
	it('aborts the run, disposes the future, releases the slot exactly once, and unwedges the notebook', async () => {
		const nb = abs();
		const c = newCell('stuck  # HANG');

		// Kick off the stuck run WITHOUT awaiting; hold its ticket so we can prove the
		// slot is not released by execute() itself.
		const ticket = queue.enqueueRun({ nb, cellId: c, actor: 'user', source: 'stuck  # HANG' });
		if (ticket.duplicate) throw new Error('unreachable');
		await ticket.wait();
		const runP = runmod
			.executeCellRun({ nb, cellId: c, actor: 'user', source: ticket.source() })
			.finally(() => ticket.done());

		// While the run is stuck (pre-trip, pre-release) the slot is HELD: a second cell
		// queues behind it → execute() has not touched the queue.
		const c2 = newCell('y = 2');
		const probe = queue.enqueueRun({ nb, cellId: c2, actor: 'user', source: 'y = 2' });
		if (probe.duplicate) throw new Error('unreachable');
		expect(probe.queued).toBe(true);
		probe.cancel();

		// Let the 40ms idle watchdog trip.
		const res = await runP;
		expect(res.status).toBe('error');
		const out = res.outputs[0] as unknown as Record<string, unknown>;
		expect(out.output_type).toBe('error');
		expect(out.ename).toBe('CellarError');
		expect(String(out.evalue)).toMatch(/unresponsive/i);
		// The stuck future was disposed exactly once on the trip.
		expect(h.lastHanging!.dispose).toHaveBeenCalledTimes(1);

		// One release — by the owner's finally, not execute(): the queue is now idle.
		expect(queue.queueStateFor(nb)).toEqual({ running: null, queue: [] });
		// A redundant release is a harmless no-op (no double-release corruption).
		ticket.done();
		expect(queue.queueStateFor(nb)).toEqual({ running: null, queue: [] });

		// Unwedged: the next run on the same notebook proceeds immediately.
		const r2 = await runViaOwner(c2, 'y = 2');
		expect(r2.status).toBe('ok');
		expect(queue.queueStateFor(nb)).toEqual({ running: null, queue: [] });
	});
});

describe('long-cell safety guarantee', () => {
	it('a busy cell with steady output is NEVER killed, well past the idle window', async () => {
		const nb = abs();
		const c = newCell('train  # STEADY');
		// 12 iopub ticks at 10ms each (~120ms) >> the 40ms idle window, yet it finishes ok.
		const res = await runViaOwner(c, 'train  # STEADY');
		expect(res.status).toBe('ok');
		expect(res.outputs.length).toBeGreaterThan(0); // its streamed output survived
		// It completed normally — never force-disposed.
		expect(h.lastSteady!.dispose).not.toHaveBeenCalled();
		expect(queue.queueStateFor(nb)).toEqual({ running: null, queue: [] });
	});
});

describe('restart force-aborts the active run', () => {
	it('a manual restart rescues a wedged run and frees its slot', async () => {
		const nb = abs();
		const c = newCell('stuck  # HANG');

		const ticket = queue.enqueueRun({ nb, cellId: c, actor: 'user', source: 'stuck  # HANG' });
		if (ticket.duplicate) throw new Error('unreachable');
		await ticket.wait();
		const runP = runmod
			.executeCellRun({ nb, cellId: c, actor: 'user', source: ticket.source() })
			.finally(() => ticket.done());

		// The run would hang forever; a restart must force-abort the ACTIVE future.
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
