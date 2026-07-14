/**
 * Kernel lifecycle & memory (kernel-per-notebook, Phase 6).
 *
 * Covers the operational safety net that keeps N kernels from quietly exhausting
 * RAM:
 *   - idle-cull reconciliation: when the sidecar culls an idle kernel it vanishes
 *     from the server's running list; the KernelManager's `runningChanged` poll
 *     fires, and kernel.ts must tear that kernel out of its Map so the card drops,
 *     the epoch is invalidated (the notebook's cells read "not run this session"),
 *     and a per-notebook `kernel:shutdown` event is published;
 *   - shutdown-on-notebook-delete: `shutdownKernelsUnder` frees the kernel(s) of a
 *     deleted notebook / folder;
 *   - rebind fan-out: a venv change tears down every live kernel.
 *
 * The whole Jupyter layer (`@jupyterlab/services`) is mocked: a stateful fake
 * KernelManager tracks a running-kernels set and exposes a `runningChanged` signal
 * so a cull can be simulated by dropping a kernel from the set and firing it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => {
	let seq = 0;
	// The single fake manager instance kernel.ts creates, captured for the test to
	// drive (simulate a server-side cull).
	let mgr: {
		models: Map<string, { id: string }>;
		runningCb: (() => void) | null;
		running: () => IterableIterator<{ id: string }>;
	} | null = null;

	function makeFakeKernel(id: string) {
		return {
			id,
			name: 'python3',
			status: 'idle' as const,
			registerCommTarget: vi.fn(),
			statusChanged: { connect: vi.fn(), disconnect: vi.fn() },
			iopubMessage: { connect: vi.fn() },
			requestExecute: vi.fn(() => ({
				onIOPub: null as unknown,
				done: Promise.resolve({ content: { status: 'ok', execution_count: 1 } })
			})),
			restart: vi.fn(async () => {}),
			interrupt: vi.fn(async () => {}),
			shutdown: vi.fn(async () => {}),
			dispose: vi.fn()
		};
	}

	return {
		makeFakeKernel,
		getMgr: () => mgr,
		setMgr: (m: NonNullable<typeof mgr>) => (mgr = m),
		nextId: () => `kernel-${++seq}`,
		activeNb: '/ws/a.ipynb',
		published: [] as Array<Record<string, unknown>>
	};
});

vi.mock('@jupyterlab/services', () => ({
	KernelManager: class {
		ready = Promise.resolve();
		models = new Map<string, { id: string }>();
		runningCb: (() => void) | null = null;
		runningChanged = {
			connect: (cb: () => void) => {
				this.runningCb = cb;
			}
		};
		running() {
			return this.models.values();
		}
		startNew = async () => {
			const id = h.nextId();
			this.models.set(id, { id });
			return h.makeFakeKernel(id);
		};
		dispose = vi.fn();
		constructor() {
			h.setMgr(this as unknown as NonNullable<ReturnType<typeof h.getMgr>>);
		}
	},
	ServerConnection: { makeSettings: (o: unknown) => o }
}));

vi.mock('../../src/lib/server/notebook', () => ({
	getActiveNotebookPath: () => h.activeNb,
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

// Capture published events so we can assert the per-notebook kernel:shutdown
// invalidation (publish) and the sidebar snapshot (publishGlobal).
vi.mock('../../src/lib/server/events', () => ({
	publish: (e: Record<string, unknown>) => {
		h.published.push(e);
		return e;
	},
	publishGlobal: (e: Record<string, unknown>) => {
		h.published.push({ ...e, global: true });
		return e;
	}
}));

import {
	execute,
	getKernelInfo,
	currentSessionId,
	loadedNotebookPaths,
	listKernels,
	shutdownKernelsUnder,
	rebindKernel
} from '../../src/lib/server/kernel';

const A = '/ws/a.ipynb';
const B = '/ws/b.ipynb';
const noop = () => {};

/** Simulate a sidecar idle-cull of the kernel with the given id. */
function cull(kernelId: string) {
	const mgr = h.getMgr()!;
	mgr.models.delete(kernelId);
	mgr.runningCb?.(); // the KernelManager poll fires runningChanged
}

beforeEach(() => {
	h.published.length = 0;
});

describe('idle-cull reconciliation', () => {
	it('drops a culled kernel: card gone, epoch invalidated, kernel:shutdown published', async () => {
		await execute(A, 'x=1', noop);
		await execute(B, 'y=2', noop);
		expect(new Set(loadedNotebookPaths())).toEqual(new Set([A, B]));
		const aId = getKernelInfo(A).id!;
		expect(aId).toBeTruthy();

		cull(aId);
		// teardownKernel runs async (disposes the connection); let microtasks settle.
		await Promise.resolve();
		await Promise.resolve();

		// A is gone: no entry, no epoch — its cells now read "not run this session".
		expect(loadedNotebookPaths()).toEqual([B]);
		expect(currentSessionId(A)).toBeNull();
		expect(getKernelInfo(A).started).toBe(false);
		expect(listKernels().map((k) => k.path)).toEqual(['b.ipynb']);

		// A per-notebook kernel:shutdown event invalidates A's run-status in open tabs.
		const shutdownEv = h.published.find((e) => e.type === 'kernel:shutdown' && e.nb === A);
		expect(shutdownEv).toMatchObject({ type: 'kernel:shutdown', nb: A, reason: 'kernel_culled' });
		// And a kernel:status snapshot refreshes the sidebar cards.
		expect(h.published.some((e) => e.type === 'kernel:status' && e.global)).toBe(true);

		// B is untouched — still live with its epoch.
		expect(getKernelInfo(B).started).toBe(true);
		expect(currentSessionId(B)).not.toBeNull();
	});

	it('a runningChanged poll that shows every kernel alive tears nothing down', async () => {
		const bId = getKernelInfo(B).id!;
		h.published.length = 0;
		// Fire the poll with B still in the running set.
		h.getMgr()!.runningCb?.();
		await Promise.resolve();
		expect(loadedNotebookPaths()).toEqual([B]);
		expect(getKernelInfo(B).id).toBe(bId);
		expect(h.published.some((e) => e.type === 'kernel:shutdown')).toBe(false);
	});

	it('re-runs a culled notebook by lazily starting a fresh kernel with a new epoch', async () => {
		// A was culled above; a new run must start a brand-new kernel/epoch.
		await execute(A, 'x=3', noop);
		expect(getKernelInfo(A).started).toBe(true);
		expect(currentSessionId(A)).not.toBeNull();
	});
});

describe('shutdown-on-notebook-delete (shutdownKernelsUnder)', () => {
	it('frees the deleted notebook’s kernel and leaves siblings intact', async () => {
		// A and B are both live at this point.
		expect(new Set(loadedNotebookPaths())).toEqual(new Set([A, B]));
		const n = await shutdownKernelsUnder('a.ipynb'); // workspace-relative, as the fs route passes
		expect(n).toBe(1);
		expect(loadedNotebookPaths()).toEqual([B]);
		expect(getKernelInfo(A).started).toBe(false);
		expect(currentSessionId(A)).toBeNull();
		expect(h.published.some((e) => e.type === 'kernel:shutdown' && e.nb === A && e.reason === 'notebook_deleted')).toBe(true);
	});

	it('shuts down every kernel nested under a deleted folder', async () => {
		await execute('/ws/proj/one.ipynb', 'a=1', noop);
		await execute('/ws/proj/sub/two.ipynb', 'b=2', noop);
		const n = await shutdownKernelsUnder('proj');
		expect(n).toBe(2);
		expect(loadedNotebookPaths()).toEqual([B]); // B (outside proj) survives
	});

	it('deleting a path with no live kernel is a no-op', async () => {
		const n = await shutdownKernelsUnder('never-ran.ipynb');
		expect(n).toBe(0);
		expect(loadedNotebookPaths()).toEqual([B]);
	});
});

describe('rebind fan-out (venv change)', () => {
	it('tears down EVERY live kernel and reports the count', async () => {
		await execute(A, 'x=1', noop); // A back up alongside B
		expect(new Set(loadedNotebookPaths())).toEqual(new Set([A, B]));
		const res = await rebindKernel(); // no arg = shared kernelspec changed
		expect(res.rebound).toBe(2);
		expect(loadedNotebookPaths()).toEqual([]);
		expect(currentSessionId(A)).toBeNull();
		expect(currentSessionId(B)).toBeNull();
	});
});
