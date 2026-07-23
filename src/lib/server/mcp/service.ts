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
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
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
	getHeaderNumbering,
	setHeaderNumbering as setHeaderNumberingDoc,
	setHideAllCode as setHideAllCodeDoc,
	setHideInput as setHideInputDoc,
	setExportTarget as setExportTargetDoc,
	getActiveNotebookPath,
	resolveNotebookPath,
	workspaceRelative,
	createNotebook as createNotebookDoc,
	notebookExists
} from '../notebook';
import { restartKernel, interruptKernel, kernelStatus, kernelSession, currentSessionId } from '../kernel';
import { kernelState, listVariables as _listVariables, inspectVariable as _inspectVariable } from '../inspect';
import { agentStatus as databricksStatus, connectionStatus as databricksConnection, forAgent as databricksCatalog, previewTable, reconnectSession as databricksReconnect, connectCluster as databricksConnect, listClustersForAgent as databricksClusters } from '../databricks';
import { publish } from '../events';
import { enqueueRun, queuesByNotebook, queuePosition } from '../run-queue';
import { executeCellRun, clearOutputsForQueue } from '../run';
import { consolidateImports, routeImports, runImportsCell } from '../imports-cell';
import { buildTree, resolveInWorkspace } from '../fstree';
import { buildNotebookHtml, exportFilename } from '../export-html';
import { getNotebookStaleness, analyzeDataflow } from '../dataflow';
import { STALE_STATE, staleIdsInOrder } from '../../staleness';
import type { StalenessEntry, StalenessMap } from '../../staleness';
import { resolveSymbol, resolveImpact } from '../../symbolGraph';
import { isSqlCell } from '../../cellLanguage';
import { isCodeHidden, hideInputExplicit } from '../../hideInput';
import { computeHeadingNumbers, outlineHeadings } from '../../headings';
import { buildImageBlocks, imagePlaceholder, isInlinableImageMime } from './image';
import type { ImageBlocks, ImageBlockPayload, ImageOutputRef, OmittedImage } from './image';
import { autoCheckpointBeforeAgentAction, createCheckpoint } from '../checkpoints';
import { computeHandles, resolveCellId } from './cellHandle';
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

// --- short cell-id handles --------------------------------------------------
//
// Every cell id emitted to the agent is a SHORT HANDLE (the shortest unique >=8
// char prefix of the full UUID — see cellHandle.ts), not the 36-char UUID that is
// stored in the .ipynb. Handles are computed over ALL of a notebook's cells (not
// just the visible ones a response shows), so a handle is unique within the whole
// document and `resolveRef` — which accepts a handle, any longer prefix, or the
// full UUID — always maps it back to exactly the cell it named.

/** Full-id → short-handle mapper for one notebook's current cells. */
function handleFn(nb?: string | null): (id: string) => string {
	const map = computeHandles(listCells(nb));
	return (id: string) => map.get(id) ?? id;
}

/** The short handle for one full cell id in `nb` (falls back to the id itself). */
export function handleFor(nb: string | null | undefined, fullId: string): string {
	return handleFn(nb)(fullId);
}

/**
 * Resolve a caller-supplied cell ref (short handle / longer prefix / full id) to a
 * full cell id, best-effort. The MCP boundary (server.ts) already resolves refs and
 * turns an ambiguous or unknown ref into an actionable tool error, so on the agent
 * path this only ever sees a full id (an instant exact match). It exists so the
 * service stays symmetric — the ids it EMITS (handles) can be fed straight back into
 * the ids it ACCEPTS — for direct callers and internally-reused handles. An
 * unresolvable ref is returned unchanged, preserving each function's existing
 * "unknown id → null/false" contract (the lookup then simply misses).
 */
function asFullId(nb: string | null | undefined, ref: string): string {
	try {
		return resolveCellId(listCells(nb), ref);
	} catch {
		return ref;
	}
}

/**
 * Resolve an agent-supplied cell reference (a short handle, any longer prefix, or
 * a full UUID) to the one full cell id it names, or throw an actionable error
 * (ambiguous prefix / not found). Applied at the tool boundary (server.ts) so all
 * downstream service + notebook code keeps working with full ids.
 */
export function resolveRef(nb: string | null | undefined, ref: string): string {
	return resolveCellId(listCells(nb), ref);
}

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
 * Drop ALL per-session state for an ended MCP session (its transport closed, or
 * the idle reaper reclaimed it). Today the only session-keyed state in the
 * service layer is the pinned working notebook; this is the single place the
 * session lifecycle (server.ts) calls to release it, so anything else keyed by
 * `sessionId` added later must be cleared here too.
 *
 * Deliberately SHARED-RESOURCE-SAFE: it forgets only this session's pin. The
 * notebook document and its per-notebook kernel are shared across sessions and
 * the UI, so this never closes a doc or touches a kernel — a reaped agent
 * session leaves every open notebook and every live kernel exactly as they were.
 * Idempotent: forgetting an unknown/already-forgotten session is a no-op.
 */
export function forgetSession(sessionId: string): void {
	sessionNotebooks.delete(sessionId);
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
 * Open-or-create: opens the notebook, creating it when it does not exist (the
 * merged replacement for the old open_notebook + create_notebook tools). Pass
 * `createIfMissing:false` for open-only semantics (throws when the notebook does
 * not exist) — the one case the old open_notebook covered that a plain open-or-
 * create does not. Records the session→notebook binding and surfaces it as an
 * AVAILABLE tab (focus:false) so an open UI shows it without yanking the user off
 * their current tab. This is how an agent declares "I am working here"; every
 * subsequent read/write/run from this session defaults to it, regardless of which
 * tab the user later focuses.
 */
export function useNotebook(sessionId: string | undefined, name?: string, createIfMissing = true) {
	let rel = (name ?? '').trim();
	if (!rel) {
		// No name: default to an untitled notebook when creating (the old
		// create_notebook affordance); open-only has nothing to open.
		if (!createIfMissing) throw new Error('use_notebook requires a notebook name to open. Use list_notebooks to see existing notebooks.');
		rel = 'untitled';
	}
	if (!/\.ipynb$/i.test(rel)) rel += '.ipynb';
	const existed = notebookExists(rel);
	if (!existed && !createIfMissing) {
		throw new Error(`Notebook "${rel}" does not exist. Use list_notebooks to see workspace notebooks, or call use_notebook without create_if_missing:false (create is the default) to create it.`);
	}
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
 * The per-cell "hide code input" fields for a map leaf, applying the SAME
 * precedence the UI and the HTML export use (`hide_input ?? hide_all_code`, see
 * `$lib/hideInput`). Only a code cell can hide its input, so a markdown cell
 * contributes nothing.
 *
 * Kept compact like the other conditional leaf fields: `code_hidden: true` only
 * when the code is EFFECTIVELY hidden (its editor is not shown to the human), and
 * `hide_input` only when the cell carries an EXPLICIT per-cell override. Their
 * absence means "code shown, following the notebook default" — the common case —
 * so a report_view-on notebook still lets the agent spot the one cell whose code
 * a human deliberately kept visible (it reports `hide_input: false` with no
 * `code_hidden`).
 */
function hideInputFields(cell: CellView, hideAllCode: boolean): Record<string, boolean> {
	if (cell.cell_type !== 'code') return {};
	const explicit = hideInputExplicit(cell);
	return {
		...(isCodeHidden(cell, hideAllCode) ? { code_hidden: true } : {}),
		...(explicit === undefined ? {} : { hide_input: explicit })
	};
}

/**
 * The display-only auto-number each heading currently renders with, keyed by cell
 * id - the exact strings the human reads ("1", "2.3"), or `{}` when no level is
 * numbered. Two things make the lookup line up with the section tree:
 *
 *  - It is computed over ALL cells, not `visibleCells`. A cell hidden from the
 *    agent still renders for the human and still consumes a counter, so numbering
 *    the visible subset would report numbers that are on no screen.
 *  - `computeHeadingNumbers` keys a cell's LEADING heading by its plain cell id
 *    (`foldKey(id, 0) === id`), which is the only heading `headerInfo` reads. A
 *    later heading in the same cell keys as `<id>#<seg>` and is simply absent
 *    here - it is not a section to this layer either (see headerInfo).
 */
function headingNumbers(nb?: string | null, levels?: readonly number[]): Record<string, string> {
	const enabled = levels ?? getHeaderNumbering(nb);
	if (!enabled.length) return {};
	return computeHeadingNumbers(outlineHeadings(listCells(nb)), new Set(enabled));
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

/**
 * A cell's image outputs, addressed by their index in `outputs`, ready for the
 * one block policy (`image.ts` `buildImageBlocks`). Every tool that SHOWS images
 * collects them here, so what an agent sees never depends on which tool it used.
 */
function imageRefs(outputs: CellOutput[] | undefined): ImageOutputRef[] {
	const refs: ImageOutputRef[] = [];
	(outputs || []).forEach((o, output_index) => {
		const mime = imageKey(o);
		if (mime && 'data' in o) refs.push({ output_index, mime, b64: String(o.data[mime]) });
	});
	return refs;
}

/**
 * The `images` / `images_omitted` fields a tool result carries when the cell
 * produced figures. `images` holds the base64 raster; the TRANSPORT (server.ts)
 * lifts it out into real MCP image blocks and keeps only the metadata in the JSON
 * text, so the payload is never stringified into the text content twice.
 */
function imageFields({ images, omitted }: ImageBlocks): { images?: ImageBlockPayload[]; images_omitted?: OmittedImage[] } {
	return {
		...(images.length ? { images } : {}),
		...(omitted.length ? { images_omitted: omitted } : {})
	};
}

function outputText(o: CellOutput): string {
	switch (o.output_type) {
		case 'stream':
			return asText(o.text);
		case 'execute_result':
		case 'display_data': {
			const d = o.data || {};
			const img = imageKey(o);
			// An image cell shows an enriched, image-token-free placeholder (mime +
			// dimensions + bytes) even when a text/plain repr exists, so the agent
			// knows an image is there and how big before fetching it with
			// get_full_output. The text/plain repr of a figure is just `<Figure …>`.
			if (img) return imagePlaceholder(img, String(d[img]));
			if (d['text/plain']) return asText(d['text/plain']);
			return '[rich output]';
		}
		case 'error':
			return stripAnsi((o.traceback || [o.ename + ': ' + o.evalue]).join('\n'));
		default:
			return '';
	}
}

/**
 * Upper bound on how much of ONE cell's concatenated output text `searchCells`
 * scans. It used to stringify EVERY output of every cell in full, so a single
 * query over an output-heavy notebook could serialize megabytes; this bounds the
 * scanned text per cell. A match sitting past the cap inside one giant output is
 * missed — the accepted trade for not serializing the whole document — but WHICH
 * cells are searched is unchanged, and the cap is generous enough that ordinary
 * outputs are scanned whole.
 */
export const SEARCH_SCAN_CAP = 100_000;

/**
 * A cell's output text for the search scan, concatenated but stopped once
 * `SEARCH_SCAN_CAP` characters have accumulated (the last output is sliced to fit
 * exactly). Bounds the work per cell without changing which cells are scanned.
 */
export function scanOutputText(outputs: CellOutput[] | undefined): string {
	let acc = '';
	for (const o of outputs || []) {
		if (acc.length >= SEARCH_SCAN_CAP) break;
		const t = outputText(o);
		const sep = acc ? '\n' : '';
		const room = SEARCH_SCAN_CAP - acc.length - sep.length;
		acc += sep + (t.length > room ? t.slice(0, room) : t);
	}
	return acc;
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
function staleFields(
	entry: StalenessEntry | undefined | null,
	toHandle: (id: string) => string = (x) => x
): Record<string, unknown> {
	if (!entry) return {};
	const out: Record<string, unknown> = { stale_state: entry.state };
	if (entry.state === STALE_STATE.STALE) {
		out.stale = true;
		out.stale_reason = entry.reason;
		// The upstream cell ids the agent must re-run are handles too, so they can be
		// passed straight back to run_cell / read_cells.
		if (entry.upstream?.length) out.stale_upstream = entry.upstream.map(toHandle);
	}
	return out;
}

function readForm(
	cell: CellView,
	cap = READ_CAP,
	sid: SessionId | null = currentSessionId(),
	staleEntry: StalenessEntry | null = null,
	toHandle: (id: string) => string = (x) => x
) {
	return {
		id: toHandle(cell.id),
		type: cell.cell_type,
		...(isSqlCell(cell) ? { language: 'sql' } : {}),
		source: cell.source,
		run_status: runStatus(cell, sid),
		...staleFields(staleEntry, toHandle),
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
 * is currently active. Paths are workspace-relative (what `use_notebook` accepts).
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

// --- read -------------------------------------------------------------------

/**
 * Hierarchical section tree derived from markdown headers (spec §4).
 *
 * The `kernel` header reports the live session, so a consumer can see at a
 * glance that the WHOLE map predates the current kernel: with
 * `kernel.started: false` (or `execs_this_session: 0`) every `*_persisted`
 * status is saved output from an earlier session and nothing those cells define
 * exists in the namespace. `kernel_state` remains the live truth.
 *
 * The `display` block reports the notebook-level display-only settings, and every
 * numbered section carries the `number` it renders with (see `headingNumbers`).
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
		number?: string;
		children: unknown[];
	}
	const root: unknown[] = [];
	const stack: { node: MapSection; level: number }[] = [];
	const toHandle = handleFn(nb);
	const view = getNotebook(nb);
	// The number each section renders with, so the agent reads the SAME heading the
	// human does ("1. Setup", not "Setup") and can see the numbering is already
	// being done for it - which is what stops it hardcoding a number into the source.
	const numbers = headingNumbers(nb, view.headerNumbering);
	const leaf = (c: CellView) => ({
		id: toHandle(c.id),
		type: c.cell_type,
		...(isSqlCell(c) ? { language: 'sql' } : {}),
		summary: firstLine(c.source),
		run_status: runStatus(c, sid),
		...staleFields(stale[c.id], toHandle),
		has_output: hasOutput(c),
		...hideInputFields(c, view.hideAllCode)
	});
	for (const c of cells) {
		const h = headerInfo(c);
		if (h) {
			const node: MapSection = { id: toHandle(c.id), type: 'markdown', level: h.level, title: h.title, ...(numbers[c.id] ? { number: numbers[c.id] } : {}), children: [] };
			while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
			(stack.length ? stack[stack.length - 1].node.children : root).push(node);
			stack.push({ node, level: h.level });
		} else {
			(stack.length ? stack[stack.length - 1].node.children : root).push(leaf(c));
		}
	}
	// The `kernel` header reports THIS notebook's own session epoch, so it lines up
	// with each cell's run_status/ran_this_session (each computed against the same
	// per-notebook epoch), never against whichever notebook the user last focused.
	// The map ships only whether a Databricks session is bound - the actionable
	// "ask the user to connect" note lives on `databricks_status`/`get_kernel_state`,
	// so we don't repeat ~150 chars of boilerplate on every map call. Read the
	// CACHED, epoch-reconciled connection (`connectionStatus`), NOT `agentStatus`:
	// this is a plain structural read that can fire on every edit, and `agentStatus`
	// would run a live `SELECT 1` liveness probe through the kernel each time. The
	// live probe still backs `databricks_status`/`get_kernel_state`, where verifying
	// the session is the point.
	const dbx = databricksConnection(nb);
	// `display` = the notebook-level settings that change how the notebook is
	// presented without touching any cell's source. They ride the map because the
	// map is what an agent reads before it writes: `header_numbering` is why a new
	// header must NOT carry a hand-typed number, `report_view` is why a cell's code
	// may be invisible to the reader even though it is in the document, and
	// `export_target` is the notebook's nbdev-style `#|default_exp` module path (the
	// `.py` file the `export`-marked cells are written to), so an agent marking
	// cells for export can see where they land and set it (see set_export_target).
	// export_target is the one settling that is not purely display: it drives the
	// auto-generated `.py` module, but it lives in the same `cellar` metadata seam.
	return {
		notebook: view.path,
		kernel: kernelSession(nb),
		databricks: { connected: dbx.connected === true },
		display: {
			header_numbering: view.headerNumbering,
			report_view: view.hideAllCode,
			export_target: view.exportTarget
		},
		cell_count: cells.length,
		sections: root
	};
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
	const toHandle = handleFn(nb);
	const out: Array<{ id: string; reason?: string; upstream?: string[] }> = [];
	for (const c of visibleCells(nb)) {
		const e = cells[c.id];
		if (e?.state === STALE_STATE.STALE) {
			out.push({ id: toHandle(c.id), reason: e.reason, ...(e.upstream?.length ? { upstream: e.upstream.map(toHandle) } : {}) });
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
 * The read/listing tools throw a `DatabricksError` with code `not_connected` when
 * there is no live session. The agent MAY restore a dead session (`reconnect`,
 * against the cluster the user already chose) and MAY connect a chosen cluster
 * (`connect`, gated on non-browser auth), but never starts compute and never drives
 * the OAuth browser — those stay human-only. Every path reuses the SAME
 * reconnect/connect machinery in `databricks.ts` (no second code path).
 */
export const databricks = {
	status: (nb?: string | null) => databricksStatus(nb),
	reconnect: (nb?: string | null) => databricksReconnect(nb),
	connect: (opts: { clusterId: string; clusterName?: string | null; profile?: string | null; host?: string | null; nb?: string | null }) =>
		databricksConnect(opts),
	listClusters: (sel: { profile?: string | null; host?: string | null }, nb?: string | null) => databricksClusters(nb, sel),
	catalogs: (nb?: string | null) => databricksCatalog.catalogs(nb),
	schemas: (catalog: string, nb?: string | null) => databricksCatalog.schemas(catalog, nb),
	tables: (catalog: string, schema: string, nb?: string | null) => databricksCatalog.tables(catalog, schema, nb),
	preview: (name: string, limit?: number, nb?: string | null) => previewTable({ name, limit, nb })
};

export async function readCell(id: string, nb?: string | null) {
	const full = asFullId(nb, id);
	const c = getCell(full, nb);
	if (!c || isHidden(c)) return null;
	const { sid, cells: stale }: { sid: SessionId | null; cells: StalenessMap } = await getNotebookStaleness(nb);
	return readForm(c, READ_CAP, sid, stale[full], handleFn(nb));
}

/**
 * Read many cells against ONE sampled epoch + one staleness pass. Letting
 * `readForm` re-sample per cell would let a restart landing mid-loop classify a
 * single response against two different kernel sessions — some cells `ok_session`,
 * some `ok_persisted` — for the same kernel state.
 */
export async function readCells(ids: string[], nb?: string | null) {
	const { sid, cells: stale }: { sid: SessionId | null; cells: StalenessMap } = await getNotebookStaleness(nb);
	const toHandle = handleFn(nb);
	return ids
		.map((id) => {
			const full = asFullId(nb, id);
			const c = getCell(full, nb);
			if (!c || isHidden(c)) return null;
			return readForm(c, READ_CAP, sid, stale[full], toHandle);
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
		const rel = asFullId(nb, relativeTo);
		const i = cells.findIndex((c) => c.id === rel);
		if (i < 0) return null;
		target = direction === 'prev' ? cells[i - 1] : cells[i + 1];
	}
	if (!target) return null;
	const { sid, cells: stale }: { sid: SessionId | null; cells: StalenessMap } = await getNotebookStaleness(nb);
	return readForm(target, READ_CAP, sid, stale[target.id], handleFn(nb));
}

/**
 * Cells under a markdown header (until the next same-or-higher header).
 *
 * Its `header` carries the display-only auto-`number` (when its level is
 * numbered), because this tool presents a heading AS a heading - the one other
 * place besides the section tree where the agent reads what the human reads.
 * `read_cell`/`read_cells`/`search_cells` deliberately do NOT: they hand back a
 * cell's raw source, where the number provably is not, and stamping a rendered
 * number onto raw source is exactly the confusion this feature exists to end.
 */
export async function readSection(headerId: string, nb?: string | null) {
	const cells = visibleCells(nb);
	const idx = cells.findIndex((c) => c.id === asFullId(nb, headerId));
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
	const toHandle = handleFn(nb);
	const number = headingNumbers(nb)[cells[idx].id];
	return { header: { id: toHandle(cells[idx].id), level: h.level, title: h.title, ...(number ? { number } : {}) }, cells: out.map((c) => readForm(c, READ_CAP, sid, stale[c.id], toHandle)) };
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
	const toHandle = handleFn(nb);
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
			if (s) results.push({ id: toHandle(c.id), where: 'input', ran_this_session: live, snippet: s });
		}
		if (where === 'output' || where === 'both') {
			const otext = scanOutputText(c.outputs); // bounded scan (see SEARCH_SCAN_CAP)
			const s = snippet(otext);
			if (s) results.push({ id: toHandle(c.id), where: 'output', ran_this_session: live, snippet: s });
		}
	}
	return results;
}

/**
 * The set of names live in a notebook's kernel namespace right now, or null when
 * that is unknowable (no kernel, busy mid-run, or the namespace belongs to a
 * session that has since restarted). Drawn from the SAME bucketed `kernel_state`
 * probe every other live-truth read uses, so `find_symbol`'s `live_in_kernel`
 * cannot disagree with `kernel_state`.
 */
async function liveKernelNames(nb?: string | null): Promise<Set<string> | null> {
	const state = await kernelState(nb);
	// Only an idle, current-session namespace has readable buckets; {started:false},
	// {busy:true}, and a stale namespace all carry no trustworthy names.
	if (!('variables' in state) || state.stale) return null;
	const names = new Set<string>();
	for (const i of state.imports || []) names.add(i.alias);
	for (const f of state.functions || []) names.add(f.name);
	for (const c of state.classes || []) names.add(c.name);
	for (const v of state.variables || []) names.add(v.name);
	return names;
}

/**
 * Locate a Python name across the notebook by DATAFLOW, not text: the cells that
 * DEFINE it (assignment/import/def/class, document order) and the cells that USE
 * it (each resolved to the definition it binds to), reconciled with the live
 * kernel. Surfaces the symbol→cell graph Cellar already computes for staleness and
 * otherwise discards — the `used_in` (references) side is a capability no other
 * tool provides, and `defined_in` is far more precise than `search_cells`.
 *
 * The graph is built over ALL code cells (a hidden cell still defines names in the
 * kernel), but only agent-visible cells are reported; a hidden definer sets
 * `hidden_definer`. Inherits the definer graph's limits (see `$lib/symbolGraph`): a
 * conditional bind (`if flag: df = load()`) hides that cell's later read of `df`,
 * dynamic names (exec/globals/star-import) are invisible, and a forward reference
 * binds to null.
 */
export async function findSymbol(name: string, nb?: string | null) {
	const cells = listCells(nb); // ALL cells (incl. hidden) so a hidden definer still counts
	const [dataflow, kernelNames] = await Promise.all([analyzeDataflow(cells), liveKernelNames(nb)]);
	return resolveSymbol({
		name,
		cells: cells.map((c) => ({
			id: c.id,
			cell_type: c.cell_type,
			hidden: isHidden(c),
			lastRunSession: c.metadata?.cellar?.lastRun?.session ?? null
		})),
		dataflow,
		sid: currentSessionId(nb),
		kernelNames,
		toHandle: handleFn(nb)
	});
}

/**
 * The dependency blast radius of ONE cell, off the SAME definer graph as staleness
 * (`$lib/symbolGraph`): `depends_on` = the cells whose definitions this cell reads
 * (its direct upstream), `dependents` = the transitive downstream cells that would
 * go STALE if this cell is edited, both in document order. Answers "what will
 * run_stale re-run after I touch this" BEFORE the edit — the downstream direction
 * `stale_upstream` (which only appears once a cell is ALREADY stale) never surfaces.
 *
 * Honest limit (inherited, see the module header): a dependency carried only through
 * a conditional bind (`if flag: df = load()`), a `global`-declared augmented
 * assignment inside a function, or `exec`/`globals()` is invisible to the graph, so
 * a data cell's `dependents` can UNDER-report. `get_notebook_map`'s `stale_state`
 * is NOT a backstop: it is derived
 * from this same static graph plus run timestamps, so it under-reports identically
 * (see `resolveImpact` in `$lib/symbolGraph`). The graph is built over ALL code
 * cells and traversed through hidden ones, but only agent-visible cells are reported.
 */
export async function cellImpact(id: string, nb?: string | null) {
	const cells = listCells(nb); // ALL cells (incl. hidden) so the graph stays complete
	const dataflow = await analyzeDataflow(cells);
	return resolveImpact({
		id: asFullId(nb, id),
		cells: cells.map((c) => ({ id: c.id, cell_type: c.cell_type, hidden: isHidden(c) })),
		dataflow,
		toHandle: handleFn(nb)
	});
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
	const toHandle = handleFn(nb);
	const errs: Array<Record<string, unknown>> = [];
	for (const c of visibleCells(nb)) {
		for (const o of c.outputs || []) {
			if (o.output_type === 'error') {
				errs.push({
					id: toHandle(c.id),
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
 * Tiered: medium cap by default; full only on size='full'. Figures ride in
 * `images` (real MCP image blocks once the transport lifts them out) alongside
 * the text summary of every output, which keeps its enriched image placeholder —
 * so the agent sees BOTH the picture and where in the output list it sat.
 * `ran_this_session: false` means these outputs were saved by a PREVIOUS session
 * - they describe a namespace that no longer exists.
 *
 * Default (medium) downscales an oversized raster (a retina/high-DPI figure) to
 * IMG_MAX_EDGE, cutting image tokens ~3x; size:'full' passes the ORIGINAL bytes
 * through untouched, so an agent that needs pixel detail opts in and gets it.
 */
export function getFullOutput(id: string, size: 'medium' | 'full' = 'medium', nb?: string | null) {
	const c = getCell(asFullId(nb, id), nb);
	if (!c || isHidden(c)) return null;
	const cap = size === 'full' ? Infinity : MEDIUM_CAP;
	const outputs = summarizeOutputs(c, cap);
	return {
		id: handleFor(nb, c.id),
		size,
		ran_this_session: ranThisSession(c, currentSessionId(nb)),
		outputs,
		// Uncapped: this call IS the agent explicitly asking for this one cell's
		// figures, so it is the route the run path's `limit` omission names — a cap
		// here would leave the 5th figure of a cell unreachable by any tool.
		...imageFields(buildImageBlocks(imageRefs(c.outputs), { full: size === 'full', limit: Infinity }))
	};
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
	const handle = cellId == null ? cellId : handleFor(nb, cellId);
	if (!added.length) return { cell_id: handle, added: [] as string[], note: 'already present in the imports cell; removed from your code' };
	const run = await runImportsCell(nb, 'agent');
	return {
		cell_id: handle,
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
 * Export the working notebook to a self-contained HTML file ON DISK and return
 * its LOCATION, never the HTML body — an inlined document would blow the token
 * budget. Reuses the SAME render as the HTTP export route (`buildNotebookHtml`),
 * so the tool and the download produce identical bytes.
 *
 * `hideCode` maps to the same report-style path as the route's `?hideCode`:
 * omitted follows the notebook's saved `hide_all_code` setting, `true`/`false`
 * force the report view on/off. A report drops code cells that have no output,
 * yielding a clean markdown + outputs document.
 *
 * The output goes alongside the notebook as `<name>.html` by default, or to an
 * explicit workspace-relative `path`. EITHER way it is resolved through
 * `resolveInWorkspace`, so a traversal / absolute-escape attempt is refused and
 * nothing is ever written outside the workspace.
 */
export function exportHtml({
	hideCode,
	path,
	nb
}: {
	hideCode?: boolean;
	path?: string | null;
	nb?: string | null;
} = {}) {
	const target = nb ?? getActiveNotebookPath();
	const { html, hideAllCode } = buildNotebookHtml({ nb: target, hideCode });

	// Default alongside the notebook (`<name>.html` in the notebook's own dir);
	// an explicit path is taken as workspace-relative. Both go through the
	// workspace guard, which throws on any escape.
	const nbAbs = resolveNotebookPath(target);
	const explicit = (path ?? '').trim();
	let outRel: string;
	if (explicit) {
		outRel = /\.html$/i.test(explicit) ? explicit : explicit + '.html';
	} else {
		const nbRel = workspaceRelative(nbAbs);
		const dir = dirname(nbRel);
		const name = exportFilename(nbAbs); // `<name>.html`
		outRel = dir === '.' || dir === '' ? name : `${dir}/${name}`;
	}
	const outAbs = resolveInWorkspace(outRel); // throws on workspace escape

	mkdirSync(dirname(outAbs), { recursive: true });
	writeFileSync(outAbs, html);
	return {
		path: workspaceRelative(outAbs),
		bytes: Buffer.byteLength(html),
		hide_code: hideAllCode
	};
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
	// Emit handles (short prefixes) for the created cells; the .ipynb keeps the UUIDs.
	const toHandle = handleFn(nb);
	return { ids: created.map(toHandle), ...(imports ? { imports } : {}) };
}

export async function editCell(id: string, source: string, { routeImports: routeEnabled = true, nb: nbArg }: { routeImports?: boolean; nb?: string | null } = {}) {
	const nb = nbArg ?? getActiveNotebookPath();
	id = asFullId(nb, id);
	const cell = getCell(id, nb);
	if (!cell) return null;
	autoCheckpointBeforeAgentAction(nb);
	// A SQL cell is a `code` cell on disk, but its source is SQL - never route
	// "imports" out of it. Pass the LOGICAL type so routeOne's `!== 'code'` guard skips it.
	const logicalType = isSqlCell(cell) ? 'sql' : cell.cell_type;
	const routed = routeOne(source, nb, { routeEnabled, cellType: logicalType, skipCellId: id });
	setSource(id, routed ? routed.source : source, nb);
	const imports = routed ? await finishImportRouting(nb, routed.importsCellId, routed.added) : null;
	return { ok: true, id: handleFor(nb, id), ...(imports ? { imports } : {}) };
}

export function removeCell(id: string, nb?: string | null) {
	const target = nb ?? getActiveNotebookPath();
	id = asFullId(target, id);
	if (!getCell(id, target)) return false;
	autoCheckpointBeforeAgentAction(target);
	deleteCell(id, target);
	return true;
}

export function moveCell(id: string, pos: number, nb?: string | null) {
	const target = nb ?? getActiveNotebookPath();
	autoCheckpointBeforeAgentAction(target);
	return moveCellTo(asFullId(target, id), pos, target);
}

export function setType(id: string, type: LogicalCellType, nb?: string | null) {
	const target = nb ?? getActiveNotebookPath();
	id = asFullId(target, id);
	if (!getCell(id, target)) return false;
	autoCheckpointBeforeAgentAction(target);
	setCellType(id, type, target);
	return true;
}

export function setCellVisibility(id: string, hidden: boolean, nb?: string | null) {
	const target = nb ?? getActiveNotebookPath();
	return setVisibility(asFullId(target, id), hidden, target);
}

/**
 * MCP `set_header_numbering`. Notebook-level and display-only: it records WHICH
 * heading levels render with an auto-number and never writes a number into any
 * cell's source. An empty list clears the setting. Returns the SANITIZED levels
 * (unique, 1-6, ascending - so a caller sees what actually took effect, not what
 * it asked for) plus how many headings now carry a number, which is the cheap
 * confirmation that the levels it picked match the headings it has; the numbers
 * themselves are one get_notebook_map away.
 *
 * Like `setCellVisibility` and unlike the content mutations, this takes no
 * pre-action checkpoint: it changes how the notebook is displayed, not what is in
 * it, so there is no cell state an undo would need to bring back.
 */
export function setHeaderNumbering(levels: readonly number[] | null | undefined, nb?: string | null) {
	const target = nb ?? getActiveNotebookPath();
	const clean = setHeaderNumberingDoc(levels, target);
	return { levels: clean, numbered_headings: Object.keys(headingNumbers(target, clean)).length };
}

/**
 * MCP `set_report_view`. The notebook-level "hide all code inputs" default: code
 * cells render output-only, for a clean report a human reads without the code.
 * Display-only - no source is touched and every cell still runs. A per-cell
 * `cellar.hide_input` overrides it in either direction (see `setHideInput`), so a
 * cell may still show its code under report view.
 */
export function setReportView(enabled: boolean, nb?: string | null) {
	const target = nb ?? getActiveNotebookPath();
	return { report_view: setHideAllCodeDoc(enabled, target) };
}

/**
 * MCP `set_export_target`. The notebook-level nbdev-style `#|default_exp` target:
 * the workspace-relative `.py` module the cells marked `cellar.export` are written
 * to. Setting it (or clearing it with null/'') persists in the allowlisted
 * `cellar` namespace so it round-trips through clean-on-save, and `persist`
 * regenerates the module as a side effect (auto-on-save) exactly like the UI's
 * target input. Returns the resulting `export_target` (the trimmed path, or null
 * when cleared); `get_notebook_map`'s `display` block reports the same value.
 *
 * Unlike the pure display setters this one DOES have a side effect (it drives the
 * generated `.py`), but it changes no cell source, so like them it takes no
 * pre-action checkpoint — there is no cell state an undo would need to bring back.
 */
export function setExportTarget(target: string | null | undefined, nb?: string | null) {
	const nbTarget = nb ?? getActiveNotebookPath();
	setExportTargetDoc(target ?? null, nbTarget);
	return { export_target: getNotebook(nbTarget).exportTarget };
}

/**
 * MCP `set_hide_input`. The per-cell override of report view: force one code
 * cell's input hidden or shown regardless of the notebook-wide default, or clear
 * the override so the cell follows it again. Tri-state — `true` = force hidden,
 * `false` = force shown, `null` = clear the per-cell choice. Display-only: the
 * source is untouched and the cell still runs.
 *
 * Only a code cell can carry it (a markdown cell has no code to hide); a bad id
 * or non-code target returns `{ ok: false }`. On success it reports the resulting
 * per-cell `hide_input` (the explicit value, or `null` when cleared), the
 * effective `code_hidden` (applying `hide_input ?? report_view`), and the
 * notebook-wide `report_view` default — so the caller sees both halves of the
 * precedence at once, matching what `get_notebook_map` surfaces.
 *
 * Like the notebook-level display setters (and unlike the content mutations) it
 * takes no pre-action checkpoint: it changes how a cell is displayed, not what is
 * in it, so there is no cell state an undo would need to bring back.
 */
export function setHideInput(id: string, hidden: boolean | null | undefined, nb?: string | null) {
	const target = nb ?? getActiveNotebookPath();
	const full = asFullId(target, id);
	if (!setHideInputDoc(full, hidden, target)) return { ok: false as const };
	const cell = getCell(full, target);
	const reportView = getNotebook(target).hideAllCode;
	const explicit = cell ? hideInputExplicit(cell) : undefined;
	return {
		ok: true as const,
		hide_input: explicit ?? null,
		code_hidden: cell ? isCodeHidden(cell, reportView) : false,
		report_view: reportView
	};
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
	for (const [abs, state] of Object.entries(byAbs)) {
		// Each entry's cellId is emitted as that notebook's short handle so the agent
		// can pass it straight back to run_cell / read_cells.
		const h = handleFn(abs);
		notebooks[workspaceRelative(abs)] = {
			running: state.running ? { ...state.running, cellId: h(state.running.cellId) } : null,
			queue: state.queue.map((e) => ({ ...e, cellId: h(e.cellId) }))
		};
	}
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
export async function runCell(
	id: string,
	nbArg?: string | null,
	opts: { skipStaleness?: boolean; skipImages?: boolean } = {}
): Promise<Record<string, unknown> | null> {
	const nbAtCall = nbArg ?? getActiveNotebookPath();
	// Accept a short handle / prefix as well as a full id; `id` is the full UUID from
	// here on (queue keys, event tags, and setOutputs are all UUID-keyed).
	id = asFullId(nbAtCall, id);
	const c = getCell(id, nbAtCall);
	if (!c) return null;
	// The agent addresses cells by short handle; every result echoes the handle, not
	// the stored full UUID.
	const outId = handleFor(nbAtCall, id);
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
		return { id: outId, status: 'rendered', note: 'markdown cell rendered (no kernel execution)' };
	}
	if (c.cell_type !== 'code') return { id: outId, status: 'skipped', note: 'not a code cell' };
	// Pin the notebook now: the UI may focus another one while we wait in the
	// queue, and this run must land in the document it was requested against.
	const nb = nbAtCall;

	const ticket = enqueueRun({ nb, cellId: id, actor: 'agent', source: c.source || '' });
	if (ticket.duplicate) {
		// This cell is already in the kernel's hands. Say which — "queued" and
		// "running" are both "accepted, not finished", and neither is an error.
		const position = queuePosition(nb, id);
		return position
			? { id: outId, status: 'queued', queue_position: position, note: `already queued at position ${position}; its source was refreshed to the current one. It will run when the kernel frees.` }
			: { id: outId, status: 'running', queue_position: 0, note: 'already executing in the kernel right now; not enqueued again.' };
	}
	// A fresh (non-duplicate) ticket now HOLDS a slot in this notebook's kernel FIFO
	// (it is either the active run or a pending entry). From here every exit path —
	// success, a handled cancel, or an UNEXPECTED throw in the pre-wait gap below
	// (e.g. `clearOutputsForQueue` faulting, or a bad-arg/null-deref before the
	// guarded await) — MUST reach `ticket.done()`, or the slot is never released and
	// every later run on THIS notebook waits behind it forever (a wedged queue). One
	// outer `finally` is the whole guarantee; `release` is idempotent per entry (a
	// second `done()` is a no-op, and it only advances the queue when this entry is
	// the active one, so it can never over-release or free a slot early).
	try {
		// Clear this cell's stale output the moment it is queued (an agent run carries
		// no originId, so every open tab empties it right away), rather than leaving the
		// prior output under the "queued · N" badge until the kernel frees.
		clearOutputsForQueue({ nb, cellId: id });
		const queuedAt = ticket.queued ? Date.now() : 0;
		const acceptedPosition = ticket.position;
		try {
			await ticket.wait();
		} catch (err) {
			// A restart / interrupt / rebind dropped this pending run before any kernel
			// touched it: nothing executed, nothing to persist, no lastRun stamp. The
			// entry was already spliced out of the queue by the cancel, so the outer
			// `finally`'s `done()` is a harmless no-op here.
			const reason = (err as { reason?: string })?.reason ?? 'cancelled';
			return { id: outId, status: 'cancelled', reason, ran_this_session: false, note: 'the queued run was dropped before it started (the kernel was interrupted or restarted).' };
		}
		const queuedInfo = queuedAt ? { queued: true, queue_position: acceptedPosition, waited_ms: Date.now() - queuedAt } : {};

		// Re-read the cell: it may have been edited (or deleted) while queued.
		const cell = getCell(id, nb);
		if (!cell) return { id: outId, status: 'cancelled', reason: 'cell_removed', ran_this_session: false, ...queuedInfo };
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
		// read is not needed just to see whether the run settled it. In a BATCH this is
		// skipped: `runCells` computes staleness ONCE over the post-batch notebook state
		// instead of once per cell (O(N^2)→O(N)), so a mid-batch per-cell pass would be
		// both redundant and superseded by the final snapshot.
		const staleAnnotation = opts.skipStaleness
			? {}
			: staleFields((await getNotebookStaleness(nb)).cells[id], handleFn(nb));
		// A figure this run just produced ships as a real image the agent can SEE
		// (bounded: downscaled, and capped per result — see image.ts). Without it an
		// agent authoring plots is blind to its own charts and has to savefig to a
		// scratch file just to look at what it drew. Skipped in a BATCH, whose
		// records are deliberately compact (`toBatchRecord`): decoding and
		// resampling every cell's figures only to discard them is pure CPU, and N
		// cells' worth of rasters would be a five-figure token bill besides.
		const images = opts.skipImages ? { images: [], omitted: [] } : buildImageBlocks(imageRefs(outputs));
		return { id: outId, status, ran_this_session: isLiveSession(session, currentSessionId(nb)), ...(kernelDown ? { kernel_unavailable: true } : {}), ...staleAnnotation, ...queuedInfo, ...hiddenNote, outputs: outputs.map((o) => summarizeOutput(o, READ_CAP)), ...imageFields(images) };
	} finally {
		// Hand the kernel to the next queued run only once this one has persisted and
		// broadcast, so the wire order stays run:end → run:start. Running on EVERY exit
		// path (the pre-wait gap included) is what closes the slot leak.
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
		// `imports.cell_id` is a short handle (emitted) — look the cell up by the FULL
		// id `routeOne` returned, not the handle.
		const cell = routed.importsCellId ? getCell(routed.importsCellId, nb) : null;
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
	// addCells emits a handle; runCell accepts it (resolves it back to the full id).
	const result = await runCell(ids[0], nb);
	return { id: ids[0], ...result, ...(imports ? { imports } : {}) };
}

/**
 * The stale annotation an agent must act on, derived from the batch's SINGLE
 * post-batch staleness snapshot (`getNotebookStaleness`, run once in `runCells`),
 * NOT from a per-cell runCell pass — that pass is skipped in a batch: only the
 * final whole-notebook snapshot is the correct end-state view. Mirrors the
 * omit-when-default pattern: a cell that just ran is fresh, so its (default)
 * `stale_state` carries no signal in a batch — we keep only
 * `stale`/`stale_reason`/`stale_upstream`, present just when the cell is STILL
 * stale after the batch (an upstream it needs was not run).
 */
function pickStale(entry: StalenessEntry | undefined | null, toHandle: (id: string) => string): Record<string, unknown> {
	const f = staleFields(entry, toHandle);
	if (f.stale !== true) return {};
	// Drop the always-present `stale_state`; keep only the stale-when-true fields.
	return {
		stale: true,
		...(f.stale_reason != null ? { stale_reason: f.stale_reason } : {}),
		...(f.stale_upstream != null ? { stale_upstream: f.stale_upstream } : {})
	};
}

/**
 * Collapse ONE runCell result into a compact batch-run record. A batch echoing
 * every OK cell's full output is the single biggest recurring token cost (a
 * ~20-cell run_all ran ~2.5-5k tokens), so an OK cell keeps only its status
 * line — id, run_status, non-default staleness — and `has_output` flags that its
 * full output is one `get_full_output(id)` call away (unchanged, always
 * reachable). An ERRORED cell keeps its `ename`/`evalue` + the SAME
 * elided-and-READ_CAP-capped traceback the single-cell path returns (already
 * summarized on `r.outputs`; the full stack stays reachable via
 * `get_full_output(id, size:'full')`), so a batch failure is actionable without a
 * second call. Non-executed results (rendered / skipped / queued / running /
 * cancelled) carry no outputs array and are already terse — pass them through.
 *
 * `run_status` is the canonical enum for the cell as it stands right after its run
 * (runStatus is the single source of truth; never re-derive the epoch rule), not
 * runCell's raw jupyter `status` field.
 */
function toBatchRecord(
	r: Record<string, unknown>,
	cell: CellView | null,
	nb: string,
	staleMap: StalenessMap,
	toHandle: (id: string) => string
): Record<string, unknown> {
	const outputs = r.outputs;
	if (!Array.isArray(outputs)) return r;
	const run_status = cell ? runStatus(cell, currentSessionId(nb)) : String(r.status);
	// Stale state comes from the batch's single post-batch snapshot, keyed by the
	// cell's FULL id (the snapshot is), not from the (skipped) per-run pass.
	const stale = pickStale(cell ? staleMap[cell.id] : null, toHandle);
	const errOut = outputs.find((o) => (o as { type?: string }).type === 'error') as
		| { ename?: unknown; evalue?: unknown; text?: unknown; truncated?: unknown }
		| undefined;
	if (errOut) {
		return {
			id: r.id,
			run_status,
			ename: errOut.ename,
			evalue: errOut.evalue,
			traceback: errOut.text,
			...(errOut.truncated ? { truncated: true } : {}),
			...stale
		};
	}
	// has_image says a FIGURE is waiting behind get_full_output, which has_output
	// alone cannot: a batch never inlines images (see runCell's skipImages), so
	// without this an agent that just ran 20 plotting cells has no way to know any
	// of them drew anything except by fetching each one.
	// Only an INLINABLE mime counts: has_image promises a figure get_full_output can
	// actually SHOW, so an svg-only output (which the block policy declines, and
	// which would come back as the same placeholder) must not send the agent on a
	// round trip that tells it nothing new.
	const hasImage = outputs.some((o) => isInlinableImageMime((o as { image?: unknown }).image));
	return { id: r.id, run_status, ...(outputs.length ? { has_output: true } : {}), ...(hasImage ? { has_image: true } : {}), ...stale };
}

/**
 * Run cells one at a time, in order, each waiting its turn in the kernel queue.
 * Stops at the first run a restart/interrupt cancelled: the rest of the sequence
 * was written against a namespace that no longer exists, so running it would
 * execute cell N+1 without cell N's definitions.
 *
 * Returns a compact batch summary `{ ran, errored, results }`: `ran`/`errored`
 * are how many cells executed / raised, and `results` is one COMPACT record per
 * cell (see `toBatchRecord`) — OK cells as a status line, errored cells with
 * their traceback in full. Any OK cell's full output is still one
 * `get_full_output(id)` call away.
 */
export async function runCells(ids: string[], nb?: string | null) {
	const target = nb ?? getActiveNotebookPath();
	// Run the whole batch first, deferring staleness: each runCell SKIPS its own
	// per-cell staleness pass, so a batch drives O(N) executions and exactly ONE
	// whole-notebook staleness computation at the end — not N of them (O(N^2)+ of
	// redundant JS recompute over the definer graph on a large notebook). The
	// post-batch snapshot is the correct end-state view for every cell that ran.
	const runs: Array<{ r: Record<string, unknown>; cell: CellView | null }> = [];
	for (const id of ids) {
		const full = asFullId(target, id);
		const r = await runCell(full, target, { skipStaleness: true, skipImages: true });
		const cell = getCell(full, target);
		if (r) runs.push({ r, cell: cell ?? null });
		// An interrupt/restart cancelled this queued run: the namespace the rest of
		// the sequence was written against is gone, so stop. Staleness is still
		// computed once below over exactly what actually ran.
		if (r?.status === 'cancelled') break;
	}
	// ONE staleness pass for the entire batch, over the real post-batch notebook
	// state (including an early stop): correct by construction, since it reads the
	// live doc rather than replaying per-cell verdicts.
	const { cells: stale }: { cells: StalenessMap } = await getNotebookStaleness(target);
	const toHandle = handleFn(target);
	const results: Array<Record<string, unknown>> = [];
	let ran = 0;
	let errored = 0;
	for (const { r, cell } of runs) {
		if (cell && isHidden(cell)) continue;
		results.push(toBatchRecord(r, cell, target, stale, toHandle));
		const outs = r.outputs;
		if (Array.isArray(outs)) {
			ran++;
			if (outs.some((o) => (o as { type?: string }).type === 'error')) errored++;
		}
	}
	return { ran, errored, results };
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
 * (same as run_all). Returns runCells' `{ ran, errored, results }` — the per-cell
 * records already name every cell that ran, so the old duplicate `ran:[ids]`
 * echo is gone.
 */
export async function runStale(nb?: string | null) {
	const target = nb ?? getActiveNotebookPath();
	const { cells: stale }: { cells: StalenessMap } = await getNotebookStaleness(target);
	const ids = staleIdsInOrder(listCells(target), stale);
	return runCells(ids, target);
}

/** Run code cells in the inclusive document range from→to. */
export async function runRange(fromId: string, toId: string, nb?: string | null) {
	const target = nb ?? getActiveNotebookPath();
	const all = listCells(target);
	const from = asFullId(target, fromId);
	const to = asFullId(target, toId);
	const i = all.findIndex((c) => c.id === from);
	const j = all.findIndex((c) => c.id === to);
	if (i < 0 || j < 0) return { ran: 0, errored: 0, results: [] as Array<Record<string, unknown>> };
	const [lo, hi] = i <= j ? [i, j] : [j, i];
	const ids = all.slice(lo, hi + 1).filter((c) => c.cell_type === 'code').map((c) => c.id);
	return runCells(ids, target);
}
