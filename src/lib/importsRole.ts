/**
 * Cellar — the imports cell's identity.
 *
 * ONE designated code cell per notebook holds the notebook's imports. It is
 * marked with `metadata.cellar.role = 'imports'` (the `cellar` namespace is the
 * one clean-on-save preserves, so the designation survives a save byte-for-byte
 * and produces no git noise). The cell is user-choosable — any code cell can be
 * designated — and it may live at ANY index: it is no longer pinned to the top.
 *
 * Both halves of the app read this identity: the server (`notebook.ts`) and the
 * browser both need `isImportsCell`/`importsCellIndex`, so they live in one pure,
 * browser-safe module rather than a predicate copied on each side.
 */

import type { CellMetadata } from '$lib/server/types';
import type { NotebookLanguage } from '$lib/cellLanguage';

/**
 * The minimal cell shape this rule reads. `Cell`/`CellView` are structurally
 * assignable, so server and browser callers pass their own cells without a cast.
 */
type RoleCell = { cell_type?: string; metadata?: CellMetadata | null } | null | undefined;

/** The `metadata.cellar.role` value that designates the imports cell. */
export const IMPORTS_ROLE = 'imports';

/**
 * Is this the notebook's imports cell? A markdown cell never is, so converting
 * the cell to markdown demotes it (see `setCellType`) rather than leaving an
 * un-runnable cell claiming to hold the imports.
 */
export function isImportsCell(cell: RoleCell): boolean {
	return !!cell && cell.cell_type === 'code' && cell.metadata?.cellar?.role === IMPORTS_ROLE;
}

/**
 * Can a notebook in this LANGUAGE use an imports cell at all?
 *
 * The imports cell is RUN by the PYTHON kernel, so on a Mojo notebook every
 * import routed into one would be stranded with nothing to execute them - which
 * is why `routeImports` and `consolidateImports` refuse such a notebook at their
 * own entry. Offering the mark there would be a dead control.
 */
export function notebookUsesImportsCell(notebookLanguage: NotebookLanguage): boolean {
	return notebookLanguage !== 'mojo';
}

/**
 * The cell CARRIES the role, but the notebook's language means it can never do
 * anything - a designation made while the notebook was Python and kept when it
 * switched to Mojo, since a language change touches no cell (which is the design).
 *
 * The mark is deliberately NOT cleared for the user: silently editing their
 * committed `.ipynb` because they changed a setting is the loss the nbdev export
 * mark's own stranded rule exists to prevent, and they cannot tell that apart
 * from Cellar losing their work. So it is SURFACED instead - the badge keeps
 * rendering and the control stays reachable, greyed, able only to CLEAR. That is
 * the hidden-vs-greyed distinction the export toggle already draws: a control
 * that can never mean anything is hidden, while one that retires stale state the
 * user would otherwise have no way to reach is shown.
 */
export function importsRoleStranded(cell: RoleCell, notebookLanguage: NotebookLanguage): boolean {
	return isImportsCell(cell) && !notebookUsesImportsCell(notebookLanguage);
}

/**
 * Why the greyed control can only clear, said on the control itself. Short and
 * per-cell like `EXPORT_STRANDED_CELL_TITLE`: it is a fact about THIS cell's
 * stale mark, so it needs no notebook-wide sentence beside it.
 */
export const IMPORTS_ROLE_STRANDED_TITLE =
	"This notebook is Mojo, and the imports cell is run by the Python kernel - it does nothing here. Clearing the mark is the only action.";

/** Index of the notebook's imports cell, or -1. */
export function importsCellIndex(cells: readonly RoleCell[] | null | undefined): number {
	return (cells ?? []).findIndex(isImportsCell);
}

/**
 * Where a move of `cells[fromIndex]` to `toIndex` is actually allowed to land.
 * `toIndex` is an index into the array with the moved cell already removed —
 * the same convention `moveCellTo` uses.
 *
 * The imports cell used to be pinned at index 0; it no longer is. A designated
 * cell moves like any other and cells move freely above it, so this is now the
 * identity function. It is kept (rather than deleted) because `notebook.ts` and
 * `Notebook.svelte` call it at every move site: routing every move through one
 * predicate leaves a single place to reintroduce a positional rule if one is
 * ever wanted again, and keeps the server/browser move math sharing one source.
 */
export function clampMoveIndex(
	_cells: readonly RoleCell[] | null | undefined,
	_fromIndex: number,
	toIndex: number
): number {
	return toIndex;
}
