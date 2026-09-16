/**
 * A fresh kernel connection whose SHELL never answers must not wedge the first run.
 *
 * Reproduced in CI and locally under CPU contention: the websocket to a just-started
 * kernel opens, iopub traffic flows, but the `kernel_info_request` @jupyterlab sends on
 * connect gets no reply - and neither does anything sent after it on that connection.
 * The startup injection went into that dead pipe, its `future.done` never settled, and
 * the user's run sat in `getKernel` until the client gave up (`POST .../run` timing out
 * at 120s in `notebook-roots-worktree.spec.ts`).
 *
 * Driven through the REAL `kernel.ts` with only the Jupyter layer faked. A "dead"
 * connection here behaves exactly as measured: it opens, and nothing sent on it is
 * ever answered.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

type Status = 'connecting' | 'connected' | 'disconnected';
type StatusListener = (sender: unknown, s: Status) => void;
type Mock = ReturnType<typeof vi.fn>;

interface FakeConnection {
	id: string;
	name: string;
	status: 'idle';
	dead: boolean;
	executed: string[];
	isDisposed: boolean;
	connectionStatus: Status;
	connectionStatusChanged: { connect: (fn: StatusListener) => void; disconnect: (fn: StatusListener) => void };
	info: Promise<unknown>;
	registerCommTarget: Mock;
	statusChanged: { connect: Mock; disconnect: Mock };
	iopubMessage: { connect: Mock };
	requestExecute: Mock;
	restart: Mock;
	interrupt: Mock;
	shutdown: Mock;
	dispose: Mock;
}

const h = vi.hoisted(() => {
	const connections: FakeConnection[] = [];
	/** How many of the connections made so far have a dead shell (in creation order). */
	const plan = { deadConnections: 0 };
	let seq = 0;

	function makeConnection(id: string): FakeConnection {
		const dead = connections.length < plan.deadConnections;
		const listeners = new Set<StatusListener>();
		const executed: string[] = [];
		const conn: FakeConnection = {
			id,
			name: 'python3',
			status: 'idle',
			dead,
			executed,
			isDisposed: false,
			connectionStatus: 'connecting',
			connectionStatusChanged: {
				connect: (fn) => void listeners.add(fn),
				disconnect: (fn) => void listeners.delete(fn)
			},
			// Resolved by the connect-time kernel_info_reply - which a dead shell never sends.
			info: dead ? new Promise(() => {}) : Promise.resolve({ status: 'ok' }),
			registerCommTarget: vi.fn(),
			statusChanged: { connect: vi.fn(), disconnect: vi.fn() },
			iopubMessage: { connect: vi.fn() },
			requestExecute: vi.fn((args: { code: string }) => {
				executed.push(args.code);
				return {
					onIOPub: null,
					done: dead ? new Promise(() => {}) : Promise.resolve({ content: { status: 'ok', execution_count: 1 } })
				};
			}),
			restart: vi.fn(async () => {}),
			interrupt: vi.fn(async () => {}),
			shutdown: vi.fn(async () => {}),
			dispose: vi.fn(() => {
				conn.isDisposed = true;
			})
		};
		connections.push(conn);
		// The websocket opens a moment after the connection object exists, as it does.
		setTimeout(() => {
			conn.connectionStatus = 'connected';
			for (const fn of [...listeners]) fn(conn, 'connected');
		}, 5);
		return conn;
	}

	return {
		connections,
		plan,
		startNew: vi.fn(async () => makeConnection(`kernel-${++seq}`)),
		connectTo: vi.fn(({ model }: { model: { id: string } }) => makeConnection(model.id))
	};
});

vi.mock('@jupyterlab/services', () => ({
	KernelManager: class {
		ready = Promise.resolve();
		startNew = h.startNew;
		connectTo = h.connectTo;
		dispose = vi.fn();
	},
	ServerConnection: { makeSettings: (o: unknown) => o }
}));
vi.mock('../../src/lib/server/notebook', () => ({
	getActiveNotebookPath: () => '/ws/a.ipynb',
	workspaceRelative: (abs: string) => abs.replace(/^\/ws\//, ''),
	resolveNotebookPath: (p: string) => (p.startsWith('/') ? p : `/ws/${p}`),
	getNotebookRoot: () => null
}));
vi.mock('../../src/lib/server/notebookRoot', () => ({ notebookRoot: () => null }));
vi.mock('../../src/lib/server/run-queue', () => ({ clearRunQueue: vi.fn() }));
vi.mock('../../src/lib/server/logs', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }));

import { execute, shutdownKernel } from '../../src/lib/server/kernel';

const NB = '/ws/a.ipynb';
const noop = () => {};

beforeEach(async () => {
	process.env.CELLAR_WORKSPACE = '/ws';
	process.env.CELLAR_KERNEL_HANDSHAKE_TIMEOUT_MS = '40';
	h.connections.length = 0;
	h.startNew.mockClear();
	h.connectTo.mockClear();
});

describe('a fresh connection whose shell never answers', () => {
	it('is replaced before anything is sent, and the run completes on the replacement', async () => {
		h.plan.deadConnections = 1;
		const settled = await Promise.race([
			execute(NB, 'x = 1', noop).then(() => 'settled'),
			new Promise((r) => setTimeout(() => r('hung'), 3000))
		]);
		expect(settled).toBe('settled');

		const [dead, live] = h.connections;
		// Nothing was put into the dead pipe - not even the startup injection.
		expect(dead.executed).toEqual([]);
		// Replacing the CONNECTION must never take the kernel with it.
		expect(dead.dispose).toHaveBeenCalled();
		expect(dead.shutdown).not.toHaveBeenCalled();
		// The replacement reconnects to the SAME kernel and carries the user's code.
		expect(h.connectTo).toHaveBeenCalledWith({ model: { id: dead.id, name: 'python3' } });
		expect(live.id).toBe(dead.id);
		expect(live.executed).toContain('x = 1');
		await shutdownKernel(NB);
	});

	it('refuses the start with a named reason, and shuts the kernel down, when no connection ever answers', async () => {
		h.plan.deadConnections = 99;
		const outcome = await Promise.race([
			execute(NB, 'x = 1', noop).then(
				() => 'resolved',
				(err: Error) => err.message
			),
			new Promise((r) => setTimeout(() => r('hung'), 3000))
		]);
		expect(outcome).toMatch(/did not answer on its shell channel over 3 fresh connections/);
		expect(h.connections).toHaveLength(3);
		expect(h.connections.every((c) => c.executed.length === 0)).toBe(true);
		// The process is not leaked behind the refusal.
		expect(h.connections[2].shutdown).toHaveBeenCalled();

		// And the failed start does not stick: the next run starts a kernel afresh.
		h.plan.deadConnections = 0;
		h.connections.length = 0;
		await execute(NB, 'y = 2', noop);
		expect(h.connections[0].executed).toContain('y = 2');
		await shutdownKernel(NB);
	});

	it('costs a healthy start nothing: one connection, no replacement', async () => {
		h.plan.deadConnections = 0;
		await execute(NB, 'z = 3', noop);
		expect(h.startNew).toHaveBeenCalledTimes(1);
		expect(h.connectTo).not.toHaveBeenCalled();
		expect(h.connections[0].dispose).not.toHaveBeenCalled();
		await shutdownKernel(NB);
	});
});
