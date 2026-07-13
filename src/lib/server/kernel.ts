/**
 * Cellar — kernel manager (one kernel per notebook).
 *
 * Cellar runs ONE Jupyter kernel per open notebook, keyed by the notebook's
 * absolute path, so notebooks execute in PARALLEL against ISOLATED namespaces:
 * a name defined in notebook A is not visible in notebook B, and a long cell in
 * A never blocks a cell in B. Each kernel is a full Python process the shared
 * `jupyter_server` sidecar hosts; `@jupyterlab/services` connects to each over
 * Jupyter's REST + WebSocket protocol. Kernels are LAZY: a notebook gets its
 * kernel on its FIRST run, not when its tab opens.
 *
 * The core wiring, per notebook:
 *   SvelteKit (Node) <-> @jupyterlab/services <-> one Jupyter kernel.
 *
 * This module is the manager: a `Map<nbPath, NotebookKernel>` replacing the old
 * single `currentKernel`. Every operation that used to act on "the kernel" now
 * takes an `nbPath` (defaulting to the ACTIVE notebook, so callers that still
 * think in terms of one kernel — the sidebar, the kernel routes, the MCP tools —
 * keep working while later phases expose the N-kernel reality). Each
 * `NotebookKernel` owns exactly what was process-global before: its connection,
 * its session epoch, its widget comms, its autorestart handler.
 *
 * Each execute() call streams its own IOPub messages back through an onEvent
 * callback — the caller (the run route / MCP tool) pipes those straight into that
 * request's response, so one run == one stream. No global broadcast, so there is
 * no way for outputs to be duplicated or cross runs.
 */
import { basename } from 'node:path';
import { KernelManager, ServerConnection } from '@jupyterlab/services';
import type { Kernel, KernelMessage } from '@jupyterlab/services';
import { clearRunQueue } from './run-queue';
import { getActiveNotebookPath, workspaceRelative } from './notebook';
import { publishGlobal } from './events';
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
import type { RunStreamEvent, ExecuteOptions, SessionId, KernelStatus } from './types';
import type { KernelListEntry } from '$lib/kernelBadge';

type KernelConnection = Kernel.IKernelConnection;
type StatusListener = (sender: KernelConnection, status: Kernel.Status) => void;

/**
 * One notebook's live kernel. Holds exactly what used to be a process-global
 * singleton, now scoped to a single notebook keyed by its absolute path.
 */
interface NotebookKernel {
	/** Absolute notebook path — the Map key. */
	nbPath: string;
	/** Resolves to the live kernel connection; cached so a lookup never re-starts. */
	startPromise: Promise<KernelConnection>;
	/** The resolved connection, once startup finished (null while still starting). */
	connection: KernelConnection | null;
	/**
	 * This notebook's session epoch. Every fresh namespace gets a new id (drawn
	 * from a process-global monotonic counter, so epochs never collide ACROSS
	 * notebooks either): a first start, a restart, a rebind, and a server-side
	 * autorestart all bump it. Callers stamp the epoch a cell ran in, so "this
	 * cell has saved outputs" (persisted, maybe from a previous session) can be
	 * told apart from "this cell executed against the namespace live right now".
	 */
	sessionId: number;
	/** Cell executions run in this notebook's current epoch (internal probes excluded). */
	execsThisSession: number;
	/** The autorestart status handler, identity-guarded to THIS connection. */
	statusHandler: StatusListener | null;
	/**
	 * Live comm objects for this kernel's open ipywidgets models, keyed by comm id.
	 * This is what lets the frontend send interaction BACK (a slider move, a button
	 * click) via `sendWidgetComm`. Cleared on every session change for this kernel.
	 */
	widgetComms: Map<string, Kernel.IComm>;
}

/** One shared KernelManager hosts every notebook's kernel (N kernels, one host). */
let manager: KernelManager | null = null;
/** Every notebook's kernel, keyed by absolute notebook path. */
const kernels = new Map<string, NotebookKernel>();

/**
 * Process-global monotonic epoch source. Each new kernel session grabs the next
 * value, so a session id is unique across ALL notebooks — a cell stamped with
 * notebook A's epoch can never accidentally read as live under notebook B's.
 * Starts at 0, which means "no kernel session has ever existed"; the first
 * session is 1, so a stamp can never match before a kernel exists.
 */
let sessionCounter = 0;

/** Resolve an optional notebook path to an absolute one (default: active notebook). */
function resolveNb(nbPath?: string | null): string {
	return nbPath || getActiveNotebookPath();
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

/** The shared KernelManager, created on first use. */
async function getManager(): Promise<KernelManager> {
	if (!manager) {
		manager = new KernelManager({ serverSettings: makeSettings() });
	}
	await manager.ready;
	return manager;
}

/**
 * Open a new session epoch for a notebook's kernel: bump its id from the global
 * counter, reset its exec count, and drop its widgets. Called on a fresh start
 * and on every restart/rebind/autorestart. Only THIS kernel's widgets are cleared
 * (by comm id) so restarting notebook A never wipes notebook B's live bars.
 */
function beginSession(nbKernel: NotebookKernel): void {
	nbKernel.sessionId = ++sessionCounter;
	nbKernel.execsThisSession = 0;
	// A fresh namespace has no widgets: drop this kernel's progress/interactive
	// models and forget their comms so a send can never target a dead model.
	const commIds = [...nbKernel.widgetComms.keys()];
	nbKernel.widgetComms.clear();
	resetWidgets(commIds);
}

/**
 * Register the ipywidgets comm target on a freshly-connected kernel. ipywidgets
 * (tqdm bars AND interactive controls) push their state over comm channels on
 * target `jupyter.widget`; we receive it into the widget store and — for
 * interactive widgets — send interaction BACK through the stored comm (see
 * `sendWidgetComm`). Registered once per kernel connection: a plain
 * `restart()`/autorestart keeps the connection (and thus the target), while a
 * rebind builds a new connection and re-runs this via `startKernel()`. Comms land
 * in THIS kernel's `widgetComms` map so a send targets the right kernel.
 *
 * The initial `comm_open` state and every `comm_msg` update are dynamic Jupyter
 * wire payloads (`content.data`), narrowed here to the widget shape.
 */
function registerWidgetComm(nbKernel: NotebookKernel, kernel: KernelConnection): void {
	try {
		kernel.registerCommTarget('jupyter.widget', (comm, msg) => {
			const commId = comm.commId;
			// Keep the comm so a browser interaction can send an update/click back to
			// the model living in the kernel.
			nbKernel.widgetComms.set(commId, comm);
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
				nbKernel.widgetComms.delete(commId);
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
 * Comm ids are globally unique per session, so the comm is looked up across every
 * notebook's kernel. Throws when the comm is unknown (widget from a dead session /
 * never opened) so the API route can answer with a clear error rather than
 * silently dropping it.
 */
export function sendWidgetComm(commId: string, data: Record<string, unknown>): void {
	let comm: Kernel.IComm | undefined;
	for (const nbKernel of kernels.values()) {
		comm = nbKernel.widgetComms.get(commId);
		if (comm) break;
	}
	if (!comm) throw new Error(`no live widget comm for ${commId}`);
	// Fire-and-forget: a comm_msg has no shell reply to await, and the kernel's
	// response (changed traits, new Output) arrives asynchronously over iopub. The
	// payload is a plain JSON object; cast to the comm API's JSON value type.
	comm.send(data as unknown as Parameters<typeof comm.send>[0]);
}

/** Absolute paths of the notebooks that currently have a live kernel entry. */
export function loadedNotebookPaths(): string[] {
	return [...kernels.keys()];
}

/**
 * Snapshot of every live per-notebook kernel — one card per entry in the
 * Kernels sidebar. Drives `/api/kernel` and the `kernel:status` SSE broadcast.
 * The workspace-relative `path` is the id the browser matches tabs on. Every
 * entry is a kernel Cellar is running: a notebook that never ran a cell has NO
 * entry (its "not started" card is built from the open tab instead). A booting
 * kernel (connection not yet resolved) reads `starting` with a null session so
 * its card appears the instant the first run is requested.
 */
export function listKernels(): KernelListEntry[] {
	const out: KernelListEntry[] = [];
	for (const [abs, nbKernel] of kernels) {
		const conn = nbKernel.connection;
		const status: KernelStatus = conn ? conn.status : 'starting';
		out.push({
			path: workspaceRelative(abs),
			name: conn?.name || 'python3',
			// A map entry IS a kernel (booting or up), so its card is never "not started".
			started: true,
			id: conn?.id ?? null,
			status,
			session_id: conn ? nbKernel.sessionId : null,
			busy: status === 'busy'
		});
	}
	return out;
}

/**
 * Broadcast the full kernel list to every open tab as a global SSE snapshot
 * (`kernel:status`), so the Kernels sidebar reflects a start / busy / idle /
 * restart / shutdown with no reload. Like `queue:changed` it is a FULL snapshot
 * carrying no `seq`, so a missed broadcast self-heals on the next one. Called on
 * every kernel lifecycle transition and, via `statusChanged`, on every idle/busy
 * flip so two notebooks running at once show two busy cards independently.
 */
export function publishKernelStatus(): void {
	publishGlobal({ type: 'kernel:status', kernels: listKernels() });
}

/**
 * Shut a single notebook's kernel down: terminate the process and REMOVE its
 * entry (its card drops from the sidebar), unlike `restartKernel` which keeps
 * the process/entry and only clears the namespace. The document and MCP session
 * are untouched; the notebook lazily gets a fresh kernel on its next run.
 * Shutting down a notebook that never started is a no-op.
 */
export async function shutdownKernel(nbPath?: string | null) {
	const abs = resolveNb(nbPath);
	const nbKernel = kernels.get(abs);
	if (!nbKernel) return { status: 'not_started', id: null, session_id: null };
	await teardownKernel(nbKernel, 'kernel_shutdown');
	publishKernelStatus();
	return { status: 'not_started', id: null, session_id: null };
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

/**
 * Start (or reuse) the kernel for notebook `nbPath`. Lazy: the kernel does not
 * exist until a notebook's first run. If the Map already holds an entry, its
 * cached start promise is returned; otherwise a fresh kernel process is started,
 * initialized (matplotlib + dataframe formatter + widget wiring), and cached.
 */
function getKernel(nbPath: string): Promise<KernelConnection> {
	const existing = kernels.get(nbPath);
	if (existing) return existing.startPromise;

	const nbKernel: NotebookKernel = {
		nbPath,
		startPromise: undefined as unknown as Promise<KernelConnection>,
		connection: null,
		sessionId: 0,
		execsThisSession: 0,
		statusHandler: null,
		widgetComms: new Map()
	};

	nbKernel.startPromise = (async () => {
		const mgr = await getManager();
		const kernel = await mgr.startNew({ name: 'python3' });
		nbKernel.connection = kernel;
		beginSession(nbKernel);
		// Register before any user code runs so a widget `comm_open` is never missed.
		registerWidgetComm(nbKernel, kernel);
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
		nbKernel.statusHandler = (_sender, status) => {
			if (nbKernel.connection !== kernel) return;
			// Every idle/busy flip reaches the Kernels sidebar so parallel runs show
			// their own busy cards independently.
			publishKernelStatus();
			if (status !== 'autorestarting') return;
			logWarn('kernel', `kernel for ${nbPath} died and was autorestarted; namespace cleared`);
			beginSession(nbKernel);
			// The namespace queued work was submitted against is gone (see clearRunQueue).
			clearRunQueue(nbPath, 'kernel_autorestart');
			void initKernel(kernel);
		};
		kernel.statusChanged.connect(nbKernel.statusHandler);
		await initKernel(kernel);
		logInfo('kernel', `kernel for ${nbPath} started (session ${nbKernel.sessionId})`);
		// The kernel is up: refresh its card from "starting" to its live status.
		publishKernelStatus();
		return kernel;
	})();

	kernels.set(nbPath, nbKernel);
	// Surface the booting kernel's card ("starting") the instant its first run is
	// requested, before the connection resolves.
	publishKernelStatus();

	// If startup fails, drop the entry so a later run can retry.
	nbKernel.startPromise.catch((err: unknown) => {
		const message = err instanceof Error ? err.message : String(err);
		logError('kernel', `kernel for ${nbPath} failed to start: ${message}`);
		if (kernels.get(nbPath) === nbKernel) kernels.delete(nbPath);
		// The card that just appeared as "starting" must drop when the boot fails.
		publishKernelStatus();
	});
	return nbKernel.startPromise;
}

/**
 * Restart notebook `nbPath`'s kernel process (clears ITS namespace) while KEEPING
 * the same connection. Other notebooks' kernels are untouched. Cellar's backend,
 * MCP server, and document are untouched — this is what makes the agent interface
 * kernel-restart-proof. Restarting a notebook that never started is a no-op.
 */
export async function restartKernel(nbPath?: string | null) {
	const abs = resolveNb(nbPath);
	// Drop this notebook's pending runs BEFORE the restart is issued, so nothing can
	// dequeue into the kernel that is about to lose its namespace.
	clearRunQueue(abs, 'kernel_restart');
	const nbKernel = kernels.get(abs);
	if (!nbKernel) return { status: 'not_started', id: null, session_id: null };
	const kernel = await nbKernel.startPromise;
	try {
		await kernel.restart();
	} finally {
		// Once the REST restart is issued the kernel process is restarted and the
		// namespace is cleared, even if the websocket reconnect afterwards rejects.
		// The epoch must be bumped on BOTH paths: it is monotonic and opaque, so an
		// extra bump is harmless, while a missing one leaves cells falsely reading
		// as `ok_session` against a namespace that no longer exists.
		beginSession(nbKernel);
	}
	// restart() clears the namespace and the inline-backend config, so re-inject.
	await initKernel(kernel);
	publishKernelStatus();
	return { status: kernel.status, id: kernel.id, session_id: nbKernel.sessionId };
}

/**
 * Tear a single notebook's kernel down: disconnect its handler, shut the process
 * down, drop its pending queue and widgets, and remove it from the Map. Used by
 * a per-notebook rebind and the (future) explicit shutdown control. Bumps the
 * epoch so any cell stamped before teardown reads as not-this-session.
 */
async function teardownKernel(nbKernel: NotebookKernel, reason = 'kernel_rebind'): Promise<void> {
	const { nbPath } = nbKernel;
	clearRunQueue(nbPath, reason);
	if (nbKernel.connection) {
		try {
			if (nbKernel.statusHandler) nbKernel.connection.statusChanged.disconnect(nbKernel.statusHandler);
		} catch {}
		try {
			await nbKernel.connection.shutdown();
		} catch {}
	}
	// The old namespace is gone; bump so its epoch can never read as current, and
	// drop this kernel's widgets from the store.
	beginSession(nbKernel);
	nbKernel.connection = null;
	nbKernel.statusHandler = null;
	if (kernels.get(nbPath) === nbKernel) kernels.delete(nbPath);
}

/**
 * Rebind onto a freshly-written kernelspec (e.g. after the Settings venv control
 * points the `python3` spec at a different interpreter). A plain `restart()`
 * reuses the kernel's original launch argv, so it would NOT switch interpreters —
 * we must tear the kernel down so the NEXT start re-reads the kernelspec from disk
 * and launches the newly-bound python.
 *
 * With one shared `python3` kernelspec across all notebooks, a venv change affects
 * every kernel — so `rebindKernel()` with NO argument tears down every live kernel
 * (they lazily re-start on their next run under the new interpreter). Passing an
 * `nbPath` rebinds just that one notebook. The connection, MCP session, and
 * documents are untouched.
 */
export async function rebindKernel(nbPath?: string | null) {
	if (nbPath) {
		const nbKernel = kernels.get(resolveNb(nbPath));
		if (!nbKernel) return { status: 'not_started', id: null, session_id: null, rebound: 0 };
		await teardownKernel(nbKernel);
		publishKernelStatus();
		return { status: 'not_started', id: null, session_id: null, rebound: 1 };
	}
	// No arg: a venv change rewrote the shared kernelspec → every kernel must rebind.
	const all = [...kernels.values()];
	await Promise.all(all.map((k) => teardownKernel(k)));
	// Dispose the shared manager so the next start reconnects cleanly under the new
	// spec; it is recreated lazily by getManager().
	try {
		manager?.dispose();
	} catch {}
	manager = null;
	publishKernelStatus();
	return { status: 'not_started', id: null, session_id: null, rebound: all.length };
}

/**
 * Interrupt notebook `nbPath`'s running kernel (SIGINT equivalent). Also drops
 * that notebook's pending run queue: "stop" must mean stop, not "stop this cell
 * and start the next one" — and jupyter aborts its own queued execute requests on
 * an interrupt anyway. Other notebooks are untouched.
 */
export async function interruptKernel(nbPath?: string | null) {
	const abs = resolveNb(nbPath);
	clearRunQueue(abs, 'kernel_interrupt');
	const nbKernel = kernels.get(abs);
	if (!nbKernel) return { status: 'not_started', id: null };
	const kernel = await nbKernel.startPromise;
	await kernel.interrupt();
	publishKernelStatus();
	return { status: kernel.status, id: kernel.id };
}

/** Current status of notebook `nbPath`'s kernel, without forcing a start. */
export function kernelStatus(nbPath?: string | null) {
	const nbKernel = kernels.get(resolveNb(nbPath));
	if (!nbKernel || !nbKernel.connection) return { status: 'not_started', id: null };
	return { status: nbKernel.connection.status, id: nbKernel.connection.id };
}

/**
 * Live kernel-session snapshot for notebook `nbPath`, without forcing a start.
 * `session_id` is the current epoch (null when its kernel is not running); a cell
 * whose recorded run epoch equals it genuinely executed against the namespace that
 * exists now. Everything else — however good its saved outputs look — did not.
 */
export function kernelSession(nbPath?: string | null) {
	const nbKernel = kernels.get(resolveNb(nbPath));
	if (!nbKernel || !nbKernel.connection) {
		return { started: false, session_id: null, status: 'not_started', execs_this_session: 0 };
	}
	return {
		started: true,
		session_id: nbKernel.sessionId,
		status: nbKernel.connection.status,
		execs_this_session: nbKernel.execsThisSession
	};
}

/** The epoch a run should be stamped with for notebook `nbPath`, or null when its kernel is not running. */
export function currentSessionId(nbPath?: string | null): SessionId | null {
	const nbKernel = kernels.get(resolveNb(nbPath));
	return nbKernel && nbKernel.connection ? nbKernel.sessionId : null;
}

/**
 * Execute one chunk of code against notebook `nbPath`'s kernel (lazy-starting it
 * if needed). Each IOPub message is delivered live via onEvent as it arrives.
 * Resolves with the execute reply when done.
 *
 * The `kernel` and `done` events both carry the kernel-session epoch this run
 * *started* in. Callers stamp that epoch on the cell rather than reading the
 * epoch afterwards: if the kernel restarted mid-run the namespace is gone, and
 * the stale stamp correctly reads as "did not run this session".
 *
 * `internal: true` marks a Cellar-issued probe (see inspect.ts) so it does not
 * inflate `execs_this_session`, which counts cell executions the agent can see.
 */
export async function execute(
	nbPath: string,
	code: string,
	onEvent: (event: RunStreamEvent) => void,
	{ internal = false }: ExecuteOptions = {}
): Promise<KernelMessage.IExecuteReplyMsg['content']> {
	const abs = resolveNb(nbPath);
	const kernel = await getKernel(abs);
	const nbKernel = kernels.get(abs)!;
	const session = nbKernel.sessionId;
	if (!internal) nbKernel.execsThisSession += 1;
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
 * Read-only snapshot of notebook `nbPath`'s kernel for the sidebar's Kernels
 * section. Does NOT start a kernel — reports `started: false` until that
 * notebook's first execute().
 *
 * `session_id` is the epoch (see above). It is what lets a client notice that a
 * restart replaced the namespace - the kernel id survives a `restart()`, so it
 * cannot answer that question. The Databricks section re-checks its `spark`
 * session on every change to it.
 */
export function getKernelInfo(nbPath?: string | null) {
	const nbKernel = kernels.get(resolveNb(nbPath));
	if (!nbKernel || !nbKernel.connection) {
		return { started: false, id: null, name: 'python3', status: 'not started', session_id: null };
	}
	return {
		started: true,
		id: nbKernel.connection.id,
		name: nbKernel.connection.name || 'python3',
		status: nbKernel.connection.status, // 'idle' | 'busy' | 'starting' | 'dead' | …
		session_id: nbKernel.sessionId
	};
}
