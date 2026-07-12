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
