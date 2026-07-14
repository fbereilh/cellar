/**
 * Per-notebook MCP kernel tools (kernel-per-notebook, Phase 5).
 *
 * Each MCP session pins its own working notebook (#99's targetFor), and each
 * notebook has its OWN kernel. So the kernel tools — restart_kernel,
 * interrupt_kernel, kernel_status, kernel_state, list_variables, run_queue —
 * resolve to the CALLING session's working notebook: an agent's restart clears
 * only its own namespace, never the user's or another agent's. These drive the
 * REAL service + notebook + run-queue + kernel manager against a scratch
 * workspace, with only the Jupyter layer faked (each startNew yields a distinct
 * kernel; every execute emits one `{}` stdout line so a probe parses cleanly).
 *
 * server.ts wires every tool as `targetOf(extra, notebook) = targetFor(sessionId,
 * notebook)`, so calling the service with `targetFor(sessionId)` reproduces
 * exactly what the transport does for a pinned agent.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
			requestExecute: () => {
				const future: { onIOPub: ((msg: unknown) => void) | null; done: Promise<unknown> } = {
					onIOPub: null,
					done: undefined as unknown as Promise<unknown>
				};
				future.done = new Promise((resolve) => {
					queueMicrotask(() => {
						future.onIOPub?.({ header: { msg_type: 'stream' }, parent_header: {}, content: { name: 'stdout', text: '{}' } });
						resolve({ content: { status: 'ok', execution_count: 1 } });
					});
				});
				return future;
			},
			restart: vi.fn(async () => {}),
			interrupt: vi.fn(async () => {}),
			shutdown: vi.fn(async () => {})
		};
	}
	return { startNew: vi.fn(async () => makeFakeKernel()) };
});

vi.mock('@jupyterlab/services', () => ({
	KernelManager: class {
		ready = Promise.resolve();
		startNew = h.startNew;
		dispose = vi.fn();
	},
	ServerConnection: { makeSettings: (o: unknown) => o }
}));

vi.mock('../../src/lib/server/dataflow', async () => {
	const { currentSessionId } = await import('../../src/lib/server/kernel');
	return {
		getNotebookStaleness: async (nb?: string | null) => ({ sid: currentSessionId(nb), cells: {} }),
		analyzeDataflow: async () => ({})
	};
});

vi.mock('../../src/lib/server/logs', () => ({
	logInfo: vi.fn(),
	logWarn: vi.fn(),
	logError: vi.fn()
}));

let WS: string;
let svc: typeof import('../../src/lib/server/mcp/service');
let nbmod: typeof import('../../src/lib/server/notebook');
let kern: typeof import('../../src/lib/server/kernel');

const A = 'agent-a.ipynb';
const B = 'agent-b.ipynb';
const absA = () => nbmod.resolveNotebookPath(A);
const absB = () => nbmod.resolveNotebookPath(B);

// Mirror server.ts's `targetOf(extra) = targetFor(sessionId)` for a pinned agent.
const targetA = () => svc.targetFor('sessA');
const targetB = () => svc.targetFor('sessB');

async function addAndRun(rel: string, source: string): Promise<string> {
	const abs = nbmod.resolveNotebookPath(rel);
	const { ids } = await svc.addCells([{ cell_type: 'code', source }], null, { nb: abs, routeImports: false });
	await svc.runCell(ids[0], abs);
	return ids[0];
}

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-mcp-kern-'));
	process.env.CELLAR_WORKSPACE = WS;
	svc = await import('../../src/lib/server/mcp/service');
	nbmod = await import('../../src/lib/server/notebook');
	kern = await import('../../src/lib/server/kernel');
	nbmod.createNotebook(A, null, { focus: false });
	nbmod.createNotebook(B, null, { focus: false });
	// The USER is looking at A; agent B must still resolve to B, never the active tab.
	nbmod.setActiveNotebook(A);
	// Two agents pin two different working notebooks.
	svc.useNotebook('sessA', A);
	svc.useNotebook('sessB', B);
});

describe('MCP kernel tools resolve to the calling session\'s working notebook', () => {
	it('two sessions pin two notebooks with distinct live kernels', async () => {
		await addAndRun(A, 'a = 1');
		await addAndRun(B, 'b = 1');
		expect(targetA()).toBe(absA());
		expect(targetB()).toBe(absB());
		expect(kern.currentSessionId(absA())).not.toBeNull();
		expect(kern.currentSessionId(absB())).not.toBeNull();
		expect(kern.currentSessionId(absA())).not.toBe(kern.currentSessionId(absB()));
	});

	it('kernel_status reflects the calling session\'s own notebook', () => {
		const stA = svc.kernel.status(targetA()) as { session_id: number | null };
		const stB = svc.kernel.status(targetB()) as { session_id: number | null };
		expect(stA.session_id).toBe(kern.currentSessionId(absA()));
		expect(stB.session_id).toBe(kern.currentSessionId(absB()));
		expect(stA.session_id).not.toBe(stB.session_id);
	});

	it('kernel_state reflects the calling session\'s own notebook epoch', async () => {
		const stateA = (await svc.getKernelState(targetA())) as { session_id: number | null };
		const stateB = (await svc.getKernelState(targetB())) as { session_id: number | null };
		expect(stateA.session_id).toBe(kern.currentSessionId(absA()));
		expect(stateB.session_id).toBe(kern.currentSessionId(absB()));
	});

	it('an agent\'s restart_kernel clears ONLY its working notebook', async () => {
		const aBefore = kern.currentSessionId(absA());
		const bBefore = kern.currentSessionId(absB());

		// Agent A restarts — through its own resolved target, exactly as the tool does.
		await svc.kernel.restart(targetA());

		// A got a fresh epoch; B is completely untouched.
		expect(kern.currentSessionId(absA())).not.toBe(aBefore);
		expect(kern.currentSessionId(absB())).toBe(bBefore);

		// The status tools now report the split honestly per notebook.
		const stB = svc.kernel.status(targetB()) as { session_id: number | null };
		expect(stB.session_id).toBe(bBefore);
	});

	it('run_queue returns a per-notebook map keyed by the caller\'s working notebook', async () => {
		// Idle (all runs finished): the map is empty but `working` names the caller's nb.
		const qA = svc.getRunQueue('sessA') as { working: string; notebooks: Record<string, unknown> };
		const qB = svc.getRunQueue('sessB') as { working: string; notebooks: Record<string, unknown> };
		expect(qA.working).toBe(A);
		expect(qB.working).toBe(B);
		expect(qA.notebooks).toEqual({});
	});

	it('run_queue shows each notebook\'s own queue, keyed by relative path', async () => {
		// Populate B's queue behind an active run using the queue primitive directly,
		// so the snapshot has deterministic contents (no reliance on run timing).
		const rq = await import('../../src/lib/server/run-queue');
		const active = rq.enqueueRun({ nb: absB(), cellId: 'c1', actor: 'agent', source: '' });
		expect(active.duplicate).toBe(false);
		const waiting = rq.enqueueRun({ nb: absB(), cellId: 'c2', actor: 'user', source: '' });

		const q = svc.getRunQueue('sessB') as {
			working: string;
			notebooks: Record<string, { running: { cellId: string } | null; queue: { cellId: string; position: number }[] }>;
		};
		expect(q.notebooks[B]?.running?.cellId).toBe('c1');
		expect(q.notebooks[B]?.queue).toEqual([{ nb: absB(), cellId: 'c2', actor: 'user', position: 1 }]);
		// A has nothing queued, so it is absent from the map.
		expect(q.notebooks[A]).toBeUndefined();

		// Clean up the queue entries.
		if (!waiting.duplicate) waiting.cancel();
		if (!active.duplicate) active.done();
	});
});
