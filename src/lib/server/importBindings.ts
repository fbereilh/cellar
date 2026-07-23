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
 * logical line is an import, a comment, a blank - or, see below, a magic that binds
 * nothing). Nothing at module scope can then bind anything the imports did not. A
 * mixed cell simply keeps today's conservative
 * behavior, which costs precision nowhere that matters: the imports cell - the
 * whole point of this mechanism - is imports-only by construction (both the
 * routing/consolidate path and `isImportsOnly` adoption keep it so).
 *
 * `from x import *` binds unknowable names, so it makes the whole map UNKNOWABLE
 * (null) rather than merely omitting an entry - same "I don't understand this, so
 * don't touch it" rule `imports.ts` applies to a statement it cannot re-render.
 *
 * INERT LINE MAGICS ARE IGNORABLE, LIKE COMMENTS. `%matplotlib inline`, `%pip
 * install …`, `%config …` above the import block is one of the most common notebook
 * headers there is, and those bind no Python name - so treating one as "other code"
 * would degrade the map to null and leave exactly the reported bug unfixed for most
 * real notebooks. The vocabulary comes from `magics.ts` (`isBareMagicLine`, the same
 * shape `blankLineMagics` blanks for the probe), never a second regex here, and the
 * assignment form (`files = !ls`) is not one, so it still reads as ordinary code and
 * still disqualifies.
 *
 * INERT is the operative word, and it is an ALLOWLIST (`magics.ts`'s
 * `INERT_LINE_MAGICS`): a magic that injects into the namespace - `%run script.py`
 * executes it THERE, `%store -r name` / `%load` inject names, `%pylab` is a star
 * import, `%load_ext` runs an extension's own `load_ipython_extension(ip)`, which may
 * `push` names - could rebind an imported name exactly like the `os = shim` case
 * above, so it disqualifies, as does any magic not on the list. Two further
 * exceptions: a `%%cell magic` cell is not a Python imports cell at all, and
 * `%autoreload` breaks the idempotence premise above (see `hasAutoreloadMagic` - the
 * check here is only the local half, since arming autoreload is kernel-global and
 * `dataflow.ts` gates the whole notebook on it).
 */
import {
	extractTopLevelImports,
	isImportsOnlyResidual,
	logicalLines,
	parseImportStatement,
	type ImportRecord,
	type LogicalLine
} from './imports';
import { isBareMagicLine, scanMagics } from './magics';

/** name → the canonical rendering of the import record that binds it. */
export type ImportSpecs = Map<string, string>;

/** One name's last KNOWN-GOOD binding, plus when it last changed. */
export interface ImportBinding {
	/**
	 * The canonical import statement that binds the name. It is the last one PROVEN
	 * to bind it and is kept even after the name is removed (see `removedAt`), so a
	 * source that comes back is compared against what it actually used to say.
	 */
	spec: string;
	/**
	 * Wall-clock ms the binding last CHANGED (was added or rebound). 0 means it has
	 * not changed since Cellar started watching this document, which is exactly the
	 * reading a downstream cell needs - its `lastRun` cannot predate that.
	 */
	at: number;
	/**
	 * Wall-clock ms a KNOWABLE source last stopped providing the name; absent while
	 * it is provided. Separate from `at` so a removal that is undone (the transient
	 * blank save below) can be un-recorded rather than re-stamped, and so staleness
	 * can tell "this name was really dropped" from "we never proved anything about
	 * this cell's current source".
	 */
	removedAt?: number;
	/**
	 * Wall-clock ms the name first APPEARED in this cell, as opposed to `at`, which
	 * moves on every rebinding. 0 (or absent) means it may have been here all along.
	 * Only `pruneImportBindings` reads it, to tell a binding that was live at the
	 * cell's last run from one that was born and died between two runs.
	 */
	sinceAt?: number;
}

/**
 * The runtime-only map stored on a cell: name → its last known-good binding.
 *
 * It is a BASELINE, not just a change log: it records every name the cell was last
 * PROVEN to bind, so a fold is always knowable-vs-knowable even when the cell's
 * current source is not (see `foldImportChange`). Names it holds beyond the ones the
 * current source provides are removal records, and `pruneImportBindings` bounds those
 * to the ones a downstream cell could actually have read.
 */
export type ImportChangeStamps = Record<string, ImportBinding>;

/**
 * A residual line the imports-only test may skip: a bare magic / shell escape, which
 * the gate above has already proven inert. The assignment form (`files = !ls`) binds
 * a name, so it is not one and still disqualifies the cell.
 */
const isIgnorableLine = (line: LogicalLine): boolean => isBareMagicLine(line.raw);

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
	// ONE tokenizer pass feeds every question below. This runs on each debounced
	// autosave of each cell, and asking them separately (each re-walking the source)
	// is the difference between one pass and half a dozen.
	const lines = logicalLines(src);
	// A `%%cell magic` cell's body is not module-level Python (bash, html, its own
	// mini-language), so it is never an imports cell; autoreload retires the
	// idempotence premise the whole exemption rests on; and a magic we cannot prove
	// inert (`%run`, `%store`, `%load`, `%load_ext`, anything unrecognized) may inject
	// a name into the namespace, which is the `os = shim` shadow in another costume.
	const magics = scanMagics(lines);
	if (magics.cellMagic || magics.autoreload || magics.nonInert) return null;
	// The same pass answers both halves of the imports-only test: what was lifted,
	// and what was left. Anything else at module scope could rebind an imported name;
	// we cannot prove otherwise without re-deriving Python's binding rules, so we do
	// not try - only bare line magics / shell escapes are discounted, and only because
	// the gate above has already refused every magic not proven inert.
	const extracted = extractTopLevelImports(src, lines);
	if (!isImportsOnlyResidual(extracted.source, isIgnorableLine)) return null;
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
	// Refuse before the tokenizer runs: with no `import` token anywhere, the source is
	// either ordinary code (baseline null) or nothing but comments and blanks (baseline
	// empty), and answering null for both is the conservative read - an empty baseline
	// and a null one already stamp identically, they differ only in that a null one
	// leaves `sinceAt` at 0, i.e. RETAINS a later removal record rather than pruning it.
	// This is what keeps an ordinary code cell's autosave off the tokenizer entirely,
	// which is most autosaves.
	if (!(prevSource ?? '').includes('import')) return null;
	const specs = importBindingSpecs(prevSource);
	if (!specs) return null;
	const out: ImportChangeStamps = {};
	for (const [name, spec] of specs) out[name] = { spec, at: 0, sinceAt: 0 };
	return out;
}

/**
 * Fold one source edit into a cell's import bindings.
 *
 * A name keeps its previous stamp when its binding is byte-identical before and
 * after (so re-rendering, reordering, or re-adding an import that was already
 * there changes nothing) and takes `now` when it was added or rebound. A name the
 * new source no longer provides keeps its entry, its spec and its `at`, and gains a
 * `removedAt`: its disappearance is a change downstream cells must see, and
 * forgetting it is precisely the false `fresh` this mechanism exists to prevent.
 * (Which of those records is worth KEEPING is a separate question, decided against
 * the cell's last run by `pruneImportBindings` - the fold itself records everything
 * it observes, so the two concerns stay apart.)
 *
 * THE COMPARISON IS ALWAYS KNOWABLE-VS-KNOWABLE, and that is load-bearing. The
 * fold diffs the new source against the cell's STORED baseline, never against the
 * previous source text, because a cell's persisted source is routinely an unusable
 * mid-edit snapshot: `Cell.svelte` autosaves on a 500ms debounce (and flushes on
 * blur), so a pause after typing a bare `import `, or the instant after a
 * select-all-then-type, really does reach this function. Stamping every name
 * whenever a side is unknowable (what this used to do) made that transient snapshot
 * permanently re-stamp every binding - the exact blanket-stale this mechanism
 * exists to remove.
 *
 * So an UNKNOWABLE next source changes nothing: the last known-good baseline is
 * frozen and returned as-is, and the real delta is computed once the source parses
 * again. That cannot certify anything falsely fresh in the meantime, because
 * staleness only ever exempts a name that the CURRENT source still provides as an
 * import binding (`dataflow`'s `imports`, i.e. `importBindingNames`, which is empty
 * for an unknowable source) - so while the cell is mid-edit it grants no exemption
 * at all and every edge out of it stays conservative.
 *
 * A select-all-then-DELETE is the other half of that story and needs the opposite
 * treatment, because an EMPTY source is perfectly knowable - it provides nothing -
 * so freezing it would silently drop a genuine "delete all imports". The removal is
 * therefore RECORDED but kept UNDOABLE: `spec` survives it, so retyping the same
 * block matches the baseline and clears `removedAt` with no stamp at all, while a
 * deletion the user MEANT keeps its `removedAt` and stales the readers of the name
 * (`staleness.ts` only consults it for names nothing defines any more). Recording
 * the removal by overwriting the stamp instead - what this used to do - meant the
 * retype could only read as "this binding just changed", i.e. the whole notebook
 * stale after a round trip that ended byte-identical to where it started.
 *
 * An unknowable BASELINE (a cell that has never been proven imports-only) is the
 * one stamp-everything case left: nothing is known to have survived, so every name
 * the new source binds is stamped `now`.
 *
 * The freeze's one blind spot, and it is the SAME family as the limit `staleness.ts`
 * already documents for a deleted definer: an edit that both stops being analyzable
 * AND drops a binding records no change for the dropped name, so a reader of it -
 * which now has no definer at all, and no edge - stays `fresh`. Closing that would
 * take yet another per-name field (last real change vs. last unprovable), which buys
 * a contrived case at the cost of the mechanism's whole point.
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
	// A name the baseline does not hold is being introduced NOW - unless the baseline
	// itself is unknowable, in which case we cannot say the name is new and must assume
	// it may have been here all along (0), the reading that RETAINS its removal record.
	const bornAt = baseline === null ? 0 : now;
	const names = new Set<string>([...Object.keys(baseline ?? {}), ...after.keys()]);
	for (const name of names) {
		const before = baseline?.[name];
		const spec = after.get(name);
		// Presence begins once and is never walked forward, so a name that survived a
		// transient removal is still judged by when it FIRST appeared.
		const sinceAt = before ? (before.sinceAt ?? 0) : bornAt;
		if (spec === undefined) {
			// Gone from a knowable source. Keep the baseline intact so a restore is still
			// recognizable as one, and remember WHEN it went - but only the first time,
			// so a run of edits that leave it absent does not walk the removal forward.
			if (before) out[name] = { ...before, sinceAt, removedAt: before.removedAt ?? now };
			continue;
		}
		// Provided again, or still: an unchanged spec keeps its stamp and drops any
		// pending removal. A name the baseline never proved (or proved differently) is
		// the real change, and is the only thing stamped `now`.
		out[name] =
			before && before.spec === spec ? { spec, at: before.at, sinceAt } : { spec, at: now, sinceAt };
	}
	return out;
}

/**
 * Drop the removal records no downstream cell could ever have depended on.
 *
 * A `removedAt` entry outlives the name it describes on purpose - that is the whole
 * removal ledger, and forgetting one is a false `fresh`. But `Cell.svelte` autosaves
 * on a 500ms debounce, so retyping an import block persists PARSEABLE intermediates
 * (`import numpy as n` on the way to `as np`), each minting a name that is then
 * removed a keystroke later. Those entries were permanent: the map grew for as long
 * as the session lasted, rode every `cell:edited` payload and every deep-cloned
 * checkpoint, and a short phantom name (`n`, `p`, `re`) colliding with a real one
 * made the ledger report a removal that never happened.
 *
 * THE TEST IS "WAS IT BOUND WHEN THIS CELL LAST RAN", NOT "IS IT IN THE SOURCE NOW" -
 * and the distinction is the whole safety of this function. Pruning every name the
 * current source lacks would delete exactly the records the ledger exists for, since a
 * genuinely deleted import is also absent from the source. A name that appeared AFTER
 * the last run (`sinceAt > lastRunAt`) and has since gone never entered the namespace
 * this cell contributed to, so nothing downstream can have read it; a name that was
 * already there when the cell ran did, so its removal record survives - however many
 * times it was rebound in between, because `sinceAt` tracks first appearance while
 * `at` tracks rebinding.
 *
 * A cell that has never run (`lastRunAt` null) bound nothing at all, so the same rule
 * drops its removals. An entry from before this field existed (a restored checkpoint)
 * reads as `sinceAt` 0 and is therefore kept.
 */
export function pruneImportBindings(
	stamps: ImportChangeStamps,
	lastRunAt: number | null | undefined
): ImportChangeStamps {
	const out: ImportChangeStamps = {};
	for (const [name, b] of Object.entries(stamps)) {
		const phantom = lastRunAt == null || (b.sinceAt ?? 0) > lastRunAt;
		if (b.removedAt != null && phantom) continue;
		out[name] = b;
	}
	return out;
}

/** The names a source provides as stable module-level import bindings (none if unknowable). */
export function importBindingNames(source: string | null | undefined): string[] {
	const specs = importBindingSpecs(source);
	return specs ? [...specs.keys()] : [];
}
