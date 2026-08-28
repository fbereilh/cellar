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
 * MAY this cell carry the export flag? Only a Python code cell — a markdown/SQL
 * cell has no module source, and `setCellType` drops the flag when a cell is
 * converted away from plain code.
 *
 * The test is `isLogicalCellType(cell, 'code')`, never a bare nbformat
 * `cell_type === 'code'`: a SQL cell IS an nbformat `code` cell tagged
 * `cellar.language='sql'` (see `cellLanguage.ts`), so that test admits one — and
 * its raw SQL would then be concatenated into the generated module, a file nbdev
 * commits to git. It is deliberately the STRICT predicate rather than
 * `logicalCellType(cell) === 'code'`, which maps an nbformat `raw` cell (passed
 * through untouched from an externally-authored notebook) to `code` too.
 *
 * This is the ELIGIBILITY rule, exported so the two SETTERS (`notebook.ts`'s
 * `setCellExports`, MCP's `setCellExport`) test it through the same function
 * `isExportCell` is built from, rather than each re-deriving it from
 * `isLogicalCellType` and agreeing only by coincidence. A cell can then never be
 * marked into a state the exporter ignores.
 *
 * It is the SAME test as `$lib/cellLanguage`'s `isPythonCodeCell`, under its own
 * name because it is also the export eligibility rule - which is why a MOJO cell
 * was excluded here the day the type landed, with no edit: stated positively, a
 * new tagged language is out of the nbdev module by construction. That matters,
 * because the generated `.py` is a file nbdev COMMITS TO GIT, so admitting a
 * non-Python body writes invalid Python into the repository.
 */
export function canExportCell(cell: ExportCell): boolean {
	return isLogicalCellType(cell, 'code');
}

/**
 * Is this cell marked for export to the `.py` module? Eligible (`canExportCell`)
 * AND flagged.
 *
 * Being the one identity every surface reads (`export-py.ts` builds the module
 * from it, `Cell.svelte` draws the badge from it, the agent map reports it),
 * keeping the eligibility half here is what makes a stale or hand-edited flag on
 * a markdown/SQL/raw cell inert everywhere rather than only at whichever setter
 * last remembered to check.
 */
export function isExportCell(cell: ExportCell): boolean {
	return canExportCell(cell) && cell?.metadata?.cellar?.export === true;
}

/** Count of cells currently marked for export. */
export function exportCellCount(cells: readonly ExportCell[] | null | undefined): number {
	return (cells ?? []).filter(isExportCell).length;
}
