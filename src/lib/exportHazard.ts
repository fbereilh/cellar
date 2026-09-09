/**
 * Cellar - the nbdev-style export's HAZARDS: the pure, browser-safe half.
 *
 * The export assembles a module out of the marked cells, and one assembly step
 * can turn cells that are each perfectly good Python into a module Python
 * REFUSES TO COMPILE - after which `import` of the generated module raises
 * `SyntaxError` and every symbol in it is unreachable. Before this module
 * existed the export reported plain success for exactly that file, so the only
 * signal was the eventual import failure.
 *
 * A hazard is a POSITIVE, DETECTED finding about the module the export just wrote
 * that the user would otherwise learn only from the file. There are THREE KINDS,
 * and no two of them are the same claim - the `kind` discriminant exists so one
 * can never be worded as another:
 *
 *   - `future-import-joined` (a `.py` target): the generated module will NOT
 *     COMPILE. The rest of this header is about that kind, and about that kind
 *     only.
 *   - `mojo-main-dropped` (a `.mojo` target): the module compiles, and code was
 *     REMOVED to make it so - every exported cell's top-level `def main()` but the
 *     last, since two `main`s in a Mojo file is a hard error (`$lib/mojoExport`).
 *     Dropping a `main` is what makes that module valid, so this kind must never
 *     be rendered as "will not compile". It is the NOTEBOOK-LEVEL summary of a
 *     loss the notebook ALSO marks on each affected cell; neither surface stands
 *     in for the other.
 *   - `mojo-main-kept` (a `.mojo` target): the module compiles AS MOJO and does
 *     not compile as a PYTHON EXTENSION, which is a capability the artifact loses
 *     rather than a defect in it. MEASURED against Mojo 1.0.0: a Python `import`
 *     of a `.mojo` module goes through `mojo build --emit shared-lib`, which
 *     refuses a module with a `main` (`shared library should not contain a 'main'
 *     function`) - so the surviving `main` that makes the module RUNNABLE is
 *     exactly what makes it un-importable from a Python cell. Certain and
 *     whole-module, hence a hazard; never worded as a compile failure, because it
 *     is not one.
 *
 * ## NOT EVERY KIND REACHES EVERY SURFACE (`humanExportHazards`)
 *
 * `mojo-main-kept` is AGENT-ONLY: it rides MCP's `module.warning` on
 * `set_cell_export` / `set_export_target`, and it is recorded here, and it reaches
 * no human surface IN THE APP - the generated module states the same fact in its
 * own header (`MAIN_KEPT_COMMENT`, emitted by `generateMojoModule`, since the file
 * is the only place a reader of a shared `.mojo` can learn it), which is a
 * separate emission rather than this hazard channel. The reason is scope rather
 * than doubt about the claim,
 * which stays measured and true: Python CALLING Mojo is a deferred direction, and
 * it is the only direction a kept `main` costs anything, so a standing warning
 * about it today warns about a consequence of a use case Cellar does not yet
 * support. It fires on the COMMONEST shape a `.mojo` export has - a module that
 * keeps one `main` is the desired outcome, being both a library and a runnable
 * program - so as export-bar chrome it was permanent, and appended to the manual
 * export it made every ordinary Mojo export read as having gone slightly wrong.
 * A notice users learn to ignore protects nothing (`misplacedDefaultExpError`
 * makes the same call).
 *
 * `mojo-main-dropped` is the OPPOSITE case and keeps every surface it has: it says
 * code the user WROTE was REMOVED, which is a real loss they must see while
 * editing. The two kinds are never collapsed or reworded into each other - that is
 * what the `kind` discriminant is for.
 *
 * This holds what needs no filesystem: the hazard shape, the ONE wording for each
 * kind, the ONE rule for which kinds a human surface may show
 * (`humanExportHazards`) and the ONE way a set of them is joined into a report
 * (`hazardReport`), so the export bar, the manual-export notice and the agent
 * surface cannot describe the same file differently (the `exportImportWarning`
 * precedent, for the same reason).
 *
 * ## WHAT A HAZARD CLAIMS, AND WHAT ITS ABSENCE DOES NOT
 *
 * A hazard is a POSITIVE finding about a construct that was DETECTED. It is
 * emphatically NOT a compile verdict, and no surface may word it as one,
 * because the class of "module that fails `compile` while the export reports
 * success" is WIDER than what is detected here. Measured against CPython 3
 * rather than assumed - see `tests/unit/export-py-future.test.ts`, which pins
 * the boundary executably:
 *
 *   - ASSEMBLY-INDUCED (the cell compiles standalone, the MODULE does not, and
 *     the difference is how Cellar assembled it). A `__future__` statement is
 *     the only position-sensitive statement in Python's grammar, so this class
 *     is exactly: a module-level `__future__` import that does not end up
 *     first. `liftFutureImports` (`server/export-py.ts`) hoists every one it
 *     can; the one it will not is a `__future__` import sharing its line with
 *     another statement, which is what `future-import-joined` reports. An
 *     encoding declaration pushed below line 2 is silently IGNORED by Python,
 *     not an error, and two individually-valid modules concatenated at indent 0
 *     are always syntactically valid - both measured.
 *   - PRE-EXISTING (the marked cell does not compile as Python on its own, and
 *     the module inherits that). IPython line magics (`%matplotlib inline`),
 *     shell escapes (`!ls`), `foo?`, top-level `await`, a bare `return`, a
 *     `__future__` import nested inside a `def`/`if`. These reach the same end
 *     - an uncompilable module - and are NOT detected here: they are the user's
 *     own Python, unchanged by the export, and telling them apart from a
 *     deliberate cell needs decisions this module does not make. Detecting them
 *     is a separate feature; the point of this paragraph is that the next
 *     reader knows the boundary was measured rather than assumed.
 *
 * The two classes are not quite disjoint at one edge, and detection deliberately
 * spills over it: a joined line whose `__future__` import comes SECOND
 * (`x = 1; from __future__ import annotations`) is PRE-EXISTING - it does not
 * compile standalone either - and is still reported, because the hoist declines
 * it for the same reason and saying so beats the silence it used to get. Over-
 * reporting toward honesty is the safe direction; under-reporting is the defect.
 *
 * So: a reported hazard means "this specific thing is wrong". No hazard means
 * "none of the things Cellar checks for is wrong", never "the module compiles".
 */

/** Longest offending statement quoted back in a hazard message, before eliding. */
export const HAZARD_STATEMENT_MAX = 80;

/** Which finding fired. Each kind makes a DIFFERENT claim - see this file's header. */
export type ExportHazardKind = 'future-import-joined' | 'mojo-main-dropped' | 'mojo-main-kept';

/** A detected finding about the generated module the user must be told about. */
export interface ExportHazard {
	/** Which check fired. Read it before wording anything: the kinds do not agree. */
	kind: ExportHazardKind;
	/**
	 * What the finding is ABOUT, whitespace-folded and bounded to
	 * `HAZARD_STATEMENT_MAX`: the offending logical line for
	 * `future-import-joined`, the affected cell handles for the two `mojo-main-*`
	 * kinds.
	 */
	statement: string;
	/** A complete, plain-language sentence: what happened, and what to change. */
	message: string;
}

/** Fold a source line to one bounded line so it can be quoted back in a message. */
export function quoteStatement(raw: string): string {
	const one = raw.replace(/\s+/g, ' ').trim();
	return one.length > HAZARD_STATEMENT_MAX ? one.slice(0, HAZARD_STATEMENT_MAX - 1) + '…' : one;
}

/**
 * The ONE wording for a `__future__` import that shares its line with another
 * statement. Names the construct, why Python rejects it, why Cellar will not fix
 * it silently, and the single edit that resolves it.
 *
 * Cellar deliberately does NOT split the line: hoisting the `__future__` import
 * would reorder the statement riding with it, and relocating a user's code is
 * out of scope for an export (`liftFutureImports` makes the same call for the
 * same reason). Saying so is what keeps this from reading as a Cellar bug the
 * user should wait out.
 *
 * It OPENS with the offending line and carries no lead of its own, so it reads
 * standalone in the export bar AND composes after each surface's own lead
 * ("Wrote utils.py, but `...` keeps a __future__ import ..."). A lead baked in
 * here would either read wrong beside one of them or have to be duplicated in
 * all three, which is how one wording becomes three.
 *
 * Backticks fence the QUOTED LINE only - it holds spaces and a semicolon, so it
 * needs delimiting - and not the word `__future__`, which would render as
 * literal punctuation in the plain-text surfaces for no gain.
 */
export function futureImportHazardMessage(statement: string): string {
	return (
		`\`${statement}\` keeps a __future__ import on the same line as another statement, so the module will not import: ` +
		'Python accepts one only before every other statement, and Cellar will not split a line to move it. ' +
		'Put the __future__ import on a line of its own.'
	);
}

/**
 * Build the `future-import-joined` hazard for one offending logical line.
 * Exported so the server never re-derives the wording at a call site.
 */
export function futureImportJoinedHazard(rawLine: string): ExportHazard {
	const statement = quoteStatement(rawLine);
	return { kind: 'future-import-joined', statement, message: futureImportHazardMessage(statement) };
}

/**
 * The ONE wording for the `main` blocks a `.mojo` export dropped.
 *
 * Says what was removed, WHY it had to be (a Mojo module can hold one `main`),
 * which cells lost theirs, and that everything else in them was exported - so a
 * reader does not conclude those cells were skipped entirely. It states the loss
 * plainly rather than hedging: this is code the user wrote and the export
 * discarded, and the whole point of the channel is that the discard is never
 * silent.
 *
 * It opens with the finding and carries no lead of its own, so it reads standalone
 * in the export bar AND composes after each surface's own lead - the
 * `futureImportHazardMessage` rule, for the same reason.
 */
export function mojoMainDroppedHazardMessage(cellHandles: readonly string[], keptHandle: string): string {
	const n = cellHandles.length;
	return (
		`${n === 1 ? 'one exported cell' : `${n} exported cells`} lost a top-level def main(): ` +
		`${cellHandles.join(', ')}. A Mojo module can define main only once, so the LAST exported cell ` +
		`that defines one keeps it (${keptHandle}) and the earlier blocks were replaced by a comment. ` +
		'Everything else in those cells is exported unchanged; move any code you need out of main() to keep it.'
	);
}

/**
 * Build the `mojo-main-dropped` hazard. `cellHandles` are the short cell ids that
 * lost their `main`, in document order; `keptHandle` is the one that kept it.
 * Exported so the server never re-derives the wording at a call site.
 */
export function mojoMainDroppedHazard(cellHandles: readonly string[], keptHandle: string): ExportHazard {
	return {
		kind: 'mojo-main-dropped',
		statement: quoteStatement(cellHandles.join(', ')),
		message: mojoMainDroppedHazardMessage(cellHandles, keptHandle)
	};
}

/**
 * The ONE wording for a `.mojo` module that KEEPS a `main`.
 *
 * The claim is exact and was measured, not inferred: a Python cell importing a
 * `.mojo` module does it through `mojo.importer`, whose `find_spec` shells out to
 * `mojo build <file> --emit shared-lib`, and that command REFUSES a module with a
 * top-level `main` - `mojo: error: shared library should not contain a 'main'
 * function` (Mojo 1.0.0). The same module with the `main` removed builds and
 * imports fine. So this is not a guess about what might go wrong: at export time
 * Cellar knows for certain that one thing the user may reasonably expect of the
 * artifact cannot happen.
 *
 * It says what the module CAN still do, because the alternative reads as a
 * failure and it is not one - the module compiles, `mojo run` runs it, and another
 * `%%mojo` cell imports it. It names the cell whose `main` survived, since that is
 * the one to edit, and it names the edit.
 *
 * Wording rules the header states: no lead of its own (it composes after each
 * surface's), and never phrased as a compile failure.
 */
export function mojoMainKeptHazardMessage(keptHandle: string): string {
	return (
		`the module keeps the def main() from cell ${keptHandle}, so NO PYTHON CELL CAN IMPORT IT: ` +
		'a Python import of a .mojo module compiles it with `mojo build --emit shared-lib`, which refuses ' +
		"a module that defines main (\"shared library should not contain a 'main' function\"). " +
		'The module is still valid Mojo - `mojo run` runs it and another Mojo cell can import it. ' +
		`Remove that cell's main to make it importable from Python.`
	);
}

/** Build the `mojo-main-kept` hazard for the cell whose `main` survived. */
export function mojoMainKeptHazard(keptHandle: string): ExportHazard {
	return {
		kind: 'mojo-main-kept',
		statement: quoteStatement(keptHandle),
		message: mojoMainKeptHazardMessage(keptHandle)
	};
}

/**
 * The kinds a HUMAN surface may not show - see this file's header for why
 * `mojo-main-kept` is one and `mojo-main-dropped` deliberately is not.
 */
const AGENT_ONLY_HAZARD_KINDS: ReadonlySet<ExportHazardKind> = new Set<ExportHazardKind>([
	'mojo-main-kept'
]);

/**
 * The hazards a human surface may show, out of a full set.
 *
 * The ONE rule, so the export bar's standing warning and the manual-export notice
 * cannot disagree about which findings a person is shown, and so the agent surface
 * - which passes the full set through - stays the single place a deferred-scope
 * finding is still reported. A kind that is not agent-only survives untouched, so
 * a `.py` export's hazards are byte-for-byte what they always were.
 */
export function humanExportHazards(hazards: readonly ExportHazard[]): ExportHazard[] {
	return hazards.filter((h) => !AGENT_ONLY_HAZARD_KINDS.has(h.kind));
}

/**
 * A whole hazard SET as one report, for a surface that shows a single line of text
 * rather than one element per finding.
 *
 * EVERY message, never `hazards[0]`: the kinds make different claims and a `.mojo`
 * export can carry more than one, so reporting the first silently drops the rest -
 * the reporting defect this channel exists to fix. The ONE joining rule, shared by
 * MCP's `module.warning` and the shell's manual-export notice, so a third spelling
 * cannot appear beside them.
 */
export function hazardReport(hazards: readonly ExportHazard[]): string {
	return hazards.map((h) => h.message).join(' Also: ');
}

/**
 * The one-clause summary a surface appends after its own lead ("Wrote 3 cells ->
 * lib/x.mojo, but ..."), for a whole hazard SET.
 *
 * Keyed by KIND rather than by `hazards[0]`, because the kinds make different
 * claims and a `.mojo` export can carry two at once: saying "it will not import"
 * over a module that compiles, or "code was dropped" over one that dropped none,
 * is the assert-more-than-was-verified defect this file exists to prevent. Ranked
 * by what costs the user most: a module that will not import at all, then code the
 * export discarded, then a capability the artifact does not have.
 */
export function hazardSummaryClause(hazards: readonly ExportHazard[]): string {
	const kinds = new Set(hazards.map((h) => h.kind));
	if (kinds.has('future-import-joined')) return 'it will not import';
	if (kinds.has('mojo-main-dropped')) return 'code was dropped';
	if (kinds.has('mojo-main-kept')) return 'no Python cell can import it';
	return 'see the warning';
}
