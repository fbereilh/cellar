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
import type { Kernel, KernelMessage } from '@jupyterlab/services';
import { clearRunQueue } from './run-queue';
import {
	openWidget,
	updateWidget,
	closeWidget,
	resetWidgets,
	setOutputCapture,
	outputCommForMsg,
	appendWidgetOutput,
	clearWidgetOutput
} from './widgets';
import { logInfo, logWarn, logError } from './logs';
import type { RunStreamEvent, ExecuteOptions, SessionId } from './types';

type KernelConnection = Kernel.IKernelConnection;
type StatusListener = (sender: KernelConnection, status: Kernel.Status) => void;

/**
 * Live comm objects for open ipywidgets models, keyed by comm id. Populated in
 * `registerWidgetComm` when the kernel opens a widget comm; this is what lets the
 * frontend send interaction BACK to the kernel (a slider move, a checkbox tick, a
 * button click) via `sendWidgetComm` — the return direction #86 lacked. Cleared
 * on every session change (a fresh namespace has no widgets) alongside the store.
 */
const widgetComms = new Map<string, Kernel.IComm>();

let kernelPromise: Promise<KernelConnection> | null = null;
let liveKernel: KernelConnection | null = null; // last-resolved kernel, for read-only status introspection
let manager: KernelManager | null = null;
let currentKernel: KernelConnection | null = null;
let statusHandler: StatusListener | null = null;

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

/**
 * Notebooks whose state actually lives in the CURRENT kernel session: the set of
 * absolute notebook paths that have executed at least one cell in this epoch.
 * With the one-shared-kernel model this is what "loaded in the kernel" means — a
 * notebook whose tab was later closed is still here (its variables persist in the
 * shared namespace), and a just-opened notebook that never ran a cell is not.
 * Cleared by `beginSession()`, so a fresh namespace starts with nothing loaded.
 */
let loadedNbPaths = new Set<string>();

function beginSession() {
	sessionId += 1;
	execsThisSession = 0;
	loadedNbPaths.clear();
	// A fresh namespace has no widgets: drop any progress/interactive models from
	// the previous session so a stale widget can never linger across a restart, and
	// forget their comms so a send can never target a dead model.
	widgetComms.clear();
	resetWidgets();
}

/**
 * Register the ipywidgets comm target on a freshly-connected kernel. ipywidgets
 * (tqdm bars AND interactive controls) push their state over comm channels on
 * target `jupyter.widget`; we receive it into the widget store and — for
 * interactive widgets — send interaction BACK through the stored comm (see
 * `sendWidgetComm`). Registered once per kernel connection: a plain
 * `restart()`/autorestart keeps the connection (and thus the target), while a
 * rebind builds a new connection and re-runs this via `getKernel()`.
 *
 * The initial `comm_open` state and every `comm_msg` update are dynamic Jupyter
 * wire payloads (`content.data`), narrowed here to the widget shape.
 */
function registerWidgetComm(kernel: KernelConnection): void {
	try {
		kernel.registerCommTarget('jupyter.widget', (comm, msg) => {
			const commId = comm.commId;
			// Keep the comm so a browser interaction can send an update/click back to
			// the model living in the kernel.
			widgetComms.set(commId, comm);
			const openState = (msg.content?.data ?? {}) as { state?: Record<string, unknown> };
			openWidget(commId, openState.state ?? {});
			// An Output widget may already name a capture target in its opening state.
			if (openState.state && 'msg_id' in openState.state) setOutputCapture(commId, openState.state.msg_id);
			comm.onMsg = (m: KernelMessage.ICommMsgMsg) => {
				const d = (m.content?.data ?? {}) as { method?: string; state?: Record<string, unknown> };
				// Regular `update`s (a Python-side value change, an observer firing, an
				// `interact` re-run repopulating an Output widget) sync into the store.
				// ipywidgets 8's `echo_update` — the kernel echoing back a value the
				// frontend just set — is deliberately ignored: applying it while the
				// user is still dragging a slider would snap the thumb backward, and the
				// optimistic local update already reflects the change.
				if (d.method === 'update') {
					updateWidget(commId, d.state ?? {});
					// An Output widget publishes/clears its capture target via `msg_id`;
					// track it so the iopub router (below) knows where to route captured
					// outputs. This lands before any captured output message arrives (it is
					// an earlier iopub message), so ordering is safe.
					if (d.state && 'msg_id' in d.state) setOutputCapture(commId, d.state.msg_id);
				}
			};
			comm.onClose = () => {
				widgetComms.delete(commId);
				closeWidget(commId);
			};
		});
	} catch (err) {
		// A widget target that fails to register must never break kernel bring-up;
		// widgets just won't render.
		const message = err instanceof Error ? err.message : String(err);
		logWarn('kernel', `ipywidgets comm target not registered: ${message}`);
	}
}

/**
 * Convert a raw iopub output message to an nbformat output object (the same shape
 * `execute()` emits), or null for a message type that isn't a rendered output.
 */
function iopubToNbformat(msg: KernelMessage.IIOPubMessage): Record<string, unknown> | null {
	const t = msg.header.msg_type;
	const c = msg.content as Record<string, unknown>;
	switch (t) {
		case 'stream':
			return { output_type: 'stream', name: c.name, text: c.text };
		case 'display_data':
			return { output_type: 'display_data', data: c.data, metadata: c.metadata ?? {} };
		case 'execute_result':
			return { output_type: 'execute_result', data: c.data, metadata: c.metadata ?? {}, execution_count: c.execution_count ?? null };
		case 'error':
			return { output_type: 'error', ename: c.ename, evalue: c.evalue, traceback: c.traceback };
		default:
			return null;
	}
}

/**
 * Route iopub outputs captured by an `Output` widget. An Output widget (built by
 * `interact`/`interactive`) captures every output whose `parent_header.msg_id`
 * matches the `msg_id` it published, INSTEAD of syncing them over its comm — so
 * a plain comm listener never sees them. This connects to the kernel's raw iopub
 * stream, and for a message whose parent is a registered capture target, appends
 * it to that Output widget's `outputs` (or honors its `clear_output`). This is
 * what makes `interact`'s result area update live as the user drives the control.
 * Registered once per connection, alongside `registerWidgetComm`.
 */
function registerWidgetOutputCapture(kernel: KernelConnection): void {
	try {
		kernel.iopubMessage.connect((_sender, msg: KernelMessage.IIOPubMessage) => {
			const parentId = msg.parent_header && 'msg_id' in msg.parent_header ? (msg.parent_header as { msg_id?: string }).msg_id : undefined;
			const commId = outputCommForMsg(parentId);
			if (!commId) return;
			if (msg.header.msg_type === 'clear_output') {
				clearWidgetOutput(commId, !!(msg.content as { wait?: boolean }).wait);
				return;
			}
			const output = iopubToNbformat(msg);
			if (output) appendWidgetOutput(commId, output);
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logWarn('kernel', `ipywidgets output capture not registered: ${message}`);
	}
}

/**
 * Send a `comm_msg` to an open widget model — the return direction that makes
 * interactive widgets work. `{method:'update', state:{<trait>:<value>}}` sets a
 * trait (a slider's `value`, a dropdown's `index`), so ipywidgets updates the
 * Python model and fires its `observe`/`interact` callbacks; `{method:'custom',
 * content:{event:'click'}}` is a Button press, firing its `on_click` handlers.
 * Any resulting trait/output changes flow back through the receive path above.
 *
 * Throws when the comm is unknown (widget from a dead session / never opened) so
 * the API route can answer with a clear error rather than silently dropping it.
 */
export function sendWidgetComm(commId: string, data: Record<string, unknown>): void {
	const comm = widgetComms.get(commId);
	if (!comm) throw new Error(`no live widget comm for ${commId}`);
	// Fire-and-forget: a comm_msg has no shell reply to await, and the kernel's
	// response (changed traits, new Output) arrives asynchronously over iopub. The
	// payload is a plain JSON object; cast to the comm API's JSON value type.
	comm.send(data as unknown as Parameters<typeof comm.send>[0]);
}

/**
 * Record that notebook `nbAbsPath` executed a cell in session `session`. The run
 * path calls this after a run resolves, passing the epoch the run STARTED in
 * (from `execute()`'s `kernel` event). Guarded so a run that spanned a restart —
 * its epoch no longer current — never re-marks a notebook as loaded in a session
 * it did not actually touch.
 */
export function markNotebookLoaded(nbAbsPath: string, session: SessionId): void {
	if (!currentKernel || !nbAbsPath || session !== sessionId) return;
	loadedNbPaths.add(nbAbsPath);
}

/** Absolute paths of the notebooks loaded in the live session (empty if none). */
export function loadedNotebookPaths(): string[] {
	return currentKernel ? [...loadedNbPaths] : [];
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

/**
 * Kernel startup injection: register a Cellar display formatter for pandas
 * DataFrame/Series that emits a bounded, structured payload under our own
 * mimetype `application/vnd.cellar.dataframe+json` — column names + dtypes, a
 * capped page of rows, and the true row/column counts. The frontend renders that
 * payload as an interactive data grid (sort / filter / paginate) instead of the
 * static text/HTML repr; a bare `df` in a cell "just works", like pandas'
 * `_repr_html_` but ours.
 *
 * The payload is bounded (MAX_ROWS × MAX_COLS) so a million-row DataFrame never
 * lands in the output (nor the DOM); the grid shows "first N of TOTAL". Values
 * are serialized with pandas' own `to_json(orient='split')` (deterministic —
 * NaN→null, dates→ISO, numpy scalars→native, anything else via `default_handler`)
 * so an identical re-run yields an identical payload. Cellar's clean-on-save
 * strips this mimetype from the persisted `.ipynb`, so it never bloats the file
 * or dirties git; it is a purely live render of the output. pandas' text/plain
 * and text/html reprs are untouched, so a bare `df` degrades gracefully anywhere
 * the mimetype isn't understood.
 *
 * Spark DataFrames are deliberately NOT auto-collected: a bare `df` must not
 * trigger a hidden distributed job. Use `.toPandas()` (or the Databricks table
 * preview, which already does `.limit(N).toPandas()`) to get the grid.
 *
 * Guarded end-to-end: no pandas, an old IPython, or any failure is a silent
 * no-op. Must run on every fresh start AND after a restart (which drops the
 * registration along with the namespace).
 */
const DATAFRAME_FORMATTER_CODE = [
	'def _cellar_register_df_formatter():',
	'    try:',
	'        import json as _json',
	'        from IPython.core.formatters import BaseFormatter',
	'        from traitlets import Unicode, ObjectName',
	'    except Exception:',
	'        return',
	'    _ip = get_ipython()',
	'    if _ip is None:',
	'        return',
	"    _MIME = 'application/vnd.cellar.dataframe+json'",
	'    _MAX_ROWS = 500',
	'    _MAX_COLS = 100',
	'    def _payload(_df):',
	'        _total_rows = int(_df.shape[0])',
	'        _total_cols = int(_df.shape[1])',
	'        _sub = _df.iloc[:_MAX_ROWS, :_MAX_COLS]',
	"        _split = _json.loads(_sub.to_json(orient='split', date_format='iso', default_handler=str))",
	'        try:',
	'            _idx_name = None if _sub.index.name is None else str(_sub.index.name)',
	'        except Exception:',
	'            _idx_name = None',
	'        return {',
	"            'columns': [str(_c) for _c in _sub.columns],",
	"            'dtypes': [str(_t) for _t in _sub.dtypes],",
	"            'index': _split.get('index', []),",
	"            'index_name': _idx_name,",
	"            'data': _split.get('data', []),",
	"            'total_rows': _total_rows,",
	"            'total_cols': _total_cols,",
	"            'shown_rows': int(_sub.shape[0]),",
	"            'shown_cols': int(_sub.shape[1]),",
	"            'truncated_rows': _total_rows > _MAX_ROWS,",
	"            'truncated_cols': _total_cols > _MAX_COLS,",
	'        }',
	'    try:',
	'        _fmts = _ip.display_formatter.formatters',
	'        if _MIME not in _fmts:',
	'            class _CellarDFFormatter(BaseFormatter):',
	'                format_type = Unicode(_MIME)',
	"                print_method = ObjectName('_repr_cellar_df_')",
	'                _return_type = (dict, str)',
	'            _fmts[_MIME] = _CellarDFFormatter(parent=_ip.display_formatter)',
	'        import pandas as _pd',
	'        _fmts[_MIME].for_type(_pd.DataFrame, _payload)',
	'        _fmts[_MIME].for_type(_pd.Series, lambda _s: _payload(_s.to_frame()))',
	'    except Exception:',
	'        pass',
	'_cellar_register_df_formatter()',
	'del _cellar_register_df_formatter'
].join('\n');

async function runSilent(kernel: KernelConnection, code: string): Promise<void> {
	try {
		const future = kernel.requestExecute({
			code,
			silent: true,
			store_history: false,
			stop_on_error: false
		});
		await future.done;
	} catch {
		// A failed startup injection must never break kernel bring-up.
	}
}

async function initKernel(kernel: KernelConnection): Promise<void> {
	await runSilent(kernel, STARTUP_CODE);
	await runSilent(kernel, DATAFRAME_FORMATTER_CODE);
}

/** Start (or reuse) the single kernel. */
async function getKernel(): Promise<KernelConnection> {
	if (kernelPromise) return kernelPromise;
	kernelPromise = (async () => {
		const serverSettings = makeSettings();
		manager = new KernelManager({ serverSettings });
		await manager.ready;
		const kernel = await manager.startNew({ name: 'python3' });
		liveKernel = kernel;
		currentKernel = kernel;
		beginSession();
		// Register before any user code runs so a widget `comm_open` is never missed.
		registerWidgetComm(kernel);
		registerWidgetOutputCapture(kernel);
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
			// (kernel captured in this closure is the one this handler belongs to)
			logWarn('kernel', 'kernel died and was autorestarted by jupyter_server; namespace cleared');
			beginSession();
			// The namespace queued work was submitted against is gone (see clearRunQueue).
			clearRunQueue('kernel_autorestart');
			void initKernel(kernel);
		};
		kernel.statusChanged.connect(statusHandler);
		await initKernel(kernel);
		logInfo('kernel', `kernel started (session ${sessionId})`);
		return kernel;
	})();
	// If startup fails, allow a later retry.
	kernelPromise.catch((err: unknown) => {
		const message = err instanceof Error ? err.message : String(err);
		logError('kernel', `kernel failed to start: ${message}`);
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
	// Drop pending runs BEFORE the restart is issued, so nothing can dequeue into
	// the kernel that is about to lose its namespace.
	clearRunQueue('kernel_restart');
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
	// Queued runs were submitted against the OLD interpreter's namespace.
	clearRunQueue('kernel_rebind');
	const wasRunning = !!currentKernel;
	if (currentKernel) {
		try {
			if (statusHandler) currentKernel.statusChanged.disconnect(statusHandler);
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

/**
 * Interrupt the running kernel (SIGINT equivalent). Also drops the pending run
 * queue: "stop" must mean stop, not "stop this cell and start the next one" —
 * and jupyter aborts its own queued execute requests on an interrupt anyway.
 */
export async function interruptKernel() {
	clearRunQueue('kernel_interrupt');
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
 */
export async function execute(
	code: string,
	onEvent: (event: RunStreamEvent) => void,
	{ internal = false }: ExecuteOptions = {}
): Promise<KernelMessage.IExecuteReplyMsg['content']> {
	const kernel = await getKernel();
	const session = sessionId;
	if (!internal) execsThisSession += 1;
	onEvent({ type: 'kernel', id: kernel.id, session });

	const future = kernel.requestExecute({ code, stop_on_error: false });

	// Output events carry a real nbformat output object under `output`, so the
	// caller can both stream them live to the browser AND accumulate them into
	// the cell's `outputs` for persistence — one shape, no divergence.
	// IOPub content is a dynamic Jupyter wire payload; narrow per msg_type.
	future.onIOPub = (msg: KernelMessage.IIOPubMessage) => {
		const t = msg.header.msg_type;
		const c = msg.content as Record<string, unknown>;
		// An output captured by an active Output widget (interact's result area) is
		// routed into that widget by registerWidgetOutputCapture; it must NOT also
		// land as a cell output, or the interact cell would double-render its result.
		// `outputCommForMsg` is truthy only while an Output is capturing this run's
		// msg_id (set/cleared by the widget's `msg_id` trait), so a normal cell run
		// is never affected.
		if (t === 'stream' || t === 'display_data' || t === 'execute_result' || t === 'error') {
			const parentId = (msg.parent_header as { msg_id?: string } | undefined)?.msg_id;
			if (outputCommForMsg(parentId)) return;
		}
		switch (t) {
			case 'status':
				onEvent({ type: 'status', execution_state: c.execution_state as string });
				break;
			case 'stream':
				onEvent({ type: 'output', output: { output_type: 'stream', name: c.name as string, text: c.text as string | string[] } });
				break;
			case 'execute_result':
				onEvent({
					type: 'output',
					output: {
						output_type: 'execute_result',
						data: c.data as Record<string, unknown>,
						metadata: (c.metadata ?? {}) as Record<string, unknown>,
						execution_count: c.execution_count as number | null
					}
				});
				break;
			case 'display_data':
				onEvent({
					type: 'output',
					output: { output_type: 'display_data', data: c.data as Record<string, unknown>, metadata: (c.metadata ?? {}) as Record<string, unknown> }
				});
				break;
			case 'error':
				onEvent({
					type: 'output',
					output: { output_type: 'error', ename: c.ename as string, evalue: c.evalue as string, traceback: c.traceback as string[] }
				});
				break;
			default:
				break;
		}
	};

	const reply = await future.done;
	onEvent({ type: 'done', status: reply.content.status, execution_count: (reply.content as { execution_count?: number | null }).execution_count ?? null, session });
	return reply.content;
}

/**
 * Read-only snapshot of the current kernel for the sidebar's Kernels section.
 * Does NOT start a kernel — reports `started: false` until the first execute().
 *
 * `session_id` is the epoch (see above). It is what lets a client notice that a
 * restart replaced the namespace - the kernel id survives a `restart()`, so it
 * cannot answer that question. The Databricks section re-checks its `spark`
 * session on every change to it.
 */
export function getKernelInfo() {
	if (!liveKernel) {
		return { started: false, id: null, name: 'python3', status: 'not started', session_id: null };
	}
	return {
		started: true,
		id: liveKernel.id,
		name: liveKernel.name || 'python3',
		status: liveKernel.status, // 'idle' | 'busy' | 'starting' | 'dead' | …
		session_id: currentSessionId()
	};
}
