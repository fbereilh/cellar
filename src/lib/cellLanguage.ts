/**
 * Cellar - cell language (pure, browser-safe).
 *
 * A SQL cell is an nbformat `code` cell tagged `metadata.cellar.language = 'sql'`
 * - NOT a new `cell_type`. nbformat 4.5 only defines `code`/`markdown`/`raw`, and
 * jupytext / other tools would choke on an invented cell_type, so the language is
 * carried in Cellar's allowlisted `cellar` metadata namespace instead (it
 * round-trips clean-on-save with zero git noise, exactly like the imports role).
 * A SQL cell therefore runs through the SAME code-cell machinery everywhere - run
 * queue, run status, staleness, persistence - and only differs where the language
 * genuinely matters: syntax highlighting; how its source is executed
 * (`server/sql.js` wraps it as `spark.sql(...)`); and how its dataflow is derived
 * (`server/dataflow.js` keeps it out of the Python `symtable` probe and reads the
 * names it binds from `sql.js` instead, so staleness still sees its result).
 *
 * This module is the single source of truth for "is this a SQL cell" and for the
 * three-way LOGICAL cell type the UI toggle + MCP tools speak (`code` / `sql` /
 * `markdown`), shared by the server and the browser so the two never disagree.
 */

import type { CellMetadata, LogicalCellType } from '$lib/server/types';

/**
 * The minimal cell shape these helpers read. Every canonical cell shape
 * (`Cell`, `CellView`, `NbCell`) is structurally assignable, so callers on both
 * the server and the browser pass their own cells without a cast.
 */
type LanguageCell = { cell_type?: string; metadata?: CellMetadata | null } | null | undefined;

/** The `cellar.language` value that marks a code cell as SQL. */
export const SQL_LANGUAGE = 'sql';

/** The editor language of a code cell: 'sql' when tagged, else 'python'. */
export function cellLanguage(cell: LanguageCell): 'sql' | 'python' {
	return cell?.metadata?.cellar?.language === SQL_LANGUAGE ? SQL_LANGUAGE : 'python';
}

/** True for a code cell whose source is SQL (`cellar.language === 'sql'`). */
export function isSqlCell(cell: LanguageCell): boolean {
	return cell?.cell_type === 'code' && cellLanguage(cell) === SQL_LANGUAGE;
}

/**
 * The LOGICAL cell type the UI cell-type control and the MCP `cell_type` argument
 * use: `markdown`, `sql`, or `code`. Distinct from the nbformat `cell_type`
 * (`code`/`markdown`) because SQL and Python share the `code` type on disk.
 */
export function logicalCellType(cell: LanguageCell): LogicalCellType {
	if (cell?.cell_type === 'markdown') return 'markdown';
	return isSqlCell(cell) ? 'sql' : 'code';
}
