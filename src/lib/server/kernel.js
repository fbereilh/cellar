/**
 * Cellar spike — kernel bridge.
 *
 * Owns a single long-lived Jupyter kernel connection (one kernel for the whole
 * spike) via @jupyterlab/services over Jupyter's REST + WebSocket protocol.
 *
 * This is the riskiest wiring the spike exists to prove:
 *   SvelteKit (Node) <-> @jupyterlab/services <-> Jupyter kernel service.
 *
 * Each execute() call streams its own IOPub messages back through an onEvent
 * callback — the caller (the /api/execute endpoint) pipes those straight into
 * that request's HTTP response, so one run == one stream. No global broadcast,
 * so there is no way for outputs to be duplicated or cross runs.
 */
import { KernelManager, ServerConnection } from '@jupyterlab/services';

let kernelPromise = null;
let liveKernel = null; // last-resolved kernel, for read-only status introspection
let manager = null;
let currentKernel = null;
let statusHandler = null;

/**
 * Kernel session epoch. Every fresh namespace gets a new id: a first start, a
 * restart, a rebind onto another interpreter, and a server-side autorestart all
 * bump it. Callers stamp the epoch a cell ran in, so "this cell has saved
 * outputs" (persisted, possibly from a previous session) can be told apart from
 * "this cell actually executed against the namespace that is live right now".
 *
 * Monotonic and starts at 0, which means "no kernel has ever started" — so a
 * stamp can never accidentally match the current epoch before a kernel exists.
 */
let sessionId = 0;
/** Cell executions run in the current epoch (internal probes excluded). */
let execsThisSession = 0;

function beginSession() {
	sessionId += 1;
	execsThisSession = 0;
}

function makeSettings() {
	const baseUrl = process.env.CELLAR_JUPYTER_URL || 'http://127.0.0.1:8888';
	const token = process.env.CELLAR_JUPYTER_TOKEN || '';
	const wsUrl = baseUrl.replace(/^http/, 'ws');
	return ServerConnection.makeSettings({
		baseUrl,
		wsUrl,
		token,
		// Node 18+ ships global fetch/WebSocket; pass them explicitly so
		// @jupyterlab/services does not reach for a browser-only shim.
		fetch: globalThis.fetch,
		WebSocket: globalThis.WebSocket
	});
}

/**
 * Kernel startup injection: activate matplotlib's inline backend so a Figure
 * renders as an `image/png` in the display bundle instead of falling back to its
 * `<Figure …>` text repr — exactly what a classic notebook's `%matplotlib
 * inline` does, but without the user typing it. Runs silently (no history, no
 * broadcast) and is a no-op when matplotlib/ipykernel's inline backend is not
 * installed (it ships with ipykernel, but we guard anyway). Must run on every
 * fresh start AND after a restart(), which clears the namespace and backend.
 */
const STARTUP_CODE = [
	'try:',
	"    get_ipython().run_line_magic('matplotlib', 'inline')",
	'except Exception:',
	'    pass'
].join('\n');

async function initKernel(kernel) {
	try {
		const future = kernel.requestExecute({
			code: STARTUP_CODE,
			silent: true,
			store_history: false,
			stop_on_error: false
		});
		await future.done;
	} catch {
		// A failed startup injection must never break kernel bring-up.
	}
}

/** Start (or reuse) the single kernel. */
async function getKernel() {
	if (kernelPromise) return kernelPromise;
	kernelPromise = (async () => {
		const serverSettings = makeSettings();
		manager = new KernelManager({ serverSettings });
		await manager.ready;
		const kernel = await manager.startNew({ name: 'python3' });
		liveKernel = kernel;
		currentKernel = kernel;
		beginSession();
		// A kernel that dies is restarted by jupyter_server behind our back, which
		// clears the namespace without any Cellar call. Catch that too, so a cell
		// stamped before the crash never reads as "ran this session" after it.
		// Our own restart() reports 'restarting', not 'autorestarting', so this
		// cannot double-bump restartKernel().
		//
		// The identity guard is load-bearing: a late emission from an OUTGOING
		// kernel must not bump the epoch of the one that replaced it, which would
		// wrongly demote cells that legitimately ran in the new session.
		//
		// Re-injecting the startup code keeps parity with restartKernel(): an
		// autorestart clears the namespace AND the matplotlib backend.
		statusHandler = (_sender, status) => {
			if (status !== 'autorestarting' || currentKernel !== kernel) return;
			beginSession();
			void initKernel(kernel);
		};
		kernel.statusChanged.connect(statusHandler);
		await initKernel(kernel);
		return kernel;
	})();
	// If startup fails, allow a later retry.
	kernelPromise.catch(() => {
		kernelPromise = null;
	});
	return kernelPromise;
}

/**
 * Restart the kernel process (clears the namespace) while KEEPING the same
 * connection. Cellar's backend, MCP server, and document are untouched — this
 * is what makes the agent interface kernel-restart-proof.
 */
export async function restartKernel() {
	const kernel = await getKernel();
	try {
		await kernel.restart();
	} finally {
		// Once the REST restart is issued the kernel process is restarted and the
		// namespace is cleared, even if the websocket reconnect afterwards rejects.
		// The epoch must be bumped on BOTH paths: it is monotonic and opaque, so an
		// extra bump is harmless, while a missing one leaves cells falsely reading
		// as `ok_session` against a namespace that no longer exists.
		beginSession();
	}
	// restart() clears the namespace and the inline-backend config, so re-inject.
	await initKernel(kernel);
	return { status: kernel.status, id: kernel.id, session_id: sessionId };
}

/**
 * Rebind onto a freshly-written kernelspec (e.g. after the Settings venv
 * control points the `python3` spec at a different interpreter). A plain
 * `restart()` reuses the kernel's original launch argv, so it would NOT switch
 * interpreters — we must tear the kernel down so the next start re-reads the
 * kernelspec from disk and launches the newly-bound python. The connection,
 * backend, MCP session, and document are untouched.
 *
 * If no kernel is running yet, we only clear cached state; the next execute()
 * naturally picks up the new spec.
 */
export async function rebindKernel() {
	const wasRunning = !!currentKernel;
	if (currentKernel) {
		try {
			currentKernel.statusChanged.disconnect(statusHandler);
		} catch {}
		try {
			await currentKernel.shutdown();
		} catch {}
	}
	try {
		manager?.dispose();
	} catch {}
	manager = null;
	statusHandler = null;
	kernelPromise = null;
	currentKernel = null;
	liveKernel = null;
	if (!wasRunning) return { status: 'not_started', id: null, session_id: null };
	// The old namespace is gone the moment the kernel was torn down, whether or not
	// the replacement comes up. Bump now so a getKernel() failure below cannot leave
	// the previous epoch reachable.
	beginSession();
	// getKernel() starts a brand-new kernel process, so it opens a new session.
	const kernel = await getKernel();
	return { status: kernel.status, id: kernel.id, session_id: sessionId };
}

/** Interrupt the running kernel (SIGINT equivalent). */
export async function interruptKernel() {
	const kernel = await getKernel();
	await kernel.interrupt();
	return { status: kernel.status, id: kernel.id };
}

/** Current kernel status without forcing a start. */
export function kernelStatus() {
	if (!currentKernel) return { status: 'not_started', id: null };
	return { status: currentKernel.status, id: currentKernel.id };
}

/**
 * Live kernel-session snapshot, without forcing a start. `session_id` is the
 * current epoch (null when no kernel is running); a cell whose recorded run
 * epoch equals it genuinely executed against the namespace that exists now.
 * Everything else — however good its saved outputs look — did not.
 */
export function kernelSession() {
	if (!currentKernel) {
		return { started: false, session_id: null, status: 'not_started', execs_this_session: 0 };
	}
	return {
		started: true,
		session_id: sessionId,
		status: currentKernel.status,
		execs_this_session: execsThisSession
	};
}

/** The epoch a run should be stamped with, or null when no kernel is running. */
export function currentSessionId() {
	return currentKernel ? sessionId : null;
}

/**
 * Execute one chunk of code. Each IOPub message is delivered live via onEvent
 * as it arrives from the kernel. Resolves with the execute reply when done.
 *
 * The `kernel` and `done` events both carry the kernel-session epoch this run
 * *started* in. Callers stamp that epoch on the cell rather than reading the
 * epoch afterwards: if the kernel restarted mid-run the namespace is gone, and
 * the stale stamp correctly reads as "did not run this session".
 *
 * `internal: true` marks a Cellar-issued probe (see inspect.js) so it does not
 * inflate `execs_this_session`, which counts cell executions the agent can see.
 *
 * @param {string} code
 * @param {(event: object) => void} onEvent
 * @param {{ internal?: boolean }} [opts]
 */
export async function execute(code, onEvent, { internal = false } = {}) {
	const kernel = await getKernel();
	const session = sessionId;
	if (!internal) execsThisSession += 1;
	onEvent({ type: 'kernel', id: kernel.id, session });

	const future = kernel.requestExecute({ code, stop_on_error: false });

	// Output events carry a real nbformat output object under `output`, so the
	// caller can both stream them live to the browser AND accumulate them into
	// the cell's `outputs` for persistence — one shape, no divergence.
	future.onIOPub = (msg) => {
		const t = msg.header.msg_type;
		const c = msg.content;
		switch (t) {
			case 'status':
				onEvent({ type: 'status', execution_state: c.execution_state });
				break;
			case 'stream':
				onEvent({ type: 'output', output: { output_type: 'stream', name: c.name, text: c.text } });
				break;
			case 'execute_result':
				onEvent({
					type: 'output',
					output: {
						output_type: 'execute_result',
						data: c.data,
						metadata: c.metadata ?? {},
						execution_count: c.execution_count
					}
				});
				break;
			case 'display_data':
				onEvent({
					type: 'output',
					output: { output_type: 'display_data', data: c.data, metadata: c.metadata ?? {} }
				});
				break;
			case 'error':
				onEvent({
					type: 'output',
					output: { output_type: 'error', ename: c.ename, evalue: c.evalue, traceback: c.traceback }
				});
				break;
			default:
				break;
		}
	};

	const reply = await future.done;
	onEvent({ type: 'done', status: reply.content.status, execution_count: reply.content.execution_count, session });
	return reply.content;
}

/**
 * Read-only snapshot of the current kernel for the sidebar's Kernels section.
 * Does NOT start a kernel — reports `started: false` until the first execute().
 */
export function getKernelInfo() {
	if (!liveKernel) {
		return { started: false, id: null, name: 'python3', status: 'not started' };
	}
	return {
		started: true,
		id: liveKernel.id,
		name: liveKernel.name || 'python3',
		status: liveKernel.status // 'idle' | 'busy' | 'starting' | 'dead' | …
	};
}
