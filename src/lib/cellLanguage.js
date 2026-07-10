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
 * genuinely matters: syntax highlighting, and how its source is executed
 * (`server/sql.js` wraps it as `spark.sql(...)`).
 *
 * This module is the single source of truth for "is this a SQL cell" and for the
 * three-way LOGICAL cell type the UI toggle + MCP tools speak (`code` / `sql` /
 * `markdown`), shared by the server and the browser so the two never disagree.
 */

/** The `cellar.language` value that marks a code cell as SQL. */
export const SQL_LANGUAGE = 'sql';

/** The editor language of a code cell: 'sql' when tagged, else 'python'. */
export function cellLanguage(cell) {
	return cell?.metadata?.cellar?.language === SQL_LANGUAGE ? SQL_LANGUAGE : 'python';
}

/** True for a code cell whose source is SQL (`cellar.language === 'sql'`). */
export function isSqlCell(cell) {
	return cell?.cell_type === 'code' && cellLanguage(cell) === SQL_LANGUAGE;
}

/**
 * The LOGICAL cell type the UI cell-type control and the MCP `cell_type` argument
 * use: `markdown`, `sql`, or `code`. Distinct from the nbformat `cell_type`
 * (`code`/`markdown`) because SQL and Python share the `code` type on disk.
 */
export function logicalCellType(cell) {
	if (cell?.cell_type === 'markdown') return 'markdown';
	return isSqlCell(cell) ? 'sql' : 'code';
}
