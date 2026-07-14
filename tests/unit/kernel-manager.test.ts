/**
 * Kernel manager (kernel-per-notebook, Phase 1).
 *
 * `kernel.ts` is now a `Map<nbPath, NotebookKernel>` manager: kernels are
 * lazy-started per notebook on first execute, each has its own connection and its
 * own monotonic session epoch, and a restart of one notebook's kernel leaves the
 * others untouched. The whole Jupyter layer (`@jupyterlab/services`) is mocked so
 * these can run without a real sidecar — each `startNew` yields a distinct fake
 * kernel, and every execute resolves immediately.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => {
	let seq = 0;
	function makeFakeKernel() {
		seq += 1;
		return {
			id: `kernel-${seq}`,
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
			shutdown: vi.fn(async () => {})
		};
	}
	return {
		startNew: vi.fn(async () => makeFakeKernel()),
		dispose: vi.fn(),
		activeNb: '/ws/a.ipynb'
	};
});

vi.mock('@jupyterlab/services', () => ({
	KernelManager: class {
		ready = Promise.resolve();
		startNew = h.startNew;
		dispose = h.dispose;
	},
	ServerConnection: { makeSettings: (o: unknown) => o }
}));

vi.mock('../../src/lib/server/notebook', () => ({
	getActiveNotebookPath: () => h.activeNb,
	// listKernels() (via the kernel:status publish) maps each absolute path to its
	// workspace-relative id; the fake workspace is '/ws'.
	workspaceRelative: (abs: string) => abs.replace(/^\/ws\//, '')
}));

vi.mock('../../src/lib/server/run-queue', () => ({
	clearRunQueue: vi.fn()
}));

vi.mock('../../src/lib/server/logs', () => ({
	logInfo: vi.fn(),
	logWarn: vi.fn(),
	logError: vi.fn()
}));

import {
	execute,
	getKernelInfo,
	kernelStatus,
	currentSessionId,
	loadedNotebookPaths,
	listKernels,
	shutdownKernel,
	restartKernel
} from '../../src/lib/server/kernel';

const A = '/ws/a.ipynb';
const B = '/ws/b.ipynb';
const noop = () => {};

beforeEach(() => {
	h.startNew.mockClear();
});

describe('kernel manager (per notebook)', () => {
	it('is lazy: no kernel exists until a notebook first runs', () => {
		expect(loadedNotebookPaths()).toEqual([]);
		expect(h.startNew).not.toHaveBeenCalled();
		expect(kernelStatus(A)).toEqual({ status: 'not_started', id: null });
		expect(currentSessionId(A)).toBeNull();
		expect(getKernelInfo(A).started).toBe(false);
	});

	it('lazy-starts one kernel on the notebook first run', async () => {
		await execute(A, 'x=1', noop);
		expect(h.startNew).toHaveBeenCalledTimes(1);
		expect(loadedNotebookPaths()).toEqual([A]);
		expect(currentSessionId(A)).not.toBeNull();
		expect(getKernelInfo(A).started).toBe(true);
	});

	it('reuses the same kernel on a second run of the same notebook', async () => {
		const before = currentSessionId(A);
		await execute(A, 'x=2', noop);
		expect(h.startNew).not.toHaveBeenCalled(); // cleared in beforeEach
		expect(loadedNotebookPaths()).toEqual([A]);
		// A reused kernel keeps its epoch — no restart happened.
		expect(currentSessionId(A)).toBe(before);
	});

	it('routes a second notebook to its own kernel with an isolated, distinct epoch', async () => {
		await execute(B, 'y=2', noop);
		expect(h.startNew).toHaveBeenCalledTimes(1); // a NEW kernel for B
		expect(new Set(loadedNotebookPaths())).toEqual(new Set([A, B]));
		const sa = currentSessionId(A);
		const sb = currentSessionId(B);
		expect(sa).not.toBeNull();
		expect(sb).not.toBeNull();
		// Epochs are drawn from one global counter, so they never collide across
		// notebooks — the run-status doctrine can't confuse A's cells with B's.
		expect(sa).not.toBe(sb);
		// Two distinct kernel connections.
		expect(getKernelInfo(A).id).not.toBe(getKernelInfo(B).id);
	});

	it('restarts one notebook without touching the other', async () => {
		const aBefore = currentSessionId(A);
		const bBefore = currentSessionId(B);
		const info = await restartKernel(A);
		expect(info.session_id).not.toBeNull();
		// A's epoch advanced; B's is unchanged.
		expect(currentSessionId(A)).not.toBe(aBefore);
		expect(currentSessionId(B)).toBe(bBefore);
		// Restart did not start a new kernel (it reuses the connection).
		expect(h.startNew).not.toHaveBeenCalled();
	});

	it('resolves a bare (no-arg) call to the active notebook', async () => {
		h.activeNb = B;
		// getKernelInfo() with no path reports B (the active notebook) now.
		expect(getKernelInfo().id).toBe(getKernelInfo(B).id);
		expect(currentSessionId()).toBe(currentSessionId(B));
		h.activeNb = A;
	});
});

describe('listKernels + shutdown (Phase 3)', () => {
	// A and B both have live kernels carried over from the runs above.
	it('lists one entry per live kernel with its own status + workspace-relative path', () => {
		const list = listKernels();
		const byPath = Object.fromEntries(list.map((k) => [k.path, k]));
		expect(new Set(list.map((k) => k.path))).toEqual(new Set(['a.ipynb', 'b.ipynb']));
		expect(byPath['a.ipynb'].started).toBe(true);
		expect(byPath['a.ipynb'].status).toBe('idle');
		expect(byPath['a.ipynb'].busy).toBe(false);
		expect(byPath['a.ipynb'].session_id).not.toBeNull();
		// The entry's id matches the live connection, and the two notebooks differ.
		expect(byPath['a.ipynb'].id).toBe(getKernelInfo(A).id);
		expect(byPath['a.ipynb'].id).not.toBe(byPath['b.ipynb'].id);
	});

	it('shutdown terminates one kernel, drops its entry, and leaves the other intact', async () => {
		const aBefore = currentSessionId(A);
		const info = await shutdownKernel(B);
		expect(info.status).toBe('not_started');
		// B is gone: no entry, no epoch, reads as not started.
		expect(new Set(loadedNotebookPaths())).toEqual(new Set([A]));
		expect(listKernels().map((k) => k.path)).toEqual(['a.ipynb']);
		expect(currentSessionId(B)).toBeNull();
		expect(getKernelInfo(B).started).toBe(false);
		// A is untouched — same live kernel, same epoch.
		expect(getKernelInfo(A).started).toBe(true);
		expect(currentSessionId(A)).toBe(aBefore);
	});

	it('shutdown of a notebook with no kernel is a no-op', async () => {
		const info = await shutdownKernel(B);
		expect(info.status).toBe('not_started');
		expect(loadedNotebookPaths()).toEqual([A]);
	});
});
