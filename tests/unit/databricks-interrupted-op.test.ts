/**
 * A Databricks op that a user's INTERRUPT force-settled is not an unreachable kernel.
 *
 * `runInKernel` used to relabel EVERY `execute()` throw as `kernel_unavailable`
 * ("the Python kernel could not be reached"), which the sidebar renders as "Cellar
 * could not reach the Python kernel. Restart Cellar, then connect again."  That was
 * safe only while the sole way `execute()` could throw was a sidecar that never
 * answered - and the interrupt escalation retired that premise: its grace window
 * deliberately force-settles the INTERNAL `CONNECT_CODE` execute that holds the
 * per-kernel exec lock, because settling that holder is exactly what unwedges a
 * notebook parked behind it.
 *
 * So on the headline path - a Spark session fails, the status poll fires
 * `autoReconnect`, its connect holds the lock while a cold cluster starts, the user
 * presses Stop - the connect came back claiming the kernel was unreachable, over a
 * kernel that was demonstrably alive and busy and that nothing had observed as
 * unreachable. That is the same assert-more-than-was-observed defect `run.ts` retired
 * for the run path, one layer up.
 *
 * Driven through the REAL `connect()` and the REAL `kernel.ts` (only the Jupyter
 * layer is faked), so the whole chain runs: interrupt -> escalation ->
 * `KernelExecuteAborted` -> `runInKernel`'s catch. A test that mocked `execute()` to
 * throw a hand-made error could not prove the two are told apart BY TYPE.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';


const h = vi.hoisted(() => {
	let seq = 0;
	function makeFuture(code: string) {
		let resolve: (v: { content: { status: string; execution_count: number } }) => void = () => {};
		const done = new Promise<{ content: { status: string; execution_count: number } }>((r) => {
			resolve = r;
		});
		return {
			onIOPub: null as ((msg: unknown) => void) | null,
			onReply: null as ((msg: unknown) => void) | null,
			onStdin: null as ((msg: unknown) => void) | null,
			done,
			dispose: vi.fn(),
			settle: () => resolve({ content: { status: 'ok', execution_count: 1 } }),
			code
		};
	}

	function makeKernel() {
		seq += 1;
		return {
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
				const f = makeFuture(code);
				// The lock holder: a Databricks connect against a cold cluster, which
				// legitimately never answers for minutes. Everything else (the startup
				// injections) settles at once, so it can never be confused with it.
				if (code.includes('_cellar_dbx_connect')) h.hanging = f;
				else queueMicrotask(f.settle);
				return f;
			},
			restart: vi.fn(async () => {}),
			// The kernel never surrenders, so the interrupt must escalate - the F1 shape,
			// which is what puts a `KernelExecuteAborted` into `runInKernel`'s catch.
			interrupt: vi.fn(async () => {}),
			shutdown: vi.fn(async () => {}),
			reconnect: vi.fn(async () => {}),
			dispose: vi.fn()
		};
	}

	return {
		makeKernel,
		hanging: null as ReturnType<typeof makeFuture> | null,
		startNew: vi.fn(async () => makeKernel()),
		getKernelModel: vi.fn(async () => ({ execution_state: 'busy' })),
		interruptKernel: vi.fn(async () => {})
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

const logs = vi.hoisted(() => ({
	logInfo: vi.fn(),
	logWarn: vi.fn(),
	logError: vi.fn()
}));
vi.mock('../../src/lib/server/logs', () => logs);

let dbx: typeof import('../../src/lib/server/databricks');
let kernelmod: typeof import('../../src/lib/server/kernel');
let nbmod: typeof import('../../src/lib/server/notebook');
let dir: string;
const NB = () => join(dir, 'n.ipynb');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, what: string, budgetMs = 5000) {
	const deadline = Date.now() + budgetMs;
	while (!fn() && Date.now() < deadline) await sleep(5);
	if (!fn()) throw new Error(`timed out after ${budgetMs}ms waiting for: ${what}`);
}

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), 'cellar-dbx-interrupted-'));
	writeFileSync(
		join(dir, '.databrickscfg'),
		'[test]\nhost = https://test.databricks.com\ntoken = dummy-pat\n'
	);
	process.env.DATABRICKS_CONFIG_FILE = join(dir, '.databrickscfg');
	process.env.CELLAR_WORKSPACE = dir;
	// No project venv bound, so the DBR probe + version pin short-circuit without
	// spawning python - this test is about the abort classification, nothing else.
	delete process.env.CELLAR_PROJECT_VENV;
	// A long idle window: the watchdog must never be what settles this run, or the
	// test would pass without the interrupt escalation being involved at all.
	process.env.CELLAR_KERNEL_IDLE_TIMEOUT_MS = '60000';
	process.env.CELLAR_KERNEL_INTERRUPT_GRACE_MS = '80';
	process.env.CELLAR_KERNEL_INTERRUPT_SIGNAL_TIMEOUT_MS = '80';
	kernelmod = await import('../../src/lib/server/kernel');
	nbmod = await import('../../src/lib/server/notebook');
	dbx = await import('../../src/lib/server/databricks');
	nbmod.createNotebook('n.ipynb', null, { focus: false });
	nbmod.createNotebook('unreachable.ipynb', null, { focus: false });
});

describe('a Databricks op stopped by an interrupt', () => {
	it('is never reported as a kernel that could not be reached', async () => {
		const nb = NB();
		logs.logError.mockClear();

		// The headline path: a connect holds the exec lock while a cold cluster starts.
		const connectP = dbx
			.connect({ profile: 'test', clusterId: '0101-abc-def', clusterName: 'c', nb })
			.then(
				() => null,
				(e: unknown) => e
			);
		await until(() => h.hanging != null, 'the connect to reach the kernel');

		// The user presses Stop. The escalation force-settles the lock holder - which is
		// the whole point of it, since that is what unwedges anything parked behind it.
		const res = await kernelmod.interruptKernel(nb);
		expect(res.stopped).toBe('forced');

		const err = (await connectP) as { code?: string; message?: string } | null;
		expect(err).toBeTruthy();

		// THE REGRESSION: this came back `kernel_unavailable`, i.e. "the Python kernel
		// could not be reached", for a kernel that was alive, busy, and never observed
		// as unreachable - the sidebar then told the user to restart Cellar.
		expect(err!.code).not.toBe('kernel_unavailable');
		expect(String(err!.message)).not.toMatch(/could not be reached/i);

		// What it IS: the operation did not finish because its kernel run was stopped.
		expect(err!.code).toBe('operation_aborted');
		expect(String(err!.message)).toMatch(/stopped before it finished/i);
		// The abort's own sentence rides along, so the specific cause is not guessed at.
		expect(String(err!.message)).toMatch(/interrupt/i);
		// And it may not blame the credential either.
		expect(String(err!.message)).not.toMatch(/token|sign in|profile/i);

		// An abort is an expected consequence of a user action, not a fault, so it is
		// not logged as an error - least of all under the unreachable-kernel line.
		const errored = logs.logError.mock.calls.map((c) => String(c[1]));
		expect(errored.some((m) => /kernel unreachable/i.test(m))).toBe(false);
	});

	it('is a state conflict, not a 503 "the kernel is gone"', () => {
		// The remedy is to try again once the kernel is free, never to restart Cellar,
		// so it must not share `kernel_unavailable`'s status.
		expect(dbx.statusFor('operation_aborted')).toBe(409);
		expect(dbx.statusFor('operation_aborted')).not.toBe(dbx.statusFor('kernel_unavailable'));
	});

	it('still reports a genuinely unreachable sidecar as kernel_unavailable', async () => {
		// The narrowing must not have cost the case the code exists for: `execute()`
		// throwing before it ever had a kernel in hand is still what it means.
		const nb = join(dir, 'unreachable.ipynb');
		h.startNew.mockImplementationOnce(async () => {
			throw new Error('sidecar unreachable');
		});
		const err = await dbx
			.connect({ profile: 'test', clusterId: '0101-abc-def', clusterName: 'c', nb })
			.then(
				() => null,
				(e: unknown) => e as { code?: string; message?: string }
			);
		expect(err).toBeTruthy();
		expect(err!.code).toBe('kernel_unavailable');
		expect(String(err!.message)).toMatch(/could not be reached/i);
	});
});
