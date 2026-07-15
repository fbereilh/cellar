/**
 * Cellar — MCP agent-interface service layer.
 *
 * Transport-independent implementations of the core agent tools (spec §4).
 * Built on the shared in-process notebook document + kernel, so it exposes
 * *live* state and stays decoupled from kernel lifecycle. Every function is
 * UUID-addressed and honors per-cell hide/show: a cell with
 * `metadata.cellar.hidden_from_agent === true` never appears in any map, read,
 * search, section, or execution result.
 */
import {
	listCells,
	getCell,
	getNotebook,
	addCell,
	setSource,
	setCellType,
	deleteCell,
	moveCellTo,
	setVisibility,
	getActiveNotebookPath,
	resolveNotebookPath,
	workspaceRelative,
	createNotebook as createNotebookDoc,
	openNotebook as openNotebookDoc,
	notebookExists
} from '../notebook';
import { restartKernel, interruptKernel, kernelStatus, kernelSession, currentSessionId } from '../kernel';
import { kernelState, listVariables as _listVariables, inspectVariable as _inspectVariable } from '../inspect';
import { agentStatus as databricksStatus, forAgent as databricksCatalog, previewTable } from '../databricks';
import { publish } from '../events';
import { enqueueRun, queuesByNotebook, queuePosition } from '../run-queue';
import { executeCellRun, clearOutputsForQueue } from '../run';
import { consolidateImports, routeImports, runImportsCell } from '../imports-cell';
import { buildTree } from '../fstree';
import { getNotebookStaleness } from '../dataflow';
import { STALE_STATE, staleIdsInOrder } from '../../staleness';
import type { StalenessEntry, StalenessMap } from '../../staleness';
import { isSqlCell } from '../../cellLanguage';
import { autoCheckpointBeforeAgentAction, createCheckpoint } from '../checkpoints';
import type { CellView, CellOutput, SessionId, LogicalCellType, QueueState } from '../types';

// Output tiering caps (chars). Reads summarize; get_full_output is medium by
// default and only returns everything on explicit size=full.
const READ_CAP = 800;
const MEDIUM_CAP = 4000;

const asText = (s: unknown): string => (Array.isArray(s) ? s.join('') : ((s as string) ?? ''));
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
const stripAnsi = (s: string): string => (typeof s === 'string' ? s.replace(ANSI, '') : s);

const isHidden = (c: CellView): boolean => c.metadata?.cellar?.hidden_from_agent === true;
const visibleCells = (nb?: string | null): CellView[] => listCells(nb).filter((c) => !isHidden(c));

// --- per-MCP-session working notebook ---------------------------------------
//
// The captain runs many agents against ONE Cellar, each on its own notebook.
// Before this, every agent tool resolved to the single global "active" notebook
// (getActiveNotebookPath) — which is also the user's focused tab — so two agents
// could not work two notebooks, and the user switching tabs redirected every
// agent. The server model underneath is already per-notebook (docs keyed by
// absolute path; every op accepts an `nb` target); only the MCP tools hard-wired
// to "active".
//
// The fix: each MCP session (one per connected `cellar mcp` stdio bridge, keyed
// by its Streamable-HTTP `Mcp-Session-Id`, surfaced to every tool call as
// `extra.sessionId`) may PIN its own working notebook here. Targeting resolves
// as: explicit per-call `notebook` > this session's pin > the global active
// notebook (the backward-compatible fallback for a lone agent that never pins).
// A session's pin is wholly decoupled from the user's focus: switching the user's
// tab never touches it, and an agent pinning/editing its notebook never steals
// the user's focus (open/create surface it focus:false).
const sessionNotebooks = new Map<string, string>(); // mcp sessionId -> absolute notebook path

/** Whether this MCP session has pinned a working notebook. */
function isPinned(sessionId?: string | null): boolean {
	return !!(sessionId && sessionNotebooks.has(sessionId));
}

/**
 * The absolute notebook path a tool call targets. Precedence:
 *   1. an explicit per-call `notebook` (a one-off cross-notebook operation),
 *   2. this session's pinned working notebook,
 *   3. the global active notebook (the user's focused tab) — the fallback for a
 *      single agent that never declared a working notebook.
 * Explicit + pinned targets are resolved to the same canonical absolute id the
 * `docs` Map and every notebook op key on.
 */
export function targetFor(sessionId?: string | null, explicit?: string | null): string {
	if (explicit != null && String(explicit).trim()) return resolveNotebookPath(explicit);
	if (sessionId) {
		const pin = sessionNotebooks.get(sessionId);
		if (pin) return pin;
	}
	return getActiveNotebookPath();
}

/**
 * Pin THIS MCP session's working notebook without stealing the user's focus.
 * Opens the notebook (creating it when it does not exist), records the
 * session→notebook binding, and surfaces it as an AVAILABLE tab (focus:false) so
 * an open UI shows it without yanking the user off their current tab. This is how
 * an agent declares "I am working here"; every subsequent read/write/run from
 * this session defaults to it, regardless of which tab the user later focuses.
 */
export function useNotebook(sessionId: string | undefined, name: string) {
	let rel = (name ?? '').trim();
	if (!rel) throw new Error('use_notebook requires a notebook name. Use list_notebooks to see existing notebooks; a name that does not exist yet is created.');
	if (!/\.ipynb$/i.test(rel)) rel += '.ipynb';
	const existed = notebookExists(rel);
	// createNotebookDoc opens an existing file or creates a new one; focus:false
	// keeps the user's tab where it is.
	const nb = createNotebookDoc(rel, null, { focus: false });
	if (sessionId) sessionNotebooks.set(sessionId, nb.path);
	return {
		working_notebook: workspaceRelative(nb.path),
		path: nb.path,
		created: !existed,
		pinned: !!sessionId,
		cells: cellCount(nb),
		note: sessionId
			? 'Pinned as this session\'s working notebook. Your reads/writes/runs now default to it; pass notebook:"other.ipynb" for a one-off cross-notebook op.'
			: 'Opened, but this connection exposes no session id, so it could not be pinned; operations still default to the active notebook.'
	};
}

/**
 * This session's current working-notebook target, and whether it is a genuine
 * pin or the active-notebook fallback — so an agent can confirm where its edits
 * will land, and notice when an unpinned target could move as the user switches
 * tabs.
 */
export function currentNotebook(sessionId?: string) {
	const pinned = isPinned(sessionId);
	const abs = targetFor(sessionId);
	return {
		working_notebook: workspaceRelative(abs),
		path: abs,
		pinned,
		source: pinned ? 'session_pin' : 'active_fallback',
		active_notebook: workspaceRelative(getActiveNotebookPath()),
		...(pinned ? {} : { note: 'No working notebook pinned: defaulting to the user\'s active tab, which moves when they switch tabs. Call use_notebook(name) to pin your own.' })
	};
}

function firstLine(src: string, cap = 80): string {
	const line = (src || '').split('\n').find((l) => l.trim()) ?? '';
	return line.length > cap ? line.slice(0, cap) + '…' : line;
}

/** Markdown header info (level 1-6 + title) or null. */
function headerInfo(cell: CellView): { level: number; title: string } | null {
	if (cell.cell_type !== 'markdown') return null;
	const line = (cell.source || '').split('\n').find((l) => l.trim()) ?? '';
	const m = /^(#{1,6})\s+(.*)$/.exec(line.trim());
	return m ? { level: m[1].length, title: m[2].trim() } : null;
}

function hasOutput(cell: CellView): boolean {
	return cell.cell_type === 'code' && (cell.outputs || []).length > 0;
}

/**
 * The one definition of "ran this session": a recorded run epoch identifies the
 * live namespace only when a kernel is up and the epochs match.
 *
 * @param {number|null|undefined} session epoch a run was stamped with
 * @param {number|null} sid current epoch, or null when no kernel is running
 */
const isLiveSession = (session: SessionId | null | undefined, sid: SessionId | null): boolean =>
	sid != null && session === sid;

/**
 * Did this cell execute against the kernel namespace that is live right now?
 *
 * A cell's `outputs` are persisted in the `.ipynb` and outlive both the kernel
 * and the server process, so they say nothing about the current session. The
 * runtime-only `cellar.lastRun.session` stamp (see notebook.js `setLastRun`)
 * does: it equals the kernel-session epoch the run started in, and a restart /
 * rebind / autorestart bumps that epoch.
 *
 * @param {object} cell
 * @param {number|null} sid current epoch, or null when no kernel is running
 */
function ranThisSession(cell: CellView, sid: SessionId | null): boolean {
	if (cell.cell_type !== 'code') return false;
	return isLiveSession(cell.metadata?.cellar?.lastRun?.session, sid);
}

/**
 * Did the last run attempt fail because no kernel could be reached, AND is the
 * kernel still unreachable? Recorded by the run entry points on the runtime-only
 * lastRun stamp, so it can never be read off disk.
 *
 * The liveness check (`sid == null` — no kernel is running) is what keeps the
 * signal honest. The stamp alone is sticky: only re-running that one cell clears
 * it, so the boot race — MCP serves before the Jupyter sidecar finishes starting,
 * an agent's first `run_cell` is rejected, the sidecar comes up moments later —
 * would leave that cell claiming a LIVE kernel-down failure forever while every
 * other cell runs fine. Deriving it means the marker expires by itself the instant
 * a kernel exists, and the cell falls back to `error_persisted`: its saved
 * CellarError really is leftover from an attempt that executed in no session.
 * Same shape as `ran_this_session`, likewise derived by comparing epochs rather
 * than stored as a boolean.
 *
 * @param {object} cell
 * @param {number|null} sid current epoch, or null when no kernel is running
 */
const kernelUnavailable = (cell: CellView, sid: SessionId | null): boolean =>
	sid == null && cell.metadata?.cellar?.lastRun?.kernel_unavailable === true;

/**
 * Per-cell run status, with persisted and live-session execution kept strictly
 * apart — conflating them is what lets an agent build on variables that were
 * never defined this session:
 *
 *   n/a                       markdown cell
 *   unrun                     no saved outputs, and it has not run this session
 *   ok_session                ran this session, no error
 *   error_session             ran this session and raised
 *   ok_persisted              saved outputs from a PREVIOUS session; nothing it defines exists now
 *   error_persisted           saved error output from a PREVIOUS session
 *   error_kernel_unavailable  the kernel could not be reached; this failure is LIVE, not leftover
 *
 * For a cell that ran this session the recorded run status is authoritative — a
 * cell can run successfully and emit no outputs at all (`lp = load()`), which
 * output inspection alone would misreport as `unrun`. Only an explicit `ok`
 * counts as success; jupyter's `abort` (and anything else) reads as an error, so
 * an agent is never told a run succeeded when it did not.
 *
 * `error_kernel_unavailable` is a status about the RUN ATTEMPT and is orthogonal
 * to `ran_this_session`, which stays false: no code executed in any session. It
 * exists so a failure raised seconds ago by the run the agent just requested is
 * never mislabelled `error_persisted`, which the doctrine tells agents to ignore
 * as leftover. It reports only while the kernel is still unreachable — once one
 * is up, the saved CellarError genuinely is leftover and reads as
 * `error_persisted` (see `kernelUnavailable`).
 */
function runStatus(cell: CellView, sid: SessionId | null): string {
	if (cell.cell_type !== 'code') return 'n/a';
	if (ranThisSession(cell, sid)) {
		return cell.metadata?.cellar?.lastRun?.status === 'ok' ? 'ok_session' : 'error_session';
	}
	if (kernelUnavailable(cell, sid)) return 'error_kernel_unavailable';
	const outs = cell.outputs || [];
	if (!outs.length) return 'unrun';
	return outs.some((o) => o.output_type === 'error') ? 'error_persisted' : 'ok_persisted';
}

// Outputs carry `data` only on execute_result/display_data; guard before probing.
const imageKey = (o: CellOutput): string | undefined => {
	const data = 'data' in o ? o.data : undefined;
	return data ? Object.keys(data).find((k) => k.startsWith('image/')) : undefined;
};

function outputText(o: CellOutput): string {
	switch (o.output_type) {
		case 'stream':
			return asText(o.text);
		case 'execute_result':
		case 'display_data': {
			const d = o.data || {};
			if (d['text/plain']) return asText(d['text/plain']);
			const img = imageKey(o);
			return img ? `[${img} output]` : '[rich output]';
		}
		case 'error':
			return stripAnsi((o.traceback || [o.ename + ': ' + o.evalue]).join('\n'));
		default:
			return '';
	}
}

/** Cap text, with a dataframe-aware shape+head summary for pandas reprs. */
function capText(text: string, cap: number): { text: string; truncated: boolean } {
	const df = text.match(/\[(\d+) rows x (\d+) columns\]/);
	if (df) {
		const lines = text.split('\n');
		const head = lines.slice(0, 12).join('\n');
		return {
			text: lines.length > 12 ? head + `\n… (dataframe: ${df[1]} rows × ${df[2]} columns)` : text,
			truncated: lines.length > 12
		};
	}
	if (text.length > cap) return { text: text.slice(0, cap) + `\n… [truncated ${text.length - cap} chars, use get_full_output]`, truncated: true };
	return { text, truncated: false };
}

/**
 * Collapse library-internal middle frames of a Python traceback so the parts that
 * identify the culprit survive a cap: the exception header, EVERY user (notebook)
 * frame, and the FIRST and LAST frames are always kept; a contiguous run of
 * site-packages/stdlib frames between them becomes a `… N library frames elided …`
 * marker. Deliberately conservative — it only acts when it can cleanly parse ≥4
 * frame openers, and returns the text unchanged otherwise, so it never mangles a
 * traceback it doesn't understand. The full, un-elided stack stays reachable via
 * `get_full_output(id, size:'full')` (that path passes cap=Infinity, which skips
 * this entirely).
 */
function elideTraceback(text: string): string {
	const lines = text.split('\n');
	// Frame openers across IPython + classic Python: "Cell In[N], line X",
	// "File <path>:X, in ...", and '  File "<path>", line X, in ...'.
	const isOpener = (l: string) => /^Cell In\[/.test(l) || /^File .+?:\d+/.test(l) || /^\s*File ".+?", line \d+/.test(l);
	const starts: number[] = [];
	for (let i = 0; i < lines.length; i++) if (isOpener(lines[i])) starts.push(i);
	if (starts.length < 4) return text; // too few frames to be worth eliding / to parse confidently
	const head = lines.slice(0, starts[0]);
	// A block runs from its opener to the next opener (the last block also holds the
	// trailing `ename: evalue` line), so always keeping the last block keeps the tail.
	const blocks = starts.map((from, k) => lines.slice(from, k + 1 < starts.length ? starts[k + 1] : lines.length));
	const isLibrary = (opener: string) => /site-packages|dist-packages|[/\\]lib[/\\]python|<frozen /.test(opener);
	const out = [...head];
	let elided = 0;
	const flush = () => {
		if (elided) out.push(`… ${elided} library frame${elided > 1 ? 's' : ''} elided …`);
		elided = 0;
	};
	blocks.forEach((block, i) => {
		const keep = i === 0 || i === blocks.length - 1 || !isLibrary(block[0]);
		if (keep) {
			flush();
			out.push(...block);
		} else {
			elided++;
		}
	});
	flush();
	return out.join('\n');
}

function summarizeOutput(o: CellOutput, cap: number) {
	const base: Record<string, unknown> = { type: o.output_type };
	if (o.output_type === 'error') Object.assign(base, { ename: o.ename, evalue: o.evalue });
	const img = imageKey(o);
	if (img) base.image = img;
	let text = outputText(o);
	// Elide library frames only when capping; the full stack must survive size='full'.
	if (o.output_type === 'error' && cap !== Infinity) text = elideTraceback(text);
	return { ...base, ...capText(text, cap) };
}

const summarizeOutputs = (cell: CellView, cap: number) => (cell.outputs || []).map((o) => summarizeOutput(o, cap));

/**
 * The staleness annotation for a read/run result, from a per-cell verdict
 * (`$lib/staleness.js`). Always carries `stale_state` (not_run / fresh / stale /
 * n/a); a stale cell additionally carries WHY and the upstream cell ids that made
 * it stale, so an agent knows exactly what to re-run before trusting the output.
 */
function staleFields(entry: StalenessEntry | undefined | null): Record<string, unknown> {
	if (!entry) return {};
	const out: Record<string, unknown> = { stale_state: entry.state };
	if (entry.state === STALE_STATE.STALE) {
		out.stale = true;
		out.stale_reason = entry.reason;
		if (entry.upstream?.length) out.stale_upstream = entry.upstream;
	}
	return out;
}

function readForm(cell: CellView, cap = READ_CAP, sid: SessionId | null = currentSessionId(), staleEntry: StalenessEntry | null = null) {
	return {
		id: cell.id,
		type: cell.cell_type,
		...(isSqlCell(cell) ? { language: 'sql' } : {}),
		source: cell.source,
		run_status: runStatus(cell, sid),
		...staleFields(staleEntry),
		outputs: summarizeOutputs(cell, cap)
	};
}

// --- lifecycle --------------------------------------------------------------

// Each notebook has its OWN kernel, so every lifecycle op resolves to the
// notebook the caller is targeting (its pinned working notebook, via `targetFor`
// in server.ts). An agent restarting/interrupting its kernel therefore touches
// ONLY its own notebook — never the user's or another agent's namespace.
export const kernel = {
	restart: (nb?: string | null) => restartKernel(nb),
	interrupt: (nb?: string | null) => interruptKernel(nb),
	// `id` is the only field unique to kernelStatus(); both report the same
	// `status`, so let kernelSession() be its single source of truth.
	status: (nb?: string | null) => ({ id: kernelStatus(nb).id, ...kernelSession(nb) })
};

/**
 * List every `.ipynb` in the workspace so the agent can discover names to open.
 * Walks the workspace file tree (skipping noise dirs) and marks which notebook
 * is currently active. Paths are workspace-relative (what `open_notebook` and
 * `create_notebook` accept).
 */
export function listNotebooks(sessionId?: string) {
	const activeAbs = getActiveNotebookPath();
	const workingAbs = targetFor(sessionId);
	const paths: string[] = [];
	// Structural view of an fstree node; the walk only needs these fields.
	interface TreeNodeLike {
		type: string;
		name: string;
		path: string;
		children?: TreeNodeLike[];
	}
	const walk = (nodes: TreeNodeLike[]) => {
		for (const n of nodes) {
			if (n.type === 'dir') walk(n.children || []);
			else if (n.type === 'file' && /\.ipynb$/i.test(n.name)) paths.push(n.path);
		}
	};
	const { root, tree } = buildTree();
	walk(tree as TreeNodeLike[]);
	paths.sort();
	return {
		working_notebook: workspaceRelative(workingAbs),
		notebooks_pinned: isPinned(sessionId),
		workspace: root,
		// `active` = the user's focused tab; `working` = THIS session's target (its
		// pin, or the active notebook when unpinned). They differ whenever an agent
		// pinned a notebook other than the one the user is looking at.
		notebooks: paths.map((rel) => {
			const abs = resolveNotebookPath(rel);
			return { path: rel, active: abs === activeAbs, working: abs === workingAbs };
		})
	};
}

const cellCount = (nb: { cells?: unknown[] }) => (nb.cells ? nb.cells.length : 0);

/**
 * Open and focus an EXISTING workspace notebook by name, making it the active
 * notebook and broadcasting `notebook:opened` so an open browser surfaces/
 * focuses its tab live. `name` is a workspace `.ipynb` path (extension
 * optional). Throws with a create_notebook pointer when it does not exist —
 * open never creates.
 */
export function openNotebook(sessionId: string | undefined, name: string) {
	let rel = (name ?? '').trim();
	if (!rel) throw new Error('open_notebook requires a notebook name. Use list_notebooks to see available notebooks, or create_notebook to make a new one.');
	if (!/\.ipynb$/i.test(rel)) rel += '.ipynb';
	if (!notebookExists(rel)) {
		throw new Error(`Notebook "${rel}" does not exist. Use list_notebooks to see workspace notebooks, or create_notebook("${rel}") to make a new one.`);
	}
	// Opening is this agent declaring "I am working here": pin it as the session's
	// working notebook, and surface it focus:false so the user's tab is not stolen.
	const nb = openNotebookDoc(rel, null, { focus: false });
	if (sessionId) sessionNotebooks.set(sessionId, nb.path);
	return { working_notebook: workspaceRelative(nb.path), path: nb.path, workspace: nb.workspace, cells: cellCount(nb), pinned: !!sessionId };
}

/**
 * Create a NEW workspace notebook (or open one if the name already exists) and
 * make it active. `name` is an optional `.ipynb` filename (defaults to
 * `untitled.ipynb`); the `.ipynb` suffix is added if missing. Broadcasts
 * `notebook:opened` so an open browser surfaces the notebook in a tab live.
 * For opening a notebook you know already exists, prefer open_notebook.
 * Returns its path + cell count.
 */
export function createNotebook(sessionId: string | undefined, name?: string) {
	let rel = (name ?? '').trim() || 'untitled';
	if (!/\.ipynb$/i.test(rel)) rel += '.ipynb';
	// Creating is likewise a declaration of intent: pin it, and don't steal focus.
	const nb = createNotebookDoc(rel, null, { focus: false });
	if (sessionId) sessionNotebooks.set(sessionId, nb.path);
	return { working_notebook: workspaceRelative(nb.path), path: nb.path, workspace: nb.workspace, cells: cellCount(nb), pinned: !!sessionId };
}

// --- read -------------------------------------------------------------------

/**
 * Hierarchical section tree derived from markdown headers (spec §4).
 *
 * The `kernel` header reports the live session, so a consumer can see at a
 * glance that the WHOLE map predates the current kernel: with
 * `kernel.started: false` (or `execs_this_session: 0`) every `*_persisted`
 * status is saved output from an earlier session and nothing those cells define
 * exists in the namespace. `kernel_state` remains the live truth.
 */
export async function getNotebookMap(nb?: string | null) {
	const cells = visibleCells(nb);
	const { sid, cells: stale }: { sid: SessionId | null; cells: StalenessMap } = await getNotebookStaleness(nb);
	// A section node holds nested cell/section entries; a cell leaf is a plain record.
	interface MapSection {
		id: string;
		type: 'markdown';
		level: number;
		title: string;
		children: unknown[];
	}
	const root: unknown[] = [];
	const stack: { node: MapSection; level: number }[] = [];
	const leaf = (c: CellView) => ({
		id: c.id,
		type: c.cell_type,
		...(isSqlCell(c) ? { language: 'sql' } : {}),
		summary: firstLine(c.source),
		run_status: runStatus(c, sid),
		...staleFields(stale[c.id]),
		has_output: hasOutput(c)
	});
	for (const c of cells) {
		const h = headerInfo(c);
		if (h) {
			const node: MapSection = { id: c.id, type: 'markdown', level: h.level, title: h.title, children: [] };
			while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
			(stack.length ? stack[stack.length - 1].node.children : root).push(node);
			stack.push({ node, level: h.level });
		} else {
			(stack.length ? stack[stack.length - 1].node.children : root).push(leaf(c));
		}
	}
	const view = getNotebook(nb);
	// The `kernel` header reports THIS notebook's own session epoch, so it lines up
	// with each cell's run_status/ran_this_session (each computed against the same
	// per-notebook epoch), never against whichever notebook the user last focused.
	// The map ships only whether a Databricks session is bound - the actionable
	// "ask the user to connect" note lives on `databricks_status`/`get_kernel_state`,
	// so we don't repeat ~150 chars of boilerplate on every map call.
	const dbx = await databricksStatus(nb);
	return { notebook: view.path, kernel: kernelSession(nb), databricks: { connected: dbx.connected === true }, cell_count: cells.length, sections: root };
}

/**
 * Live kernel namespace, bucketed into imports / functions / classes /
 * variables. Returns `{ started: false }` when no kernel is running rather than
 * forcing a boot.
 *
 * Carries the Databricks connection alongside it, because `spark` and `w` are
 * exactly the kind of namespace fact this tool exists to report - and an agent
 * that knows a live cluster session is bound will use it instead of writing the
 * connection boilerplate this integration replaces. The flag is epoch-checked
 * against the same kernel session the namespace was read from, so a restart that
 * destroyed `spark` reads as disconnected here too.
 */
export async function getKernelState(nb?: string | null) {
	// Read THIS notebook's own namespace + epoch; each notebook has its own kernel,
	// so kernel_state for A must reflect A's session, never the active tab's.
	const [state, stale, dbx] = await Promise.all([kernelState(nb), staleCells(nb), databricksStatus(nb)]);
	return { ...state, databricks: dbx, stale_cells: stale };
}

/**
 * MCP `list_variables` / `inspect_variable`. Thin pass-throughs to the shared
 * kernel introspection (`inspect.js`) - the SAME internal-execute probe plumbing
 * the Variables sidebar and `kernel_state` use, so no user code runs and exec
 * counts are untouched. Read-only; reflect only the live kernel session.
 */
export function getVariables(nb?: string | null) {
	return _listVariables(nb);
}
export function inspectVariable(name: string, nb?: string | null) {
	return _inspectVariable(name, nb);
}

/**
 * The visible cells whose live result is STALE — their inputs changed since they
 * last ran — as `[{ id, reason, upstream }]` in document order. Handed to the
 * agent in kernel_state so it can re-run (or distrust) them before relying on
 * their outputs, the same way the UI's stale indicator warns a human.
 */
async function staleCells(nb?: string | null) {
	const { cells }: { cells: StalenessMap } = await getNotebookStaleness(nb);
	const out: Array<{ id: string; reason?: string; upstream?: string[] }> = [];
	for (const c of visibleCells(nb)) {
		const e = cells[c.id];
		if (e?.state === STALE_STATE.STALE) {
			out.push({ id: c.id, reason: e.reason, ...(e.upstream?.length ? { upstream: e.upstream } : {}) });
		}
	}
	return out;
}

/**
 * Agent-facing Databricks tools. The Unity Catalog listings reuse the *same*
 * server-side SDK plumbing as the UI's data browser (`databricks.js`), so the
 * two views can never disagree; `preview` reads through the kernel's `spark`
 * without touching the notebook - an agent peeking at a table must not append a
 * cell to the human's document (the UI's own preview deliberately does, since
 * there the cell IS the deliverable).
 *
 * Every one of these throws a `DatabricksError` with code `not_connected` when
 * there is no live session. Connecting stays a human action, in the sidebar.
 */
export const databricks = {
	status: (nb?: string | null) => databricksStatus(nb),
	catalogs: (nb?: string | null) => databricksCatalog.catalogs(nb),
	schemas: (catalog: string, nb?: string | null) => databricksCatalog.schemas(catalog, nb),
	tables: (catalog: string, schema: string, nb?: string | null) => databricksCatalog.tables(catalog, schema, nb),
	preview: (name: string, limit?: number, nb?: string | null) => previewTable({ name, limit, nb })
};

export async function readCell(id: string, nb?: string | null) {
	const c = getCell(id, nb);
	if (!c || isHidden(c)) return null;
	const { sid, cells: stale }: { sid: SessionId | null; cells: StalenessMap } = await getNotebookStaleness(nb);
	return readForm(c, READ_CAP, sid, stale[id]);
}

/**
 * Read many cells against ONE sampled epoch + one staleness pass. Letting
 * `readForm` re-sample per cell would let a restart landing mid-loop classify a
 * single response against two different kernel sessions — some cells `ok_session`,
 * some `ok_persisted` — for the same kernel state.
 */
export async function readCells(ids: string[], nb?: string | null) {
	const { sid, cells: stale }: { sid: SessionId | null; cells: StalenessMap } = await getNotebookStaleness(nb);
	return ids
		.map((id) => {
			const c = getCell(id, nb);
			if (!c || isHidden(c)) return null;
			return readForm(c, READ_CAP, sid, stale[id]);
		})
		.filter(Boolean);
}

/** index (0-based over visible cells), position first/last, or next/prev of an id. */
export async function readByLocation({ index, position, relativeTo, direction }: {
	index?: number;
	position?: 'first' | 'last';
	relativeTo?: string;
	direction?: 'prev' | 'next';
}, nb?: string | null) {
	const cells = visibleCells(nb);
	if (!cells.length) return null;
	let target: CellView | null | undefined = null;
	if (typeof index === 'number') target = cells[index];
	else if (position === 'first') target = cells[0];
	else if (position === 'last') target = cells[cells.length - 1];
	else if (relativeTo) {
		const i = cells.findIndex((c) => c.id === relativeTo);
		if (i < 0) return null;
		target = direction === 'prev' ? cells[i - 1] : cells[i + 1];
	}
	if (!target) return null;
	const { sid, cells: stale }: { sid: SessionId | null; cells: StalenessMap } = await getNotebookStaleness(nb);
	return readForm(target, READ_CAP, sid, stale[target.id]);
}

/** Cells under a markdown header (until the next same-or-higher header). */
export async function readSection(headerId: string, nb?: string | null) {
	const cells = visibleCells(nb);
	const idx = cells.findIndex((c) => c.id === headerId);
	if (idx < 0) return null;
	const h = headerInfo(cells[idx]);
	if (!h) return null;
	const out = [cells[idx]];
	for (let i = idx + 1; i < cells.length; i++) {
		const hi = headerInfo(cells[i]);
		if (hi && hi.level <= h.level) break;
		out.push(cells[i]);
	}
	// One sampled epoch + staleness pass for the whole section (see readCells).
	const { sid, cells: stale }: { sid: SessionId | null; cells: StalenessMap } = await getNotebookStaleness(nb);
	return { header: { id: cells[idx].id, level: h.level, title: h.title }, cells: out.map((c) => readForm(c, READ_CAP, sid, stale[c.id])) };
}

/**
 * Search cell sources and saved outputs. Every row carries `ran_this_session`:
 * an output snippet from a cell that has not run this session was deserialized
 * from the `.ipynb` and describes a namespace that no longer exists.
 */
export function searchCells(query: string, where: 'input' | 'output' | 'both' = 'both', nb?: string | null) {
	const q = (query || '').toLowerCase();
	if (!q) return [];
	const sid = currentSessionId(nb);
	const results: Array<{ id: string; where: string; ran_this_session: boolean; snippet: string }> = [];
	const snippet = (text: string): string | null => {
		const i = text.toLowerCase().indexOf(q);
		if (i < 0) return null;
		const start = Math.max(0, i - 40);
		return (start > 0 ? '…' : '') + text.slice(start, i + q.length + 40).replace(/\n/g, ' ') + '…';
	};
	for (const c of visibleCells(nb)) {
		const live = ranThisSession(c, sid);
		if (where === 'input' || where === 'both') {
			const s = snippet(c.source || '');
			if (s) results.push({ id: c.id, where: 'input', ran_this_session: live, snippet: s });
		}
		if (where === 'output' || where === 'both') {
			const otext = (c.outputs || []).map(outputText).join('\n');
			const s = snippet(otext);
			if (s) results.push({ id: c.id, where: 'output', ran_this_session: live, snippet: s });
		}
	}
	return results;
}

/**
 * Cells whose saved outputs contain an error. `ran_this_session` separates an
 * error the current kernel really raised from one deserialized out of the
 * `.ipynb` — chasing the latter debugs a previous session. `kernel_unavailable`
 * marks the third case: the run could not reach a kernel at all, so despite
 * `ran_this_session: false` the failure is LIVE and blocking, not leftover.
 */
export function getErrors(nb?: string | null) {
	const sid = currentSessionId(nb);
	const errs: Array<Record<string, unknown>> = [];
	for (const c of visibleCells(nb)) {
		for (const o of c.outputs || []) {
			if (o.output_type === 'error') {
				errs.push({
					id: c.id,
					run_status: runStatus(c, sid),
					...(kernelUnavailable(c, sid) ? { kernel_unavailable: true } : {}),
					ename: o.ename,
					evalue: o.evalue,
					// Multi-error SCAN tool: cap each stack at READ_CAP (not MEDIUM_CAP) and
					// elide library frames - the truncation marker + get_full_output reach the rest.
					traceback: capText(elideTraceback(stripAnsi((o.traceback || []).join('\n'))), READ_CAP).text
				});
			}
		}
	}
	return errs;
}

/**
 * Tiered: medium cap by default; full only on size='full'. Images passed through.
 * `ran_this_session: false` means these outputs were saved by a PREVIOUS session
 * - they describe a namespace that no longer exists.
 */
export function getFullOutput(id: string, size: 'medium' | 'full' = 'medium', nb?: string | null) {
	const c = getCell(id, nb);
	if (!c || isHidden(c)) return null;
	const cap = size === 'full' ? Infinity : MEDIUM_CAP;
	const outputs: Array<Record<string, unknown>> = (c.outputs || []).map((o) => {
		const img = imageKey(o);
		if (img && 'data' in o) return { type: o.output_type, image: img, data: o.data[img] };
		return summarizeOutput(o, cap);
	});
	return { id: c.id, size, ran_this_session: ranThisSession(c, currentSessionId(nb)), outputs };
}

// --- write ------------------------------------------------------------------

/**
 * Lift the module-level imports out of code an agent is writing into a cell and
 * merge them into the notebook's imports cell (wherever it is designated).
 *
 * This is a pure DOCUMENT edit; it never runs the kernel. Running the imports
 * cell is the caller's job (`finishImportRouting`) precisely because a write tool
 * may route several cells' worth of code at once: they merge into one cell, so
 * they must produce exactly one run, not one run per cell.
 *
 * Routing is the default for every write tool and opt-out-able per call
 * (`route_imports: false`). Only agent writes are routed: a human typing an
 * import into their own cell is never touched (see `imports-cell.js`).
 *
 * Returns the code with its imports removed and the statements that were new, or
 * `null` when nothing was routed — so a tool that routed nothing says nothing
 * about imports.
 */
function routeOne(
	source: string,
	nb: string,
	{ routeEnabled, cellType = 'code', skipCellId = null }: { routeEnabled?: boolean; cellType?: string; skipCellId?: string | null } = {}
) {
	if (!routeEnabled || cellType !== 'code') return null;
	const routed = routeImports(source ?? '', nb, undefined, { skipCellId });
	// No imports at all (or none we could parse): the source is untouched, so say so.
	if (routed.source === source && !routed.added.length) return null;
	return routed;
}

/**
 * Run the imports cell once for a write that routed something, and build the
 * `imports` report the tool result carries. `added` empty means every routed
 * import was already in the cell — the kernel has them, so there is nothing to
 * run; the lines were still stripped, because a duplicate import helps nobody.
 *
 * `nb` is pinned by the caller at the start of the write, not re-read here: the
 * UI may focus another notebook while the imports cell waits in the run queue,
 * and this run belongs to the notebook the code was written into.
 */
async function finishImportRouting(nb: string, cellId: string | null, added: string[]) {
	if (!added.length) return { cell_id: cellId, added: [] as string[], note: 'already present in the imports cell; removed from your code' };
	const run = await runImportsCell(nb, 'agent');
	return {
		cell_id: cellId,
		added,
		run_status: run?.status ?? 'not_run',
		// A failed imports cell (a missing package) is surfaced, never swallowed:
		// every cell the agent writes next depends on it.
		...(run?.status === 'error' ? { outputs: (run.outputs ?? []).map((o) => summarizeOutput(o, READ_CAP)) } : {}),
		...(run?.note ? { note: run.note } : {})
	};
}

/**
 * Sweep every module-level import in the active notebook into its imports cell
 * and run it. Idempotent; see `imports-cell.js`.
 */
export async function consolidate(nb?: string | null) {
	const target = nb ?? getActiveNotebookPath();
	autoCheckpointBeforeAgentAction(target);
	return consolidateImports(target, { actor: 'agent' });
}

/**
 * Snapshot the active notebook to a restorable checkpoint (agent-facing). The
 * agent can call this to deliberately mark a good state; it is a manual save
 * point (trigger `manual`), distinct from the automatic pre-action `agent`
 * snapshots Cellar takes before each agent mutation/run. Keeping it `manual`
 * means "undo last agent action" targets only those automatic pre-action
 * snapshots — never a save point the agent chose to keep.
 */
export function checkpoint(label?: string, nb?: string | null) {
	const target = nb ?? getActiveNotebookPath();
	return createCheckpoint(target, { trigger: 'manual', label: label || 'Agent checkpoint' });
}

/**
 * Add cells, routing their imports first. Every spec routes into the SAME imports
 * cell, so they merge once and the cell runs once — not once per cell.
 *
 * A spec that routing empties (its source was nothing but imports) creates no
 * cell: its imports are in the imports cell, and an empty cell beside them is
 * litter. An explicitly empty source still creates its empty cell.
 */
export async function addCells(
	specs: Array<{ cell_type?: string; source?: string }>,
	afterId?: string | null,
	{ routeImports: routeEnabled = true, nb: nbArg }: { routeImports?: boolean; nb?: string | null } = {}
) {
	const nb = nbArg ?? getActiveNotebookPath();
	autoCheckpointBeforeAgentAction(nb);
	const bodies: Array<{ cellType: string; source: string }> = [];
	const added: string[] = [];
	let importsCellId: string | null = null;
	for (const spec of specs) {
		const cellType = spec.cell_type || 'code';
		const routed = routeOne(spec.source ?? '', nb, { routeEnabled, cellType });
		if (routed) {
			added.push(...routed.added);
			importsCellId = routed.importsCellId ?? importsCellId;
			if (!routed.source.trim()) continue; // wholly routed away
		}
		bodies.push({ cellType, source: routed ? routed.source : (spec.source ?? '') });
	}

	let anchor = afterId;
	const created: string[] = [];
	for (const body of bodies) {
		const cell = addCell(anchor, body.cellType as LogicalCellType, nb);
		if (body.source) setSource(cell.id, body.source, nb);
		created.push(cell.id);
		anchor = cell.id;
	}
	const imports = importsCellId ? await finishImportRouting(nb, importsCellId, added) : null;
	return { ids: created, ...(imports ? { imports } : {}) };
}

export async function editCell(id: string, source: string, { routeImports: routeEnabled = true, nb: nbArg }: { routeImports?: boolean; nb?: string | null } = {}) {
	const nb = nbArg ?? getActiveNotebookPath();
	const cell = getCell(id, nb);
	if (!cell) return null;
	autoCheckpointBeforeAgentAction(nb);
	// A SQL cell is a `code` cell on disk, but its source is SQL - never route
	// "imports" out of it. Pass the LOGICAL type so routeOne's `!== 'code'` guard skips it.
	const logicalType = isSqlCell(cell) ? 'sql' : cell.cell_type;
	const routed = routeOne(source, nb, { routeEnabled, cellType: logicalType, skipCellId: id });
	setSource(id, routed ? routed.source : source, nb);
	const imports = routed ? await finishImportRouting(nb, routed.importsCellId, routed.added) : null;
	return { ok: true, id, ...(imports ? { imports } : {}) };
}

export function removeCell(id: string, nb?: string | null) {
	const target = nb ?? getActiveNotebookPath();
	if (!getCell(id, target)) return false;
	autoCheckpointBeforeAgentAction(target);
	deleteCell(id, target);
	return true;
}

export function moveCell(id: string, pos: number, nb?: string | null) {
	const target = nb ?? getActiveNotebookPath();
	autoCheckpointBeforeAgentAction(target);
	return moveCellTo(id, pos, target);
}

export function setType(id: string, type: LogicalCellType, nb?: string | null) {
	const target = nb ?? getActiveNotebookPath();
	if (!getCell(id, target)) return false;
	autoCheckpointBeforeAgentAction(target);
	setCellType(id, type, target);
	return true;
}

export function setCellVisibility(id: string, hidden: boolean, nb?: string | null) {
	return setVisibility(id, hidden, nb ?? getActiveNotebookPath());
}

// --- execute ----------------------------------------------------------------

/**
 * The run queue across every notebook, as a per-notebook map
 * `{ [relPath]: {running, queue} }`. Each notebook has its own kernel and its own
 * FIFO, so an agent's run only ever waits behind ITS OWN notebook's cells — this
 * map lets the agent see that (and see whether another notebook is busy) rather
 * than a single global queue. `working` names the caller's pinned notebook so the
 * agent can find its own slice; a notebook with no active/pending run is absent
 * (its queue is empty). Reads only; never boots a kernel.
 */
export function getRunQueue(sessionId?: string) {
	const workingAbs = targetFor(sessionId);
	const byAbs = queuesByNotebook();
	const notebooks: Record<string, QueueState> = {};
	for (const [abs, state] of Object.entries(byAbs)) notebooks[workspaceRelative(abs)] = state;
	return { working: workspaceRelative(workingAbs), notebooks };
}

/**
 * Run one cell by id. A markdown cell doesn't execute on the kernel; running it
 * RENDERS it (flips every open tab to its rendered view via `cell:rendered`) and
 * returns `status:'rendered'`; no queue, no persist (rendered-ness is view-only).
 *
 * Broadcasts the run lifecycle (`run:start` / `run:output` per streamed chunk /
 * `run:end`) over the event bus tagged `actor:'agent'`, so an already-open
 * browser shows this agent-driven run — running indicator + streaming outputs —
 * with no reload. `runCells`/`runAll`/`runRange` all funnel through here, so
 * every MCP run path broadcasts.
 *
 * QUEUEING. One kernel means one run at a time app-wide, so an agent's run
 * requested while a user's (or another agent call's) cell is executing takes a
 * ticket in the kernel-global FIFO instead of being dropped or racing into the
 * kernel. Two shapes tell the agent what happened, and neither ever claims a run
 * finished when it did not:
 *
 *   - The cell is already queued (or already running) → returns immediately with
 *     `status: "queued"` (or `"running"`) and its `queue_position`. A pending run
 *     has its source refreshed; nothing is ever enqueued twice.
 *   - It had to wait its turn → the call BLOCKS until the kernel frees, then runs
 *     and returns the real outputs, annotated `queued: true` + the
 *     `queue_position` it was accepted at + `waited_ms`.
 *
 * Waiting (rather than returning `queued` and making the agent poll) is what
 * keeps `run_cells` / `run_all` / `run_range` meaning "these cells ran, here is
 * what they printed": they drive this function sequentially and depend on its
 * outputs. `run_queue` shows the pending list at any time; `interrupt_kernel` /
 * `restart_kernel` drop it, and a dropped run returns `status: "cancelled"`.
 */
export async function runCell(id: string, nbArg?: string | null): Promise<Record<string, unknown> | null> {
	const nbAtCall = nbArg ?? getActiveNotebookPath();
	const c = getCell(id, nbAtCall);
	if (!c) return null;
	// Snapshot before this agent run so it can be undone (throttled: one checkpoint
	// per N agent actions, not one per cell). Captures the pre-run outputs.
	autoCheckpointBeforeAgentAction(nbAtCall);
	if (c.cell_type === 'markdown') {
		// Markdown doesn't execute on the kernel; "running" it RENDERS it (the same
		// state the UI's Shift+Enter produces). No queue, no persist: rendered-ness
		// is a view concern, so the .ipynb stays clean. Broadcast `cell:rendered` so
		// every open tab flips this cell to its rendered view (no originId: an agent
		// run has none, so every tab renders it).
		publish({ type: 'cell:rendered', nb: nbAtCall, cellId: id });
		return { id, status: 'rendered', note: 'markdown cell rendered (no kernel execution)' };
	}
	if (c.cell_type !== 'code') return { id, status: 'skipped', note: 'not a code cell' };
	// Pin the notebook now: the UI may focus another one while we wait in the
	// queue, and this run must land in the document it was requested against.
	const nb = nbAtCall;

	const ticket = enqueueRun({ nb, cellId: id, actor: 'agent', source: c.source || '' });
	if (ticket.duplicate) {
		// This cell is already in the kernel's hands. Say which — "queued" and
		// "running" are both "accepted, not finished", and neither is an error.
		const position = queuePosition(nb, id);
		return position
			? { id, status: 'queued', queue_position: position, note: `already queued at position ${position}; its source was refreshed to the current one. It will run when the kernel frees.` }
			: { id, status: 'running', queue_position: 0, note: 'already executing in the kernel right now; not enqueued again.' };
	}
	// Clear this cell's stale output the moment it is queued (an agent run carries no
	// originId, so every open tab empties it right away), rather than leaving the
	// prior output under the "queued · N" badge until the kernel frees.
	clearOutputsForQueue({ nb, cellId: id });
	const queuedAt = ticket.queued ? Date.now() : 0;
	const acceptedPosition = ticket.position;
	try {
		await ticket.wait();
	} catch (err) {
		// A restart / interrupt / rebind dropped this pending run before any kernel
		// touched it: nothing executed, nothing to persist, no lastRun stamp.
		const reason = (err as { reason?: string })?.reason ?? 'cancelled';
		return { id, status: 'cancelled', reason, ran_this_session: false, note: 'the queued run was dropped before it started (the kernel was interrupted or restarted).' };
	}
	const queuedInfo = queuedAt ? { queued: true, queue_position: acceptedPosition, waited_ms: Date.now() - queuedAt } : {};

	try {
		// Re-read the cell: it may have been edited (or deleted) while queued.
		const cell = getCell(id, nb);
		if (!cell) return { id, status: 'cancelled', reason: 'cell_removed', ran_this_session: false, ...queuedInfo };
		// One shared execution core with the UI route and the imports cell (`run.js`):
		// execute, persist, stamp the kernel-session epoch, broadcast the lifecycle.
		const { outputs, status, session, kernelDown } = await executeCellRun({
			nb,
			cellId: id,
			actor: 'agent',
			source: ticket.source() ?? cell.source ?? ''
		});
		const hiddenNote = isHidden(cell) ? { hidden: true } : {};
		// The run may have made downstream cells stale (this one just re-ran) or
		// cleared this cell's own staleness — surface its fresh verdict so a follow-up
		// read is not needed just to see whether the run settled it.
		const { cells: stale }: { cells: StalenessMap } = await getNotebookStaleness(nb);
		return { id, status, ran_this_session: isLiveSession(session, currentSessionId(nb)), ...(kernelDown ? { kernel_unavailable: true } : {}), ...staleFields(stale[id]), ...queuedInfo, ...hiddenNote, outputs: outputs.map((o) => summarizeOutput(o, READ_CAP)) };
	} finally {
		// Hand the kernel to the next queued run only once this one has persisted and
		// broadcast, so the wire order stays run:end → run:start.
		ticket.done();
	}
}

/**
 * Create a cell and (if it's code) run it in one call — the common
 * write-and-execute flow, without a separate add_cell + run_cell round-trip.
 * Composes addCells + runCell (no reimplementation), so structural sync
 * (`cell:added`) and the run lifecycle (`run:start`/`run:output`/`run:end`,
 * `actor:'agent'`) both fire and the new cell surfaces + streams live in an
 * open UI exactly like run_cell. Returns run_cell's result shape (id / status /
 * summarized outputs) — the created cell's id is that same `id`. Code that
 * raises returns the error as its result (never throws); a markdown cell is
 * created AND rendered (markdown doesn't execute on the kernel, so running it
 * renders it), returning `status:'rendered'` to mirror run_cell; this is the
 * intended way to add markdown, so it shows rendered rather than raw source.
 *
 * Import routing (the default) happens BEFORE the cell is created, so the imports
 * cell has already run by the time this cell executes and the code that needed
 * `pd` finds it. Source that is nothing BUT imports creates no cell at all: its
 * imports are in the imports cell, and an empty cell beside them is litter.
 */
export async function addAndRun({ source, cellType = 'code', afterId, routeImports: routeEnabled = true, nb: nbArg }: {
	source?: string;
	cellType?: LogicalCellType;
	afterId?: string | null;
	routeImports?: boolean;
	nb?: string | null;
} = {}) {
	const nb = nbArg ?? getActiveNotebookPath();
	const routed = routeOne(source ?? '', nb, { routeEnabled, cellType });
	const body = routed ? routed.source : (source ?? '');
	// Run the imports cell BEFORE the new cell, so the code that needs `pd` finds it.
	const imports = routed ? await finishImportRouting(nb, routed.importsCellId, routed.added) : null;

	if (routed && imports && !body.trim()) {
		// The submitted code was nothing but imports. They now live in the imports
		// cell; an empty cell beside it would be litter, so report that cell instead.
		const cell = imports.cell_id ? getCell(imports.cell_id, nb) : null;
		return {
			id: imports.cell_id,
			status: ('run_status' in imports ? imports.run_status : undefined) ?? 'skipped',
			routed_to_imports: true,
			note: "the submitted code was only imports; they were merged into the notebook's imports cell and no new cell was created.",
			ran_this_session: cell ? ranThisSession(cell, currentSessionId(nb)) : false,
			imports,
			outputs: cell ? summarizeOutputs(cell, READ_CAP) : []
		};
	}
	// Routing already happened (once), so the add must not route a second time.
	const { ids } = await addCells([{ cell_type: cellType, source: body }], afterId, { routeImports: false, nb });
	const id = ids[0];
	const result = await runCell(id, nb);
	return { id, ...result, ...(imports ? { imports } : {}) };
}

/**
 * Run cells one at a time, in order, each waiting its turn in the kernel queue.
 * Stops at the first run a restart/interrupt cancelled: the rest of the sequence
 * was written against a namespace that no longer exists, so running it would
 * execute cell N+1 without cell N's definitions.
 */
export async function runCells(ids: string[], nb?: string | null) {
	const target = nb ?? getActiveNotebookPath();
	const results: Array<Record<string, unknown>> = [];
	for (const id of ids) {
		const r = await runCell(id, target);
		const cell = getCell(id, target);
		if (r && !(cell && isHidden(cell))) results.push(r);
		if (r?.status === 'cancelled') break;
	}
	return results;
}

/** Run every code cell in document order; hidden cells run but are omitted from results. */
export async function runAll(nb?: string | null) {
	const target = nb ?? getActiveNotebookPath();
	const ids = listCells(target).filter((c) => c.cell_type === 'code').map((c) => c.id);
	return runCells(ids, target);
}

/**
 * Run every STALE code cell, in document order — which is dependency
 * (topological) order for the preceding-definer graph, so a cell always runs
 * after the upstreams that made it stale. This is the agent-side counterpart of
 * the UI's "Run all stale" action: one call to bring the whole notebook back in
 * sync with its current code. Hidden cells run but are omitted from results
 * (same as run_all). Returns the run results plus which cells were run.
 */
export async function runStale(nb?: string | null) {
	const target = nb ?? getActiveNotebookPath();
	const { cells: stale }: { cells: StalenessMap } = await getNotebookStaleness(target);
	const ids = staleIdsInOrder(listCells(target), stale);
	const results = await runCells(ids, target);
	return { ran: ids, results };
}

/** Run code cells in the inclusive document range from→to. */
export async function runRange(fromId: string, toId: string, nb?: string | null) {
	const target = nb ?? getActiveNotebookPath();
	const all = listCells(target);
	const i = all.findIndex((c) => c.id === fromId);
	const j = all.findIndex((c) => c.id === toId);
	if (i < 0 || j < 0) return [];
	const [lo, hi] = i <= j ? [i, j] : [j, i];
	const ids = all.slice(lo, hi + 1).filter((c) => c.cell_type === 'code').map((c) => c.id);
	return runCells(ids, target);
}
