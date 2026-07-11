/**
 * Cellar — the imports cell's identity + pinning rule.
 *
 * ONE designated code cell per notebook holds the notebook's imports. It is
 * marked with `metadata.cellar.role = 'imports'` (the `cellar` namespace is the
 * one clean-on-save preserves, so the designation survives a save byte-for-byte
 * and produces no git noise) and it is pinned at index 0.
 *
 * Both halves of the app need this: the server enforces the pin in `notebook.js`
 * and the browser must apply the SAME rule optimistically before its move POST
 * lands, or the two would disagree about where a cell went. Hence one pure,
 * browser-safe module rather than a predicate copied on each side.
 */

/** The `metadata.cellar.role` value that designates the imports cell. */
export const IMPORTS_ROLE = 'imports';

/**
 * Is this the notebook's imports cell? A markdown cell never is, so converting
 * the cell to markdown demotes it (see `setCellType`) rather than leaving an
 * un-runnable cell claiming to hold the imports.
 */
export function isImportsCell(cell) {
	return !!cell && cell.cell_type === 'code' && cell.metadata?.cellar?.role === IMPORTS_ROLE;
}

/** Index of the notebook's imports cell, or -1. */
export function importsCellIndex(cells) {
	return (cells ?? []).findIndex(isImportsCell);
}

/**
 * Where a move of `cells[fromIndex]` to `toIndex` is actually allowed to land.
 * `toIndex` is an index into the array with the moved cell already removed —
 * the same convention `moveCellTo` uses.
 *
 * The imports cell is pinned: it never leaves the top, and nothing may be
 * inserted above it. Returns `-1` when the move must be refused outright (the
 * pinned imports cell itself was asked to move).
 *
 * A notebook whose imports cell is NOT yet at index 0 (e.g. one just adopted, or
 * an `.ipynb` written elsewhere) is left free to move until `ensureImportsCell`
 * hoists it — the pin is a rule about the cell at the top, not a lock on a role.
 */
export function clampMoveIndex(cells, fromIndex, toIndex) {
	if (!isImportsCell(cells?.[0])) return toIndex;
	if (fromIndex === 0) return -1; // the pinned imports cell never moves
	return Math.max(1, toIndex);
}
