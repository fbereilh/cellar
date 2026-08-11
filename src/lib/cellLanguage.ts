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
 * (`server/dataflow.js` keeps it out of the Python `ast`/`symtable` probe and reads the
 * names it binds from `sql.js` instead, so staleness still sees its result).
 *
 * `raw` is the OPPOSITE case, and the same reasoning gives the opposite answer:
 * it IS one of nbformat 4.5's three types, so encoding it as a tagged code cell
 * would be exactly the interop breakage the SQL decision was avoiding, with the
 * sign flipped - Quarto reads `"cell_type": "raw"` to find frontmatter, and
 * nbconvert/nbdev route raw cells by it, so a tagged code cell would be executed
 * or rendered by every downstream tool. It is therefore a real `cell_type`, which
 * Cellar already wrote to disk (`ipynb.ts` passes a foreign type through
 * verbatim) long before it was a type the UI could choose.
 *
 * This module is the single source of truth for "is this a SQL cell", for the
 * four-way LOGICAL cell type the UI toggle + MCP tools speak (`code` / `sql` /
 * `markdown` / `raw`), and for the ONE mapping back onto nbformat (`nbCellType`),
 * shared by the server and the browser so the two never disagree.
 */

import type { CellMetadata, CellType, LogicalCellType } from '$lib/server/types';

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
 * True for an nbformat `raw` cell: verbatim text Cellar never executes and never
 * renders (frontmatter for Quarto/nbdev, directives for nbconvert). The ONE
 * predicate, so no surface hand-writes `cell.cell_type === 'raw'`.
 */
export function isRawCell(cell: LanguageCell): boolean {
	return cell?.cell_type === 'raw';
}

/**
 * The nbformat `cell_type` a LOGICAL type maps onto. `sql` is a `code` cell
 * tagged `cellar.language='sql'`; `markdown` and `raw` are nbformat types of
 * their own.
 *
 * The ONE mapping. It replaced four hand-written copies of
 * `=== 'markdown' ? 'markdown' : 'code'` (`newCell`, `applyCellType`,
 * `isLogicalCellType`, `LiveNotebook.applyCellTypeLocally`) - a shorthand that
 * reads every third type as code, which is precisely what let a raw cell be
 * silently retyped by whichever copy was not updated.
 */
export function nbCellType(cellType: LogicalCellType): CellType {
	if (cellType === 'markdown') return 'markdown';
	if (cellType === 'raw') return 'raw';
	return 'code';
}

/**
 * The LOGICAL cell type the UI cell-type control and the MCP `cell_type` argument
 * use: `markdown`, `raw`, `sql`, or `code`. Distinct from the nbformat
 * `cell_type` because SQL and Python share the `code` type on disk.
 *
 * The raw arm is tested BEFORE the SQL one to state the intent: a foreign
 * notebook's raw cell may carry any metadata, and although `isSqlCell` already
 * requires `cell_type === 'code'`, the answer must not rest on that.
 */
export function logicalCellType(cell: LanguageCell): LogicalCellType {
	if (cell?.cell_type === 'markdown') return 'markdown';
	if (isRawCell(cell)) return 'raw';
	return isSqlCell(cell) ? 'sql' : 'code';
}

/**
 * Is `cell` ALREADY `cellType` - i.e. would switching it be a no-op? The ONE rule
 * behind the bulk retype's skip: the server's `setCellTypes` skips on it and the
 * browser predicts the resulting count from it, so a legitimate skip can never
 * read as a refused batch.
 *
 * Requiring BOTH halves - the nbformat type via `nbCellType` and the logical type
 * - is what keeps `isLogicalCellType(rawCell, 'code')` FALSE. That entry carries
 * the weight: if it flips, a bulk retype-to-code silently stops converting a raw
 * cell while the single-cell `setCellType`, which has no "already" check at all,
 * still does - the divergence this predicate exists to close. The nbformat half
 * also keeps an nbformat `raw` cell out of `code` for the same reason it always
 * did, now stated by the shared mapping rather than an inlined ternary.
 */
export function isLogicalCellType(cell: LanguageCell, cellType: LogicalCellType): boolean {
	return cell?.cell_type === nbCellType(cellType) && logicalCellType(cell) === cellType;
}
