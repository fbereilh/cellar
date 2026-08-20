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
 * A CHAT cell follows the SQL shape exactly: an nbformat `code` cell tagged
 * `metadata.cellar.language = 'chat'`, whose source is a QUESTION for the AI and
 * whose reply is a `display_data` output carrying `text/markdown` (a native
 * nbformat mime, so plain Jupyter renders the reply too). Two costs are ACCEPTED
 * and must not be "fixed" later:
 *   - **A chat reply is nondeterministic, so re-running a chat cell always
 *     produces a git diff.** Every other cell type re-runs to identical bytes
 *     (the zero-git-diff doctrine); a model reply cannot, and the alternative -
 *     not persisting it - would lose the reply on reload and contradict the
 *     reply-as-output design. The diff is the price of a durable reply.
 *   - **In plain Jupyter a chat cell is a code cell holding English prose**:
 *     it renders fine as a document, but running it there raises `SyntaxError` -
 *     the same interop trade already accepted for SQL cells.
 *
 * This module is the single source of truth for "is this a SQL/chat cell", for
 * the five-way LOGICAL cell type the UI toggle + MCP tools speak (`code` / `sql`
 * / `markdown` / `raw` / `chat`), and for the ONE mapping back onto nbformat
 * (`nbCellType`), shared by the server and the browser so the two never disagree.
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

/** The `cellar.language` value that marks a code cell as an AI chat cell. */
export const CHAT_LANGUAGE = 'chat';

/** The editor language of a code cell: 'sql'/'chat' when tagged, else 'python'. */
export function cellLanguage(cell: LanguageCell): 'sql' | 'chat' | 'python' {
	const tag = cell?.metadata?.cellar?.language;
	if (tag === SQL_LANGUAGE) return SQL_LANGUAGE;
	if (tag === CHAT_LANGUAGE) return CHAT_LANGUAGE;
	return 'python';
}

/** True for a code cell whose source is SQL (`cellar.language === 'sql'`). */
export function isSqlCell(cell: LanguageCell): boolean {
	return cell?.cell_type === 'code' && cellLanguage(cell) === SQL_LANGUAGE;
}

/**
 * True for a code cell whose source is a chat QUESTION (`cellar.language ===
 * 'chat'`). Run through the chat engine (`server/chat/`), never the kernel;
 * excluded from the Python dataflow probe and from staleness (reports `n/a`).
 */
export function isChatCell(cell: LanguageCell): boolean {
	return cell?.cell_type === 'code' && cellLanguage(cell) === CHAT_LANGUAGE;
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
 * The four LOGICAL cell types the UI toggle, the REST routes and the MCP
 * `cell_type` argument speak. The ONE vocabulary: a route that hand-maintained
 * its own copy would keep accepting three while the others accept four (this
 * list grew by one when `raw` landed), and an out-of-vocabulary value is not
 * inert - `nbCellType` maps anything it does not recognize onto `code`, so a
 * typo would silently turn a raw cell holding frontmatter into a runnable
 * Python cell.
 */
export const LOGICAL_CELL_TYPES: readonly LogicalCellType[] = ['code', 'sql', 'markdown', 'raw', 'chat'];

/**
 * Is `value` one of the logical cell types above? The predicate every entry point
 * that accepts a `cell_type` from a request body validates with, so a malformed
 * value is REFUSED rather than falling through `nbCellType`'s `code` default.
 */
export function isLogicalCellTypeName(value: unknown): value is LogicalCellType {
	return typeof value === 'string' && (LOGICAL_CELL_TYPES as readonly string[]).includes(value);
}

/** The refusal code a route reports when `raw` was asked for on a `.py` notebook. */
export const RAW_UNSUPPORTED_REASON = 'raw-in-py-notebook';

/** The refusal code a route reports when `chat` was asked for on a `.py` notebook. */
export const CHAT_UNSUPPORTED_REASON = 'chat-in-py-notebook';

/**
 * The logical types a `.py` TEXT notebook cannot hold, in ONE list.
 *
 * Both fail the same way and for the same reason (see `TextNotebookCellTypeError`
 * below): such a document is rebuilt from its CELLS on every save by jupytext /
 * the Databricks converter, which carries neither `cellar` cell metadata nor
 * outputs - so the declaration lives only in memory and disk holds a plain
 * `code` cell. The list exists so a SIXTH logical type is added HERE rather than
 * shipping straight into the same trap, and so no writer keeps a per-type copy
 * of the rule.
 */
export const PY_UNSUPPORTED_TYPES: readonly LogicalCellType[] = ['raw', 'chat'];

/** Can a `.py` TEXT notebook hold this logical type? */
export function isPyUnsupportedType(cellType: unknown): cellType is LogicalCellType {
	return typeof cellType === 'string' && (PY_UNSUPPORTED_TYPES as readonly string[]).includes(cellType);
}

/** The one message for the raw refusal, shared by the server writers and the browser. */
export const TEXT_NOTEBOOK_RAW_MESSAGE =
	'A .py notebook cannot hold a raw cell: a .py (jupytext / Databricks source) notebook is rebuilt from its CELLS on every save and has no raw marker, so the cell would come back after a reload as a RUNNABLE Python cell holding what was meant to be verbatim text. Convert it to .ipynb first.';

/** The same, for a chat cell - whose loss is worse: the REPLY goes with it. */
export const TEXT_NOTEBOOK_CHAT_MESSAGE =
	'A .py notebook cannot hold a chat cell: a .py (jupytext / Databricks source) notebook is rebuilt from its CELLS on every save and carries neither cell metadata nor outputs, so after a reload the cell would be a RUNNABLE Python cell holding English prose and the AI reply would be gone for good (no re-run reproduces it). Convert it to .ipynb first.';

/** The message for one unsupported type. */
export function textNotebookTypeMessage(cellType: LogicalCellType): string {
	return cellType === 'chat' ? TEXT_NOTEBOOK_CHAT_MESSAGE : TEXT_NOTEBOOK_RAW_MESSAGE;
}

/** The refusal code for one unsupported type. */
export function textNotebookTypeReason(cellType: LogicalCellType): string {
	return cellType === 'chat' ? CHAT_UNSUPPORTED_REASON : RAW_UNSUPPORTED_REASON;
}

/**
 * A logical type a `.py` TEXT notebook cannot hold was asked for (`raw`, `chat`).
 *
 * Such a notebook is written back through jupytext / the Databricks converter,
 * which rebuilds the file from its cells and coerces every `cell_type` to
 * markdown|code (`jupytext.ts`) - and coerces again on read, carrying no
 * `cellar` metadata and no outputs. So the declaration would live only in memory
 * while disk held a `code` cell: after a reload the frontmatter sits in a cell
 * with a Run button (raw), or the question does while its REPLY is gone (chat) -
 * the exact silent degrade each type exists to prevent, and worse from MARKDOWN,
 * whose prose would lose its markers on the way too.
 *
 * Refused by name instead, at the doc-layer writers, so no surface can route
 * around it - the `textNotebookRootError` precedent, for the identical
 * rebuilt-from-cells reason. Only these types, and only on a `.py` doc: every
 * other conversion, every raw or chat cell in an `.ipynb`, and CLEARING a type
 * are all untouched.
 */
export class TextNotebookCellTypeError extends Error {
	/** The refused logical type, and the route-facing code for it. */
	readonly cellType: LogicalCellType;
	readonly reason: string;
	constructor(cellType: LogicalCellType = 'raw') {
		super(textNotebookTypeMessage(cellType));
		this.name = 'TextNotebookCellTypeError';
		this.cellType = cellType;
		this.reason = textNotebookTypeReason(cellType);
	}
}

/** The refusal above, as a throwable. */
export function textNotebookCellTypeError(cellType: LogicalCellType): TextNotebookCellTypeError {
	return new TextNotebookCellTypeError(cellType);
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
	return 'code'; // 'code', 'sql' and 'chat' all share the nbformat code type
}

/**
 * The `cellar.language` tag a LOGICAL type carries on disk: 'sql' and 'chat' are
 * tagged code cells, everything else carries no tag. The ONE tag rule, shared by
 * the server's `applyCellType`/`newCell`, the `cell:type` event payload, and the
 * browser's `applyCellTypeLocally` - a per-site `isSql ? 'sql' : null` ternary is
 * how the chat tag would be dropped by whichever copy was not updated.
 */
export function languageTagFor(cellType: LogicalCellType): string | null {
	if (cellType === 'sql') return SQL_LANGUAGE;
	if (cellType === 'chat') return CHAT_LANGUAGE;
	return null;
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
	if (isSqlCell(cell)) return 'sql';
	return isChatCell(cell) ? 'chat' : 'code';
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
