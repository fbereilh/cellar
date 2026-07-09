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
	deleteCell,
	moveCellTo,
	setVisibility,
	getActiveNotebookPath,
	createNotebook as createNotebookDoc
} from '../notebook.js';
import { execute, restartKernel, interruptKernel, kernelStatus } from '../kernel.js';
import { kernelState } from '../inspect.js';
import { publish } from '../events.js';

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

function runStatus(cell) {
	if (cell.cell_type !== 'code') return 'n/a';
	const outs = cell.outputs || [];
	if (outs.some((o) => o.output_type === 'error')) return 'error';
	return outs.length ? 'ok' : 'unrun';
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

function readForm(cell, cap = READ_CAP) {
	return {
		id: cell.id,
		type: cell.cell_type,
		source: cell.source,
		run_status: runStatus(cell),
		has_output: hasOutput(cell),
		visible: !isHidden(cell),
		outputs: summarizeOutputs(cell, cap)
	};
}

// --- lifecycle --------------------------------------------------------------

export const kernel = {
	restart: () => restartKernel(),
	interrupt: () => interruptKernel(),
	status: () => kernelStatus()
};

export function listNotebooks() {
	const nb = getNotebook();
	return [{ path: nb.path, workspace: nb.workspace, open: true }];
}

export function openNotebook() {
	const nb = getNotebook();
	return { path: nb.path, workspace: nb.workspace, cells: nb.cells.length };
}

/**
 * Create (or open) a workspace notebook and make it active. `name` is an
 * optional `.ipynb` filename (defaults to `untitled.ipynb`); the `.ipynb`
 * suffix is added if missing. Broadcasts `notebook:opened` so an open browser
 * surfaces the new notebook in a tab live. Returns its path + cell count.
 */
export function createNotebook(name) {
	let rel = (name || 'untitled').trim();
	if (!/\.ipynb$/i.test(rel)) rel += '.ipynb';
	const nb = createNotebookDoc(rel);
	return { path: nb.path, workspace: nb.workspace, cells: nb.cells.length };
}

// --- read -------------------------------------------------------------------

/** Hierarchical section tree derived from markdown headers (spec §4). */
export function getNotebookMap() {
	const cells = visibleCells();
	const root = [];
	const stack = [];
	const leaf = (c) => ({
		id: c.id,
		kind: 'cell',
		type: c.cell_type,
		summary: firstLine(c.source),
		run_status: runStatus(c),
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
	return { notebook: nb.path, cell_count: cells.length, sections: root };
}

/**
 * Live kernel namespace, bucketed into imports / functions / classes /
 * variables. Returns `{ started: false }` when no kernel is running rather than
 * forcing a boot.
 */
export function getKernelState() {
	return kernelState();
}

export function readCell(id) {
	const c = getCell(id);
	if (!c || isHidden(c)) return null;
	return readForm(c);
}

export function readCells(ids) {
	return ids.map((id) => readCell(id)).filter(Boolean);
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
	return { header: { id: cells[idx].id, level: h.level, title: h.title }, cells: out.map((c) => readForm(c)) };
}

export function searchCells(query, where = 'both') {
	const q = (query || '').toLowerCase();
	if (!q) return [];
	const results = [];
	const snippet = (text) => {
		const i = text.toLowerCase().indexOf(q);
		if (i < 0) return null;
		const start = Math.max(0, i - 40);
		return (start > 0 ? '…' : '') + text.slice(start, i + q.length + 40).replace(/\n/g, ' ') + '…';
	};
	for (const c of visibleCells()) {
		if (where === 'input' || where === 'both') {
			const s = snippet(c.source || '');
			if (s) results.push({ id: c.id, where: 'input', snippet: s });
		}
		if (where === 'output' || where === 'both') {
			const otext = (c.outputs || []).map(outputText).join('\n');
			const s = snippet(otext);
			if (s) results.push({ id: c.id, where: 'output', snippet: s });
		}
	}
	return results;
}

export function getErrors() {
	const errs = [];
	for (const c of visibleCells()) {
		for (const o of c.outputs || []) {
			if (o.output_type === 'error') {
				errs.push({
					id: c.id,
					ename: o.ename,
					evalue: o.evalue,
					traceback: capText(stripAnsi((o.traceback || []).join('\n')), MEDIUM_CAP).text
				});
			}
		}
	}
	return errs;
}

/** Tiered: medium cap by default; full only on size='full'. Images passed through. */
export function getFullOutput(id, size = 'medium') {
	const c = getCell(id);
	if (!c || isHidden(c)) return null;
	const cap = size === 'full' ? Infinity : MEDIUM_CAP;
	const outputs = (c.outputs || []).map((o) => {
		const img = imageKey(o);
		if (img) return { type: o.output_type, image: img, data: o.data[img] };
		return summarizeOutput(o, cap);
	});
	return { id: c.id, size, outputs };
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

async function runSource(source, onOutput) {
	const outputs = [];
	const reply = await execute(source, (ev) => {
		if (ev.type === 'output') {
			outputs.push(ev.output);
			onOutput?.(ev.output);
		}
	});
	return { outputs, status: reply?.status ?? 'ok' };
}

/**
 * Run one cell by id; markdown cells are skipped (no kernel).
 *
 * Broadcasts the run lifecycle (`run:start` / `run:output` per streamed chunk /
 * `run:end`) over the event bus tagged `actor:'agent'`, so an already-open
 * browser shows this agent-driven run — running indicator + streaming outputs —
 * with no reload. `runCells`/`runAll`/`runRange` all funnel through here, so
 * every MCP run path broadcasts.
 */
export async function runCell(id) {
	const c = getCell(id);
	if (!c) return null;
	if (c.cell_type !== 'code') return { id, status: 'skipped', note: 'not a code cell' };
	const nb = getActiveNotebookPath();
	const startedAt = Date.now();
	publish({ type: 'run:start', nb, cellId: id, actor: 'agent', at: startedAt });
	let outputs = [];
	let status = 'ok';
	try {
		const res = await runSource(c.source || '', (output) => publish({ type: 'run:output', nb, cellId: id, output }));
		outputs = res.outputs;
		status = res.status;
	} catch (err) {
		const output = { output_type: 'error', ename: 'CellarError', evalue: String(err?.message ?? err), traceback: [String(err?.message ?? err)] };
		outputs = [output];
		publish({ type: 'run:output', nb, cellId: id, output });
		status = 'error';
	}
	setOutputs(id, outputs);
	publish({ type: 'run:end', nb, cellId: id, actor: 'agent', at: Date.now(), durationMs: Date.now() - startedAt, status });
	const hiddenNote = isHidden(c) ? { hidden: true } : {};
	return { id, status, ...hiddenNote, outputs: outputs.map((o) => summarizeOutput(o, READ_CAP)) };
}

export async function runCells(ids) {
	const results = [];
	for (const id of ids) {
		const r = await runCell(id);
		if (r && !isHidden(getCell(id) || {})) results.push(r);
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
