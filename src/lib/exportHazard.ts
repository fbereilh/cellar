/**
 * Cellar - the nbdev-style `.py` export's COMPILE HAZARDS: the pure,
 * browser-safe half.
 *
 * The export assembles a module out of the marked cells, and one assembly step
 * can turn cells that are each perfectly good Python into a module Python
 * REFUSES TO COMPILE - after which `import` of the generated module raises
 * `SyntaxError` and every symbol in it is unreachable. Before this module
 * existed the export reported plain success for exactly that file, so the only
 * signal was the eventual import failure.
 *
 * This holds what needs no filesystem: the hazard shape and the ONE wording for
 * each kind, so the export bar, the manual-export notice and the agent surface
 * cannot describe the same file differently (the `exportImportWarning`
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
 * So: a reported hazard means "this specific thing is wrong". No hazard means
 * "none of the things Cellar checks for is wrong", never "the module compiles".
 */

/** Longest offending statement quoted back in a hazard message, before eliding. */
export const HAZARD_STATEMENT_MAX = 80;

/** A construct in the marked cells that makes the generated module uncompilable. */
export interface ExportHazard {
	/** Which check fired. One kind today; the field exists so a second cannot be mistaken for it. */
	kind: 'future-import-joined';
	/** The offending logical line, whitespace-folded and bounded to `HAZARD_STATEMENT_MAX`. */
	statement: string;
	/** A complete, plain-language sentence: what is wrong, and what to change. */
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
 */
export function futureImportHazardMessage(statement: string): string {
	return (
		`this module will not import: \`${statement}\` keeps a \`__future__\` import on the same line as another statement. ` +
		'Python accepts a `__future__` import only before every other statement, and Cellar will not split a line to move one - ' +
		'put the `__future__` import on a line of its own.'
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
