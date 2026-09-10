/**
 * Cellar - what KIND a NEWLY INSERTED code cell takes (pure, browser-safe).
 *
 * "Add a code cell" is one gesture with two possible meanings, and until a
 * notebook could hold more than one kind of code cell the difference never
 * showed: the user means "another cell like the ones I am writing", not "a plain
 * Python cell". Writing a run of SQL cells, the literal reading makes every second
 * cell the wrong kind and forces a trip through the type menu after every insert.
 * So a plain code insertion INHERITS: it takes the KIND of the nearest preceding
 * code cell, and falls back to the caller's default when there is none.
 *
 * IT CARRIES A CELL KIND, NEVER A LANGUAGE. python-vs-mojo is the NOTEBOOK's own
 * axis (`metadata.cellar.language`), so a plain "+ Code" insertion in a Mojo
 * notebook is already Mojo with nothing to inherit - there is no per-cell spelling
 * of it to carry, and adding one back would be the second contradictable setting
 * that axis exists to remove. What is genuinely per-cell is `sql`, and that is the
 * whole of what this rule moves.
 *
 * THE RULE, and why each clause is the way it is:
 *  - **Nearest PRECEDING code cell wins.** Scanning upward is what makes the
 *    common gesture (write a cell, add another below it) land on the kind the
 *    user is visibly working in. Nothing BELOW the insertion point is consulted:
 *    inserting above a SQL cell must not turn the new cell into one.
 *  - **Markdown, raw and chat cells are SKIPPED, not stopped at.** A prose cell
 *    between two SQL cells is exactly the shape a documented notebook has, and
 *    stopping there would make a SQL run flip back to code at every heading.
 *    Chat is skipped for the same reason it can never be INHERITED (below).
 *  - **No preceding code cell ⇒ the caller's default**, which is `code`
 *    everywhere today. The first cell of an empty notebook is unchanged.
 *
 * WHAT MAY BE INHERITED IS AN ALLOWLIST (`INHERITABLE_CODE_TYPES`), not
 * "whatever the cell above is", and the exclusion that proves the point is CHAT:
 * a chat cell is an nbformat code cell, so a naive `logicalCellType(prev)` would
 * let a click on "+ Code" create a cell whose Run button spends money on a model
 * turn. Cellar already refuses to let AGENTS create chat cells for that reason
 * (`chat` is absent from every MCP write enum); creating one from a gesture that
 * says "code" would be the same surprise from the other direction. A sixth
 * logical type is likewise NOT inheritable until it is named here.
 *
 * WHY THIS IS CLIENT-SIDE AND NOT A RULE INSIDE `addCell`. Three server-side
 * callers legitimately mean the LITERAL "a Python cell" and would break under a
 * blanket rule: `imports-cell.ts` creates the pinned imports cell (which must hold
 * Python or every routed import is stranded), `LiveNotebook`'s `insertAndRunCode`
 * appends the Databricks table preview (which IS `spark.read.table(...).toPandas()`,
 * an ordinary code cell, and is appended at the END of whatever notebook is open), and every MCP
 * write tool states its `cell_type` explicitly because an agent has already
 * decided what it is writing. Inheritance is a property of the HUMAN insertion
 * GESTURE, so it is resolved where that gesture is - and `tests/unit/cell-inherit.test.ts`
 * carries a source guard over every insertion site so a new one cannot quietly
 * skip it.
 */

import { logicalCellType } from '$lib/cellLanguage';
import type { CellMetadata, LogicalCellType } from '$lib/server/types';

/** The minimal cell shape this rule reads (`Cell`/`CellView`/`UICell` are assignable). */
type InheritCell = { cell_type?: string; metadata?: CellMetadata | null } | null | undefined;

/**
 * The code languages a plain "+ Code" insertion may take from the cell above.
 * An ALLOWLIST: `chat` is deliberately absent (see the module header), and so is
 * every non-code type, so an unlisted logical type falls back to the default.
 *
 * Mojo needs no entry and must not gain one: it is the NOTEBOOK's language
 * (`$lib/cellLanguage`), so a plain `code` cell created in a Mojo notebook is
 * already Mojo. The only thing left for this rule to carry across is SQL, which
 * really is a per-cell kind.
 */
export const INHERITABLE_CODE_TYPES: readonly LogicalCellType[] = ['code', 'sql'];

/** May a plain code insertion inherit this logical type? */
export function isInheritableCodeType(cellType: unknown): cellType is LogicalCellType {
	return typeof cellType === 'string' && (INHERITABLE_CODE_TYPES as readonly string[]).includes(cellType);
}

/**
 * The logical type a plain code cell inserted at `index` should take: the nearest
 * preceding inheritable code cell's language, else `fallback` (Python).
 *
 * `index` is the position the NEW cell will occupy, so the scan starts at
 * `index - 1`; an index at or past the end appends and therefore looks at the last
 * cell. Out-of-range and empty inputs are the fallback, never a throw - this runs
 * inside click handlers and a `$derived`, where a throw takes the render tree with
 * it: the app's only `<svelte:boundary>` wraps a notebook CELL row (see
 * `cellRenderFailure.ts`), and it catches render-time throws only, never one from an
 * event handler.
 */
export function inheritedCodeType(
	cells: readonly InheritCell[] | null | undefined,
	index: number,
	fallback: LogicalCellType = 'code'
): LogicalCellType {
	const list = cells ?? [];
	const start = Math.min(Math.max(0, Math.floor(index)), list.length) - 1;
	for (let i = start; i >= 0; i--) {
		const type = logicalCellType(list[i]);
		if (isInheritableCodeType(type)) return type;
	}
	return fallback;
}

/**
 * The same rule addressed by the cell an insertion is anchored AFTER, which is
 * how the add API and several call sites name a position (`afterId`). A null /
 * unknown anchor appends, so the scan runs from the end of the notebook - which
 * is what the bottom "+ Code" button and run-and-advance both want.
 */
export function inheritedCodeTypeAfter(
	cells: readonly (InheritCell & { id?: string })[] | null | undefined,
	afterId: string | null | undefined,
	fallback: LogicalCellType = 'code'
): LogicalCellType {
	const list = cells ?? [];
	const i = afterId ? list.findIndex((c) => c?.id === afterId) : -1;
	return inheritedCodeType(list, i < 0 ? list.length : i + 1, fallback);
}
