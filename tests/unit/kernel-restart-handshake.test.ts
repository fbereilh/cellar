/**
 * A kernel RESTART must end - usable, or refused with a reason - in bounded time.
 *
 * Reproduced end to end against a real Cellar under CPU load (repeated
 * `POST /api/kernel/restart` while the Variables panel polls): restarts hung for 30s
 * to 90s and beyond. Two separate ways in, each pinned here, plus the healthy path:
 *
 * 1. LOCK OWNERSHIP - the one actually seen. A Variables probe arriving while the
 *    restart is in flight took the exec lock (free at that moment) and was put on the
 *    wire to the DYING kernel. No reply ever came, and the post-restart startup
 *    injection waited behind it on the lock. The new kernel's shell was answering all
 *    along, so no shell-handshake guard could have caught it.
 * 2. SILENCE after the restart - the fresh-connection shell guard's question, asked of
 *    the restarted connection: the reconnect's `kernel_info_request` goes unanswered,
 *    or the handshake answers and the startup injection sent right after it is never
 *    acknowledged. Nothing bounded the injection's `future.done`.
 *
 * Driven through the REAL `kernel.ts` with only the Jupyter layer faked. The fake's
 * wire behaviour follows what was measured: `anyMessage` carries every send and
 * receive, a request to a dying or silent kernel gets no reply of any kind, and a
 * live kernel acknowledges an execute with an iopub `busy` before it replies.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

type Status = 'connecting' | 'connected' | 'disconnected';
type AnyListener = (sender: unknown, args: { msg: FakeMsg; direction: 'send' | 'recv' }) => void;
type Mock = ReturnType<typeof vi.fn>;

interface FakeMsg {
	channel: string;
	header: { msg_id: string; msg_type: string };
	parent_header: { msg_id?: string };
	content: Record<string, unknown>;
}

/**
 * The kernel process behind the connection. `dying` is the window a `restart()` opens
 * (the old process is going away); the rest describe the replacement.
 */
interface Kernel {
	phase: 'live' | 'dying';
	/** The replacement never answers a `kernel_info_request`. */
	silentShell: boolean;
	/** Drop this many executes on the floor (no busy, no reply) once live. */
	dropExecutes: number;
	/** Drop this many `kernel_info_request`s on the floor (the measured lost reconnect request). */
	dropKernelInfos: number;
}

interface FakeConnection {
	id: string;
	name: string;
	status: 'idle';
	connectionStatus: Status;
	connectionStatusChanged: { connect: Mock; disconnect: Mock };
	info: Promise<unknown>;
	anyMessage: { connect: (fn: AnyListener) => void; disconnect: (fn: AnyListener) => void };
	registerCommTarget: Mock;
	statusChanged: { connect: Mock; disconnect: Mock };
	iopubMessage: { connect: Mock };
	requestExecute: Mock;
	requestKernelInfo: Mock;
	restart: Mock;
	interrupt: Mock;
	shutdown: Mock;
	dispose: Mock;
	/** Every execute put on the wire, with the phase it was sent in. */
	sent: { code: string; phase: Kernel['phase']; answered: boolean }[];
	disposedFutures: number;
	proc: Kernel;
}

const h = vi.hoisted(() => {
	const connections: FakeConnection[] = [];
	let seq = 0;
	let msgSeq = 0;
	const nextId = () => `m${++msgSeq}`;
	/** How the NEXT restart's replacement process behaves. */
	const next = { silentShell: false, dropExecutes: 0, dropKernelInfos: 0, restartMs: 60 };

	function makeConnection(id: string): FakeConnection {
		const listeners = new Set<AnyListener>();
		const emit = (msg: FakeMsg, direction: 'send' | 'recv') => {
			for (const fn of [...listeners]) fn(conn, { msg, direction });
		};
		const msg = (channel: string, type: string, parent = '', content: Record<string, unknown> = {}): FakeMsg => ({
			channel,
			header: { msg_id: nextId(), msg_type: type },
			parent_header: parent ? { msg_id: parent } : {},
			content
		});
		const later = (fn: () => void) => setTimeout(fn, 1);

		/** Send a kernel_info_request as @jupyterlab does, answering it if the shell is alive. */
		const sendKernelInfo = () => {
			const req = msg('shell', 'kernel_info_request');
			emit(req, 'send');
			const { proc } = conn;
			if (proc.phase === 'dying' || proc.silentShell) return;
			if (proc.dropKernelInfos > 0) {
				proc.dropKernelInfos--;
				return;
			}
			later(() => emit(msg('shell', 'kernel_info_reply', req.header.msg_id), 'recv'));
		};

		const conn: FakeConnection = {
			id,
			name: 'python3',
			status: 'idle',
			connectionStatus: 'connected',
			connectionStatusChanged: { connect: vi.fn(), disconnect: vi.fn() },
			info: Promise.resolve({ status: 'ok' }),
			anyMessage: {
				connect: (fn) => void listeners.add(fn),
				disconnect: (fn) => void listeners.delete(fn)
			},
			registerCommTarget: vi.fn(),
			statusChanged: { connect: vi.fn(), disconnect: vi.fn() },
			iopubMessage: { connect: vi.fn() },
			requestExecute: vi.fn((args: { code: string }) => {
				const req = msg('shell', 'execute_request');
				emit(req, 'send');
				const { proc } = conn;
				const record = { code: args.code, phase: proc.phase, answered: false };
				conn.sent.push(record);
				let answer = proc.phase === 'live' && !proc.silentShell;
				if (answer && proc.dropExecutes > 0) {
					proc.dropExecutes--;
					answer = false;
				}
				const future = {
					msg: req,
					onIOPub: null as null | ((m: FakeMsg) => void),
					done: answer
						? new Promise((resolve) =>
								later(() => {
									emit(msg('iopub', 'status', req.header.msg_id, { execution_state: 'busy' }), 'recv');
									record.answered = true;
									later(() => resolve({ content: { status: 'ok', execution_count: 1 } }));
								})
							)
						: new Promise(() => {}),
					dispose: vi.fn(() => void conn.disposedFutures++)
				};
				return future;
			}),
			requestKernelInfo: vi.fn(async () => sendKernelInfo()),
			restart: vi.fn(async () => {
				// The old process goes away; anything sent now reaches nobody.
				conn.proc.phase = 'dying';
				await new Promise((r) => setTimeout(r, next.restartMs));
				conn.proc = {
					phase: 'live',
					silentShell: next.silentShell,
					dropExecutes: next.dropExecutes,
					dropKernelInfos: next.dropKernelInfos
				};
				// The socket reconnects and @jupyterlab asks for kernel_info, as it does.
				sendKernelInfo();
			}),
			interrupt: vi.fn(async () => {}),
			shutdown: vi.fn(async () => {}),
			dispose: vi.fn(),
			sent: [],
			disposedFutures: 0,
			proc: { phase: 'live', silentShell: false, dropExecutes: 0, dropKernelInfos: 0 }
		};
		connections.push(conn);
		return conn;
	}

	return {
		connections,
		next,
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
vi.mock('../../src/lib/server/databricks', () => ({
	databricksBound: () => false,
	reconnectAfterKernelRestart: async () => {}
}));

import { execute, restartKernel, kernelStatus, shutdownKernel } from '../../src/lib/server/kernel';

const NB = '/ws/a.ipynb';
const noop = () => {};
const HANDSHAKE_MS = 600;

/** Resolve to the value, or to 'hung' once `ms` passes. */
function within<T>(p: Promise<T>, ms: number): Promise<T | 'hung'> {
	return Promise.race([p, new Promise<'hung'>((r) => setTimeout(() => r('hung'), ms))]);
}

/** Start the notebook's kernel with an ordinary run and return its connection. */
async function started(): Promise<FakeConnection> {
	await execute(NB, 'x = 1', noop);
	const conn = h.connections.at(-1)!;
	conn.sent.length = 0;
	return conn;
}

beforeEach(async () => {
	process.env.CELLAR_WORKSPACE = '/ws';
	process.env.CELLAR_KERNEL_HANDSHAKE_TIMEOUT_MS = String(HANDSHAKE_MS);
	// The idle watchdog must not be what ends a hang here: it is a separate, slower
	// mechanism, and leaving it on would let a regression pass as a slow success.
	process.env.CELLAR_KERNEL_IDLE_TIMEOUT_MS = '0';
	Object.assign(h.next, { silentShell: false, dropExecutes: 0, dropKernelInfos: 0, restartMs: 60 });
	await shutdownKernel(NB).catch(() => {});
	h.connections.length = 0;
});

describe('a healthy restart', () => {
	it('completes promptly, re-injects once, and asks nothing extra', async () => {
		const conn = await started();
		const t0 = Date.now();
		const res = await within(restartKernel(NB), 4000);
		const ms = Date.now() - t0;
		expect(res).not.toBe('hung');
		// The restart itself takes restartMs (60); no bound was waited out on top of it.
		expect(ms).toBeLessThan(HANDSHAKE_MS);
		// The reconnect's own kernel_info reply was enough - no re-ask went out.
		expect(conn.requestKernelInfo).not.toHaveBeenCalled();
		expect(conn.sent.map((s) => s.phase)).toEqual(['live']);
		expect(conn.shutdown).not.toHaveBeenCalled();
		expect((await kernelStatus(NB)).status).not.toBe('not_started');
	});

	it('survives the reconnect kernel_info request being lost, by asking again', async () => {
		// MEASURED ~1 restart in 15 under load: the reconnect's request never reaches the
		// kernel while every later one is answered. One lost request is not a silent shell.
		h.next.dropKernelInfos = 1;
		const conn = await started();
		const res = await within(restartKernel(NB), 4000);
		expect(res).not.toBe('hung');
		expect(conn.requestKernelInfo).toHaveBeenCalled();
		expect(conn.shutdown).not.toHaveBeenCalled();
		expect(conn.sent.map((s) => s.phase)).toEqual(['live']);
	});
});

describe('a request arriving while the restart is in flight (the hang that was seen)', () => {
	it('queues behind the restart and reaches the NEW kernel, so the restart completes', async () => {
		h.next.restartMs = 80;
		const conn = await started();
		const restart = restartKernel(NB);
		// A Variables probe lands mid-restart, while the old process is going away.
		await new Promise((r) => setTimeout(r, 20));
		expect(conn.proc.phase).toBe('dying');
		const probe = execute(NB, 'print(1)', noop, { internal: true });

		expect(await within(restart, 4000)).not.toBe('hung');
		expect(await within(probe, 4000)).not.toBe('hung');
		// Nothing was sent to the dying process, and the startup code ran before the probe.
		expect(conn.sent.every((s) => s.phase === 'live')).toBe(true);
		expect(conn.sent.map((s) => s.code)).toHaveLength(2);
		expect(conn.sent[1].code).toBe('print(1)');
		expect(conn.shutdown).not.toHaveBeenCalled();
	});
});

describe('a restarted kernel that does not answer', () => {
	it('is refused in bounded time when its shell never answers, and is not left behind', async () => {
		h.next.silentShell = true;
		const conn = await started();
		const res = await within(
			restartKernel(NB).then(
				() => 'resolved',
				(e: Error) => e.message
			),
			2000
		);
		expect(res).not.toBe('hung');
		expect(res).toMatch(/restarted, but it did not answer on its shell channel/);
		expect(res).toMatch(/Run a cell to start a new kernel/);
		// It kept asking while it waited, and then shut the process down.
		expect(conn.requestKernelInfo).toHaveBeenCalled();
		expect(conn.shutdown).toHaveBeenCalled();
		// Nothing was sent into the silent shell, and the notebook has no kernel now.
		expect(conn.sent).toHaveLength(0);
		expect((await kernelStatus(NB)).status).toBe('not_started');
	});

	it('is refused in bounded time when the handshake answers but the startup code is never acknowledged', async () => {
		h.next.dropExecutes = 1;
		const conn = await started();
		const res = await within(
			restartKernel(NB).then(
				() => 'resolved',
				(e: Error) => e.message
			),
			2000
		);
		expect(res).not.toBe('hung');
		expect(res).toMatch(/restarted and answered on its shell channel, but it did not acknowledge Cellar's startup code/);
		// The unanswered future was released rather than left holding the exec lock.
		expect(conn.disposedFutures).toBe(1);
		expect(conn.shutdown).toHaveBeenCalled();
		expect((await kernelStatus(NB)).status).toBe('not_started');
	});

	it('leaves the notebook usable: the next run starts a fresh kernel', async () => {
		h.next.silentShell = true;
		const first = await started();
		await restartKernel(NB).catch(() => {});
		expect(await within(execute(NB, 'y = 2', noop), 4000)).not.toBe('hung');
		expect(h.connections.at(-1)).not.toBe(first);
	});
});
