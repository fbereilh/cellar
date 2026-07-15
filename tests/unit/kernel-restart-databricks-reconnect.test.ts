/**
 * Wiring: a kernel restart re-establishes the notebook's Databricks session.
 *
 * kernel.ts must, AFTER a restart / autorestart has brought the namespace back,
 * fire the Databricks layer's `reconnectAfterKernelRestart(nb)` (fire-and-forget,
 * so it never blocks the restart). This test mocks the whole Jupyter layer AND
 * `./databricks`, so it asserts only the trigger + its target notebook; the
 * reconnect LOGIC (target/guards/failure-degrade) is covered by
 * databricks-restart-reconnect.test.ts.
 *
 * The dynamic `import('./databricks')` in kernel.ts is intercepted by the mock, so
 * no real Databricks/subprocess code runs.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => {
	let seq = 0;
	/** The most recently created fake kernel, so a test can drive its status signal. */
	let lastKernel: FakeKernel | null = null;

	interface FakeKernel {
		id: string;
		name: string;
		status: string;
		commsOverSubshells: unknown;
		registerCommTarget: ReturnType<typeof vi.fn>;
		statusChanged: { connect: (cb: (s: unknown, st: string) => void) => void; disconnect: (cb: unknown) => void };
		iopubMessage: { connect: ReturnType<typeof vi.fn> };
		requestExecute: () => Record<string, unknown>;
		restart: ReturnType<typeof vi.fn>;
		interrupt: ReturnType<typeof vi.fn>;
		shutdown: ReturnType<typeof vi.fn>;
		dispose: ReturnType<typeof vi.fn>;
		emitStatus: (st: string) => void;
	}

	function makeFakeKernel(id: string): FakeKernel {
		const listeners = new Set<(s: unknown, st: string) => void>();
		const k: FakeKernel = {
			id,
			name: 'python3',
			status: 'idle',
			commsOverSubshells: undefined,
			registerCommTarget: vi.fn(),
			statusChanged: {
				connect: (cb) => listeners.add(cb),
				disconnect: (cb) => listeners.delete(cb as (s: unknown, st: string) => void)
			},
			iopubMessage: { connect: vi.fn() },
			requestExecute: () => ({
				onIOPub: null,
				onReply: null,
				onStdin: null,
				done: Promise.resolve({ content: { status: 'ok', execution_count: 1 } }),
				dispose: vi.fn()
			}),
			restart: vi.fn(async () => {}),
			interrupt: vi.fn(async () => {}),
			shutdown: vi.fn(async () => {}),
			dispose: vi.fn(),
			emitStatus: (st) => {
				k.status = st;
				for (const l of listeners) l(k, st);
			}
		};
		lastKernel = k;
		return k;
	}

	return {
		makeFakeKernel,
		nextId: () => `kernel-${++seq}`,
		getLastKernel: () => lastKernel,
		activeNb: '/ws/a.ipynb',
		/** Records every (nb) `reconnectAfterKernelRestart` was called with. */
		reconnectCalls: [] as string[]
	};
});

vi.mock('@jupyterlab/services', () => ({
	KernelManager: class {
		ready = Promise.resolve();
		models = new Map<string, { id: string }>();
		runningChanged = { connect: () => {} };
		running() {
			return this.models.values();
		}
		startNew = async () => {
			const id = h.nextId();
			this.models.set(id, { id });
			return h.makeFakeKernel(id);
		};
		dispose = vi.fn();
	},
	ServerConnection: { makeSettings: (o: unknown) => o },
	CommsOverSubshells: { Disabled: 'disabled' }
}));

vi.mock('../../src/lib/server/notebook', () => ({
	getActiveNotebookPath: () => h.activeNb,
	workspaceRelative: (abs: string) => abs.replace(/^\/ws\//, ''),
	resolveNotebookPath: (p: string) => (p.startsWith('/') ? p : `/ws/${p}`)
}));

vi.mock('../../src/lib/server/run-queue', () => ({ clearRunQueue: vi.fn() }));
vi.mock('../../src/lib/server/logs', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }));
vi.mock('../../src/lib/server/events', () => ({ publish: vi.fn(), publishGlobal: vi.fn() }));

// The seam under test: the reconnect the restart must fire (loaded dynamically by
// kernel.ts). Record its calls; return a resolved no-op so nothing blocks.
vi.mock('../../src/lib/server/databricks', () => ({
	reconnectAfterKernelRestart: vi.fn(async (nb: string) => {
		h.reconnectCalls.push(nb);
		return { reconnected: false };
	})
}));

import { execute, restartKernel } from '../../src/lib/server/kernel';

const A = '/ws/a.ipynb';
const noop = () => {};

beforeEach(() => {
	h.reconnectCalls.length = 0;
});

/** Wait for the fire-and-forget reconnect (dynamic import + microtasks) to settle. */
async function flush() {
	await vi.waitFor(() => expect(h.reconnectCalls.length).toBeGreaterThan(0));
}

describe('restart → Databricks reconnect wiring', () => {
	it('restartKernel fires reconnectAfterKernelRestart for that notebook', async () => {
		await execute(A, 'x=1', noop); // lazily start A's kernel
		const res = await restartKernel(A);
		// The restart returns its normal status without waiting on the reconnect.
		expect(res.status).toBeDefined();
		await flush();
		expect(h.reconnectCalls).toContain(A);
	});

	it('a jupyter-driven autorestart also fires the reconnect', async () => {
		await execute(A, 'x=1', noop);
		h.reconnectCalls.length = 0;
		// The sidecar restarts the dead kernel behind our back → 'autorestarting'.
		h.getLastKernel()!.emitStatus('autorestarting');
		await flush();
		expect(h.reconnectCalls).toContain(A);
	});
});
