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
	setOutputs,
	setLastRun,
	deleteCell,
	moveCellTo,
	setVisibility,
	getActiveNotebookPath,
	resolveNotebookPath,
	createNotebook as createNotebookDoc,
	openNotebook as openNotebookDoc,
	notebookExists
} from '../notebook.js';
import { execute, restartKernel, interruptKernel, kernelStatus, kernelSession, currentSessionId } from '../kernel.js';
import { kernelState } from '../inspect.js';
import { publish } from '../events.js';
import { enqueueRun, queueState, queuePosition } from '../run-queue.js';
import { buildTree } from '../fstree.js';

// Output tiering caps (chars). Reads summarize; get_full_output is medium by
// default and only returns everything on explicit size=full.
const READ_CAP = 800;
const MEDIUM_CAP = 4000;

const asText = (s) => (Array.isArray(s) ? s.join('') : (s ?? ''));
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
const stripAnsi = (s) => (typeof s === 'string' ? s.replace(ANSI, '') : s);

const isHidden = (c) => c.metadata?.cellar?.hidden_from_agent === true;
const visibleCells = () => listCells().filter((c) => !isHidden(c));

function firstLine(src, cap = 80) {
	const line = (src || '').split('\n').find((l) => l.trim()) ?? '';
	return line.length > cap ? line.slice(0, cap) + '…' : line;
}

/** Markdown header info (level 1-6 + title) or null. */
function headerInfo(cell) {
	if (cell.cell_type !== 'markdown') return null;
	const line = (cell.source || '').split('\n').find((l) => l.trim()) ?? '';
	const m = /^(#{1,6})\s+(.*)$/.exec(line.trim());
	return m ? { level: m[1].length, title: m[2].trim() } : null;
}

function hasOutput(cell) {
	return cell.cell_type === 'code' && (cell.outputs || []).length > 0;
}

/**
 * The one definition of "ran this session": a recorded run epoch identifies the
 * live namespace only when a kernel is up and the epochs match.
 *
 * @param {number|null|undefined} session epoch a run was stamped with
 * @param {number|null} sid current epoch, or null when no kernel is running
 */
const isLiveSession = (session, sid) => sid != null && session === sid;

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
function ranThisSession(cell, sid) {
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
const kernelUnavailable = (cell, sid) =>
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
function runStatus(cell, sid) {
	if (cell.cell_type !== 'code') return 'n/a';
	if (ranThisSession(cell, sid)) {
		return cell.metadata.cellar.lastRun.status === 'ok' ? 'ok_session' : 'error_session';
	}
	if (kernelUnavailable(cell, sid)) return 'error_kernel_unavailable';
	const outs = cell.outputs || [];
	if (!outs.length) return 'unrun';
	return outs.some((o) => o.output_type === 'error') ? 'error_persisted' : 'ok_persisted';
}

const imageKey = (o) => o.data && Object.keys(o.data).find((k) => k.startsWith('image/'));

function outputText(o) {
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
function capText(text, cap) {
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

function summarizeOutput(o, cap) {
	const base = { type: o.output_type };
	if (o.output_type === 'error') Object.assign(base, { ename: o.ename, evalue: o.evalue });
	const img = imageKey(o);
	if (img) base.image = img;
	return { ...base, ...capText(outputText(o), cap) };
}

const summarizeOutputs = (cell, cap) => (cell.outputs || []).map((o) => summarizeOutput(o, cap));

function readForm(cell, cap = READ_CAP, sid = currentSessionId()) {
	return {
		id: cell.id,
		type: cell.cell_type,
		source: cell.source,
		run_status: runStatus(cell, sid),
		ran_this_session: ranThisSession(cell, sid),
		has_output: hasOutput(cell),
		visible: !isHidden(cell),
		outputs: summarizeOutputs(cell, cap)
	};
}

// --- lifecycle --------------------------------------------------------------

export const kernel = {
	restart: () => restartKernel(),
	interrupt: () => interruptKernel(),
	// `id` is the only field unique to kernelStatus(); both report the same
	// `status`, so let kernelSession() be its single source of truth.
	status: () => ({ id: kernelStatus().id, ...kernelSession() })
};

/**
 * List every `.ipynb` in the workspace so the agent can discover names to open.
 * Walks the workspace file tree (skipping noise dirs) and marks which notebook
 * is currently active. Paths are workspace-relative (what `open_notebook` and
 * `create_notebook` accept).
 */
export function listNotebooks() {
	const activeAbs = getActiveNotebookPath();
	const paths = [];
	const walk = (nodes) => {
		for (const n of nodes) {
			if (n.type === 'dir') walk(n.children || []);
			else if (n.type === 'file' && /\.ipynb$/i.test(n.name)) paths.push(n.path);
		}
	};
	const { root, tree } = buildTree();
	walk(tree);
	paths.sort();
	return {
		workspace: root,
		notebooks: paths.map((rel) => ({ path: rel, active: resolveNotebookPath(rel) === activeAbs }))
	};
}

const cellCount = (nb) => (nb.cells ? nb.cells.length : 0);

/**
 * Open and focus an EXISTING workspace notebook by name, making it the active
 * notebook and broadcasting `notebook:opened` so an open browser surfaces/
 * focuses its tab live. `name` is a workspace `.ipynb` path (extension
 * optional). Throws with a create_notebook pointer when it does not exist —
 * open never creates.
 */
export function openNotebook(name) {
	let rel = (name ?? '').trim();
	if (!rel) throw new Error('open_notebook requires a notebook name. Use list_notebooks to see available notebooks, or create_notebook to make a new one.');
	if (!/\.ipynb$/i.test(rel)) rel += '.ipynb';
	if (!notebookExists(rel)) {
		throw new Error(`Notebook "${rel}" does not exist. Use list_notebooks to see workspace notebooks, or create_notebook("${rel}") to make a new one.`);
	}
	const nb = openNotebookDoc(rel);
	return { path: nb.path, workspace: nb.workspace, cells: cellCount(nb) };
}

/**
 * Create a NEW workspace notebook (or open one if the name already exists) and
 * make it active. `name` is an optional `.ipynb` filename (defaults to
 * `untitled.ipynb`); the `.ipynb` suffix is added if missing. Broadcasts
 * `notebook:opened` so an open browser surfaces the notebook in a tab live.
 * For opening a notebook you know already exists, prefer open_notebook.
 * Returns its path + cell count.
 */
export function createNotebook(name) {
	let rel = (name ?? '').trim() || 'untitled';
	if (!/\.ipynb$/i.test(rel)) rel += '.ipynb';
	const nb = createNotebookDoc(rel);
	return { path: nb.path, workspace: nb.workspace, cells: cellCount(nb) };
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
export function getNotebookMap() {
	const cells = visibleCells();
	const sid = currentSessionId();
	const root = [];
	const stack = [];
	const leaf = (c) => ({
		id: c.id,
		kind: 'cell',
		type: c.cell_type,
		summary: firstLine(c.source),
		run_status: runStatus(c, sid),
		ran_this_session: ranThisSession(c, sid),
		has_output: hasOutput(c),
		visible: true
	});
	for (const c of cells) {
		const h = headerInfo(c);
		if (h) {
			const node = { id: c.id, kind: 'section', type: 'markdown', level: h.level, title: h.title, summary: h.title, visible: true, children: [] };
			while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
			(stack.length ? stack[stack.length - 1].node.children : root).push(node);
			stack.push({ node, level: h.level });
		} else {
			(stack.length ? stack[stack.length - 1].node.children : root).push(leaf(c));
		}
	}
	const nb = getNotebook();
	return { notebook: nb.path, kernel: kernelSession(), cell_count: cells.length, sections: root };
}

/**
 * Live kernel namespace, bucketed into imports / functions / classes /
 * variables. Returns `{ started: false }` when no kernel is running rather than
 * forcing a boot.
 */
export function getKernelState() {
	return kernelState();
}

export function readCell(id, sid = currentSessionId()) {
	const c = getCell(id);
	if (!c || isHidden(c)) return null;
	return readForm(c, READ_CAP, sid);
}

/**
 * Read many cells against ONE sampled epoch. Letting `readForm` re-sample per
 * cell would let a restart landing mid-loop classify a single response against
 * two different kernel sessions — some cells `ok_session`, some `ok_persisted`,
 * for the same kernel state.
 */
export function readCells(ids) {
	const sid = currentSessionId();
	return ids.map((id) => readCell(id, sid)).filter(Boolean);
}

/** index (0-based over visible cells), position first/last, or next/prev of an id. */
export function readByLocation({ index, position, relativeTo, direction }) {
	const cells = visibleCells();
	if (!cells.length) return null;
	let target = null;
	if (typeof index === 'number') target = cells[index];
	else if (position === 'first') target = cells[0];
	else if (position === 'last') target = cells[cells.length - 1];
	else if (relativeTo) {
		const i = cells.findIndex((c) => c.id === relativeTo);
		if (i < 0) return null;
		target = direction === 'prev' ? cells[i - 1] : cells[i + 1];
	}
	return target ? readForm(target) : null;
}

/** Cells under a markdown header (until the next same-or-higher header). */
export function readSection(headerId) {
	const cells = visibleCells();
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
	// One sampled epoch for the whole section (see readCells).
	const sid = currentSessionId();
	return { header: { id: cells[idx].id, level: h.level, title: h.title }, cells: out.map((c) => readForm(c, READ_CAP, sid)) };
}

/**
 * Search cell sources and saved outputs. Every row carries `ran_this_session`:
 * an output snippet from a cell that has not run this session was deserialized
 * from the `.ipynb` and describes a namespace that no longer exists.
 */
export function searchCells(query, where = 'both') {
	const q = (query || '').toLowerCase();
	if (!q) return [];
	const sid = currentSessionId();
	const results = [];
	const snippet = (text) => {
		const i = text.toLowerCase().indexOf(q);
		if (i < 0) return null;
		const start = Math.max(0, i - 40);
		return (start > 0 ? '…' : '') + text.slice(start, i + q.length + 40).replace(/\n/g, ' ') + '…';
	};
	for (const c of visibleCells()) {
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
export function getErrors() {
	const sid = currentSessionId();
	const errs = [];
	for (const c of visibleCells()) {
		for (const o of c.outputs || []) {
			if (o.output_type === 'error') {
				errs.push({
					id: c.id,
					ran_this_session: ranThisSession(c, sid),
					run_status: runStatus(c, sid),
					...(kernelUnavailable(c, sid) ? { kernel_unavailable: true } : {}),
					ename: o.ename,
					evalue: o.evalue,
					traceback: capText(stripAnsi((o.traceback || []).join('\n')), MEDIUM_CAP).text
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
export function getFullOutput(id, size = 'medium') {
	const c = getCell(id);
	if (!c || isHidden(c)) return null;
	const cap = size === 'full' ? Infinity : MEDIUM_CAP;
	const outputs = (c.outputs || []).map((o) => {
		const img = imageKey(o);
		if (img) return { type: o.output_type, image: img, data: o.data[img] };
		return summarizeOutput(o, cap);
	});
	return { id: c.id, size, ran_this_session: ranThisSession(c, currentSessionId()), outputs };
}

// --- write ------------------------------------------------------------------

export function addCells(specs, afterId) {
	let anchor = afterId;
	const created = [];
	for (const spec of specs) {
		const cell = addCell(anchor, spec.cell_type || 'code');
		if (spec.source) setSource(cell.id, spec.source);
		created.push(cell.id);
		anchor = cell.id;
	}
	return created;
}

export function editCell(id, source) {
	if (!getCell(id)) return false;
	setSource(id, source);
	return true;
}

export function removeCell(id) {
	if (!getCell(id)) return false;
	deleteCell(id);
	return true;
}

export function moveCell(id, pos) {
	return moveCellTo(id, pos);
}

export function setType(id, type) {
	if (!getCell(id)) return false;
	setCellType(id, type);
	return true;
}

export function setCellVisibility(id, hidden) {
	return setVisibility(id, hidden);
}

// --- execute ----------------------------------------------------------------

/**
 * Run code, collecting its outputs and handing the caller - via `onSession`, so
 * it survives the throw path - the kernel-session epoch the run STARTED in.
 * Stamping that (rather than reading the epoch after the run) means a kernel
 * restart mid-run leaves the cell correctly marked as not-this-session.
 */
async function runSource(source, onOutput, onSession) {
	const outputs = [];
	const reply = await execute(source, (ev) => {
		if (ev.type === 'output') {
			outputs.push(ev.output);
			onOutput?.(ev.output);
		} else if (ev.type === 'kernel') {
			onSession?.(ev.session);
		}
	});
	return { outputs, status: reply?.status ?? 'ok' };
}

/**
 * The kernel's run queue: what is executing and what is waiting behind it,
 * across every open notebook (there is one kernel, so there is one queue).
 */
export function getRunQueue() {
	return queueState();
}

/**
 * Run one cell by id; markdown cells are skipped (no kernel).
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
export async function runCell(id) {
	const nbAtCall = getActiveNotebookPath();
	const c = getCell(id, nbAtCall);
	if (!c) return null;
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
	const queuedAt = ticket.queued ? Date.now() : 0;
	const acceptedPosition = ticket.position;
	try {
		await ticket.wait();
	} catch (err) {
		// A restart / interrupt / rebind dropped this pending run before any kernel
		// touched it: nothing executed, nothing to persist, no lastRun stamp.
		return { id, status: 'cancelled', reason: err?.reason ?? 'cancelled', ran_this_session: false, note: 'the queued run was dropped before it started (the kernel was interrupted or restarted).' };
	}
	const queuedInfo = queuedAt ? { queued: true, queue_position: acceptedPosition, waited_ms: Date.now() - queuedAt } : {};

	try {
		// Re-read the cell: it may have been edited (or deleted) while queued.
		const cell = getCell(id, nb);
		if (!cell) return { id, status: 'cancelled', reason: 'cell_removed', ran_this_session: false, ...queuedInfo };
		const source = ticket.source() ?? cell.source ?? '';

		const startedAt = Date.now();
		publish({ type: 'run:start', nb, cellId: id, actor: 'agent', at: startedAt });
		let outputs = [];
		let status = 'ok';
		// The epoch the run STARTED in, captured as soon as the kernel is in hand.
		// It stays null when execute() failed before any kernel existed, and it is
		// never re-read afterwards: an autorestart mid-run bumps the live epoch, and
		// this cell must then read as not-this-session.
		let session = null;
		let kernelDown = false;
		try {
			const res = await runSource(
				source,
				(output) => publish({ type: 'run:output', nb, cellId: id, output }),
				(sid) => { session = sid; }
			);
			outputs = res.outputs;
			status = res.status;
		} catch (err) {
			const output = { output_type: 'error', ename: 'CellarError', evalue: String(err?.message ?? err), traceback: [String(err?.message ?? err)] };
			outputs = [output];
			publish({ type: 'run:output', nb, cellId: id, output });
			status = 'error';
			// execute() threw before it ever had a kernel in hand, so no session exists
			// to stamp. Mark the attempt: this error is live, not saved from a prior run.
			if (session === null) kernelDown = true;
		}
		setOutputs(id, outputs, nb);
		// Runtime-only run metadata (stripped from disk by clean.js); `at` = run start,
		// `session` = the kernel-session epoch this run executed in (see setLastRun).
		const lastRun = { at: startedAt, durationMs: Date.now() - startedAt, actor: 'agent', status, session, ...(kernelDown ? { kernel_unavailable: true } : {}) };
		setLastRun(id, lastRun, nb);
		publish({ type: 'run:end', nb, cellId: id, ...lastRun });
		const hiddenNote = isHidden(cell) ? { hidden: true } : {};
		return { id, status, ran_this_session: isLiveSession(session, currentSessionId()), ...(kernelDown ? { kernel_unavailable: true } : {}), ...queuedInfo, ...hiddenNote, outputs: outputs.map((o) => summarizeOutput(o, READ_CAP)) };
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
 * created (surfaced live in the UI) but not run, returning `status:'skipped'`
 * to mirror run_cell.
 */
export async function addAndRun({ source, cellType = 'code', afterId } = {}) {
	const [id] = addCells([{ cell_type: cellType, source }], afterId);
	const result = await runCell(id);
	return { id, ...result };
}

/**
 * Run cells one at a time, in order, each waiting its turn in the kernel queue.
 * Stops at the first run a restart/interrupt cancelled: the rest of the sequence
 * was written against a namespace that no longer exists, so running it would
 * execute cell N+1 without cell N's definitions.
 */
export async function runCells(ids) {
	const results = [];
	for (const id of ids) {
		const r = await runCell(id);
		if (r && !isHidden(getCell(id) || {})) results.push(r);
		if (r?.status === 'cancelled') break;
	}
	return results;
}

/** Run every code cell in document order; hidden cells run but are omitted from results. */
export async function runAll() {
	const ids = listCells().filter((c) => c.cell_type === 'code').map((c) => c.id);
	return runCells(ids);
}

/** Run code cells in the inclusive document range from→to. */
export async function runRange(fromId, toId) {
	const all = listCells();
	const i = all.findIndex((c) => c.id === fromId);
	const j = all.findIndex((c) => c.id === toId);
	if (i < 0 || j < 0) return [];
	const [lo, hi] = i <= j ? [i, j] : [j, i];
	const ids = all.slice(lo, hi + 1).filter((c) => c.cell_type === 'code').map((c) => c.id);
	return runCells(ids);
}
