/**
 * Cellar — the imports cell.
 *
 * ONE user-choosable code cell per notebook, marked
 * `metadata.cellar.role = 'imports'` and living at any index, holds the
 * notebook's imports. Two things fill it, and only these two:
 *
 *   1. CONSOLIDATE (`consolidateImports`) — an explicit, human-invoked sweep that
 *      lifts every module-level import out of every cell.
 *   2. AGENT ROUTING (`routeImports`) — the MCP write tools lift the imports out
 *      of the code an agent submits, before it becomes a cell.
 *
 * A human typing `import os` into cell 7 is left completely alone. Their cell is
 * their cell; yanking a line out from under a cursor is the one behavior this
 * feature must never have. Both entry points above are deliberate acts — a menu
 * click, or an agent's write — and neither observes a human's keystrokes.
 *
 * When new imports land, the imports cell RUNS: an import the kernel has not
 * executed is worse than no import at all, because the agent's next cell then
 * fails with a NameError against a notebook that looks correct. Errors from that
 * run (a missing package) surface as the cell's own outputs, exactly as if a human
 * had pressed Run — never swallowed.
 */
import {
	listCells,
	getCell,
	setSource,
	deleteCell,
	addCellAt,
	setCellRole,
	getImportsCell,
	resolveNotebookPath
} from './notebook';
import { IMPORTS_ROLE, isImportsCell } from '../importsRole';
import { extractTopLevelImports, mergeImportSources, isImportsOnly, hasTopLevelImports } from './imports';
import { isCellMagicCell } from './magics';
import { enqueueRun, queuePosition, RunCancelled } from './run-queue';
import { executeCellRun, clearOutputsForQueue } from './run';
import type { Actor, Cell, CellView, CellOutput, SessionId } from './types';

/** The imports cell's run outcome: a run result, or a non-executing status when
 * the kernel queue refused (duplicate/running) or dropped (cancelled) the ticket. */
export interface ImportsRunResult {
	id: string;
	status: string;
	queue_position?: number;
	note?: string;
	reason?: string;
	session?: SessionId | null;
	outputs?: CellOutput[];
}

/** The result of routing an agent's module-level imports into the imports cell. */
export interface RouteImportsResult {
	source: string;
	added: string[];
	importsCellId: string | null;
}

/** The result of a full-notebook consolidate sweep. */
export interface ConsolidateResult {
	changed: boolean;
	imports_cell_id: string | null;
	added: string[];
	edited: number;
	removed: number;
	run: ImportsRunResult | null;
}

/**
 * The notebook's imports cell, creating it only if there is nowhere to put the
 * imports.
 *
 * The imports cell is user-choosable and un-pinned, so its POSITION is left
 * exactly where the user (or a prior adoption) put it — this function never
 * hoists a designated cell to the top.
 *
 *   1. A cell already carries the role → return it where it sits.
 *   2. FALLBACK, no designated cell. A notebook whose first cell is already
 *      nothing but imports (comments and blank lines allowed) is the common
 *      shape, so that cell is adopted in place rather than stacking a second
 *      import cell on top of it.
 *   3. FALLBACK, nothing to adopt → a fresh code cell is inserted at index 0.
 *      This is the ONE case that touches the top: a notebook with no imports cell
 *      at all needs the imports to land somewhere sensible, and the top of the
 *      notebook is where imports conventionally live. The user can then move it,
 *      or designate a different cell.
 *
 * This is only ever called from the two deliberate import flows (agent routing
 * and human consolidate); merely opening a notebook creates nothing. To look one
 * up WITHOUT creating it, use `getImportsCell`.
 */
export function ensureImportsCell(nb?: string | null, originId?: string | null): Cell | CellView {
	const cells = listCells(nb);
	const existing = cells.find(isImportsCell);
	// Honor the user's designation wherever it is — do NOT hoist it to the top.
	if (existing) return getCell(existing.id, nb)!;

	const first = cells[0];
	if (first && first.cell_type === 'code' && isImportsOnly(first.source)) {
		setCellRole(first.id, IMPORTS_ROLE, nb, originId);
		return getCell(first.id, nb)!;
	}
	return addCellAt(0, 'code', nb, originId, '', IMPORTS_ROLE);
}

/**
 * Run the imports cell against the shared kernel, taking its turn in the
 * kernel-global FIFO like any other run (`run-queue.js`): one kernel means one
 * run at a time, and an import block is not special enough to jump a human's
 * queued cell.
 *
 * Returns a run result, or a non-executing status when the queue refused or
 * dropped the ticket. The `duplicate` case is not an error: the imports cell is
 * already in the kernel's hands, and a QUEUED entry has just had its source
 * refreshed to the merged one, so the new imports will execute when its turn
 * comes. Only a cell already EXECUTING right now cannot pick them up — the caller
 * is told so rather than being left to assume the kernel has them.
 */
export async function runImportsCell(
	nb?: string | null,
	actor: Actor = 'agent',
	originId?: string | null
): Promise<ImportsRunResult | null> {
	const abs = resolveNotebookPath(nb);
	const cell = listCells(abs).find(isImportsCell);
	if (!cell) return null;

	const ticket = enqueueRun({ nb: abs, cellId: cell.id, actor, source: cell.source ?? '' });
	if (ticket.duplicate) {
		const position = queuePosition(abs, cell.id);
		return position
			? { id: cell.id, status: 'queued', queue_position: position, note: 'the imports cell is already queued; it will run the merged imports when the kernel frees.' }
			: { id: cell.id, status: 'running', note: 'the imports cell is executing right now, so it did not pick up the new imports; re-run it once it finishes.' };
	}
	// Clear the imports cell's stale output the moment it is queued (see run.ts).
	clearOutputsForQueue({ nb: abs, cellId: cell.id, originId });
	try {
		await ticket.wait!();
	} catch (err) {
		return { id: cell.id, status: 'cancelled', reason: err instanceof RunCancelled ? err.reason : 'cancelled' };
	}
	try {
		const res = await executeCellRun({
			nb: abs,
			cellId: cell.id,
			actor,
			source: ticket.source!() ?? cell.source ?? '',
			originId
		});
		return { id: cell.id, status: res.status, session: res.session, outputs: res.outputs };
	} finally {
		ticket.done!();
	}
}

/**
 * Route the module-level imports out of code an AGENT is about to write into a
 * cell: merge the new ones into the imports cell and hand back the code with
 * those lines removed. Purely a document edit — the caller decides whether to run
 * the imports cell (it should, whenever `added` is non-empty).
 *
 * `skipCellId` keeps an edit to the imports cell itself from routing into itself.
 * No import in the code (or an unparseable one) means no imports cell is created:
 * an agent writing `x = 1` must not conjure an empty pinned cell.
 */
export function routeImports(
	source: string,
	nb?: string | null,
	originId?: string | null,
	{ skipCellId = null }: { skipCellId?: string | null } = {}
): RouteImportsResult {
	const none: RouteImportsResult = { source, added: [], importsCellId: null };
	if (skipCellId && getImportsCell(nb)?.id === skipCellId) return none;
	// A cell magic (`%%bash`, `%%writefile foo.py`, …) is a deliberate special cell
	// whose body is not ordinary Python — never rearrange its lines, even if the body
	// happens to contain an `import`-looking line (a writefile of a .py file does).
	if (isCellMagicCell(source)) return none;
	if (!hasTopLevelImports(source)) return none;

	const { statements, source: stripped } = extractTopLevelImports(source);
	const cell = ensureImportsCell(nb, originId);
	const { source: merged, added } = mergeImportSources(cell.source ?? '', statements);
	if (added.length) setSource(cell.id, merged, nb, originId);
	return { source: stripped, added, importsCellId: cell.id };
}

/**
 * Sweep every module-level import in the notebook into the imports cell, strip
 * them from their source cells, and run the imports cell.
 *
 * IDEMPOTENT: a second consolidate finds nothing left to lift, adds nothing to a
 * cell whose imports are already canonical (`mergeImportSources` returns the
 * existing source untouched), and therefore does not run the kernel either. The
 * document is byte-identical and no cell re-executes.
 *
 * A cell left EMPTY by the sweep (it held nothing but imports) is deleted rather
 * than left as an empty husk — except the notebook's last cell, which must always
 * exist, and the imports cell itself.
 *
 * Runs with NO `originId`: the tab that clicked Consolidate wants the resulting
 * edits, deletions and insert rendered like any other tab's, rather than having to
 * replay a whole multi-cell sweep locally.
 */
export async function consolidateImports(
	nb?: string | null,
	{ actor = 'user' }: { actor?: Actor } = {}
): Promise<ConsolidateResult> {
	const abs = resolveNotebookPath(nb);
	const cells = listCells(abs);
	const existing = cells.find(isImportsCell);

	// Resolve the imports cell FIRST so it is excluded from its own sweep, then
	// plan every edit before touching the document (planning over a mutating array
	// is how a sweep silently skips cells).
	const adoptable = !existing && cells[0]?.cell_type === 'code' && isImportsOnly(cells[0].source);
	const importsSourceCell = existing ?? (adoptable ? cells[0] : null);

	const collected: string[] = [];
	const edits: { id: string; source: string }[] = [];
	const removals: string[] = [];
	for (const cell of cells) {
		if (cell.cell_type !== 'code' || cell.id === importsSourceCell?.id) continue;
		if (isCellMagicCell(cell.source)) continue; // never sweep a cell magic's body
		const { statements, source, changed } = extractTopLevelImports(cell.source);
		if (!changed) continue;
		collected.push(...statements);
		if (source.trim() === '') removals.push(cell.id);
		else edits.push({ id: cell.id, source });
	}

	// Nothing to lift, no cell already designated, and no first cell worth adopting
	// → this notebook has no imports to manage. Do not create an empty pinned cell.
	if (!collected.length && !existing && !(adoptable && hasTopLevelImports(cells[0].source))) {
		return { changed: false, imports_cell_id: null, added: [], edited: 0, removed: 0, run: null };
	}

	const cell = ensureImportsCell(abs);
	const { source: merged, added } = mergeImportSources(cell.source ?? '', collected);

	if (added.length) setSource(cell.id, merged, abs);
	for (const e of edits) setSource(e.id, e.source, abs);
	// A notebook keeps at least one cell; the imports cell may not be swept away.
	for (const id of removals) {
		if (listCells(abs).length <= 1) break;
		deleteCell(id, abs);
	}

	const changed = !!(added.length || edits.length || removals.length || !existing);
	// Only run when something actually moved — that is what makes a second
	// consolidate a true no-op rather than a redundant kernel round-trip.
	const run = changed && added.length ? await runImportsCell(abs, actor) : null;

	return {
		changed,
		imports_cell_id: cell.id,
		added,
		edited: edits.length,
		removed: removals.length,
		run
	};
}
