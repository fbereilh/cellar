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
import { basename, sep } from 'node:path';
import { KernelManager, ServerConnection, CommsOverSubshells } from '@jupyterlab/services';
import type { Kernel, KernelMessage } from '@jupyterlab/services';
import { clearRunQueue } from './run-queue';
import { getActiveNotebookPath, workspaceRelative, resolveNotebookPath } from './notebook';
import { workspaceRoot } from './fstree';
import { addProjectRootToPath } from './ui-state';
import { projectRootAddCode, projectRootRemoveCode } from './projectRoot';
import { CONTROL_COMM_TARGET, RESTART_MAGIC_CODE, controlOp } from './controlMagic';
import { publish, publishGlobal } from './events';
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
	/**
	 * How many USER (non-internal) runs are currently executing on this kernel.
	 * Gates the status broadcast: a busy/idle flip is fanned out to the Kernels
	 * sidebar only while this is > 0. Flips caused solely by internal work — inspect/
	 * variable probes and the startup injections — leave it at 0, so they never
	 * flicker a card nor fan a redundant snapshot out to every open tab.
	 */
	userRuns: number;
	/** The autorestart status handler, identity-guarded to THIS connection. */
	statusHandler: StatusListener | null;
	/**
	 * Live comm objects for this kernel's open ipywidgets models, keyed by comm id.
	 * This is what lets the frontend send interaction BACK (a slider move, a button
	 * click) via `sendWidgetComm`. Cleared on every session change for this kernel.
	 */
	widgetComms: Map<string, Kernel.IComm>;
	/**
	 * Runs currently awaiting this kernel's `execute_reply`. Tracked so a restart /
	 * autorestart / teardown can force-abort a run whose reply the kernel change
	 * destroys (see `abortActiveRuns`); `clearRunQueue` drops only PENDING runs, so
	 * without this an ACTIVE run stuck awaiting a lost reply would wedge the notebook
	 * forever.
	 */
	activeRuns: Set<ActiveRun>;
}

/**
 * A run currently awaiting its kernel's reply. `abort` rejects the run's
 * `Promise.race` in `execute()`, causing it to dispose the future and throw — so
 * the run's OWNER releases its queue slot through its existing `finally`, the same
 * single release path a normal run uses (never a second one). The future itself is
 * disposed inside `execute()`'s finally, so it need not be held here.
 */
interface ActiveRun {
	abort: (reason: string) => void;
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

/**
 * Resolve an optional notebook path to an absolute one (default: active notebook).
 *
 * The `kernels` Map is keyed by ABSOLUTE path, so a workspace-relative `nbPath`
 * MUST be resolved here or it simply misses every entry. It used to be passed
 * through verbatim, which silently broke every caller that addresses a notebook the
 * way the browser does (`notebook.ipynb`): `currentSessionId('notebook.ipynb')`
 * returned null, so `getNotebookStaleness` reconciled against "no kernel session"
 * and reported EVERY cell `not_run` — the whole staleness signal read dead in the
 * UI, whatever the cells had actually done. `resolveNotebookPath` is the same
 * resolver `notebook.ts` applies to its own `nb` arguments (it is idempotent on an
 * already-absolute path), so the two now agree on what a path names.
 */
function resolveNb(nbPath?: string | null): string {
	return nbPath ? resolveNotebookPath(nbPath) : getActiveNotebookPath();
}

/**
 * Idle watchdog window for `execute()`. If a running cell's kernel produces NO
 * traffic at all — no iopub output, no status flip, no reply — for this long, the
 * kernel is treated as unresponsive (a stalled websocket, an undelivered
 * `execute_reply`, a dropped autorestart) and the run is aborted, so its queue slot
 * frees instead of wedging the notebook forever.
 *
 * It is an IDLE window, NOT a wall-clock timeout: ANY kernel activity RESETS it
 * (see `resetWatchdog` in `execute()`), so a legitimately long-running cell that
 * keeps emitting output — a training loop, a tqdm bar, steady prints — is NEVER
 * killed. That guarantee is non-negotiable, so the window is deliberately generous:
 * the manual "Restart kernel" control (which now force-aborts the active run) is the
 * INSTANT recovery path, and this watchdog is only the automatic backstop for a
 * kernel that has gone truly silent. Override with `CELLAR_KERNEL_IDLE_TIMEOUT_MS`
 * (milliseconds), primarily so tests can drive the trip with a tiny window.
 */
const DEFAULT_KERNEL_IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

function kernelIdleTimeoutMs(): number {
	const raw = process.env.CELLAR_KERNEL_IDLE_TIMEOUT_MS;
	if (raw == null || raw === '') return DEFAULT_KERNEL_IDLE_TIMEOUT_MS;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : DEFAULT_KERNEL_IDLE_TIMEOUT_MS;
}

/**
 * Thrown by `execute()` when a run is aborted before its reply arrives: either the
 * idle watchdog tripped (`reason: 'idle_watchdog'`) or a restart/autorestart/
 * teardown force-aborted the active future (`reason: 'kernel_restart'` etc.). The
 * caller (`executeCellRun`) catches it and turns it into an error output; because
 * `execute()` returns control to the caller, the owner's `finally` releases the
 * queue slot — unwedging the notebook.
 */
export class KernelExecuteAborted extends Error {
	reason: string;
	constructor(message: string, reason: string) {
		super(message);
		this.name = 'KernelExecuteAborted';
		this.reason = reason;
	}
}

/**
 * Force-abort every run currently awaiting `nbKernel`'s reply. Each aborted run's
 * `execute()` disposes its future and throws `KernelExecuteAborted`, so the run's
 * OWNER releases its queue slot through its existing `finally` — no second release
 * path. Called from restart / autorestart / teardown, whose kernel change destroys
 * the namespace the awaited reply belonged to (the reply may now never arrive).
 * `clearRunQueue` drops only PENDING runs; this covers the ACTIVE one, so a manual
 * restart actually rescues a wedged run.
 */
function abortActiveRuns(nbKernel: NotebookKernel, reason: string): void {
	if (nbKernel.activeRuns.size === 0) return;
	const runs = [...nbKernel.activeRuns];
	nbKernel.activeRuns.clear();
	for (const run of runs) {
		try {
			run.abort(reason);
		} catch {}
	}
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
		// Detect idle-culled kernels. The sidecar's MappingKernelManager culls a
		// kernel that has been idle past `cull_idle_timeout` (configured in
		// bin/cellar.js); when it does, the kernel vanishes from the server's running
		// list. The KernelManager polls that list (~10s) and fires `runningChanged`,
		// so we reconcile our Map against it: any kernel we hold that is gone
		// server-side was culled and must be torn down (card drops, epoch bumped, so
		// its cells correctly read "not run this session"). Feature-guarded so a mock
		// manager without the signal (unit tests) is a harmless no-op.
		manager.runningChanged?.connect?.(() => reconcileCulledKernels());
	}
	await manager.ready;
	return manager;
}

/**
 * Reconcile the kernel Map against the server's live running list: any kernel we
 * still hold whose connection is no longer running server-side was culled (idle
 * shutdown) — tear it down so its card drops and its epoch is invalidated. Driven
 * by the KernelManager's `runningChanged` poll. Safe to call repeatedly:
 * `teardownKernel` is idempotent (it removes the Map entry synchronously), so a
 * repeated poll can't double-process. A still-booting kernel (null connection) is
 * skipped — it isn't in the running list yet by our own doing, not a cull.
 */
function reconcileCulledKernels(): void {
	const mgr = manager;
	if (!mgr || typeof mgr.running !== 'function') return;
	const liveIds = new Set<string>();
	try {
		for (const model of mgr.running()) liveIds.add(model.id);
	} catch {
		return; // a transient poll error must never tear kernels down
	}
	for (const nbKernel of [...kernels.values()]) {
		const conn = nbKernel.connection;
		if (!conn) continue; // still starting — not a cull
		if (liveIds.has(conn.id)) continue; // still alive server-side
		logWarn('kernel', `kernel for ${nbKernel.nbPath} was culled by the sidecar (idle); reconciling`);
		void teardownKernel(nbKernel, 'kernel_culled', { alreadyGone: true }).then(publishKernelStatus);
	}
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
			openWidget(nbKernel.nbPath, commId, openState.state ?? {});
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
 * Register the `cellar.control` comm target on a freshly-connected kernel: the
 * channel a Cellar magic uses to ask the SERVER to act on this notebook's kernel.
 * Currently one op, `restart` (from `%restart_python`), which runs a managed
 * `restartKernel(nbPath)` for THIS notebook — the closure captures `nbKernel`, so
 * the restart targets the right kernel and never another notebook's.
 *
 * Registered once per kernel connection (like `registerWidgetComm`): a plain
 * `restart()`/autorestart keeps the connection and thus this target, while a
 * rebind builds a new connection and re-runs this via `getKernel()`.
 */
function registerControlComm(nbKernel: NotebookKernel, kernel: KernelConnection): void {
	try {
		kernel.registerCommTarget(CONTROL_COMM_TARGET, (comm, msg) => {
			handleControlData(nbKernel, msg.content?.data);
			comm.onMsg = (m: KernelMessage.ICommMsgMsg) => handleControlData(nbKernel, m.content?.data);
		});
	} catch (err) {
		// A control target that fails to register must never break kernel bring-up;
		// %restart_python just won't reach the server (it prints its friendly line and
		// the comm open is dropped).
		const message = err instanceof Error ? err.message : String(err);
		logWarn('kernel', `cellar control comm target not registered: ${message}`);
	}
}

/**
 * Act on a `cellar.control` payload. `restart` runs a managed restart of the
 * calling notebook's kernel, DEFERRED until the kernel is next idle: the restart
 * request arrives as an iopub `comm_open` WHILE the `%restart_python` cell is still
 * executing, and tearing the process down mid-run would reject that run's future
 * (surfacing a spurious error on the cell). Jupyter emits the kernel's `idle`
 * status only AFTER the cell's `execute_reply`, so waiting for idle guarantees the
 * run has completed (and its `run:end` published) before we restart. A bounded
 * fallback covers the pathological "no idle ever arrives" case.
 */
function handleControlData(nbKernel: NotebookKernel, data: unknown): void {
	if (controlOp(data) !== 'restart') return;
	const kernel = nbKernel.connection;
	if (!kernel) return;
	logInfo('kernel', `%restart_python requested for ${nbKernel.nbPath}`);
	void whenIdle(kernel).then(() => {
		// Guard against a rebind/teardown that replaced the connection while we waited:
		// only restart if this is still the notebook's live kernel.
		if (kernels.get(nbKernel.nbPath) !== nbKernel) return;
		return restartKernel(nbKernel.nbPath);
	}).catch((err: unknown) => {
		const message = err instanceof Error ? err.message : String(err);
		logError('kernel', `%restart_python restart failed for ${nbKernel.nbPath}: ${message}`);
	});
}

/**
 * Resolve once the kernel is idle: immediately if it already is, otherwise on its
 * next `idle` status. A bounded timeout resolves anyway so a caller can never hang
 * forever on a kernel that stops reporting status. The one-shot listener always
 * disconnects itself, so it never leaks.
 */
function whenIdle(kernel: KernelConnection, timeoutMs = 10000): Promise<void> {
	if (kernel.status === 'idle') return Promise.resolve();
	return new Promise<void>((resolve) => {
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			try {
				kernel.statusChanged.disconnect(handler);
			} catch {}
			clearTimeout(timer);
			resolve();
		};
		const handler: StatusListener = (_sender, status) => {
			if (status === 'idle') finish();
		};
		const timer = setTimeout(finish, timeoutMs);
		kernel.statusChanged.connect(handler);
	});
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
 * Kernel-status broadcast — deduped, with a coalescing (debounced) fast path.
 *
 * The Kernels sidebar reflects a start / busy / idle / restart / shutdown by
 * reading a full `kernel:status` snapshot (like `queue:changed`, no `seq`, so a
 * missed one self-heals). Two problems this layer solves:
 *   1. REDUNDANCY — the internal-probe / startup-injection busy/idle flurry, and
 *      repeated lifecycle calls, would each fan the SAME snapshot out to every open
 *      tab. `emitKernelStatus` skips a snapshot byte-identical to the last one sent,
 *      so an unchanged status never fans out. Seeding a fresh tab is independent
 *      (the SSE route calls `listKernels()` on connect; the client replays the last
 *      snapshot to a late in-tab subscriber), so a skipped duplicate is always safe.
 *   2. BURSTS — a single run produces several flips (busy → … → idle). The
 *      high-frequency path (`scheduleKernelStatus`, used by the `statusChanged`
 *      handler and user-run boundaries) COALESCES a burst into one trailing
 *      broadcast that captures the final state.
 */
let lastStatusSnapshot: string | null = null;
let statusDebounceTimer: ReturnType<typeof setTimeout> | null = null;

/** Debounce window for the coalesced status path (ms). Overridable so tests drive it. */
function statusDebounceMs(): number {
	const raw = process.env.CELLAR_KERNEL_STATUS_DEBOUNCE_MS;
	if (raw == null || raw === '') return 80;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : 80;
}

/** Fan the current kernel list out, unless it is byte-identical to the last one sent. */
function emitKernelStatus(): void {
	const kernelList = listKernels();
	const snapshot = JSON.stringify(kernelList);
	if (snapshot === lastStatusSnapshot) return; // nothing changed — no fan-out
	lastStatusSnapshot = snapshot;
	publishGlobal({ type: 'kernel:status', kernels: kernelList });
}

/**
 * Broadcast the kernel list NOW (deduped). Used by lifecycle transitions
 * (start / restart / shutdown / cull / rebind) — infrequent single events that
 * should reach tabs promptly. Cancels any pending coalesced broadcast, since this
 * one already carries the change.
 */
export function publishKernelStatus(): void {
	if (statusDebounceTimer) {
		clearTimeout(statusDebounceTimer);
		statusDebounceTimer = null;
	}
	emitKernelStatus();
}

/**
 * Broadcast the kernel list soon, coalescing a burst into ONE trailing message.
 * The high-frequency path: the `statusChanged` handler's user-run busy/idle flips
 * and the end-of-run boundary. A pending broadcast absorbs further calls and
 * captures the latest snapshot when it fires, so a run's flurry of flips collapses
 * to a single wire message.
 */
function scheduleKernelStatus(): void {
	if (statusDebounceTimer) return; // one already queued — it captures the latest state at fire time
	statusDebounceTimer = setTimeout(() => {
		statusDebounceTimer = null;
		emitKernelStatus();
	}, statusDebounceMs());
	// Never keep the Node process alive just to flush a status snapshot.
	statusDebounceTimer.unref?.();
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

/**
 * Best-effort: after a kernel restart has re-established a notebook's namespace,
 * ask the Databricks layer to rebuild that notebook's `spark`/`w` session against
 * the same profile+cluster it had before (a no-op if it had none). Detached and
 * error-swallowing so it can NEVER block or break the restart. Loaded dynamically
 * to keep databricks.ts's dependency on this module one-directional (no import
 * cycle) - the reconnect is a pure side effect, not part of the restart's result.
 */
async function reconnectDatabricksAfterRestart(nbPath: string): Promise<void> {
	try {
		const { reconnectAfterKernelRestart } = await import('./databricks');
		await reconnectAfterKernelRestart(nbPath);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logWarn('kernel', `Databricks reconnect after restart of ${nbPath} errored: ${message}`);
	}
}

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
	// Coalesce every startup injection into ONE round-trip in front of the first
	// user result. Each block is independently guarded (a matplotlib/pandas/IPython
	// failure degrades to a no-op) and defines-then-`del`s its own private temp
	// names, so they compose cleanly as consecutive top-level statements — running
	// them as one silent exec, rather than four serial `execute_reply`s, gets the
	// kernel ready sooner without dropping anything they establish. Runs on every
	// fresh start AND after a restart/autorestart (which clears the namespace, the
	// matplotlib backend, the DataFrame formatter, the magic, and sys.path).
	const parts = [
		// matplotlib inline backend → Figures emit image/png, not their text repr.
		STARTUP_CODE,
		// The Cellar DataFrame/Series display formatter (interactive grid mimetype).
		DATAFRAME_FORMATTER_CODE,
		// The %restart_python line magic (managed restart via the control comm).
		RESTART_MAGIC_CODE
	];
	// Add the workspace root to sys.path so a notebook in any subfolder can import
	// project modules (and the `.py` module the export writes at the root). Gated by
	// the per-workspace setting (default ON) and re-read here so a restart /
	// autorestart re-applies the current choice. Idempotent — never inserts a
	// duplicate (see projectRoot.ts).
	if (addProjectRootToPath()) parts.push(projectRootAddCode(workspaceRoot()));
	await runSilent(kernel, parts.join('\n\n'));
}

/**
 * Apply the "add workspace root to sys.path" setting to every LIVE kernel now, so
 * toggling it takes effect without a restart: ON inserts the root into each
 * running namespace's `sys.path`, OFF removes it. Kernels still starting are
 * skipped (their `connection` is null) — they pick up the current setting from
 * `initKernel` once up. The store must be updated BEFORE this is called so a
 * kernel finishing start mid-apply reads the new value. Idempotent.
 */
export async function applyProjectRootToLiveKernels(enabled: boolean): Promise<void> {
	const root = workspaceRoot();
	const code = enabled ? projectRootAddCode(root) : projectRootRemoveCode(root);
	const live = [...kernels.values()]
		.map((k) => k.connection)
		.filter((c): c is KernelConnection => c !== null);
	await Promise.all(live.map((c) => runSilent(c, code)));
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
		userRuns: 0,
		statusHandler: null,
		widgetComms: new Map(),
		activeRuns: new Set()
	};

	nbKernel.startPromise = (async () => {
		const mgr = await getManager();
		const kernel = await mgr.startNew({ name: 'python3' });
		nbKernel.connection = kernel;
		// Run every comm on the kernel's MAIN shell, not a per-comm-target subshell
		// (@jupyterlab/services' default under ipykernel 7). Cellar serializes runs
		// anyway, so it gains nothing from subshells — and a comm subshell is actively
		// harmful here: opening one issues a `create_subshell_request` whose future
		// `restart()` cancels, and @jupyterlab rejects that future WITHOUT an awaiter,
		// crashing the Node process (an unhandled rejection). `%restart_python` opens a
		// comm and then restarts, so it would hit this every time; a widget open racing
		// a restart hits the same latent trap. Disabling subshells removes it entirely
		// and matches classic-Jupyter comm behavior. Must be set before any comm opens.
		try {
			kernel.commsOverSubshells = CommsOverSubshells.Disabled;
		} catch {
			// Older @jupyterlab/services without the property: nothing to disable.
		}
		beginSession(nbKernel);
		// Register before any user code runs so a widget `comm_open` is never missed.
		registerWidgetComm(nbKernel, kernel);
		registerWidgetOutputCapture(kernel);
		// The control channel `%restart_python` signals the server on.
		registerControlComm(nbKernel, kernel);
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
			// Fan a flip out only when it can matter to a user:
			//   - a lifecycle transition (restarting / autorestarting / dead / …)
			//     always broadcasts;
			//   - a plain busy/idle flip broadcasts only while a USER run is in flight,
			//     so two notebooks running at once still show their own busy cards
			//     independently — but a flip caused solely by an internal probe
			//     (inspect/variables) or a startup injection (userRuns === 0) is
			//     suppressed, never flickering a card nor fanning out to every tab.
			// The broadcast is coalesced so a run's flurry of flips collapses to one.
			const isBusyIdle = status === 'idle' || status === 'busy';
			if (!isBusyIdle || nbKernel.userRuns > 0) scheduleKernelStatus();
			if (status !== 'autorestarting') return;
			logWarn('kernel', `kernel for ${nbPath} died and was autorestarted; namespace cleared`);
			beginSession(nbKernel);
			// The active run's reply will never arrive (the process died and was replaced),
			// so force-abort it — otherwise its queue slot never frees. Then drop pending
			// (submitted against the namespace that is now gone; see clearRunQueue).
			abortActiveRuns(nbKernel, 'kernel_autorestart');
			clearRunQueue(nbPath, 'kernel_autorestart');
			// Re-inject the startup code, THEN best-effort re-establish a Databricks
			// session if this notebook had one (both after the namespace is fresh).
			// Detached so a jupyter-driven autorestart is never blocked by either.
			void initKernel(kernel)
				.then(() => reconnectDatabricksAfterRestart(nbPath))
				.catch(() => {});
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
 * Free every kernel at or under a workspace path that a sidebar file-management
 * op just deleted — the notebook itself, or (when a folder was deleted) any
 * notebook nested under it. Deleting a notebook must free its Python process, not
 * just its document (`dropDocs` handles the doc). Idempotent: a path with no live
 * kernel is a no-op, matching `dropDocs`. Returns how many kernels were shut down.
 */
export async function shutdownKernelsUnder(deletedPath: string): Promise<number> {
	const deletedAbs = resolveNotebookPath(deletedPath);
	const prefix = deletedAbs + sep;
	const victims = [...kernels.values()].filter(
		(k) => k.nbPath === deletedAbs || k.nbPath.startsWith(prefix)
	);
	if (victims.length === 0) return 0;
	await Promise.all(victims.map((k) => teardownKernel(k, 'notebook_deleted')));
	publishKernelStatus();
	return victims.length;
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
	// Force-abort the ACTIVE run too: `clearRunQueue` drops only pending, so a run
	// stuck awaiting a reply this restart will destroy would keep its slot forever.
	// Its owner's `finally` then frees the slot — this is what makes a manual restart
	// actually rescue a wedged run.
	abortActiveRuns(nbKernel, 'kernel_restart');
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
	// If this notebook had a live Databricks session, rebuild it against the same
	// profile+cluster now the namespace is fresh. Detached (void) so it never blocks
	// the restart from returning; failures degrade to the honest ask-user state.
	void reconnectDatabricksAfterRestart(abs);
	return { status: kernel.status, id: kernel.id, session_id: nbKernel.sessionId };
}

/**
 * Tear a single notebook's kernel down: disconnect its handler, shut the process
 * down, drop its pending queue and widgets, and remove it from the Map. Used by
 * the explicit shutdown control, a per-notebook rebind, and idle-cull
 * reconciliation. Bumps the epoch so any cell stamped before teardown reads as
 * not-this-session, and publishes a per-notebook `kernel:shutdown` event so an
 * open tab refetches its run-status (its cells now read "not run this session").
 *
 * Idempotent: the Map entry is removed synchronously up front, so a concurrent
 * teardown (e.g. a cull poll racing an explicit shutdown) is a no-op the second
 * time. `alreadyGone` skips the REST shutdown call for a kernel the sidecar has
 * already removed (idle cull), disposing our local connection instead.
 */
async function teardownKernel(
	nbKernel: NotebookKernel,
	reason = 'kernel_rebind',
	{ alreadyGone = false }: { alreadyGone?: boolean } = {}
): Promise<void> {
	const { nbPath } = nbKernel;
	if (kernels.get(nbPath) !== nbKernel) return; // already torn down
	kernels.delete(nbPath);
	// The process is going away; abort any run awaiting its reply so its slot frees,
	// then drop pending runs (submitted against a namespace that is about to vanish).
	abortActiveRuns(nbKernel, reason);
	clearRunQueue(nbPath, reason);
	const conn = nbKernel.connection;
	if (conn) {
		try {
			if (nbKernel.statusHandler) conn.statusChanged.disconnect(nbKernel.statusHandler);
		} catch {}
		if (alreadyGone) {
			// The server already removed the kernel; just dispose our dead connection.
			try {
				conn.dispose?.();
			} catch {}
		} else {
			try {
				await conn.shutdown();
			} catch {}
		}
	}
	// The old namespace is gone; bump so its epoch can never read as current, and
	// drop this kernel's widgets from the store.
	beginSession(nbKernel);
	nbKernel.connection = null;
	nbKernel.statusHandler = null;
	// Invalidate this notebook's run-status in every open tab: with no live kernel
	// its cells must read "not run this session".
	publish({ type: 'kernel:shutdown', nb: nbPath, reason });
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

/**
 * Silently clear the user-defined DATA variables from notebook `nbPath`'s kernel
 * namespace — the "wipe variables to free memory" action — WITHOUT restarting.
 *
 * This is deliberately a scalpel, not a restart: the kernel process and its
 * session stay alive and the epoch is NOT bumped (so a subsequent cell runs
 * instantly, and any live Databricks session — whose liveness `databricks.ts`
 * reconciles against the epoch — stays connected). What it removes is exactly the
 * data variables the Variables inspector lists; it PRESERVES imports, user-defined
 * functions and classes, and every name in `preserve` (the caller passes
 * `['spark','w']` when a Databricks session is live, since deleting `spark` while
 * keeping the epoch would leave `connectionStatus()` falsely reporting connected).
 * It also flushes IPython's output cache (`_`, `__`, `Out[...]`), which otherwise
 * pins the last results in memory and would defeat the point of freeing state.
 *
 * Runs through `execute(..., {internal:true})` like every other Cellar probe, so
 * it bypasses the run queue (jupyter serializes it after any running cell) and
 * does not inflate `execs_this_session`. Never forces a start: a notebook whose
 * kernel is not running has nothing to wipe. Returns the names actually deleted so
 * the caller can invalidate the run-status of the cells that defined them.
 *
 * Other notebooks' kernels are untouched (this resolves and probes ONE kernel).
 */
export async function wipeKernelVariables(
	nbPath?: string | null,
	{ preserve = [] }: { preserve?: string[] } = {}
): Promise<{ status: string; cleared: string[]; session_id: SessionId | null; probe_failed?: boolean }> {
	const abs = resolveNb(nbPath);
	const nbKernel = kernels.get(abs);
	// No kernel → nothing in memory to clear. Never boot one just to wipe it.
	if (!nbKernel || !nbKernel.connection) return { status: 'not_started', cleared: [], session_id: null };
	const code = wipeProbeCode(preserve);
	let stdout = '';
	let session: SessionId | null = null;
	await execute(
		abs,
		code,
		(ev) => {
			if (ev.type === 'kernel') session = ev.session;
			else if (ev.type === 'output' && ev.output.output_type === 'stream' && ev.output.name === 'stdout') {
				stdout += Array.isArray(ev.output.text) ? ev.output.text.join('') : ev.output.text;
			}
		},
		{ internal: true }
	);
	// The probe deleted the names kernel-side regardless of whether we can parse its
	// printed summary; the parse only recovers WHICH names for staleness reflection.
	const line = stdout.trim().split('\n').filter(Boolean).at(-1);
	let cleared: string[] = [];
	let probe_failed = false;
	try {
		const parsed = line ? (JSON.parse(line) as { cleared?: unknown }) : null;
		if (parsed && Array.isArray(parsed.cleared)) cleared = parsed.cleared.map(String);
		else probe_failed = true;
	} catch {
		probe_failed = true;
	}
	// No epoch bump, no restart, no reconnect: the session the wipe ran in is still live.
	return { status: nbKernel.connection.status, cleared, session_id: session, ...(probe_failed ? { probe_failed: true } : {}) };
}

/**
 * Python for the wipe probe: classify the user namespace exactly as inspect.ts's
 * PROBE does (so "what the Variables inspector shows" and "what a wipe removes"
 * cannot disagree), delete the data variables, flush the output cache, and print
 * `{"cleared":[...]}`. Every name it binds is underscore-prefixed and deleted, so
 * the probe leaves no trace in the namespace. `preserve` is injected as a JSON
 * literal (valid Python) — imports/functions/classes are skipped structurally.
 */
function wipeProbeCode(preserve: string[]): string {
	return `
import json as _cellar_wj, inspect as _cellar_wi
def _cellar_wipe(_preserve):
    try:
        _ip = get_ipython(); _ns = _ip.user_ns; _hidden = set(_ip.user_ns_hidden)
    except Exception:
        _ip = None; _ns = globals(); _hidden = set()
    _skip = {'typing', 'abc', 'IPython.core.magic'}
    _keep = set(_preserve) | {'In', 'Out', 'exit', 'quit', 'get_ipython'}
    _cleared = []
    for _k, _v in list(_ns.items()):
        if _k.startswith('_') or _k in _hidden or _k in _keep:
            continue
        try:
            if (_cellar_wi.ismodule(_v) or _cellar_wi.isfunction(_v)
                    or _cellar_wi.isbuiltin(_v) or _cellar_wi.isroutine(_v)
                    or _cellar_wi.isclass(_v)):
                continue
        except Exception:
            continue
        if getattr(type(_v), '__module__', '') in _skip:
            continue
        _cleared.append(_k)
    for _k in _cleared:
        try:
            del _ns[_k]
        except Exception:
            pass
    # Flush the output cache (_, __, Out[...]) so wiped values are not pinned by history.
    try:
        if _ip is not None:
            _ip.displayhook.flush()
    except Exception:
        pass
    return _cleared
print(_cellar_wj.dumps({'cleared': _cellar_wipe(${JSON.stringify(preserve)})}))
del _cellar_wipe, _cellar_wj, _cellar_wi
`;
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
	if (!internal) {
		nbKernel.execsThisSession += 1;
		// A USER run: its busy/idle flips must reach the sidebar (see statusHandler).
		nbKernel.userRuns += 1;
	}
	onEvent({ type: 'kernel', id: kernel.id, session });

	const future = kernel.requestExecute({ code, stop_on_error: false });

	// --- Idle watchdog + force-abort -----------------------------------------
	// `await future.done` is unbounded: a stalled websocket, an undelivered
	// `execute_reply`, or a dropped autorestart would leave it pending forever, so
	// the run's queue slot never frees and the notebook can never run again. Guard it
	// two ways, both resolving through the SAME race below (never a second release):
	//   (1) an IDLE watchdog — if the kernel goes silent (no iopub, no status flip,
	//       no reply) for `idleMs`, the run aborts. `resetWatchdog` re-arms on ANY
	//       activity, so a long cell that keeps emitting output is never killed;
	//   (2) a force-abort handle in `nbKernel.activeRuns`, so restart/autorestart/
	//       teardown can settle THIS run (see `abortActiveRuns`).
	// Either trigger rejects the race; `execute()` then disposes the future and
	// throws `KernelExecuteAborted`, and the caller's `finally` releases the slot.
	const idleMs = kernelIdleTimeoutMs();
	let settled = false;
	let aborted = false;
	let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
	let abortReject: ((err: Error) => void) | null = null;
	const abortRace = new Promise<never>((_, reject) => {
		abortReject = reject;
	});
	// Swallow the race's own late rejection: after the run settles normally the
	// promise never rejects, and while it is live the `await` below handles it — this
	// only marks it handled so a post-settle no-op can never surface unhandled.
	abortRace.catch(() => {});
	const triggerAbort = (err: Error) => {
		if (settled || aborted) return;
		aborted = true;
		abortReject?.(err);
	};
	const resetWatchdog = () => {
		if (settled || aborted) return;
		if (watchdogTimer) clearTimeout(watchdogTimer);
		watchdogTimer = setTimeout(() => {
			triggerAbort(
				new KernelExecuteAborted(
					`Kernel went unresponsive (no activity for ${Math.round(idleMs / 1000)}s); run aborted. Restart the kernel to recover.`,
					'idle_watchdog'
				)
			);
		}, idleMs);
		// The watchdog must never keep the Node process alive on its own.
		watchdogTimer.unref?.();
	};
	const run: ActiveRun = {
		abort: (reason) => triggerAbort(new KernelExecuteAborted('Run aborted: the kernel was restarted.', reason))
	};
	nbKernel.activeRuns.add(run);
	resetWatchdog(); // arm before any traffic can arrive
	// A reply or stdin request on any channel is kernel activity: reset the watchdog.
	future.onReply = () => resetWatchdog();
	future.onStdin = () => resetWatchdog();

	// Output events carry a real nbformat output object under `output`, so the
	// caller can both stream them live to the browser AND accumulate them into
	// the cell's `outputs` for persistence — one shape, no divergence.
	// IOPub content is a dynamic Jupyter wire payload; narrow per msg_type.
	future.onIOPub = (msg: KernelMessage.IIOPubMessage) => {
		// Any iopub message (output, status flip, clear) is activity: keep the run alive.
		resetWatchdog();
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

	try {
		const reply = await Promise.race([future.done, abortRace]);
		onEvent({ type: 'done', status: reply.content.status, execution_count: (reply.content as { execution_count?: number | null }).execution_count ?? null, session });
		return reply.content;
	} finally {
		settled = true;
		if (watchdogTimer) clearTimeout(watchdogTimer);
		nbKernel.activeRuns.delete(run);
		if (!internal) {
			nbKernel.userRuns -= 1;
			// Reflect the now-idle kernel promptly, without depending on the idle
			// `statusChanged` flip's timing (it can land after userRuns hit 0 and be
			// suppressed). Coalesced + deduped, so this is at most one extra broadcast.
			scheduleKernelStatus();
		}
		// On an abort (watchdog trip or restart) the future is still live, awaiting a
		// reply that may never arrive: dispose it so its handlers detach. A future that
		// completed normally has already disposed itself, so only dispose when aborted.
		if (aborted) {
			try {
				future.dispose();
			} catch {}
		}
	}
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
