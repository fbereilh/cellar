/**
 * Editor introspection over Jupyter's SHELL channel: `complete_request` (Tab
 * completion that knows the live namespace) and `inspect_request` (the Shift+Tab
 * documentation tooltip).
 *
 * Driven against the REAL `kernel.ts` with only the Jupyter layer faked, because
 * the load-bearing claims are all about what this code does to the KERNEL MANAGER
 * rather than about parsing a reply:
 *
 *   - it never STARTS a kernel (a keystroke must not boot a Python process),
 *   - it never EXECUTES code (the whole architectural decision: an execute probe
 *     would run user-visible code at keystroke frequency AND hold the per-kernel
 *     exec lock, so the user's next RUN would park behind a tooltip),
 *   - it refuses a kernel that cannot answer NOW - busy, restarting, dead,
 *     disconnected - by name rather than queueing behind it, which is the whole of
 *     "neither feature blocks or breaks while a cell is running",
 *   - and it is bounded even so, because the busy check is a check-then-send.
 *
 * The timeout is driven to 120ms via CELLAR_KERNEL_INTROSPECT_TIMEOUT_MS so the
 * bound is observable in-test; production defaults to 3s.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const h = vi.hoisted(() => {
	function makeFakeKernel() {
		const k = {
			id: 'kernel-introspect-1',
			name: 'python3',
			status: 'idle' as string,
			connectionStatus: 'connected' as string,
			commsOverSubshells: undefined as unknown,
			registerCommTarget: vi.fn(),
			statusChanged: { connect: vi.fn(), disconnect: vi.fn() },
			iopubMessage: { connect: vi.fn() },
			requestExecute: () => {
				h.executes += 1;
				let done!: (v: unknown) => void;
				const f = {
					onIOPub: null as ((m: unknown) => void) | null,
					onReply: null,
					onStdin: null,
					done: new Promise((res) => {
						done = res;
					}),
					dispose: vi.fn()
				};
				const settle = () => done({ content: { status: 'ok', execution_count: 1 } });
				// `holdExecute` lets a test keep an execute IN FLIGHT, which is the only
				// way to hold the per-kernel exec lock and so the only way to drive the
				// "Cellar is busy with its own work" signal the idle wait now follows.
				if (h.holdExecute) void h.holdExecute.then(settle);
				else queueMicrotask(settle);
				return f;
			},
			requestComplete: vi.fn(async (content: { code: string; cursor_pos: number }) => {
				h.completeCalls.push(content);
				return h.completeReply(content);
			}),
			requestInspect: vi.fn(async (content: { code: string; cursor_pos: number; detail_level: number }) => {
				h.inspectCalls.push(content);
				return h.inspectReply(content);
			}),
			restart: vi.fn(async () => {}),
			interrupt: vi.fn(async () => {}),
			shutdown: vi.fn(async () => {}),
			reconnect: vi.fn(async () => {}),
			dispose: vi.fn()
		};
		h.lastKernel = k;
		return k;
	}
	return {
		makeFakeKernel,
		startNew: vi.fn(async () => makeFakeKernel()),
		starts: 0,
		executes: 0,
		lastKernel: null as ReturnType<typeof makeFakeKernel> | null,
		holdExecute: null as Promise<void> | null,
		completeCalls: [] as { code: string; cursor_pos: number }[],
		inspectCalls: [] as { code: string; cursor_pos: number; detail_level: number }[],
		completeReply: (() => ({
			content: { status: 'ok', matches: [], cursor_start: 0, cursor_end: 0, metadata: {} }
		})) as (c: { code: string; cursor_pos: number }) => unknown | Promise<unknown>,
		inspectReply: (() => ({ content: { status: 'ok', found: false, data: {}, metadata: {} } })) as (c: {
			code: string;
			cursor_pos: number;
			detail_level: number;
		}) => unknown | Promise<unknown>
	};
});

vi.mock('@jupyterlab/services', () => ({
	KernelManager: class {
		ready = Promise.resolve();
		startNew = (...args: unknown[]) => {
			h.starts += 1;
			return h.startNew(...(args as []));
		};
		runningChanged = { connect: vi.fn() };
		running() {
			return [][Symbol.iterator]();
		}
		dispose = vi.fn();
	},
	ServerConnection: { makeSettings: (o: unknown) => o },
	CommsOverSubshells: { Disabled: 'disabled' },
	KernelAPI: { getKernelModel: vi.fn(async () => ({ execution_state: 'idle' })), interruptKernel: vi.fn(async () => {}) }
}));

vi.mock('../../src/lib/server/logs', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }));

let WS: string;
let nbmod: typeof import('../../src/lib/server/notebook');
let kernelmod: typeof import('../../src/lib/server/kernel');
let queue: typeof import('../../src/lib/server/run-queue');

const NB = 'introspect.ipynb';
const abs = () => nbmod.resolveNotebookPath(NB);

/** The timeout this suite runs with, mirrored from the env below. */
const TIMEOUT_MS = 120;
/** The internal-probe idle wait this suite runs with, likewise mirrored. */
const IDLE_WAIT_MS = 200;

/** Timer slack, so a wall-clock lower bound is not a flake on a contended machine. */
const INTROSPECT_SLACK_MS = 20;

/** The bound cellar SHIPS with, mirrored from kernel.ts's `introspectIdleWaitMs`. */
const SHIPPED_IDLE_WAIT_MS = 3000;

/** Bring the notebook's kernel up the ordinary way: by running something in it. */
async function startKernel(): Promise<void> {
	await kernelmod.execute(abs(), 'pass', () => {});
}

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-introspect-'));
	process.env.CELLAR_WORKSPACE = WS;
	process.env.CELLAR_KERNEL_INTROSPECT_TIMEOUT_MS = String(TIMEOUT_MS);
	process.env.CELLAR_KERNEL_INTROSPECT_IDLE_WAIT_MS = String(IDLE_WAIT_MS);
	// The watchdog must never be what ends a test here.
	process.env.CELLAR_KERNEL_IDLE_TIMEOUT_MS = '0';
	nbmod = await import('../../src/lib/server/notebook');
	kernelmod = await import('../../src/lib/server/kernel');
	queue = await import('../../src/lib/server/run-queue');
	nbmod.createNotebook(NB, null, { focus: false });
	nbmod.setActiveNotebook(NB);
});

beforeEach(() => {
	h.completeCalls = [];
	h.inspectCalls = [];
	h.completeReply = () => ({
		content: { status: 'ok', matches: [], cursor_start: 0, cursor_end: 0, metadata: {} }
	});
	h.inspectReply = () => ({ content: { status: 'ok', found: false, data: {}, metadata: {} } });
	if (h.lastKernel) {
		h.lastKernel.status = 'idle';
		h.lastKernel.connectionStatus = 'connected';
	}
});

describe('the routes answer a malformed request in their OWN shape', () => {
	type RoutePost = (e: { request: Request }) => Promise<Response>;

	/** POST a body to a route handler, exactly as SvelteKit would. */
	async function post(handler: RoutePost, body: unknown) {
		const res = await handler({
			request: new Request('http://localhost/api/kernel/x', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			})
		});
		return { status: res.status, body: (await res.json()) as Record<string, unknown> };
	}

	async function routePost(route: 'complete' | 'inspect'): Promise<RoutePost> {
		const mod =
			route === 'complete'
				? await import('../../src/routes/api/kernel/complete/+server.js')
				: await import('../../src/routes/api/kernel/inspect/+server.js');
		return mod.POST as unknown as RoutePost;
	}

	it('refuses a path that escapes the workspace with a 400, not an unhandled 500', async () => {
		// `resolveNotebookPath` THROWS for such a path. Left uncaught it escaped as a
		// generic 500, which says nothing the client can read - and these routes promise
		// that a kernel REFUSAL is a 200 `{ok:false, reason}` while only a MALFORMED
		// request is a 4xx, so an escaping path belongs on the 4xx side with the reason.
		const escaping = { path: '../../elsewhere.ipynb', code: 'x', cursorPos: 1 };
		const complete = await routePost('complete');
		const inspect = await routePost('inspect');

		const c = await post(complete, escaping);
		expect(c.status).toBe(400);
		expect(c.body).toMatchObject({ ok: false, reason: 'failed' });
		expect(String(c.body.message)).toContain('escapes workspace');

		const i = await post(inspect, { ...escaping, detail: 0 });
		expect(i.status).toBe(400);
		expect(i.body).toMatchObject({ ok: false, reason: 'failed' });
		expect(String(i.body.message)).toContain('escapes workspace');
	});

	it('still answers a VALID request as a 200 kernel verdict', async () => {
		// The guard must not turn every failure into a 400: with no kernel for this
		// notebook the honest answer is still a 200 the editor reads as "no kernel
		// completions" and falls back from.
		const res = await post(await routePost('complete'), { path: 'never-opened.ipynb', code: 'x', cursorPos: 1 });
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ ok: false, reason: 'no_kernel' });
	});
});

describe('a keystroke never boots a kernel', () => {
	it('refuses `no_kernel` for a notebook that has none, and starts nothing', async () => {
		const startsBefore = h.starts;
		expect(await kernelmod.completeInKernel(abs(), 'myva', 4)).toEqual({ ok: false, reason: 'no_kernel' });
		expect(await kernelmod.inspectInKernel(abs(), 'len(', 4, 0)).toEqual({ ok: false, reason: 'no_kernel' });
		expect(h.starts).toBe(startsBefore);
	});
});

describe('a live, idle kernel answers', () => {
	beforeAll(async () => {
		await startKernel();
	});

	it('returns the kernel’s own matches, types and replacement range', async () => {
		h.completeReply = () => ({
			content: {
				status: 'ok',
				matches: ['pardir', 'path', 'pathsep'],
				cursor_start: 3,
				cursor_end: 5,
				metadata: {
					_jupyter_types_experimental: [
						{ text: 'pardir', type: 'instance' },
						{ text: 'path', type: 'module' },
						{ text: 'pathsep', type: 'instance' }
					]
				}
			}
		});
		const out = await kernelmod.completeInKernel(abs(), 'os.pa', 5);
		expect(out).toEqual({
			ok: true,
			matches: [
				{ text: 'pardir', type: 'instance' },
				{ text: 'path', type: 'module' },
				{ text: 'pathsep', type: 'instance' }
			],
			// The PROTOCOL's own replacement range, passed through verbatim. It is the
			// thing a file-only completer has to guess at, so re-deriving a word
			// boundary here would throw away the whole point of asking.
			cursorStart: 3,
			cursorEnd: 5
		});
		expect(h.completeCalls).toEqual([{ code: 'os.pa', cursor_pos: 5 }]);
	});

	it('EXECUTES NOTHING - the architectural claim, not a detail', async () => {
		const before = h.executes;
		await kernelmod.completeInKernel(abs(), 'os.pa', 5);
		await kernelmod.inspectInKernel(abs(), 'len(', 4, 0);
		// An `execute()` probe would have run code in the user's namespace here AND
		// taken this kernel's exec lock, parking the next real run behind a tooltip.
		expect(h.executes).toBe(before);
		expect(h.lastKernel?.requestComplete).toHaveBeenCalled();
		expect(h.lastKernel?.requestInspect).toHaveBeenCalled();
	});

	it('pairs types by TEXT, so a partial or reordered metadata list cannot mislabel', async () => {
		h.completeReply = () => ({
			content: {
				status: 'ok',
				matches: ['alpha', 'beta', 'gamma'],
				cursor_start: 0,
				cursor_end: 1,
				// Shorter than `matches` and in a different order: pairing by INDEX would
				// call `alpha` a function and `beta` a module.
				metadata: { _jupyter_types_experimental: [{ text: 'gamma', type: 'function' }, { text: 'beta', type: 'module' }] }
			}
		});
		const out = await kernelmod.completeInKernel(abs(), 'a', 1);
		expect(out).toMatchObject({
			matches: [
				{ text: 'alpha', type: null },
				{ text: 'beta', type: 'module' },
				{ text: 'gamma', type: 'function' }
			]
		});
	});

	it('reports no types at all for a kernel that sends no metadata', async () => {
		h.completeReply = () => ({
			content: { status: 'ok', matches: ['x_from_other_kernel'], cursor_start: 0, cursor_end: 1 }
		});
		const out = await kernelmod.completeInKernel(abs(), 'x', 1);
		expect(out).toMatchObject({ ok: true, matches: [{ text: 'x_from_other_kernel', type: null }] });
	});

	it('strips ANSI from the inspect text and echoes the detail level it answered at', async () => {
		h.inspectReply = (c) => ({
			content: {
				status: 'ok',
				found: true,
				data: { 'text/plain': `[31mSignature:[39m f(a)\nlevel=${c.detail_level}` },
				metadata: {}
			}
		});
		expect(await kernelmod.inspectInKernel(abs(), 'f(', 2, 0)).toEqual({
			ok: true,
			found: true,
			text: 'Signature: f(a)\nlevel=0',
			detail: 0
		});
		expect(await kernelmod.inspectInKernel(abs(), 'f(', 2, 1)).toEqual({
			ok: true,
			found: true,
			text: 'Signature: f(a)\nlevel=1',
			detail: 1
		});
		// The WHOLE cell source and the caret go to the kernel: IPython's own
		// `token_at_cursor` is what finds the callable from inside a call's arguments.
		expect(h.inspectCalls.map((c) => c.detail_level)).toEqual([0, 1]);
		expect(h.inspectCalls[0]).toMatchObject({ code: 'f(', cursor_pos: 2 });
	});

	it('reports `found: false` as an ANSWER, never as a refusal', async () => {
		h.inspectReply = () => ({ content: { status: 'ok', found: false, data: {}, metadata: {} } });
		expect(await kernelmod.inspectInKernel(abs(), 'nosuch(', 7, 0)).toEqual({
			ok: true,
			found: false,
			text: '',
			detail: 0
		});
	});

	it('joins a multi-line `text/plain` the way every other nbformat reader does', async () => {
		h.inspectReply = () => ({
			content: { status: 'ok', found: true, data: { 'text/plain': ['line one\n', 'line two'] }, metadata: {} }
		});
		expect(await kernelmod.inspectInKernel(abs(), 'f(', 2, 0)).toMatchObject({ text: 'line one\nline two' });
	});
});

describe('a kernel that cannot answer now is REFUSED, not queued behind', () => {
	beforeAll(async () => {
		await startKernel();
	});

	it('refuses `busy` from the RUN QUEUE’s own truth, without sending anything', async () => {
		// A run claims the kernel synchronously at dequeue while jupyter's idle->busy
		// flip lands a beat later, so the queue is the earlier signal - reading only
		// the status leaves a window where the request goes into the back of a cell
		// that has already started.
		const ticket = queue.enqueueRun({ nb: abs(), cellId: 'c1', actor: 'user', source: 'x' });
		if (ticket.duplicate) throw new Error('unreachable: fresh ticket expected');
		await ticket.wait();
		try {
			expect(await kernelmod.completeInKernel(abs(), 'myva', 4)).toEqual({ ok: false, reason: 'busy' });
			expect(await kernelmod.inspectInKernel(abs(), 'len(', 4, 0)).toEqual({ ok: false, reason: 'busy' });
			expect(h.completeCalls).toEqual([]);
			expect(h.inspectCalls).toEqual([]);
		} finally {
			ticket.done();
		}
	});

	it('WAITS OUT Cellar’s own internal probe rather than refusing - the run-then-type case', async () => {
		// The variable inspector fires an `execute({internal:true})` on `run:end`, so
		// jupyter reports `busy` for tens of milliseconds at exactly the moment a user
		// types a name the run just defined. Refusing there is a DEAD END, not a delay:
		// CodeMirror does not re-run a completion source by itself.
		h.lastKernel!.status = 'busy';
		setTimeout(() => (h.lastKernel!.status = 'idle'), 40);
		h.completeReply = () => ({
			content: { status: 'ok', matches: ['after_probe'], cursor_start: 0, cursor_end: 4, metadata: {} }
		});
		expect(await kernelmod.completeInKernel(abs(), 'myva', 4)).toMatchObject({
			ok: true,
			matches: [{ text: 'after_probe' }]
		});
	});

	it('waits out a probe LONGER than the bound it used to have', async () => {
		// THE REGRESSION, in terms of the shipped numbers. The bound was 500ms, chosen
		// against a namespace probe on a 15-core M5 Pro; on a machine measured 2.3-3x
		// slower the probe outlived it, the completion was refused, and the user
		// silently got no kernel names (deterministic: kernel-introspection.spec.ts:217
		// failed 5 of 5 Linux CI runs). Here the kernel stays busy for longer than that
		// old bound and the completion must still succeed - which it does only because
		// the bound is now set by what a keystroke may sit through, not by an estimate
		// of the probe.
		const OLD_BOUND_MS = 500;
		const BUSY_MS = OLD_BOUND_MS + 200;
		process.env.CELLAR_KERNEL_INTROSPECT_IDLE_WAIT_MS = String(SHIPPED_IDLE_WAIT_MS);
		try {
			h.lastKernel!.status = 'busy';
			setTimeout(() => (h.lastKernel!.status = 'idle'), BUSY_MS);
			h.completeReply = () => ({
				content: {
					status: 'ok',
					matches: ['after_slow_probe'],
					cursor_start: 0,
					cursor_end: 4,
					metadata: {}
				}
			});
			const started = Date.now();
			expect(await kernelmod.completeInKernel(abs(), 'myva', 4)).toMatchObject({
				ok: true,
				matches: [{ text: 'after_slow_probe' }]
			});
			// It really did wait past the old bound rather than being answered early.
			expect(Date.now() - started).toBeGreaterThanOrEqual(OLD_BOUND_MS - INTROSPECT_SLACK_MS);
		} finally {
			process.env.CELLAR_KERNEL_INTROSPECT_IDLE_WAIT_MS = String(IDLE_WAIT_MS);
		}
	});

	it('gives up on a status-busy kernel that never frees - as `busy_timeout`, not `busy`', async () => {
		// The give-up is its OWN fact and must not borrow the word for "a cell is
		// running": no user run holds this kernel, Cellar's own background work does,
		// and Cellar stopped waiting for it. That distinction is what $lib/
		// kernelCompletion keys on to SAY something instead of returning silence, so a
		// regression to `busy` here would restore the silent failure rather than break
		// a name.
		h.lastKernel!.status = 'busy';
		const started = Date.now();
		expect(await kernelmod.completeInKernel(abs(), 'myva', 4)).toEqual({
			ok: false,
			reason: 'busy_timeout'
		});
		expect(Date.now() - started).toBeGreaterThanOrEqual(IDLE_WAIT_MS - INTROSPECT_SLACK_MS);
		expect(h.completeCalls).toEqual([]);
	});

	it('never waits for a USER run, however long the idle window is', async () => {
		// The asymmetry is the point: a user cell owns the kernel for its whole life,
		// so this must refuse at once rather than hold a keystroke request open.
		const ticket = queue.enqueueRun({ nb: abs(), cellId: 'c-nowait', actor: 'user', source: 'x' });
		if (ticket.duplicate) throw new Error('unreachable: fresh ticket expected');
		await ticket.wait();
		try {
			h.lastKernel!.status = 'busy';
			const started = Date.now();
			expect(await kernelmod.completeInKernel(abs(), 'myva', 4)).toEqual({ ok: false, reason: 'busy' });
			expect(Date.now() - started).toBeLessThan(IDLE_WAIT_MS);
		} finally {
			ticket.done();
		}
	});

	it('converts to the immediate refusal when a run STARTS during the wait', async () => {
		h.lastKernel!.status = 'busy';
		const ticket = queue.enqueueRun({ nb: abs(), cellId: 'c-late', actor: 'user', source: 'x' });
		if (ticket.duplicate) throw new Error('unreachable: fresh ticket expected');
		const pending = kernelmod.completeInKernel(abs(), 'myva', 4);
		await ticket.wait();
		try {
			expect(await pending).toEqual({ ok: false, reason: 'busy' });
			expect(h.completeCalls).toEqual([]);
		} finally {
			ticket.done();
		}
	});

	it.each([
		['restarting', 'restarting'],
		['autorestarting', 'restarting'],
		['dead', 'dead'],
		['starting', 'not_ready'],
		['terminating', 'not_ready'],
		['unknown', 'not_ready']
	])('reports %s as `%s` - each a distinct fact, never one generic failure', async (status, reason) => {
		h.lastKernel!.status = status;
		expect(await kernelmod.completeInKernel(abs(), 'myva', 4)).toEqual({ ok: false, reason });
		expect(await kernelmod.inspectInKernel(abs(), 'len(', 4, 0)).toEqual({ ok: false, reason });
		expect(h.completeCalls).toEqual([]);
	});

	it('refuses a DISCONNECTED socket rather than queueing the message forever', async () => {
		// @jupyterlab pushes a send onto `_pendingMessages` when the socket is not
		// connected, so the promise would simply never settle. That is the one wedge a
		// timeout alone would only paper over.
		h.lastKernel!.connectionStatus = 'disconnected';
		expect(await kernelmod.completeInKernel(abs(), 'myva', 4)).toEqual({ ok: false, reason: 'not_connected' });
		h.lastKernel!.connectionStatus = 'connecting';
		expect(await kernelmod.inspectInKernel(abs(), 'len(', 4, 0)).toEqual({ ok: false, reason: 'not_connected' });
		expect(h.completeCalls).toEqual([]);
		expect(h.inspectCalls).toEqual([]);
	});
});

describe('the wait is bounded even so', () => {
	beforeAll(async () => {
		await startKernel();
	});

	it('reports `timeout` when the kernel is asked and says nothing', async () => {
		// The busy guard is a check-then-send, so the kernel can legitimately go busy
		// in between; and `requestComplete` hands back only a promise, so there is no
		// future to dispose. This bound is what turns that race into a refusal.
		h.completeReply = () => new Promise(() => {});
		const started = Date.now();
		expect(await kernelmod.completeInKernel(abs(), 'myva', 4)).toEqual({ ok: false, reason: 'timeout' });
		expect(Date.now() - started).toBeLessThan(TIMEOUT_MS * 20);
	});

	it('reports `failed` - not `timeout` - when the ask itself does not survive', async () => {
		// A dead kernel throws out of `_sendMessage`; a restart REJECTS the pending
		// future ("Canceled future ... before replies were done"). Both are the request
		// not surviving, which is a different fact from a kernel that said nothing.
		h.completeReply = () => {
			throw new Error('Kernel is dead');
		};
		expect(await kernelmod.completeInKernel(abs(), 'myva', 4)).toEqual({ ok: false, reason: 'failed' });
		h.inspectReply = () => Promise.reject(new Error('Canceled future for inspect_request message'));
		expect(await kernelmod.inspectInKernel(abs(), 'len(', 4, 0)).toEqual({ ok: false, reason: 'failed' });
	});

	it('reports `failed` for a reply whose own status is not ok', async () => {
		h.completeReply = () => ({ content: { status: 'error', ename: 'X', evalue: '', traceback: [] } });
		expect(await kernelmod.completeInKernel(abs(), 'myva', 4)).toEqual({ ok: false, reason: 'failed' });
	});

	it('leaves the kernel usable afterwards - a refusal is never a teardown', async () => {
		h.completeReply = () => ({
			content: { status: 'ok', matches: ['recovered'], cursor_start: 0, cursor_end: 1, metadata: {} }
		});
		expect(await kernelmod.completeInKernel(abs(), 'r', 1)).toMatchObject({
			ok: true,
			matches: [{ text: 'recovered' }]
		});
	});
});
