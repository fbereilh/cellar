/**
 * Cellar — jupytext notebook actions (export `.py`, convert `.py` → `.ipynb`).
 *
 * The two human-invoked operations on top of the `.py` ⇄ cells boundary
 * (`jupytext.js`), kept out of `notebook.js` so that module stays a pure
 * document store:
 *
 *   1. EXPORT — write any open notebook (`.ipynb` or `.py`) out as a `.py` in a
 *      chosen jupytext/Databricks format. Source only, no outputs.
 *   2. CONVERT — take a `.py` notebook, RUN every code cell against the shared
 *      kernel to materialize outputs, then write a real `.ipynb` beside it. A
 *      cell that errors still lands its error output in the `.ipynb`, exactly as
 *      a normal run would; convert never aborts on a bad cell.
 */
import { listCells, resolveNotebookPath } from './notebook';
import { writeNotebook } from './ipynb';
import { enqueueRun } from './run-queue';
import { executeCellRun, clearOutputsForQueue } from './run';
import {
	JupytextError,
	SAVE_FORMATS,
	ensureJupytext,
	resolveInWorkspace,
	writePyNotebook
} from './jupytext';
import type { Actor } from './types';

/** Result of running every code cell of a `.py` notebook during a convert. */
interface RunSummary {
	total: number;
	ok: number;
	errors: number;
}

/**
 * Write `source` notebook's cells to `target` (`.py`) in `format`. `source` may
 * be an `.ipynb` or another `.py`; only source + cell type are written (no
 * outputs). Returns the workspace-relative target path.
 */
export async function exportNotebookAsPy({
	source,
	target,
	format
}: {
	source?: string;
	target: string;
	format: string;
}): Promise<{ path: string; format: string }> {
	if (!SAVE_FORMATS.includes(format)) {
		throw new JupytextError('bad_request', `unsupported format: ${JSON.stringify(format)} (use one of ${SAVE_FORMATS.join(', ')})`);
	}
	if (!target || !/\.py$/i.test(target)) {
		throw new JupytextError('bad_request', 'target must be a .py path');
	}
	// The percent/light writers need jupytext; the Databricks writer is pure text.
	if (format !== 'databricks') await ensureJupytext();
	const targetAbs = resolveInWorkspace(target);
	const cells = listCells(source);
	writePyNotebook(targetAbs, cells, format);
	return { path: target, format };
}

/**
 * Run every code cell of the `.py` notebook `nb` (an ABSOLUTE path) in order,
 * taking a ticket in the kernel-global FIFO for each like any other run. Returns
 * a `{ total, ok, errors }` summary. Errors are not fatal — the whole point of
 * convert is to capture them as outputs.
 */
async function runAllCells(nb: string, actor: Actor, originId?: string | null): Promise<RunSummary> {
	const cells = listCells(nb).filter((c) => c.cell_type === 'code');
	let ok = 0;
	let errors = 0;
	for (const c of cells) {
		const ticket = enqueueRun({ nb, cellId: c.id, actor, source: c.source ?? '' });
		if (ticket.duplicate) continue; // already running/queued elsewhere; its run stands
		// Clear this cell's stale output the moment it is queued (see run.ts).
		clearOutputsForQueue({ nb, cellId: c.id, originId });
		try {
			await ticket.wait();
		} catch {
			continue; // the queue dropped it (kernel restart); leave its outputs as-is
		}
		try {
			const res = await executeCellRun({ nb, cellId: c.id, actor, source: ticket.source() ?? c.source ?? '', originId });
			if (res.status === 'ok') ok += 1;
			else errors += 1;
		} finally {
			ticket.done();
		}
	}
	return { total: cells.length, ok, errors };
}

/**
 * Open the `.py` notebook `source`, run all its cells, and write a real `.ipynb`
 * (with outputs) to `target`. Returns `{ path, ran }` where `ran` is the run
 * summary. The `.py` itself is untouched (a run does not rewrite a text notebook).
 */
export async function convertPyToIpynb({
	source,
	target,
	actor = 'user',
	originId
}: {
	source?: string;
	target: string;
	actor?: Actor;
	originId?: string | null;
}): Promise<{ path: string; ran: RunSummary }> {
	if (!source || !/\.py$/i.test(source)) throw new JupytextError('bad_request', 'source must be a .py notebook');
	if (!target || !/\.ipynb$/i.test(target)) throw new JupytextError('bad_request', 'target must be a .ipynb path');
	// Loads the `.py` as a live doc (needs jupytext for percent/light); Databricks
	// parsing is pure text, but ensuring here gives one clear message either way.
	await ensureJupytext();
	const abs = resolveNotebookPath(source);
	listCells(abs); // force-load the doc so a bad `.py` fails here, before running anything
	const ran = await runAllCells(abs, actor, originId);
	const targetAbs = resolveInWorkspace(target);
	writeNotebook(targetAbs, { path: targetAbs, cells: listCells(abs), metadata: undefined });
	return { path: target, ran };
}
