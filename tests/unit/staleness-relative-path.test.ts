/**
 * A notebook addressed by a WORKSPACE-RELATIVE path must name the SAME kernel as
 * its absolute form — the way the browser addresses everything.
 *
 * `kernel.ts`'s `kernels` Map is keyed by ABSOLUTE path, but `resolveNb` used to
 * pass its argument straight through, so a relative path became its own Map key and
 * missed every entry the run path had created. `notebook.ts` resolves its own `nb`
 * arguments, so `getNotebookStaleness('notebook.ipynb')` found the CELLS but not the
 * KERNEL: `currentSessionId` returned null, every cell reconciled against "no kernel
 * session", and the UI rendered `not run` on every cell forever — the flagship
 * staleness signal read dead for humans, while MCP (which addresses notebooks
 * absolutely) worked fine, so nothing pointed at the cause.
 *
 * These pin the contract `resolveNb`'s own docstring always claimed. They spin a
 * kernel up under the ABSOLUTE path and then interrogate it under the RELATIVE one,
 * so they fail against the pass-through version rather than passing vacuously on a
 * pair of nulls.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => {
	let seq = 0;
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
	return { makeFakeKernel, nextId: () => `kernel-${++seq}`, activeNb: '/ws/active.ipynb' };
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
	ServerConnection: { makeSettings: (o: unknown) => o }
}));

// The real resolver's contract: relative → absolute against the workspace root,
// idempotent on an already-absolute path.
vi.mock('../../src/lib/server/notebook', () => ({
	getActiveNotebookPath: () => h.activeNb,
	workspaceRelative: (abs: string) => abs.replace(/^\/ws\//, ''),
	resolveNotebookPath: (p: string) => (p.startsWith('/') ? p : `/ws/${p}`)
}));

vi.mock('../../src/lib/server/run-queue', () => ({ clearRunQueue: vi.fn() }));
vi.mock('../../src/lib/server/logs', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }));
vi.mock('../../src/lib/server/events', () => ({ publish: vi.fn(), publishGlobal: vi.fn() }));

import { execute, currentSessionId, getKernelInfo, listKernels } from '../../src/lib/server/kernel';

const ABS = '/ws/notebook.ipynb';
const REL = 'notebook.ipynb';
const noop = () => {};

describe('a relative notebook path names the same kernel as its absolute form', () => {
	beforeEach(async () => {
		// Start the kernel the way a run does: addressed ABSOLUTELY.
		await execute(ABS, 'x = 1', noop);
	});

	it('currentSessionId finds the absolute-keyed kernel under a relative path', () => {
		const abs = currentSessionId(ABS);
		expect(abs).not.toBeNull(); // guard: the kernel really did start
		// The regression: this used to be null, which is what made every cell read
		// `not_run` in the UI while the very same notebook was live.
		expect(currentSessionId(REL)).toBe(abs);
	});

	it('getKernelInfo reports the same live kernel under either spelling', () => {
		const abs = getKernelInfo(ABS);
		expect(abs.started).toBe(true);
		expect(getKernelInfo(REL)).toEqual(abs);
	});

	it('a relative path does NOT start a second kernel for the same notebook', async () => {
		const before = listKernels().length;
		await execute(REL, 'y = 2', noop);
		// Passing through verbatim gave `notebook.ipynb` its own Map entry — two
		// kernels, two namespaces, for one notebook.
		expect(listKernels()).toHaveLength(before);
	});

	it('resolution does not collapse a DIFFERENT notebook onto the active one', async () => {
		await execute('/ws/other.ipynb', 'z = 3', noop);
		expect(currentSessionId('other.ipynb')).toBe(currentSessionId('/ws/other.ipynb'));
		expect(currentSessionId('other.ipynb')).not.toBe(currentSessionId(ABS));
	});
});
