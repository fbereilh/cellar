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
 * MOJO IS NOT A CELL TAG AT ALL - IT IS THE NOTEBOOK'S LANGUAGE. A notebook is
 * either Python or Mojo and never both (the captain's ruling), so the choice is
 * made ONCE, in notebook metadata (`metadata.cellar.language = 'mojo'`; absent
 * means Python, permanently and with no migration), and every plain `code` cell
 * in that notebook IS a cell of that language. There is deliberately no per-cell
 * `mojo` tag and no `mojo` entry in `LOGICAL_CELL_TYPES`: a second, per-cell
 * spelling of the same fact is a setting that can CONTRADICT the notebook's, which
 * is precisely the mixed-language notebook the ruling excludes. `sql` and `chat`
 * stay per-cell because they are orthogonal cell KINDS that legitimately coexist
 * in one notebook - a SQL cell and a chat cell sit happily in a Python notebook -
 * whereas python-vs-mojo is the notebook's own axis.
 *
 * The mechanism a Mojo code cell then runs through is unchanged, and one
 * difference decides its whole design: the kernel is a PYTHON kernel and Modular
 * ships NO Mojo Jupyter kernel, so a Mojo cell runs the only way Modular supports
 * - `import mojo.notebook` registers a `%%mojo` CELL MAGIC, and the magic writes
 * the body to a temp file, `mojo run`s it in a subprocess and prints its stdout.
 * `server/mojo.ts` compiles such a cell to that magic at RUN time exactly as
 * `server/sql.ts` compiles SQL to `spark.sql(...)`; the source on disk stays bare
 * Mojo. Two costs are ACCEPTED and must not be "fixed" later:
 *   - **NO state persists between Mojo cells.** Each `%%mojo` cell is a fresh temp
 *     file and a fresh `mojo run`, so Modular's own docs say every Mojo cell must
 *     be a complete program with a `main()`. That is Modular's semantics, not a
 *     Cellar defect; Cellar states it (the badge tooltip) rather than faking
 *     continuity.
 *   - **In plain Jupyter a Mojo notebook's cells are code cells holding Mojo
 *     source**: they render fine, and running one there raises `SyntaxError` -
 *     the same interop trade already accepted for SQL and chat cells.
 *
 * This module is the single source of truth for the NOTEBOOK language
 * (`notebookLanguageOf`), for "is this a SQL/chat/Mojo cell", for the five-way
 * LOGICAL cell type the UI toggle + MCP tools speak (`code` / `sql` / `markdown`
 * / `raw` / `chat`), and for the ONE mapping back onto nbformat (`nbCellType`),
 * shared by the server and the browser so the two never disagree.
 *
 * EVERY LANGUAGE-RESOLVING PREDICATE TAKES THE NOTEBOOK LANGUAGE AND DEFAULTS IT
 * TO `python`. That default is not laziness: `python` is the answer for every
 * notebook that existed before this axis did and for every notebook that never
 * sets it, so an untouched caller keeps its exact previous behaviour and a Python
 * notebook is byte-for-byte unaffected. Callers that HAVE a notebook in scope pass
 * the real value; the pattern is `canExportCell(cell, lang = 'python')`'s, which
 * this file's own `exportRole.ts` sibling already established.
 *
 * IT ALSO OWNS THE TWO "WHOSE SOURCE IS PYTHON" PREDICATES every Python-semantics
 * engine asks (`isPythonCodeCell`, `hasPythonDataflow`). They are stated
 * POSITIVELY - a language is in the set only by being named - so a SEVENTH
 * language is excluded from the dataflow probe, the staleness graph and the
 * imports sweep BY CONSTRUCTION rather than by three new
 * `&& !isWhateverCell(c)` clauses that a future language would have to remember
 * to add in three places. (The nbdev export asks a target-aware question of its
 * own instead - see `isPythonCodeCell` below.)
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

/**
 * The `metadata.cellar.language` value on a NOTEBOOK that makes it a Mojo
 * notebook. Deliberately the same spelling as the per-cell tag key: it answers
 * the same question ("what language is this?") one level up.
 */
export const MOJO_LANGUAGE = 'mojo';

/**
 * The language a notebook's plain `code` cells are written in. Exactly two, and
 * `python` is what an absent declaration means - permanently, so a notebook that
 * never sets it needs no migration and no compatibility shim.
 */
export type NotebookLanguage = 'python' | 'mojo';

/** Every notebook language, in the order the selector offers them. */
export const NOTEBOOK_LANGUAGES: readonly NotebookLanguage[] = ['python', 'mojo'];

/** How the selector names each notebook language. */
export const NOTEBOOK_LANGUAGE_LABELS: Record<NotebookLanguage, string> = {
	python: 'Python',
	mojo: 'Mojo'
};

/** Is this value one of the two notebook languages? */
export function isNotebookLanguage(v: unknown): v is NotebookLanguage {
	return v === 'python' || v === MOJO_LANGUAGE;
}

/** The minimal notebook-metadata shape the language reader needs. */
type LanguageMetadata = { cellar?: { language?: unknown } | null } | null | undefined;

/**
 * The language declared by a notebook's metadata: `mojo` only when
 * `metadata.cellar.language` says so EXACTLY, and `python` for everything else -
 * absent, empty, a hand-edited typo, a value from a newer Cellar.
 *
 * A strict positive test rather than a parse, for the same reason
 * `databricksRuntimeEnabled` is a strict `=== true`: this decides how the user's
 * code is EXECUTED (a Mojo notebook compiles every code cell to a `%%mojo` magic
 * and hands it to `mojo run`), so an unrecognised value must fall to the default
 * that runs the notebook the way it has always run, never to a guess.
 */
export function notebookLanguageOf(metadata: LanguageMetadata): NotebookLanguage {
	return metadata?.cellar?.language === MOJO_LANGUAGE ? MOJO_LANGUAGE : 'python';
}

/**
 * The editor language of a code cell: its own tag when it carries one (`sql` /
 * `chat` - the orthogonal cell KINDS), else the NOTEBOOK's language.
 *
 * `nbLang` defaults to `python`, which is what every notebook that declares
 * nothing is, so a caller with no notebook in scope gets the pre-selector answer.
 */
export function cellLanguage(
	cell: LanguageCell,
	nbLang: NotebookLanguage = 'python'
): 'sql' | 'chat' | 'mojo' | 'python' {
	const tag = cell?.metadata?.cellar?.language;
	if (tag === SQL_LANGUAGE) return SQL_LANGUAGE;
	if (tag === CHAT_LANGUAGE) return CHAT_LANGUAGE;
	return nbLang;
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
 * True for a cell whose source is MOJO: a plain `code` cell (not SQL, not chat)
 * in a notebook whose declared language is `mojo`. Compiled to a `%%mojo` cell
 * magic at run time (`server/mojo.ts`) and run by the ordinary PYTHON kernel;
 * excluded from every Python-semantics engine by `isPythonCodeCell` /
 * `hasPythonDataflow` below.
 *
 * The notebook decides, so `nbLang` is REQUIRED information rather than a
 * property of the cell - and its `python` default is what makes every existing
 * caller answer `false`, exactly as it did before a notebook could be Mojo.
 */
export function isMojoCell(cell: LanguageCell, nbLang: NotebookLanguage = 'python'): boolean {
	return cell?.cell_type === 'code' && cellLanguage(cell, nbLang) === MOJO_LANGUAGE;
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
 * The five LOGICAL cell types the UI toggle, the REST routes and the MCP
 * `cell_type` argument speak. The ONE vocabulary: a route that hand-maintained
 * its own copy would keep accepting three while the others accept five (this
 * list grew by one when `raw` landed, and again for `chat`), and an
 * out-of-vocabulary value is not
 * inert - `nbCellType` maps anything it does not recognize onto `code`, so a
 * typo would silently turn a raw cell holding frontmatter into a runnable
 * Python cell.
 *
 * `mojo` is deliberately NOT here. A code cell's LANGUAGE is the notebook's (see
 * the header), so "make this one cell Mojo" is not a type a surface may offer -
 * offering it is exactly how a notebook ends up holding two languages.
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
 * The refusal code a route reports when the MOJO NOTEBOOK LANGUAGE was asked for
 * on a `.py` notebook. Note it is notebook-scoped, not cell-scoped, since Mojo is
 * no longer a cell type - see `TEXT_NOTEBOOK_MOJO_MESSAGE`.
 */
export const MOJO_UNSUPPORTED_REASON = 'mojo-in-py-notebook';

/**
 * The logical types a `.py` TEXT notebook cannot hold, named ONCE.
 *
 * Both fail the same way and for the same reason (see
 * `TextNotebookCellTypeError` below): such a document is rebuilt from its CELLS
 * on every save by jupytext / the Databricks converter, which carries neither
 * `cellar` cell metadata nor outputs - so the declaration lives only in memory
 * and disk holds a plain `code` cell. The union exists so a SIXTH logical type
 * is added HERE rather than shipping straight into the same trap, and so no
 * writer keeps a per-type copy of the rule.
 *
 * The NOTEBOOK LANGUAGE fails identically and is refused by the same argument one
 * level up, in `setNotebookLanguage` rather than here - a `.py` notebook stores no
 * notebook metadata either, so a Mojo declaration would live only in memory and
 * every cell would come back Python.
 *
 * It is the UNION rather than a list because everything else about the rule is
 * DERIVED from it: `PY_UNSUPPORTED_COPY` is a `Record` over it (so a member with
 * no message and no refusal code does not compile) and `PY_UNSUPPORTED_TYPES` is
 * that record's keys (so the list cannot fall behind either).
 */
export type PyUnsupportedType = Extract<LogicalCellType, 'raw' | 'chat'>;

/** Can a `.py` TEXT notebook hold this logical type? */
export function isPyUnsupportedType(cellType: unknown): cellType is PyUnsupportedType {
	return typeof cellType === 'string' && (PY_UNSUPPORTED_TYPES as readonly string[]).includes(cellType);
}

/**
 * May a UI surface OFFER this logical type for a notebook of this format? The ONE
 * rule behind every create/convert control - the cell-type menu's `typeOptions`
 * filter, the add affordances' chat gate (`Notebook.svelte`'s bottom add row +
 * hover-between strip), `LiveNotebook`'s optimistic `refuseUnsupportedType`, and
 * the multi-cell PASTE (which asks it of each entry's LOGICAL type - see
 * `$lib/cellClipboard`) - so no control can ever offer a type the doc layer's
 * `assertCanHoldType` is about to refuse.
 *
 * It is a FUNCTION rather than the same expression written out per surface for
 * the reason this whole module exists: three inlined copies of
 * `!isPy || !isPyUnsupportedType(t)` agreed only by coincidence, and - living in
 * a Svelte template - could be pinned only by READING SOURCE, so the rule's
 * meaning had no executable test. Here the truth table is a real one.
 *
 * Enforcement stays the SERVER's: this is the optimistic mirror (the
 * `clampMoveIndex` pairing), never the authority.
 */
export function offersCellType(cellType: LogicalCellType, isPy: boolean): boolean {
	return !isPy || !isPyUnsupportedType(cellType);
}

/** The one message for the raw refusal, shared by the server writers and the browser. */
export const TEXT_NOTEBOOK_RAW_MESSAGE =
	'A .py notebook cannot hold a raw cell: a .py (jupytext / Databricks source) notebook is rebuilt from its CELLS on every save and has no raw marker, so the cell would come back after a reload as a RUNNABLE Python cell holding what was meant to be verbatim text. Convert it to .ipynb first.';

/** The same, for a chat cell - whose loss is worse: the REPLY goes with it. */
export const TEXT_NOTEBOOK_CHAT_MESSAGE =
	'A .py notebook cannot hold a chat cell: a .py (jupytext / Databricks source) notebook is rebuilt from its CELLS on every save and carries neither cell metadata nor outputs, so after a reload the cell would be a RUNNABLE Python cell holding English prose and the AI reply would be gone for good (no re-run reproduces it). Convert it to .ipynb first.';

/**
 * The same argument one level up, for the NOTEBOOK LANGUAGE. Not part of
 * `PY_UNSUPPORTED_COPY` - it refuses a notebook-level setting, not a cell type -
 * but it lives here so the wording sits beside its two siblings.
 */
export const TEXT_NOTEBOOK_MOJO_MESSAGE =
	'A .py notebook cannot be a Mojo notebook: a .py (jupytext / Databricks source) notebook is rebuilt from its CELLS on every save and stores no notebook metadata, so the language would be lost and after a reload every cell would be a RUNNABLE Python cell holding Mojo source. Convert it to .ipynb first.';

/**
 * A `.py` TEXT notebook was asked to become a MOJO notebook.
 *
 * The notebook-level sibling of `TextNotebookCellTypeError`, and refused for the
 * identical reason one level up: such a document is written back from its cells
 * alone, so the declaration would live only in memory and every cell would come
 * back Python after a reload. It carries `MOJO_UNSUPPORTED_REASON` so a route
 * reports it in the same `{reason, message}` shape as the cell-type refusals.
 */
export class TextNotebookLanguageError extends Error {
	readonly reason = MOJO_UNSUPPORTED_REASON;
	constructor() {
		super(TEXT_NOTEBOOK_MOJO_MESSAGE);
		this.name = 'TextNotebookLanguageError';
	}
}

/** The refusal above, as a throwable (mirrors `textNotebookCellTypeError`). */
export function textNotebookLanguageError(): TextNotebookLanguageError {
	return new TextNotebookLanguageError();
}

/**
 * Message + refusal code per unsupported type, in ONE record rather than a pair
 * of ternaries: with two types a `x === 'chat' ? … : …` reads as exhaustive, and
 * with a third it SILENTLY reports the raw message for the other's refusal.
 *
 * Keyed over `PyUnsupportedType` rather than `string`, which is what makes the
 * next addition a compile-time obligation rather than a claim: a member added to
 * the union with no copy is a missing-property error here, and a key added here
 * that is not in the union is an excess-property error - so neither half can be
 * forgotten, and neither can silently fall back to the RAW message and the RAW
 * refusal code, which is exactly the failure the record replaced the ternaries to
 * prevent.
 */
const PY_UNSUPPORTED_COPY: Record<PyUnsupportedType, { message: string; reason: string }> = {
	raw: { message: TEXT_NOTEBOOK_RAW_MESSAGE, reason: RAW_UNSUPPORTED_REASON },
	chat: { message: TEXT_NOTEBOOK_CHAT_MESSAGE, reason: CHAT_UNSUPPORTED_REASON }
};

/**
 * The unsupported types as a list, DERIVED from the record above so it cannot
 * list a type the copy does not cover (nor miss one the copy does).
 */
export const PY_UNSUPPORTED_TYPES: readonly PyUnsupportedType[] = Object.keys(PY_UNSUPPORTED_COPY) as PyUnsupportedType[];

/**
 * The copy for a type. A type the `.py` rule does not refuse has none, so it can
 * only be a caller asking about a type it never refused - answered with the raw
 * copy as before. It can no longer mean "this unsupported type has no entry",
 * which the `Record` above now makes unrepresentable.
 */
function pyUnsupportedCopy(cellType: LogicalCellType): { message: string; reason: string } {
	return isPyUnsupportedType(cellType) ? PY_UNSUPPORTED_COPY[cellType] : PY_UNSUPPORTED_COPY.raw;
}

/** The message for one unsupported type. */
export function textNotebookTypeMessage(cellType: LogicalCellType): string {
	return pyUnsupportedCopy(cellType).message;
}

/** The refusal code for one unsupported type. */
export function textNotebookTypeReason(cellType: LogicalCellType): string {
	return pyUnsupportedCopy(cellType).reason;
}

/** The reverse of `textNotebookTypeReason`, built from the same record. */
const PY_UNSUPPORTED_BY_REASON: ReadonlyMap<string, PyUnsupportedType> = new Map(
	PY_UNSUPPORTED_TYPES.map((t) => [PY_UNSUPPORTED_COPY[t].reason, t] as const)
);

/**
 * Which type a route's refusal code names, or null when the code is not one of
 * ours - so a client can say WHY a conversion it thought legal came back refused
 * without keeping a second copy of the codes.
 *
 * A DIRECT lookup keyed by the code, never a scan of `PY_UNSUPPORTED_TYPES`
 * matching each type's reason in turn: a scan answers with the FIRST type whose
 * reason matches, so it names the right type only for as long as every type has
 * a distinct one - which is a property of the copy record, not of the scan. Read
 * off that record instead, the two cannot disagree.
 */
export function textNotebookTypeForReason(reason: unknown): PyUnsupportedType | null {
	if (typeof reason !== 'string') return null;
	return PY_UNSUPPORTED_BY_REASON.get(reason) ?? null;
}

/**
 * A logical type a `.py` TEXT notebook cannot hold was asked for (`raw`, `chat`).
 *
 * Such a notebook is written back through jupytext / the Databricks converter,
 * which rebuilds the file from its cells and coerces every `cell_type` to
 * markdown|code (`jupytext.ts`) - and coerces again on read, carrying no
 * `cellar` metadata and no outputs. So the declaration would live only in memory
 * while disk held a `code` cell: after a reload the frontmatter sits in a cell
 * with a Run button (raw), the question does while its REPLY is gone (chat), or
 * or the question does while its REPLY is gone (chat) - the exact silent degrade
 * each type exists to prevent, and worse from MARKDOWN, whose prose would lose its
 * markers on the way too.
 *
 * Refused by name instead, at the doc-layer writers, so no surface can route
 * around it - the `textNotebookRootError` precedent, for the identical
 * rebuilt-from-cells reason. Only these types, and only on a `.py` doc: every
 * other conversion, every raw or chat cell in an `.ipynb`, and CLEARING a
 * type are all untouched.
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
 * tagged code cells, everything else carries no tag. The ONE tag rule,
 * shared by the server's `applyCellType`/`newCell`, the `cell:type` event payload,
 * and the browser's `applyCellTypeLocally` - a per-site `isSql ? 'sql' : null`
 * ternary is how the chat tag would be dropped by whichever copy was not updated.
 *
 * A plain `code` cell carries NO tag whatever the notebook's language is: Mojo is
 * declared once on the notebook, so writing it per cell would mint the second,
 * contradictable spelling the header rules out - and would put a key in every code
 * cell of the user's committed `.ipynb` for a fact one line of notebook metadata
 * already states.
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
	if (isChatCell(cell)) return 'chat';
	return 'code';
}

/**
 * The INVERSE of `nbCellType` + `languageTagFor`: the logical type an nbformat
 * `cell_type` plus a `cellar.language` tag describe.
 *
 * The `cell:type` SSE event carries exactly that pair (and no metadata), so the
 * browser has to reconstruct the logical type from it. Doing that with a hand-
 * written ternary chain is how a new tagged language silently lands on the client
 * as a plain `code` cell - visibly the wrong grammar, wrong badge, and (because
 * `applyCellTypeLocally` re-derives the tag from what it is given) the tag stripped
 * from the local model until a reload. Expressed here, the forward and reverse
 * mappings are edited together.
 *
 * An UNRECOGNIZED tag reads as `code` rather than throwing: it can only arrive from
 * a hand-edited notebook or a newer Cellar, and a code cell is what such a cell
 * already is on disk.
 */
export function logicalTypeFor(
	nbType: string | null | undefined,
	language: string | null | undefined
): LogicalCellType {
	if (nbType === 'markdown') return 'markdown';
	if (nbType === 'raw') return 'raw';
	if (language === SQL_LANGUAGE) return 'sql';
	if (language === CHAT_LANGUAGE) return 'chat';
	return 'code';
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

/**
 * Does this cell's SOURCE hold module-level PYTHON? The ONE rule every
 * Python-semantics engine asks before touching a cell: the `ast`/`symtable`
 * dataflow probe (`server/dataflow.ts`), and the imports sweep and agent import
 * routing (`server/imports-cell.ts`).
 *
 * The nbdev export asks a DIFFERENT question of its own and is deliberately not a
 * caller: `exportRole.ts`'s `canExportCell` is TARGET-AWARE (a cell is eligible
 * iff its language matches the target's extension), so it reads
 * `exportLanguageOf`, which is this test plus the `%%mojo` magic header - a
 * `code` cell pasted out of Modular's docs is Mojo while every type-based test
 * calls it Python. Keep the two apart: widening this predicate to admit Mojo
 * would hand Mojo source to the Python dataflow probe and the imports sweep,
 * which is the exact failure the paragraph below measures.
 *
 * Stated POSITIVELY - `isLogicalCellType(cell, 'code')` - and that is the whole
 * point. Written as the negations it replaced (`cell_type === 'code' &&
 * !isSqlCell(c) && !isChatCell(c)`), every new tagged language costs one more
 * `&&` in every engine, and the engine whose clause was forgotten silently hands
 * non-Python source to a Python parser. Measured on real Mojo: the probe reads
 * `def main(): print(...)` as Python and reports `defines=['main']` - a wholly
 * fabricated dependency edge - while the imports sweep LIFTS `from std.time
 * import sleep` out of the cell into the Python imports cell and RUNS it,
 * breaking both halves at once. Positively stated, `mojo` was never in the set.
 *
 * The NOTEBOOK's language is now the other half of that same rule: in a Mojo
 * notebook a plain `code` cell holds Mojo, so it is out of the set for exactly the
 * reason a `mojo`-tagged cell used to be. `nbLang` defaults to `python`, which is
 * what makes every existing caller - and every Python notebook - answer exactly as
 * before.
 *
 * Deliberately the STRICT `isLogicalCellType`, not `logicalCellType(cell) ===
 * 'code'`: the loose form maps a FOREIGN nbformat `cell_type` (`ipynb.ts` passes
 * one through verbatim) onto `code`, so an externally-authored cell Cellar
 * cannot identify would be parsed and rewritten as Python.
 */
export function isPythonCodeCell(cell: LanguageCell, nbLang: NotebookLanguage = 'python'): boolean {
	return nbLang === 'python' && isLogicalCellType(cell, 'code');
}

/**
 * Does this cell participate in the notebook's Python DATAFLOW graph - i.e. can
 * running it bind a name later Python cells read?
 *
 * A superset of `isPythonCodeCell` by exactly one member: a SQL cell's source is
 * not Python, but `server/sql.ts` compiles it to a `spark.sql(...)` wrapper that
 * really does bind `_sql_df` (and the `-- >> name` binding) in the kernel
 * namespace, so `dataflow.ts` gives it a SYNTHETIC contribution and the graph
 * must keep it - a Python cell reading a SQL result has to go stale when the
 * query is edited.
 *
 * Everything else is out, and each for its own reason rather than by a shared
 * accident: a CHAT cell's source is prose and its reply binds nothing; a MOJO
 * cell runs in a `mojo run` SUBPROCESS whose entire namespace dies with it, so
 * even `def main()` binds nothing that outlives the cell; markdown and raw never
 * reach the kernel at all.
 *
 * `staleness.ts` asks this to pick the cells the definer graph is built over;
 * every cell it excludes falls to that module's `n/a` verdict, which is why a
 * Mojo notebook's cells show no staleness chip without any chip-level special
 * case - and it is the ONE notebook-level condition the follow-up that HIDES the
 * remaining Python-only affordances hangs off.
 */
export function hasPythonDataflow(cell: LanguageCell, nbLang: NotebookLanguage = 'python'): boolean {
	return isPythonCodeCell(cell, nbLang) || isSqlCell(cell);
}
