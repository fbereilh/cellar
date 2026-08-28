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
import { nbdevDirective } from '$lib/nbdevDirectives';

/** The minimal cell shape this rule reads (Cell/CellView are assignable). */
type ExportCell =
	| { cell_type?: string; source?: string; metadata?: CellMetadata | null }
	| null
	| undefined;

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
 * Does this cell's SOURCE carry nbdev's bare `#| export` directive?
 *
 * Read STATICALLY, never by running the cell - a `#|` line is a comment. The
 * scanning rule (leading block only, exact name, `true` as bare) lives in
 * `$lib/nbdevDirectives`, measured against nbdev 3.3.13.
 *
 * ## Only a BARE `#| export`, and only that name
 *
 * A VALUED `#| export other` is deliberately NOT a mark: measured against real
 * nbdev, that exports the cell to a module named `other`, a SECOND module beside
 * the notebook's `default_exp` one. Cellar has exactly one target per notebook, so
 * treating it as a mark would concatenate the cell into the wrong module - the
 * very "resolves plausibly and writes to the wrong file" defect the scout report's
 * §5.2 is about, reached from the cell side instead of the target side.
 *
 * `exporti` / `exports` / `exportd` are each a DIFFERENT directive name, so the
 * exact-name test excludes them with no special case. That is the scoped decision,
 * not an oversight:
 *
 * - `exporti` is module code that is NOT in `__all__`, and `exportd` is docstring
 *   material that is not module code at all. A single boolean cannot say either,
 *   and a wrong guess writes an unwanted public name or a markdown blob into a
 *   file that is committed to git.
 * - `exports` is, MEASURED, module-identical to `export` (both land in the module
 *   and in `__all__`; the difference is purely docs rendering, which Cellar has
 *   no equivalent of). It is left unrecognised anyway because the increment's
 *   scope names it, and widening it is a one-line change wherever that is decided.
 *
 * The cost of not recognising them is stated plainly: a module Cellar generates for
 * such a notebook omits those cells, so a marked cell calling an `exporti` helper
 * yields a module that raises `NameError` on import. That is not a regression -
 * Cellar saw ZERO nbdev marks before - but it is a real limit, and the clobber
 * guard in `export-py.ts` is what stops it damaging an existing nbdev module.
 */
export function hasExportDirective(cell: ExportCell): boolean {
	return nbdevDirective(cell?.source, 'export') === '';
}

/**
 * Does this cell's own SOURCE own its export mark - i.e. is the cell exported
 * BECAUSE of a `#| export` line Cellar may never write and so may never remove?
 *
 * This is the refusal rule, and it is deliberately `canExportCell(cell) &&
 * hasExportDirective(cell)` in ONE place rather than that pair repeated at each
 * refusing site. The two halves must be the same eligibility the MARK rule applies,
 * because a refusal is a claim about `isExportCell`: a markdown/SQL/raw cell whose
 * source happens to open with `#| export` is NOT exported (the exporter ignores it
 * entirely), so reporting the directive as owning it would refuse to clear a stale
 * flag and tell the caller a cell is in a module it was never in. Every refusing
 * surface asks this - the doc setter, its batch form, the PATCH route through them,
 * MCP's `set_cell_export`, and the row toggle - so the client and the server cannot
 * drift about which cells the source owns.
 */
export function exportDirectiveOwnsCell(cell: ExportCell): boolean {
	return canExportCell(cell) && hasExportDirective(cell);
}

/**
 * Is this cell marked for export to the `.py` module? Eligible (`canExportCell`)
 * AND marked - by Cellar's own `metadata.cellar.export` flag, or by nbdev's
 * `#| export` directive in the source.
 *
 * ## Which wins, and why the question has no answer to argue about
 *
 * nbdev's own rule is comments-beat-metadata (`fastcore/nbio.py` `_directives_get`)
 * and Cellar's is metadata-first, so the two look like they must be reconciled.
 * For THIS flag they do not, because NEITHER SOURCE CAN EXPRESS A NEGATION:
 * nbdev's `#| export` is presence-only (there is no "not exported" directive), and
 * Cellar's flag is presence-only too - `setCellExports` DELETES the key rather than
 * storing `false`, and this predicate is a strict `=== true`, so an absent flag and
 * a hand-edited `false` already read alike. With no way to say "no", precedence has
 * nothing to decide: comments-win, metadata-win and union are the SAME function on
 * the values that can actually occur. A cell is exported if either says so.
 *
 * That is what makes this settleable without a product call - the disagreement the
 * two designs appear to have is not reachable.
 *
 * ## The UI consequence, which IS a decision
 *
 * Marking stays metadata-only: toggling export in Cellar must never write a `#|`
 * line into the user's source. Source is code the kernel runs and git diffs, while
 * `metadata.cellar` is the namespace clean-on-save preserves byte-for-byte - the
 * whole reason this flag lives there. So a cell the DIRECTIVE marks cannot be
 * unmarked from Cellar at all: `setCellExports` refuses it and the row toggle shows
 * ON while staying LIVE rather than going `disabled` - a disabled button gets no
 * pointer events, so its `title` could never be hovered and the one thing the user
 * needs (which line to remove) would be unreachable. Clicking it declines on the
 * shell's notice line instead, the same live-control-that-explains-itself stance the
 * Databricks card takes. Clearing the metadata half instead would leave the cell
 * exported with the toggle bouncing back to ON, which is exactly the lie this is
 * written to avoid.
 *
 * Being the one identity every surface reads (`export-py.ts` builds the module
 * from it, `Cell.svelte` draws the badge from it, the agent map reports it),
 * keeping the eligibility half here is what makes a stale or hand-edited flag on
 * a markdown/SQL/raw cell inert everywhere rather than only at whichever setter
 * last remembered to check.
 */
export function isExportCell(cell: ExportCell): boolean {
	if (!canExportCell(cell)) return false;
	return cell?.metadata?.cellar?.export === true || hasExportDirective(cell);
}

/** Count of cells currently marked for export. */
export function exportCellCount(cells: readonly ExportCell[] | null | undefined): number {
	return (cells ?? []).filter(isExportCell).length;
}
