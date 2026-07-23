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
import { extractTopLevelImports, isImportsOnlyResidual, parseImportStatement, type ImportRecord } from './imports';

/** name → the canonical rendering of the import record that binds it. */
export type ImportSpecs = Map<string, string>;

/** One name's last KNOWN-GOOD binding, plus when it last changed. */
export interface ImportBinding {
	/** The canonical import statement that binds the name, or null once it is gone. */
	spec: string | null;
	/**
	 * Wall-clock ms the binding last CHANGED (added, rebound, removed). 0 means it
	 * has not changed since Cellar started watching this document, which is exactly
	 * the reading a downstream cell needs - its `lastRun` cannot predate that.
	 */
	at: number;
}

/**
 * The runtime-only map stored on a cell: name → its last known-good binding.
 *
 * It is a BASELINE, not just a change log: it records every name the cell was last
 * PROVEN to bind, so a fold is always knowable-vs-knowable even when the cell's
 * current source is not (see `foldImportChange`).
 */
export type ImportChangeStamps = Record<string, ImportBinding>;

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
	// ONE tokenizer pass answers both halves: what was lifted, and what was left.
	// Anything else at module scope could rebind an imported name; we cannot prove
	// otherwise without re-deriving Python's binding rules, so we do not try.
	const extracted = extractTopLevelImports(src);
	if (!isImportsOnlyResidual(extracted.source)) return null;
	const specs: ImportSpecs = new Map();
	// `statements` is one canonical, deduplicated statement per bound name, in
	// document order - so each entry is exactly one binding and is its own spec.
	for (const statement of extracted.statements) {
		const recs = parseImportStatement(statement);
		if (!recs || recs.length !== 1) return null; // never expected; degrade rather than guess
		const name = boundName(recs[0]);
		if (name == null) return null; // `import *` ⇒ unknowable
		specs.set(name, statement); // a later duplicate binding wins, like Python
	}
	return specs;
}

/**
 * The baseline a fold compares against: the cell's stored last known-good bindings
 * when it has any, else the ones its previous source provides (the very first fold
 * of a cell, whose runtime stamps were never written or were stripped on load).
 *
 * Null means we have no proven picture of what this cell bound - no stamps yet AND
 * an unknowable previous source - so nothing about it may be certified stable.
 */
function baselineOf(
	prev: ImportChangeStamps | undefined | null,
	prevSource: string | null | undefined
): ImportChangeStamps | null {
	if (prev && Object.keys(prev).length) return { ...prev };
	const specs = importBindingSpecs(prevSource);
	if (!specs) return null;
	const out: ImportChangeStamps = {};
	for (const [name, spec] of specs) out[name] = { spec, at: 0 };
	return out;
}

/**
 * Fold one source edit into a cell's import bindings.
 *
 * A name keeps its previous stamp when its binding is byte-identical before and
 * after (so re-rendering, reordering, or re-adding an import that was already
 * there changes nothing) and takes `now` when it was added, rebound, or REMOVED.
 * A removed name stays in the map with a null spec: its disappearance is a change
 * downstream cells must see, and forgetting it is precisely the false `fresh` this
 * mechanism exists to prevent.
 *
 * THE COMPARISON IS ALWAYS KNOWABLE-VS-KNOWABLE, and that is load-bearing. The
 * fold diffs the new source against the cell's STORED baseline, never against the
 * previous source text, because a cell's persisted source is routinely an unusable
 * mid-edit snapshot: `Cell.svelte` autosaves on a 500ms debounce, so the instant
 * after a select-all, or a pause after typing a bare `import `, reaches this
 * function. Stamping every name whenever a side is unknowable (what this used to
 * do) made that transient snapshot permanently re-stamp every binding - the exact
 * blanket-stale this mechanism exists to remove.
 *
 * So an UNKNOWABLE next source changes nothing: the last known-good baseline is
 * frozen and returned as-is, and the real delta is computed once the source parses
 * again. That cannot certify anything falsely fresh in the meantime, because
 * staleness only ever exempts a name that the CURRENT source still provides as an
 * import binding (`dataflow`'s `imports`, i.e. `importBindingNames`, which is empty
 * for an unknowable source) - so while the cell is mid-edit it grants no exemption
 * at all and every edge out of it stays conservative.
 *
 * An unknowable BASELINE (a cell that has never been proven imports-only) is the
 * one stamp-everything case left: nothing is known to have survived, so every name
 * the new source binds is stamped `now`.
 *
 * The freeze's one blind spot, and it is the SAME family as the limit `staleness.ts`
 * already documents for a deleted definer: an edit that both stops being analyzable
 * AND drops a binding records no change for the dropped name, so a reader of it -
 * which now has no definer at all, and no edge - stays `fresh`. Closing that would
 * take a second per-name field (last real change vs. last unprovable), which buys a
 * contrived case at the cost of the mechanism's whole point.
 */
export function foldImportChange(
	prevSource: string | null | undefined,
	nextSource: string | null | undefined,
	prev: ImportChangeStamps | undefined | null,
	now: number
): ImportChangeStamps {
	const baseline = baselineOf(prev, prevSource);
	const after = importBindingSpecs(nextSource);
	// Unknowable now: freeze what we last proved rather than invent a change.
	if (!after) return baseline ?? { ...(prev ?? {}) };

	const out: ImportChangeStamps = {};
	const names = new Set<string>([...Object.keys(baseline ?? {}), ...after.keys()]);
	for (const name of names) {
		// A name absent from the baseline and one the baseline records as REMOVED are
		// the same fact - it was not bound before - so both compare as null.
		const before = baseline ? (baseline[name]?.spec ?? null) : undefined;
		const spec = after.get(name) ?? null;
		if (before !== undefined && before === spec) {
			out[name] = baseline?.[name] ?? { spec, at: 0 };
			continue;
		}
		out[name] = { spec, at: now };
	}
	return out;
}

/** The names a source provides as stable module-level import bindings (none if unknowable). */
export function importBindingNames(source: string | null | undefined): string[] {
	const specs = importBindingSpecs(source);
	return specs ? [...specs.keys()] : [];
}
