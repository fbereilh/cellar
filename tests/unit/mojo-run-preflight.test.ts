/**
 * The Mojo run PRE-FLIGHT, driven through the REAL run queue + REAL `executeCellRun`
 * with only the Jupyter layer faked - the level at which "does this run ever free its
 * queue slot" is a real question.
 *
 * A mojo cell compiles to a `%%mojo` cell magic that only exists after
 * `import mojo.notebook` has run in the session, so `executeCellRun` runs a
 * once-per-session setup BEFORE it dispatches. That setup goes through `runCapture`,
 * which awaits `future.done` with NO watchdog of its own - so an unbounded await
 * there would hang the run BEFORE `execute()`, i.e. before the idle watchdog that
 * exists to free exactly that slot, and before the run registers its `ActiveRun`, so
 * no abort path could see it either. That is the wedge class this repo's kernel
 * doctrine is written against, and it is what the bound below exists to prevent.
 *
 * Three properties, and the middle one is the subtle one:
 *   1. a READY setup dispatches the compiled `%%mojo` source to the kernel;
 *   2. a setup that CANNOT ANSWER - it never settles, it never gets its turn on the
 *      per-kernel exec lock, or it throws - yields NO VERDICT and the run FALLS
 *      THROUGH to `execute()`; it must never be reported as a missing toolchain,
 *      because that would name a cause nothing observed and send the user after a
 *      534 MB install they may already have;
 *   3. a NOT-READY setup reports the install instruction and never touches the
 *      kernel with an unregistered magic.
 *
 * Plus: the verdict is memoized per SESSION, so a notebook of Mojo cells pays one
 * probe, and a restart re-probes.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MOJO_MAGIC_HEADER, MOJO_SETUP_MARKER } from '../../src/lib/server/mojo';

const h = vi.hoisted(() => {
	let seq = 0;
	/** Code the fake kernel accepts and NEVER answers, so its caller keeps the exec lock. */
	const HOLD_CODE = '__cellar_test_hold_exec_lock__';
	function makeFuture() {
		let resolveDone: (v: { content: { status: string; execution_count: number } }) => void = () => {};
		const f = {
			onIOPub: null as ((msg: unknown) => void) | null,
			onReply: null as ((msg: unknown) => void) | null,
			onStdin: null as ((msg: unknown) => void) | null,
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
			connectionStatus: 'connected' as string,
			commsOverSubshells: undefined as unknown,
			registerCommTarget: vi.fn(),
			statusChanged: { connect: vi.fn(), disconnect: vi.fn() },
			iopubMessage: { connect: vi.fn() },
			requestExecute: (args: { code?: string }) => {
				const code = typeof args?.code === 'string' ? args.code : '';
				// The Mojo setup probe, recognised by the marker it prints. `h.setupMode`
				// decides what this kernel does with it.
				if (code.includes(MOJO_SETUP_MARKER)) {
					h.setupRuns += 1;
					if (h.setupMode === 'throw') throw new Error('kernel connection is dead');
					const f = makeFuture();
					if (h.setupMode === 'hang') {
						h.hangingSetup = f; // never resolves until a test says so
						return f;
					}
					const payload =
						h.setupMode === 'ready'
							? `${MOJO_SETUP_MARKER} {"ready": true, "version": "26.5.0"}`
							: `${MOJO_SETUP_MARKER} {"ready": false, "detail": "ModuleNotFoundError: No module named 'mojo'"}`;
					queueMicrotask(() => {
						f.onIOPub?.({ header: { msg_type: 'stream' }, parent_header: {}, content: { name: 'stdout', text: payload + '\n' } });
						f._resolve('ok');
					});
					return f;
				}
				h.executed.push(code);
				const f = makeFuture();
				// A predecessor that takes the per-kernel exec lock and never lets go -
				// the shape a Databricks CONNECT_CODE has on a cold cluster.
				if (code === h.HOLD_CODE) return f;
				queueMicrotask(() => f._resolve('ok'));
				return f;
			},
			restart: vi.fn(async () => {}),
			interrupt: vi.fn(async () => {}),
			shutdown: vi.fn(async () => {}),
			reconnect: vi.fn(async () => {}),
			dispose: vi.fn()
		};
		h.lastKernel = k;
		return k;
	}

	return {
		makeFakeKernel,
		HOLD_CODE,
		startNew: vi.fn(async () => makeFakeKernel()),
		lastKernel: null as ReturnType<typeof makeFakeKernel> | null,
		hangingSetup: null as ReturnType<typeof makeFuture> | null,
		setupMode: 'ready' as 'ready' | 'missing' | 'hang' | 'throw',
		setupRuns: 0,
		/** Every non-setup code string the kernel was asked to execute. */
		executed: [] as string[]
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
	KernelAPI: {
		getKernelModel: vi.fn(async () => ({ execution_state: 'busy' })),
		interruptKernel: vi.fn(async () => {})
	}
}));

vi.mock('../../src/lib/server/logs', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }));

let WS: string;
let nbmod: typeof import('../../src/lib/server/notebook');
let queue: typeof import('../../src/lib/server/run-queue');
let runmod: typeof import('../../src/lib/server/run');
let kernelmod: typeof import('../../src/lib/server/kernel');

const NB = 'mojo-preflight.ipynb';
const abs = () => nbmod.resolveNotebookPath(NB);
const MOJO_SOURCE = 'def main():\n    print("hi")';

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
	WS = mkdtempSync(join(tmpdir(), 'cellar-mojo-preflight-'));
	process.env.CELLAR_WORKSPACE = WS;
	process.env.CELLAR_MOJO_SETUP_TIMEOUT_MS = '120'; // tiny bound so a hang is observable
	process.env.CELLAR_KERNEL_IDLE_TIMEOUT_MS = '0'; // the watchdog is a different test's subject
	process.env.CELLAR_KERNEL_INTERRUPT_GRACE_MS = '60'; // a parked run never surrenders; do not wait 5s for it
	nbmod = await import('../../src/lib/server/notebook');
	queue = await import('../../src/lib/server/run-queue');
	runmod = await import('../../src/lib/server/run');
	kernelmod = await import('../../src/lib/server/kernel');
	nbmod.createNotebook(NB, null, { focus: false });
	nbmod.setActiveNotebook(NB);
});

beforeEach(async () => {
	h.setupMode = 'ready';
	h.setupRuns = 0;
	h.executed.length = 0;
	h.hangingSetup = null;
	await kernelmod.shutdownKernel(abs()); // a fresh session per test, so the memo is clear
});

describe('a READY setup dispatches the compiled magic', () => {
	it('sends `%%mojo` + the cell source, and probes exactly once per session', async () => {
		const a = nbmod.addCell(null, 'mojo', abs(), null, MOJO_SOURCE).id;
		const b = nbmod.addCell(null, 'mojo', abs(), null, 'def main():\n    print("two")').id;
		const first = await runViaOwner(a, MOJO_SOURCE);
		expect(first.status).toBe('ok');
		expect(h.executed.some((c) => c.startsWith(`${MOJO_MAGIC_HEADER}\n${MOJO_SOURCE}`))).toBe(true);

		await runViaOwner(b, 'def main():\n    print("two")');
		// ONE probe for the whole session: the registration lives in the namespace.
		expect(h.setupRuns).toBe(1);
	});

	it('re-probes after a RESTART, because the namespace that held the magic is gone', async () => {
		const id = nbmod.addCell(null, 'mojo', abs(), null, MOJO_SOURCE).id;
		await runViaOwner(id, MOJO_SOURCE);
		expect(h.setupRuns).toBe(1);
		await kernelmod.restartKernel(abs());
		await runViaOwner(id, MOJO_SOURCE);
		expect(h.setupRuns).toBe(2);
	});

	it('leaves a PYTHON cell alone: no probe, no magic, source sent verbatim', async () => {
		const id = nbmod.addCell(null, 'code', abs(), null, 'x = 1').id;
		await runViaOwner(id, 'x = 1');
		expect(h.setupRuns).toBe(0);
		expect(h.executed).toContain('x = 1');
		expect(h.executed.every((c) => !c.includes(MOJO_MAGIC_HEADER))).toBe(true);
	});
});

describe('THE WEDGE GUARD: a setup that cannot answer must not hang the run', () => {
	it('gives up on the bound, falls through to execute(), and FREES the queue slot', async () => {
		h.setupMode = 'hang';
		const id = nbmod.addCell(null, 'mojo', abs(), null, MOJO_SOURCE).id;
		const started = Date.now();
		const res = await runViaOwner(id, MOJO_SOURCE);
		// It COMPLETED. Unbounded, this await would never return and the notebook could
		// not run again without a restart.
		expect(Date.now() - started).toBeLessThan(10_000);
		// The compiled source still reached the kernel: `execute()` owns the outcome.
		expect(h.executed.some((c) => c.startsWith(MOJO_MAGIC_HEADER))).toBe(true);
		expect(res.status).toBe('ok');
		// And it did NOT claim a missing toolchain - nothing observed one.
		const text = JSON.stringify(res.outputs);
		expect(text).not.toContain('uv pip install max');
		expect(text).not.toContain('MojoToolchainMissing');
		// The slot is free: the next run goes through.
		h.setupMode = 'ready';
		h.hangingSetup?._resolve('ok');
		const next = nbmod.addCell(null, 'code', abs(), null, 'y = 2').id;
		await expect(runViaOwner(next, 'y = 2')).resolves.toMatchObject({ status: 'ok' });
	});

	it('gives up when parked on the EXEC LOCK, so the run reaches execute() and Stop can settle it', async () => {
		// The lock is taken BEFORE the probe's own request, so bounding only the reply
		// left this shape un-bounded: the probe parked here in front of a run that has
		// already emitted `run:start` and holds the queue's `running` slot while being
		// in neither `pending` nor `activeRuns` - reachable by no abort path at all.
		// Post-fix the probe gives up on the same bound, the run falls through to
		// `execute()`, which registers its `ActiveRun`, and the user's Stop reaches it.
		const holder = kernelmod.execute(abs(), h.HOLD_CODE, () => {}, { internal: true }).catch(() => {});
		await vi.waitFor(() => expect(h.executed).toContain(h.HOLD_CODE));

		const id = nbmod.addCell(null, 'mojo', abs(), null, MOJO_SOURCE).id;
		const run = runViaOwner(id, MOJO_SOURCE);
		// Long enough for the probe's 120ms bound to elapse and the run to register.
		await new Promise((r) => setTimeout(r, 400));

		const interrupted = await kernelmod.interruptKernel(abs());
		// The parked run was VISIBLE to the interrupt - it is what `forced` reports.
		expect(interrupted.stopped).toBe('forced');
		// And Stop really stopped it: the cell ends in error and the compiled magic was
		// never dispatched. Parked in the probe it was invisible to this call, and the
		// cell went on to run once the holder was cleared - a run nobody could cancel.
		const res = await run;
		expect(res.status).toBe('error');
		expect(h.executed.every((c) => !c.includes(MOJO_MAGIC_HEADER))).toBe(true);
		await holder;
	});

	it('a probe that THROWS is NO VERDICT too, never a missing toolchain', async () => {
		// A dead connection / a restart landing mid-probe makes `requestExecute` throw.
		// That observed NOTHING about the toolchain, so it must take the SAME exit the
		// timeout takes rather than prescribing a 534 MB install for a cause nobody saw.
		h.setupMode = 'throw';
		const id = nbmod.addCell(null, 'mojo', abs(), null, MOJO_SOURCE).id;
		const res = await runViaOwner(id, MOJO_SOURCE);
		const text = JSON.stringify(res.outputs);
		expect(text).not.toContain('uv pip install max');
		expect(text).not.toContain('MojoToolchainMissing');
		// It fell through to `execute()`, which owns the outcome.
		expect(h.executed.some((c) => c.startsWith(MOJO_MAGIC_HEADER))).toBe(true);
		expect(res.status).toBe('ok');
	});
});

describe('a NOT-READY setup reports the instruction and never sends an unregistered magic', () => {
	it('fails the cell with the install command, stamped with the LIVE session', async () => {
		h.setupMode = 'missing';
		const id = nbmod.addCell(null, 'mojo', abs(), null, MOJO_SOURCE).id;
		const res = await runViaOwner(id, MOJO_SOURCE);
		expect(res.status).toBe('error');
		const text = JSON.stringify(res.outputs);
		expect(text).toContain('uv pip install max');
		expect(text).toContain('MojoToolchainMissing');
		// The kernel was never asked to run a magic it does not have.
		expect(h.executed.every((c) => !c.includes(MOJO_MAGIC_HEADER))).toBe(true);
		// A session IS stamped: the kernel is alive and the probe ran in it, so the
		// failure is LIVE rather than a leftover from a previous session.
		expect(res.session).not.toBeNull();
		expect(res.kernelDown).toBe(false);
	});

	it('RE-PROBES on the next run, so `uv pip install max` then re-run actually works', async () => {
		h.setupMode = 'missing';
		const id = nbmod.addCell(null, 'mojo', abs(), null, MOJO_SOURCE).id;
		await runViaOwner(id, MOJO_SOURCE);
		expect(h.setupRuns).toBe(1);
		// The user installs it; the SAME session must pick it up (the probe calls
		// importlib.invalidate_caches for exactly this).
		h.setupMode = 'ready';
		const res = await runViaOwner(id, MOJO_SOURCE);
		expect(h.setupRuns).toBe(2);
		expect(res.status).toBe('ok');
		expect(h.executed.some((c) => c.startsWith(MOJO_MAGIC_HEADER))).toBe(true);
	});
});
