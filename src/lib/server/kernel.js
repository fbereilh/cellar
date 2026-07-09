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
	await kernel.restart();
	// restart() clears the namespace and the inline-backend config, so re-inject.
	await initKernel(kernel);
	return { status: kernel.status, id: kernel.id };
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
			await currentKernel.shutdown();
		} catch {}
	}
	try {
		manager?.dispose();
	} catch {}
	manager = null;
	kernelPromise = null;
	currentKernel = null;
	liveKernel = null;
	if (!wasRunning) return { status: 'not_started', id: null };
	const kernel = await getKernel();
	return { status: kernel.status, id: kernel.id };
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
 * Execute one chunk of code. Each IOPub message is delivered live via onEvent
 * as it arrives from the kernel. Resolves with the execute reply when done.
 *
 * @param {string} code
 * @param {(event: object) => void} onEvent
 */
export async function execute(code, onEvent) {
	const kernel = await getKernel();
	onEvent({ type: 'kernel', id: kernel.id });

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
	onEvent({ type: 'done', status: reply.content.status, execution_count: reply.content.execution_count });
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
