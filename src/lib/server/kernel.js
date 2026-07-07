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

/** Start (or reuse) the single kernel. */
async function getKernel() {
	if (kernelPromise) return kernelPromise;
	kernelPromise = (async () => {
		const serverSettings = makeSettings();
		const manager = new KernelManager({ serverSettings });
		await manager.ready;
		return manager.startNew({ name: 'python3' });
	})();
	// If startup fails, allow a later retry.
	kernelPromise.catch(() => {
		kernelPromise = null;
	});
	return kernelPromise;
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

	future.onIOPub = (msg) => {
		const t = msg.header.msg_type;
		const c = msg.content;
		switch (t) {
			case 'status':
				onEvent({ type: 'status', execution_state: c.execution_state });
				break;
			case 'stream':
				onEvent({ type: 'stream', name: c.name, text: c.text });
				break;
			case 'execute_result':
				onEvent({
					type: 'execute_result',
					text: c.data?.['text/plain'] ?? '',
					execution_count: c.execution_count
				});
				break;
			case 'display_data':
				onEvent({ type: 'display_data', text: c.data?.['text/plain'] ?? '[display_data]' });
				break;
			case 'error':
				onEvent({ type: 'error', ename: c.ename, evalue: c.evalue, traceback: c.traceback });
				break;
			default:
				break;
		}
	};

	const reply = await future.done;
	onEvent({ type: 'done', status: reply.content.status, execution_count: reply.content.execution_count });
	return reply.content;
}
