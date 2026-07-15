/**
 * "Wipe variables" kernel op (`wipeKernelVariables`) — the Kernels-sidebar action
 * that frees a notebook's in-memory data variables WITHOUT restarting.
 *
 * The invariants proven here are the ones the feature stands on:
 *   1. it runs a delete-probe on the TARGET notebook's kernel and returns the
 *      names it cleared;
 *   2. it is NOT a restart — the kernel's `restart()` is never called and the
 *      session epoch is unchanged (so a live Databricks session, whose liveness is
 *      reconciled against the epoch, survives);
 *   3. it is isolated — another notebook's kernel is never touched (no probe runs
 *      on it, its epoch is unchanged);
 *   4. it never boots a kernel just to wipe it (a not-started notebook is a no-op);
 *   5. the `preserve` names (`spark`/`w` when Databricks is connected) are carried
 *      into the probe so they are kept.
 *
 * Only the Jupyter layer is faked (the real notebook + kernel + run-queue modules
 * run); the fake kernel answers the wipe probe with a canned `{"cleared":[...]}`
 * stdout line, exactly as ipykernel would.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const h = vi.hoisted(() => {
	let seq = 0;
	// Every executed code string, tagged with the kernel id that ran it — lets the
	// test assert WHICH kernel saw the wipe probe (isolation).
	const execLog: Array<{ id: string; code: string }> = [];
	function makeFuture(kernelId: string, code: string) {
		let resolveDone: (v: { content: { status: string; execution_count: number } }) => void = () => {};
		const f: {
			onIOPub: ((msg: unknown) => void) | null;
			onReply: ((msg: unknown) => void) | null;
			onStdin: ((msg: unknown) => void) | null;
			done: Promise<{ content: { status: string; execution_count: number } }>;
			dispose: ReturnType<typeof vi.fn>;
		} = {
			onIOPub: null,
			onReply: null,
			onStdin: null,
			done: undefined as unknown as Promise<{ content: { status: string; execution_count: number } }>,
			dispose: vi.fn()
		};
		f.done = new Promise((res) => {
			resolveDone = res;
		});
		// After execute() has wired up onIOPub, emit the wipe probe's stdout (if this
		// is the wipe probe), then resolve ok.
		queueMicrotask(() => {
			if (code.includes('_cellar_wipe')) {
				f.onIOPub?.({
					header: { msg_type: 'stream' },
					parent_header: {},
					content: { name: 'stdout', text: JSON.stringify({ cleared: ['df', 'arr'] }) }
				});
			}
			resolveDone({ content: { status: 'ok', execution_count: ++seq } });
		});
		return f;
	}
	function makeFakeKernel() {
		const id = `kernel-${++seq}`;
		return {
			id,
			name: 'python3',
			status: 'idle' as const,
			commsOverSubshells: undefined as unknown,
			registerCommTarget: vi.fn(),
			statusChanged: { connect: vi.fn(), disconnect: vi.fn() },
			iopubMessage: { connect: vi.fn() },
			requestExecute: (args: { code?: string }) => {
				const code = typeof args?.code === 'string' ? args.code : '';
				execLog.push({ id, code });
				return makeFuture(id, code);
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
		execLog,
		// The most recent kernel per id (to inspect its restart mock).
		kernels: new Map<string, ReturnType<typeof makeFakeKernel>>()
	};
});

vi.mock('@jupyterlab/services', () => ({
	KernelManager: class {
		ready = Promise.resolve();
		startNew = async () => {
			const k = h.makeFakeKernel();
			h.kernels.set(k.id, k);
			return k;
		};
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
let kernelmod: typeof import('../../src/lib/server/kernel');

const A = 'wipe-a.ipynb';
const B = 'wipe-b.ipynb';
const absA = () => nbmod.resolveNotebookPath(A);
const absB = () => nbmod.resolveNotebookPath(B);
const noop = () => {};

/** The kernel object currently backing a notebook (to inspect its restart mock). */
function kernelOf(nbAbs: string) {
	const id = kernelmod.kernelStatus(nbAbs).id;
	return id ? h.kernels.get(id) : undefined;
}

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-wipe-'));
	process.env.CELLAR_WORKSPACE = WS;
	nbmod = await import('../../src/lib/server/notebook');
	kernelmod = await import('../../src/lib/server/kernel');
	nbmod.createNotebook(A, null, { focus: false });
	nbmod.createNotebook(B, null, { focus: false });
});

describe('wipeKernelVariables', () => {
	it('clears the target kernel, keeps it alive (no restart, same epoch), and reports the names', async () => {
		// Boot both kernels with a run so each has a live session/epoch.
		await kernelmod.execute(absA(), 'df = 1', noop);
		await kernelmod.execute(absB(), 'y = 2', noop);
		const epochA = kernelmod.currentSessionId(absA());
		const epochB = kernelmod.currentSessionId(absB());
		expect(epochA).not.toBeNull();
		expect(epochB).not.toBeNull();
		const kA = kernelOf(absA())!;
		const kB = kernelOf(absB())!;
		h.execLog.length = 0;

		const res = await kernelmod.wipeKernelVariables(absA(), { preserve: ['spark', 'w'] });

		// It reported what it cleared and stayed on the same live session.
		expect(res.cleared).toEqual(['df', 'arr']);
		expect(res.session_id).toBe(epochA);
		expect(res.probe_failed).toBeUndefined();

		// NOT a restart: the epoch is unchanged and restart() was never called.
		expect(kernelmod.currentSessionId(absA())).toBe(epochA);
		expect(kA.restart).not.toHaveBeenCalled();

		// Isolation: the wipe probe ran ONLY on A's kernel; B's kernel saw nothing and
		// keeps its epoch.
		const wipeRuns = h.execLog.filter((e) => e.code.includes('_cellar_wipe'));
		expect(wipeRuns.length).toBe(1);
		expect(wipeRuns[0].id).toBe(kA.id);
		expect(h.execLog.some((e) => e.id === kB.id)).toBe(false);
		expect(kernelmod.currentSessionId(absB())).toBe(epochB);
		expect(kB.restart).not.toHaveBeenCalled();
	});

	it('carries the preserve names into the probe so spark/w are kept', async () => {
		h.execLog.length = 0;
		await kernelmod.wipeKernelVariables(absA(), { preserve: ['spark', 'w'] });
		const probe = h.execLog.find((e) => e.code.includes('_cellar_wipe'))!;
		// The preserve list is injected as a JSON literal the probe adds to `_keep`.
		expect(probe.code).toContain('["spark","w"]');
	});

	it('is a no-op on a notebook whose kernel never started (never boots one)', async () => {
		const C = 'wipe-c.ipynb';
		nbmod.createNotebook(C, null, { focus: false });
		const absC = nbmod.resolveNotebookPath(C);
		expect(kernelmod.kernelStatus(absC).status).toBe('not_started');

		const res = await kernelmod.wipeKernelVariables(absC, { preserve: [] });
		expect(res).toEqual({ status: 'not_started', cleared: [], session_id: null });
		// Still not started — the wipe did not force a kernel into existence.
		expect(kernelmod.kernelStatus(absC).status).toBe('not_started');
	});
});
