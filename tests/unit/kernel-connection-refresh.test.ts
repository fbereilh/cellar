/**
 * Rung 1 of the reconnect ladder: `refreshKernelConnection()` — the fix for the
 * dead-kernel-connection bug (`cellar-dead-connection-refresh-x8`).
 *
 * After the watchdog convicts a `disconnected` kernel socket, the dead
 * `KernelConnection` used to stay in the map: the PROCESS is still in the server's
 * running list (so cull reconciliation won't drop it) and `getKernel` handed that same
 * dead socket to the next run, whose messages sat in @jupyterlab's `_pendingMessages`
 * awaiting a reconnect whose retries were spent — every later run silently wedged.
 *
 * `refreshKernelConnection` repairs the TRANSPORT only, on `KernelConnection.reconnect()`
 * (which rebuilds the websocket without touching the process), so the namespace and any
 * running cell survive. A plain teardown would be wrong: a `disconnected` socket does NOT
 * prove the process is dead — the user's Spark job is very likely still executing.
 *
 * Proven here (only the Jupyter layer is faked):
 *   (a) `disconnected` socket + a PRESENT server model → `reconnect()` is called, the
 *       kernel is NOT torn down, and the session epoch is NOT bumped;
 *   (b) a GONE server model (getKernelModel → undefined) → proven dead → fall through to
 *       `teardownKernel` (rung 3), NO `reconnect()`;
 *   (c) single-flight: a burst of triggers reconnects exactly ONCE;
 *   plus the no-kernel short-circuit (never boot one).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => {
	let seq = 0;

	function makeFakeKernel(id: string) {
		const k = {
			id,
			name: 'python3',
			status: 'idle' as const,
			// Healthy on start; a test flips this to 'disconnected' to simulate the drop.
			connectionStatus: 'connected' as string,
			commsOverSubshells: undefined as unknown,
			registerCommTarget: vi.fn(),
			statusChanged: { connect: vi.fn(), disconnect: vi.fn() },
			iopubMessage: { connect: vi.fn() },
			// Startup injections + plain cells complete immediately (nothing to drive).
			requestExecute: vi.fn(() => ({
				onIOPub: null as unknown,
				onReply: null as unknown,
				onStdin: null as unknown,
				done: Promise.resolve({ content: { status: 'ok', execution_count: 1 } }),
				dispose: vi.fn()
			})),
			restart: vi.fn(async () => {}),
			interrupt: vi.fn(async () => {}),
			shutdown: vi.fn(async () => {}),
			// A real reconnect() rebuilds the websocket → socket returns to 'connected'.
			// `reconnectImpl` lets a test make it slow (to observe single-flight).
			reconnect: vi.fn(async () => {
				await h.reconnectImpl();
				k.connectionStatus = 'connected';
			}),
			dispose: vi.fn()
		};
		h.lastKernel = k;
		return k;
	}

	return {
		makeFakeKernel,
		startNew: vi.fn(async () => makeFakeKernel(`kernel-${++seq}`)),
		lastKernel: null as ReturnType<typeof makeFakeKernel> | null,
		/** The server's REST view of the kernel; a test sets this per case. */
		model: (() => ({ execution_state: 'busy' })) as () =>
			| { execution_state: string }
			| undefined
			| Promise<{ execution_state: string } | undefined>,
		getKernelModel: vi.fn(async () => h.model()),
		/** Gate for `reconnect()`; resolves immediately unless a test replaces it. */
		reconnectImpl: (() => Promise.resolve()) as () => Promise<void>
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

vi.mock('../../src/lib/server/notebook', () => ({
	getActiveNotebookPath: () => '/ws/a.ipynb',
	workspaceRelative: (abs: string) => abs.replace(/^\/ws\//, ''),
	resolveNotebookPath: (p: string) => (p.startsWith('/') ? p : `/ws/${p}`)
}));

vi.mock('../../src/lib/server/run-queue', () => ({
	clearRunQueue: vi.fn()
}));

vi.mock('../../src/lib/server/logs', () => ({
	logInfo: vi.fn(),
	logWarn: vi.fn(),
	logError: vi.fn()
}));

const published: Array<Record<string, unknown>> = [];
vi.mock('../../src/lib/server/events', () => ({
	publish: (e: Record<string, unknown>) => {
		published.push(e);
		return e;
	},
	publishGlobal: (e: Record<string, unknown>) => {
		published.push({ ...e, global: true });
		return e;
	}
}));

import {
	execute,
	refreshKernelConnection,
	getKernelInfo,
	currentSessionId,
	loadedNotebookPaths
} from '../../src/lib/server/kernel';

const noop = () => {};

/** Bring a kernel up for notebook `nb` and return its id + starting epoch. */
async function startKernel(nb: string) {
	await execute(nb, 'x = 1', noop, { internal: true });
	return { id: getKernelInfo(nb).id!, session: currentSessionId(nb) };
}

beforeEach(() => {
	published.length = 0;
	h.model = () => ({ execution_state: 'busy' });
	h.reconnectImpl = () => Promise.resolve();
	h.getKernelModel.mockClear();
	h.startNew.mockClear();
});

describe('a disconnected socket with a present server model refreshes the transport', () => {
	it('calls reconnect(), does NOT tear down, does NOT bump the epoch', async () => {
		const NB = '/ws/refresh-a.ipynb';
		const started = await startKernel(NB);
		// The websocket died; the server still HAS the kernel (model present, busy).
		h.lastKernel!.connectionStatus = 'disconnected';

		const res = await refreshKernelConnection(NB);

		expect(res).toEqual({ refreshed: true, reason: 'reconnected' });
		// The transport was refreshed on the SAME connection.
		expect(h.lastKernel!.reconnect).toHaveBeenCalledTimes(1);
		// The process was preserved: no shutdown, still in the map, same kernel id.
		expect(h.lastKernel!.shutdown).not.toHaveBeenCalled();
		expect(getKernelInfo(NB).started).toBe(true);
		expect(getKernelInfo(NB).id).toBe(started.id);
		expect(loadedNotebookPaths()).toContain(NB);
		// No epoch bump: the session never changed, so ran_this_session / spark stay valid.
		expect(currentSessionId(NB)).toBe(started.session);
		// A refresh is not a shutdown: no kernel:shutdown was published.
		expect(published.some((e) => e.type === 'kernel:shutdown')).toBe(false);
	});
});

describe('a kernel gone from the server falls through to teardown (rung 3)', () => {
	it('does NOT reconnect; tears the dead entry down so the next run starts fresh', async () => {
		const NB = '/ws/refresh-gone.ipynb';
		await startKernel(NB);
		// The socket is down AND the server no longer has the kernel: proven dead.
		h.lastKernel!.connectionStatus = 'disconnected';
		const goneKernel = h.lastKernel!;
		h.model = () => undefined; // getKernelModel resolves the 404 as undefined

		const res = await refreshKernelConnection(NB);

		expect(res).toEqual({ refreshed: false, reason: 'kernel_gone' });
		// We must NOT reconnect to a corpse — a socket reconnect would hang or reject.
		expect(goneKernel.reconnect).not.toHaveBeenCalled();
		// Torn down: entry gone, epoch invalidated, process shut down.
		expect(goneKernel.shutdown).toHaveBeenCalledTimes(1);
		expect(getKernelInfo(NB).started).toBe(false);
		expect(currentSessionId(NB)).toBeNull();
		expect(loadedNotebookPaths()).not.toContain(NB);
		expect(
			published.some((e) => e.type === 'kernel:shutdown' && e.nb === NB && e.reason === 'kernel_gone')
		).toBe(true);

		// Rung 3 in action: the next run lazily starts a BRAND-NEW kernel/epoch.
		await startKernel(NB);
		expect(getKernelInfo(NB).started).toBe(true);
		expect(getKernelInfo(NB).id).not.toBe(goneKernel.id);
	});

	it('a server model reporting the process dead also tears down (no reconnect)', async () => {
		const NB = '/ws/refresh-dead.ipynb';
		await startKernel(NB);
		h.lastKernel!.connectionStatus = 'disconnected';
		const deadKernel = h.lastKernel!;
		h.model = () => ({ execution_state: 'dead' });

		const res = await refreshKernelConnection(NB);

		expect(res).toEqual({ refreshed: false, reason: 'kernel_gone' });
		expect(deadKernel.reconnect).not.toHaveBeenCalled();
		expect(deadKernel.shutdown).toHaveBeenCalledTimes(1);
		expect(getKernelInfo(NB).started).toBe(false);
	});
});

describe('single-flight: a burst of triggers reconnects once', () => {
	it('coalesces concurrent refreshes onto one reconnect()', async () => {
		const NB = '/ws/refresh-burst.ipynb';
		await startKernel(NB);
		h.lastKernel!.connectionStatus = 'disconnected';

		// Make reconnect() slow so all three callers overlap in-flight.
		let release: () => void = () => {};
		h.reconnectImpl = () =>
			new Promise<void>((r) => {
				release = r;
			});

		const p1 = refreshKernelConnection(NB);
		const p2 = refreshKernelConnection(NB);
		const p3 = refreshKernelConnection(NB);
		// Wait until the shared attempt has actually reached (the slow) reconnect(), then
		// release it — releasing earlier would no-op against the not-yet-assigned resolver.
		const deadline = Date.now() + 2000;
		while (h.lastKernel!.reconnect.mock.calls.length === 0 && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 5));
		}
		release();

		const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
		expect(r1).toEqual({ refreshed: true, reason: 'reconnected' });
		expect(r2).toEqual({ refreshed: true, reason: 'reconnected' });
		expect(r3).toEqual({ refreshed: true, reason: 'reconnected' });
		// The whole point: one reconnect, not three.
		expect(h.lastKernel!.reconnect).toHaveBeenCalledTimes(1);
		// The in-flight guard cleared, so a later refresh can run again (fast this time).
		h.reconnectImpl = () => Promise.resolve();
		h.lastKernel!.connectionStatus = 'disconnected';
		await refreshKernelConnection(NB);
		expect(h.lastKernel!.reconnect).toHaveBeenCalledTimes(2);
	});
});

describe('no kernel', () => {
	it('never boots one — returns {refreshed:false, reason:no_kernel}', async () => {
		const res = await refreshKernelConnection('/ws/never-ran.ipynb');
		expect(res).toEqual({ refreshed: false, reason: 'no_kernel' });
		expect(h.startNew).not.toHaveBeenCalled();
	});
});
