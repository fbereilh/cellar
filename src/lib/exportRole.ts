/**
 * Cellar — nbdev-style cell export identity.
 *
 * A code cell can be marked for export to a `.py` module (nbdev's `#|export`),
 * recorded as `metadata.cellar.export = true`. The `cellar` namespace is the one
 * clean-on-save preserves, so the flag survives a save byte-for-byte and produces
 * no git noise. Only code cells can be exported (a markdown/SQL cell carries no
 * Python module source), so converting a cell away from Python drops the flag.
 *
 * Both halves of the app read this identity — the server (`notebook.ts`,
 * `export-py.ts`) and the browser (`Cell.svelte`) — so it lives in one pure,
 * browser-safe module rather than a predicate copied on each side. It is the
 * export counterpart to `importsRole.ts`.
 */

import type { CellMetadata } from '$lib/server/types';
import { isLogicalCellType } from '$lib/cellLanguage';

/** The minimal cell shape this rule reads (Cell/CellView are assignable). */
type ExportCell = { cell_type?: string; metadata?: CellMetadata | null } | null | undefined;

/**
 * Is this cell marked for export to the `.py` module? Only a Python code cell can
 * be — a markdown/SQL cell has no module source, and `setCellType` drops the flag
 * when a cell is converted away from plain code.
 *
 * The test is `isLogicalCellType(cell, 'code')`, never a bare nbformat
 * `cell_type === 'code'`: a SQL cell IS an nbformat `code` cell tagged
 * `cellar.language='sql'` (see `cellLanguage.ts`), so that test admits one — and
 * its raw SQL would then be concatenated into the generated module, a file nbdev
 * commits to git. It is deliberately the STRICT predicate rather than
 * `logicalCellType(cell) === 'code'`, which maps an nbformat `raw` cell (passed
 * through untouched from an externally-authored notebook) to `code` too. Being the
 * one identity every surface reads (`export-py.ts` builds the module from it,
 * `Cell.svelte` draws the badge from it, the agent map reports it), fixing the
 * rule here is what keeps a stale or hand-edited flag on such a cell inert
 * everywhere rather than only at whichever setter last remembered to check.
 */
export function isExportCell(cell: ExportCell): boolean {
	return isLogicalCellType(cell, 'code') && cell?.metadata?.cellar?.export === true;
}

/** Count of cells currently marked for export. */
export function exportCellCount(cells: readonly ExportCell[] | null | undefined): number {
	return (cells ?? []).filter(isExportCell).length;
}
