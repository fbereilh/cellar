/**
 * Kernel startup round-trips + internal-probe status-broadcast suppression.
 *
 * Two related kernel-chatter fixes covered here:
 *
 *  1. COALESCED STARTUP — the matplotlib-inline magic, the DataFrame formatter,
 *     the %restart_python magic, and the sys.path project-root add used to be four
 *     serial silent `execute_reply`s in front of the first user result. They are now
 *     ONE combined silent exec, so startup does a single round-trip yet establishes
 *     exactly the same state (each piece still present in the injected code).
 *
 *  2. INTERNAL-PROBE STATUS SUPPRESSION + DEBOUNCE — a full `kernel:status`
 *     snapshot used to fan out on every busy/idle flip, including flips caused by
 *     internal inspect/variable probes and the startup injections. Now a busy/idle
 *     flip broadcasts only while a USER run is in flight; a flip with no user run
 *     (an internal probe) is suppressed. USER runs still broadcast busy → idle.
 *
 * The Jupyter layer is mocked: the fake kernel exposes a `_emitStatus` to drive
 * `statusChanged`, and a manual future so a user run can be held "in flight" while
 * status flips are emitted.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => {
	let seq = 0;

	type Future = {
		onIOPub: ((msg: unknown) => void) | null;
		onReply: ((msg: unknown) => void) | null;
		onStdin: ((msg: unknown) => void) | null;
		done: Promise<{ content: { status: string; execution_count: number } }>;
		dispose: () => void;
		_resolve: (status?: string) => void;
	};

	function makeFuture(): Future {
		let resolveDone!: (v: { content: { status: string; execution_count: number } }) => void;
		const f: Future = {
			onIOPub: null,
			onReply: null,
			onStdin: null,
			done: undefined as unknown as Future['done'],
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
		const statusHandlers = new Set<(sender: unknown, status: string) => void>();
		const kernel = {
			id: `kernel-${seq}`,
			name: 'python3',
			status: 'idle' as string,
			commsOverSubshells: undefined as unknown,
			registerCommTarget: vi.fn(),
			statusChanged: {
				connect: (cb: (sender: unknown, status: string) => void) => statusHandlers.add(cb),
				disconnect: (cb: (sender: unknown, status: string) => void) => statusHandlers.delete(cb)
			},
			iopubMessage: { connect: vi.fn() },
			// Every silent injection (startup) resolves immediately. A non-silent user
			// run returns a future the test resolves manually, so it can hold the run
			// "in flight" and drive status flips around it.
			requestExecute: (args: { code?: string; silent?: boolean }) => {
				h.execCalls.push({ code: args?.code ?? '', silent: !!args?.silent });
				const f = makeFuture();
				if (args?.silent) {
					queueMicrotask(() => f._resolve('ok'));
				} else {
					h.lastUserFuture = f;
				}
				return f;
			},
			restart: vi.fn(async () => {}),
			interrupt: vi.fn(async () => {}),
			shutdown: vi.fn(async () => {}),
			dispose: vi.fn(),
			// Drive a statusChanged flip: set the live status then notify handlers.
			_emitStatus: (status: string) => {
				kernel.status = status;
				for (const cb of statusHandlers) cb(kernel, status);
			}
		};
		h.lastKernel = kernel;
		return kernel;
	}

	return {
		makeFakeKernel,
		startNew: vi.fn(async () => makeFakeKernel()),
		execCalls: [] as Array<{ code: string; silent: boolean }>,
		lastUserFuture: null as Future | null,
		lastKernel: null as ReturnType<typeof makeFakeKernel> | null,
		// Captured kernel:status snapshots (global broadcasts).
		statusBroadcasts: [] as Array<{ kernels: Array<{ path: string; status: string }> }>
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

vi.mock('../../src/lib/server/notebook', () => ({
	getActiveNotebookPath: () => '/ws/a.ipynb',
	workspaceRelative: (abs: string) => abs.replace(/^\/ws\//, ''),
	resolveNotebookPath: (p: string) => (p.startsWith('/') ? p : `/ws/${p}`)
}));

vi.mock('../../src/lib/server/run-queue', () => ({ clearRunQueue: vi.fn() }));

vi.mock('../../src/lib/server/fstree', () => ({ workspaceRoot: () => '/ws' }));

vi.mock('../../src/lib/server/ui-state', () => ({
	addProjectRootToPath: () => true,
	injectDatabricksRuntime: () => false,
	databricksRuntimeVersion: () => '15.4'
}));

// initKernel dynamically imports this to scope the Databricks-runtime env; a plain
// kernel is unbound, so the bound check is false (no injection).
vi.mock('../../src/lib/server/databricks', () => ({ databricksBound: () => false }));

vi.mock('../../src/lib/server/logs', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }));

vi.mock('../../src/lib/server/events', () => ({
	publish: vi.fn(),
	publishGlobal: (e: { type: string; kernels?: unknown }) => {
		if (e.type === 'kernel:status') h.statusBroadcasts.push(e as never);
		return e;
	}
}));

let kernelmod: typeof import('../../src/lib/server/kernel');

const A = '/ws/a.ipynb';
const noop = () => {};
// A near-zero debounce so a scheduled broadcast flushes on the next macrotask.
const flush = () => new Promise((r) => setTimeout(r, 5));

beforeAll(async () => {
	process.env.CELLAR_KERNEL_STATUS_DEBOUNCE_MS = '1';
	kernelmod = await import('../../src/lib/server/kernel');
});

beforeEach(() => {
	h.execCalls.length = 0;
	h.statusBroadcasts.length = 0;
});

describe('coalesced startup round-trips', () => {
	it('injects all startup setup in ONE silent round-trip, establishing the same state', async () => {
		const runP = kernelmod.execute(A, 'x=1', noop);
		await flush(); // let startup (silent injection) + the user requestExecute settle
		h.lastUserFuture!._resolve('ok');
		await runP;
		// Exactly one SILENT injection exec — the coalesced startup, not four.
		const silent = h.execCalls.filter((c) => c.silent);
		expect(silent).toHaveLength(1);
		// …yet it establishes everything the four separate injections did.
		const code = silent[0].code;
		expect(code).toContain("run_line_magic('matplotlib', 'inline')"); // matplotlib inline backend
		expect(code).toContain('application/vnd.cellar.dataframe+json'); // DataFrame formatter
		expect(code).toContain("magic_name='restart_python'"); // %restart_python magic
		expect(code).toContain('_sys.path.insert(0, _cellar_root)'); // project-root sys.path add
		// The user's own code ran as its own (non-silent) exec.
		expect(h.execCalls.some((c) => !c.silent && c.code === 'x=1')).toBe(true);
	});
});

describe('internal-probe vs user status broadcasts', () => {
	it('does NOT broadcast a busy/idle flip with no user run in flight (internal probe)', async () => {
		// Kernel is up (from the run above). Simulate the busy→idle flips an internal
		// inspect/variable probe induces — no user run is in flight.
		h.statusBroadcasts.length = 0;
		const k = h.lastKernel!;
		k._emitStatus('busy');
		k._emitStatus('idle');
		await flush();
		expect(h.statusBroadcasts).toHaveLength(0);
	});

	it('DOES broadcast busy then idle for a USER cell run', async () => {
		h.statusBroadcasts.length = 0;
		const k = h.lastKernel!;
		// Start a user run but hold it in flight (manual future).
		const runP = kernelmod.execute(A, 'y=2', noop);
		await Promise.resolve(); // let execute() reach requestExecute
		// Kernel goes busy while the user run executes → must broadcast.
		k._emitStatus('busy');
		await flush();
		expect(h.statusBroadcasts.length).toBeGreaterThanOrEqual(1);
		expect(h.statusBroadcasts.at(-1)!.kernels.find((e) => e.path === 'a.ipynb')!.status).toBe('busy');
		// Complete the run; the boundary reflects the now-idle kernel.
		k.status = 'idle';
		h.lastUserFuture!._resolve('ok');
		await runP;
		await flush();
		expect(h.statusBroadcasts.at(-1)!.kernels.find((e) => e.path === 'a.ipynb')!.status).toBe('idle');
	});

	it('coalesces a burst of user-run flips into a single broadcast', async () => {
		h.statusBroadcasts.length = 0;
		const k = h.lastKernel!;
		const runP = kernelmod.execute(A, 'z=3', noop);
		await Promise.resolve();
		// A flurry of flips within one debounce window collapses to ONE wire message.
		k._emitStatus('busy');
		k._emitStatus('idle');
		k._emitStatus('busy');
		await flush();
		const busyBroadcasts = h.statusBroadcasts.length;
		expect(busyBroadcasts).toBe(1);
		k.status = 'idle';
		h.lastUserFuture!._resolve('ok');
		await runP;
	});
});
