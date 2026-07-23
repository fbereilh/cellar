/**
 * Cellar - per-name import BINDING identity, and when each one last changed.
 *
 * WHY THIS EXISTS. The definer graph is per name, but the staleness rule was per
 * CELL: an edge (i ← j) transmitted staleness whenever j was edited / re-ran /
 * was itself stale, whatever names the edge actually carried. An imports cell
 * defines `pd`, `np`, `os`, … - a name almost every code cell below it uses - so
 * ANY touch of it staled the whole notebook downstream. Correct by those rules,
 * and useless in practice: agent import-routing rewrites the imports cell
 * constantly, so "stale" stopped carrying information for most of a session.
 *
 * THE ONE PROPERTY THAT MAKES PRECISION POSSIBLE. A name bound by a MODULE-LEVEL
 * import is a pure function of its import statement: `import pandas as pd` always
 * binds `pd` to `sys.modules['pandas']`, so re-executing it - or re-rendering the
 * statement, or reordering the block around it - rebinds the SAME object. That is
 * emphatically NOT true of an ordinary define (`df = load()` re-run yields a new
 * frame), which is why this refinement is scoped to import bindings and every
 * other name keeps the conservative cell-level rule.
 *
 * A binding is therefore identified by the CANONICAL RENDERING of the single
 * import record that produces it (`renderImport` in `imports.ts`, one record per
 * bound name). Two sources bind `pd` identically iff that string matches - and
 * that rendering is already the dedup key the consolidate/routing path works on,
 * so this cannot drift from what Cellar elsewhere calls "the same import".
 *
 * WHY ONLY AN IMPORTS-ONLY CELL. To claim a name's value is determined by its
 * import statement we must know that NOTHING ELSE in the cell binds it - a cell
 * holding `import os` and then `os = shim` (or `for os in …`, `with … as os`,
 * `del os`) does not. Enumerating every binding form with a regex over Python
 * source is exactly the mistake `imports.ts` exists to avoid, and a MISSED shadow
 * is a false `fresh` - the one verdict staleness must never invent. So the test is
 * the tokenizer's own, already-exact one: `isImportsOnly` (every module-level
 * logical line is an import, a comment, or blank). Nothing at module scope can then
 * bind anything the imports did not. A mixed cell simply keeps today's conservative
 * behavior, which costs precision nowhere that matters: the imports cell - the
 * whole point of this mechanism - is imports-only by construction (both the
 * routing/consolidate path and `isImportsOnly` adoption keep it so).
 *
 * `from x import *` binds unknowable names, so it makes the whole map UNKNOWABLE
 * (null) rather than merely omitting an entry - same "I don't understand this, so
 * don't touch it" rule `imports.ts` applies to a statement it cannot re-render.
 */
import { extractTopLevelImports, isImportsOnly, parseImportStatement, type ImportRecord } from './imports';

/** name → the canonical rendering of the import record that binds it. */
export type ImportSpecs = Map<string, string>;

/**
 * The runtime-only stamp map stored on a cell: name → wall-clock ms its import
 * binding last CHANGED (added, rebound, or removed). A name absent from the map
 * has not changed since Cellar started watching this document, which is exactly
 * the reading a downstream cell needs - its `lastRun` cannot predate that.
 */
export type ImportChangeStamps = Record<string, number>;

/** The name an import record binds at module scope (`import a.b` binds `a`). */
function boundName(rec: ImportRecord): string | null {
	if (rec.kind === 'import') return rec.alias ?? rec.module.split('.')[0];
	if (rec.name === '*') return null; // unknowable - the caller degrades the whole map
	return rec.alias ?? rec.name;
}

/**
 * The module-level import bindings a source provides: name → canonical statement.
 *
 * Returns `null` when the source's binding set is UNKNOWABLE - it is not
 * imports-only at module scope (so something else may rebind a name), or it holds
 * a `from x import *`. A null map is the conservative signal: the caller must then
 * treat the cell as providing no stable import binding at all.
 */
export function importBindingSpecs(source: string | null | undefined): ImportSpecs | null {
	const src = source ?? '';
	// Anything else at module scope could rebind an imported name; we cannot prove
	// otherwise without re-deriving Python's binding rules, so we do not try.
	if (!isImportsOnly(src)) return null;
	const specs: ImportSpecs = new Map();
	// `statements` is one canonical, deduplicated statement per bound name, in
	// document order - so each entry is exactly one binding and is its own spec.
	for (const statement of extractTopLevelImports(src).statements) {
		const recs = parseImportStatement(statement);
		if (!recs || recs.length !== 1) return null; // never expected; degrade rather than guess
		const name = boundName(recs[0]);
		if (name == null) return null; // `import *` ⇒ unknowable
		specs.set(name, statement); // a later duplicate binding wins, like Python
	}
	return specs;
}

/**
 * Fold one source edit into a cell's import-change stamps.
 *
 * A name keeps its previous stamp when its binding is byte-identical before and
 * after (so re-rendering, reordering, or re-adding an import that was already
 * there changes nothing) and takes `now` when it was added, rebound, or REMOVED.
 * A removed name stays in the map: its disappearance is a change downstream cells
 * must see, and forgetting it is precisely the false `fresh` this mechanism exists
 * to prevent.
 *
 * When either side is UNKNOWABLE (`importBindingSpecs` returned null) every name
 * either side mentions is stamped `now` - we cannot prove any binding survived, so
 * none may be certified stable.
 */
export function foldImportChange(
	prevSource: string | null | undefined,
	nextSource: string | null | undefined,
	prev: ImportChangeStamps | undefined | null,
	now: number
): ImportChangeStamps {
	const before = importBindingSpecs(prevSource);
	const after = importBindingSpecs(nextSource);
	const out: ImportChangeStamps = { ...(prev ?? {}) };

	const names = new Set<string>([...Object.keys(out), ...(before?.keys() ?? []), ...(after?.keys() ?? [])]);
	for (const name of names) {
		if (!before || !after) {
			out[name] = now; // unknowable on either side ⇒ nothing is provably stable
			continue;
		}
		if (before.get(name) === after.get(name)) continue; // unchanged (absent on both sides included)
		out[name] = now;
	}
	return out;
}

/** The names a source provides as stable module-level import bindings (none if unknowable). */
export function importBindingNames(source: string | null | undefined): string[] {
	const specs = importBindingSpecs(source);
	return specs ? [...specs.keys()] : [];
}
