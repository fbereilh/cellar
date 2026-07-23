/**
 * Cellar — cell staleness rule (pure, browser-safe).
 *
 * "Stale" means a cell's saved result no longer reflects its inputs: the cell
 * itself was edited after it last ran, or one of the cells it DEPENDS ON changed
 * (was edited, re-ran, or never ran this session) more recently than this cell
 * last ran. It is the flagship correctness signal for an agent-first notebook,
 * where cells are routinely run out of order.
 *
 * This module owns ONLY the rule; it does not parse Python. The dependency
 * information (which names each cell defines / uses) is computed elsewhere
 * (`server/dataflow.js`, a Python `ast` + `symtable` analysis) and handed in as
 * `dataflow`. Keeping the rule pure and separate from the analysis means the
 * exact same staleness verdict is computed for the UI (a fetch of the server's
 * result) and for the MCP agent surface — one definition, no drift — and that it
 * is trivially testable without a kernel.
 *
 * The rule is layered on the existing run-tracking foundation (see
 * `mcp/service.js`, `kernel.js`): a cell's `metadata.cellar.lastRun` carries the
 * kernel-session epoch + start time it last ran at, and `metadata.cellar.editedAt`
 * the wall-clock time its source last changed. Both are runtime-only (stripped
 * from disk), so staleness is computed fresh each time and never persisted — a
 * stale cell produces zero git diff.
 *
 * PER-NAME PRECISION FOR IMPORT BINDINGS. Those two stamps are per CELL while the
 * graph is per NAME, so the rule originally transmitted staleness along EVERY edge
 * out of a cell that was touched. An imports cell defines a name almost every cell
 * below it uses, so any touch of it - one added import, agent routing re-adding a
 * line, even a plain re-run - staled the entire notebook downstream, and "stale"
 * stopped carrying information for most of an agent session. The one property
 * strong enough to fix that safely: a name bound by a MODULE-LEVEL import has a
 * value that is a pure function of its import statement, so re-executing it rebinds
 * the same object. `metadata.cellar.importBindings` (a third runtime-only stamp;
 * see `server/importBindings.ts`) records per name when its import statement last
 * changed, and `edgeCarriesChange` below exempts an edge whose names are ALL
 * unchanged import bindings. The exemption is a whitelist, so anything unmodelled -
 * an ordinary define, an `import *`, a cell mixing imports with other code, an
 * upstream that never ran this session - keeps the conservative cell-level rule.
 *
 * WHAT THIS IS NOT: a runtime check of the kernel. The verdict is STATIC ANALYSIS
 * (the definer graph, built from `ast` + `symtable` output) PLUS TIMESTAMPS (`lastRun`,
 * `editedAt`). `lastRun` carries `{at, durationMs, actor, status, session}` - it
 * never records the names a cell actually read or wrote, and nothing here inspects
 * the kernel namespace. So every blind spot below is a blind spot in the verdict
 * too: staleness cannot catch a dependency the graph missed, and no other signal
 * catches it either (`find_symbol` and `cell_impact` are derived from this same
 * graph, so they under-report identically - none of the three backs up the other).
 * The one genuinely runtime-derived input is `lastRun.session`: a kernel restart
 * bumps the epoch and correctly resets every cell to `not_run`. That is epoch
 * tracking, not name tracking.
 *
 * KNOWN LIMITS (documented, acceptable for a dataflow-by-common-cases graph):
 *  - Dynamic names never reach the graph: `exec`, `globals()[...]=`, `setattr`,
 *    `del`, star-imports' expansion, monkeypatching. A dependency carried only
 *    through those is invisible here.
 *  - A CONDITIONAL bind counts as bound: `if flag: df = load()` then `df.head()`
 *    records no use of `df`, so an upstream `df` cell's edit does not stale it.
 *    The module-scope walk (`dataflow.js`) is sequential, not a branch join.
 *  - An augmented assignment to a name declared `global` INSIDE a function
 *    (`def g(): global c; c += 1`) is missed - that read lives in a deferred body,
 *    which is `symtable`'s half of the probe, and `symtable` reports
 *    `is_referenced() == False` for an augmented target. Module-scope `count += 1`
 *    is caught (see `dataflow.js`).
 *  - A SQL cell is a graph SOURCE: `dataflow.js` gives it the names its run binds
 *    (`_sql_df`, plus any `-- >> name`) as `defines` but never any `uses`, since
 *    reading table names out of SQL is lineage analysis and out of scope. So a
 *    Python cell reading a SQL result does go stale when the query is edited, but
 *    a SQL cell never goes stale from an upstream Python cell (a temp view it
 *    queries, say) - only from its own edit or a restart.
 *  - The definer is the nearest *preceding* cell (document order) that binds the
 *    name; a name defined only by a later cell is treated as external.
 *  - The import-binding exemption assumes an import is idempotent, which
 *    `importlib.reload` (or a module with import-time side effects) breaks. Both
 *    are deliberate, explicit acts; treating them as ordinary would give back the
 *    blanket-stale this exists to remove.
 *  - REMOVAL is only covered while the cell that provided the name survives. The
 *    ledger below reads `importBindings` off that cell, so DELETING the imports
 *    cell outright takes its stamps with it: its readers then have no definer, no
 *    ledger entry, and report `fresh`. This is pre-existing (a deleted definer
 *    never produced an edge either, so nothing changed here), but it is asymmetric
 *    with the in-cell removal ledger - do not read that ledger as covering removal
 *    in general. Same family: an edit that drops a binding AND leaves the cell
 *    unanalyzable in one step records no change for the dropped name (see
 *    `foldImportChange`), so its readers - which have no definer either - stay
 *    `fresh` too.
 *  - Redefinition resolves to that nearest preceding definer, which is correct
 *    for the common top-to-bottom notebook and approximate for out-of-order runs.
 */

import type { Cell, ImportChangeStamps, LastRun, SessionId } from '$lib/server/types';
import { buildDefinerGraph, type Dataflow } from '$lib/symbolGraph';

export type { Dataflow };

/** state values a cell can carry. */
export const STALE_STATE = {
	NA: 'n/a', // markdown (or otherwise not a code cell)
	NOT_RUN: 'not_run', // a code cell that has not run in the current kernel session
	FRESH: 'fresh', // ran this session and every input is older than that run
	STALE: 'stale' // ran this session but an input changed since
} as const;

/** One of the four staleness states. */
export type StaleState = (typeof STALE_STATE)[keyof typeof STALE_STATE];

/** A single cell's staleness verdict. */
export interface StalenessEntry {
	state: StaleState;
	reason?: string;
	upstream?: string[];
	self?: boolean;
}

/** cellId → verdict, for every cell in the notebook. */
export type StalenessMap = Record<string, StalenessEntry>;

/** The staleness rule reads only these fields; `Cell`/`CellView` are assignable. */
type StaleCell = Cell;

const shortId = (id: string | undefined): string =>
	typeof id === 'string' ? id.slice(0, 8) : String(id);

const lastRunOf = (cell: StaleCell | undefined | null): LastRun | null =>
	cell?.metadata?.cellar?.lastRun ?? null;
const editedAtOf = (cell: StaleCell | undefined | null): number | null =>
	cell?.metadata?.cellar?.editedAt ?? null;
const importStampsOf = (cell: StaleCell | undefined | null): ImportChangeStamps =>
	cell?.metadata?.cellar?.importBindings ?? {};

/**
 * Does the edge from `up` into a cell that last ran at `at` carry a name whose
 * value could actually have moved? - the precision half of the rule.
 *
 * An edge is a BUNDLE of per-name facts, but the timestamps above are per CELL, so
 * the rule used to transmit staleness along every edge out of a touched cell. For
 * an imports cell that is the whole notebook below it, which is how "stale" stopped
 * carrying information in an agent session (routing rewrites that cell constantly).
 *
 * A name is exempt only under a property strong enough to survive re-execution: it
 * is bound by a MODULE-LEVEL import (`importDefines`), so its value is a pure
 * function of its import statement, AND that statement has not changed since this
 * cell ran (`importBindings[name].at <= at`; an absent stamp, or a 0 one, means it
 * has not changed since the document was loaded, which no `lastRun` can predate).
 * Re-running such
 * an import rebinds the same `sys.modules` entry, so the reader's saved result
 * still reflects its input.
 *
 * Every other name - an ordinary define, a name whose import moved, a cell whose
 * bindings are unknowable (`import *`, a mixed cell; see `importBindings.ts`) -
 * keeps the conservative cell-level behavior. The exemption is a whitelist, so the
 * failure direction of anything unmodelled is a needless re-run, never a false
 * `fresh`.
 */
function edgeCarriesChange(
	names: ReadonlySet<string> | undefined,
	up: StaleCell,
	importDefines: ReadonlySet<string>,
	at: number
): boolean {
	if (!names || names.size === 0) return true; // no name-level detail ⇒ conservative
	const stamps = importStampsOf(up);
	for (const name of names) {
		if (!importDefines.has(name)) return true; // not an import binding
		if ((stamps[name]?.at ?? 0) > at) return true; // its import statement moved after we ran
	}
	return false;
}

/** Did this cell execute against the kernel session that is live right now? */
function ranThisSession(cell: StaleCell | undefined | null, sid: SessionId | null): boolean {
	if (!cell || cell.cell_type !== 'code') return false;
	const lr = lastRunOf(cell);
	return sid != null && lr != null && lr.session === sid;
}

/**
 * Compute per-cell staleness for a whole notebook.
 *
 * @param cells cells in document order, carrying `metadata.cellar.lastRun` + `.editedAt`
 * @param dataflow per-cell defined/used names (code cells; missing entry ⇒ no dataflow)
 * @param sid current kernel-session epoch, or null when no kernel runs
 * @param unavailable code-cell ids whose dataflow could NOT be computed this pass
 *   (the `ast`/`symtable` probe timed out or is backed off - see `dataflow.js`). Their
 *   `dataflow` entry is empty, which would otherwise read as "no dependencies ⇒ fresh".
 *   A cell we could not analyze must NEVER be certified fresh, so any such cell that ran
 *   this session is marked `stale` outright. This is the conservative direction the
 *   backoff design demands: a false `fresh` is the one verdict staleness must not invent.
 */
export function computeStaleness(
	cells: readonly StaleCell[],
	dataflow: Dataflow | null | undefined,
	sid: SessionId | null,
	unavailable?: ReadonlySet<string> | null
): StalenessMap {
	const df: Dataflow = dataflow || {};
	const result: StalenessMap = {};

	// The graph is over CODE cells only. The definer graph (per name, the
	// document-ordered defining cells; each use's nearest preceding definer) is
	// built by `$lib/symbolGraph`, so the exact same rule backs the MCP find_symbol
	// tool — one definition, no drift.
	const codeCells = cells.filter((c) => c.cell_type === 'code');
	const { definerBefore, edgeNames } = buildDefinerGraph(codeCells, df);
	const importDefines = codeCells.map((c) => new Set(df[c.id]?.imports ?? []));

	// An import a preceding cell REMOVED leaves no edge behind - the name has no
	// definer any more - so the loop below cannot see it, and a reader of that name
	// would be certified `fresh` while the kernel still holds the binding the removal
	// is about to drop. Accumulated in document order (a removal only reaches cells
	// BELOW it): name → the latest wall-clock ms some earlier cell stopped providing
	// it, plus which cell that was. A stamp for a name the cell still provides is an
	// ordinary rebinding and is handled by `edgeCarriesChange`, not here.
	const removedBefore = new Map<string, { at: number; id: string }>();

	// Process in document order: an upstream (nearest preceding definer) always has
	// a smaller index, so its verdict is already known — transitive staleness
	// propagates in one pass, and the preceding-definer graph is acyclic by
	// construction (no need to guard against cycles).
	const stale: boolean[] = new Array(codeCells.length).fill(false);
	const foldRemovals = (cell: StaleCell, i: number): void => {
		for (const [name, { at }] of Object.entries(importStampsOf(cell))) {
			if (importDefines[i].has(name)) continue; // still provided ⇒ not a removal
			const prev = removedBefore.get(name);
			if (!prev || at > prev.at) removedBefore.set(name, { at, id: cell.id });
		}
	};
	codeCells.forEach((cell, i) => {
		// Fold the PREVIOUS cell's removals in here rather than at the end of its own
		// iteration: the paths below return early, and a cell must never see its own
		// removal as an upstream one.
		if (i > 0) foldRemovals(codeCells[i - 1], i - 1);
		if (!ranThisSession(cell, sid)) {
			result[cell.id] = { state: STALE_STATE.NOT_RUN };
			return;
		}
		// Analysis unavailable (probe timed out / backed off): we hold no trustworthy
		// dataflow for this cell, so we cannot rule out a changed dependency. Mark it
		// stale rather than let its empty dataflow read as "no deps ⇒ fresh".
		if (unavailable?.has(cell.id)) {
			stale[i] = true;
			result[cell.id] = {
				state: STALE_STATE.STALE,
				reason: 'dependency analysis timed out; treated as stale',
				self: false,
				upstream: []
			};
			return;
		}
		const at = lastRunOf(cell)?.at ?? 0;
		const reasons: Reason[] = [];
		const upstreamIds = new Set<string>();

		const selfEdited = editedAtOf(cell);
		if (selfEdited != null && selfEdited > at) reasons.push({ kind: 'self_edited' });

		for (const [j, names] of edgeNames[i]) {
			const up = codeCells[j];
			const upEdited = editedAtOf(up);
			const upAt = lastRunOf(up)?.at ?? 0;
			// The other three reasons all claim the upstream's VALUES moved, so each is
			// gated on the edge actually carrying a name that could have moved - an
			// imports cell's edit moves one binding, not all of them, and transmitting
			// along all of them is what blanket-staled the notebook below it.
			// `upstream_unrun` is deliberately NOT gated: an upstream that never ran
			// this session has none of its names bound in the live namespace, so there
			// is no surviving import binding left to exempt. Reason PRECEDENCE below is
			// unchanged (a direct edit still outranks an unrun upstream).
			const carries = edgeCarriesChange(names, up, importDefines[j], at);
			let kind: ReasonKind | null = null;
			if (carries && upEdited != null && upEdited > at) kind = 'upstream_edited';
			else if (carries && ranThisSession(up, sid) && upAt > at) kind = 'upstream_reran';
			else if (!ranThisSession(up, sid)) kind = 'upstream_unrun';
			else if (carries && stale[j]) kind = 'upstream_stale';
			if (kind) {
				reasons.push({ kind, id: up.id });
				upstreamIds.add(up.id);
			}
		}

		// A name a preceding cell REMOVED from its imports has no definer left, so it
		// produced no edge above. Only consult the removal ledger for names nothing
		// defines any more - a name some other cell still provides is an ordinary edge
		// and was just handled.
		for (const name of df[cell.id]?.uses ?? []) {
			if (definerBefore(name, i) >= 0) continue;
			const rm = removedBefore.get(name);
			if (rm && rm.at > at) {
				reasons.push({ kind: 'upstream_edited', id: rm.id });
				upstreamIds.add(rm.id);
			}
		}

		if (!reasons.length) {
			result[cell.id] = { state: STALE_STATE.FRESH };
			return;
		}
		stale[i] = true;
		// Surface the most salient reason first (a direct edit beats a transitively
		// inherited one), regardless of the order upstreams happened to be visited.
		const primary = [...reasons].sort((a, b) => REASON_RANK[a.kind] - REASON_RANK[b.kind])[0];
		result[cell.id] = {
			state: STALE_STATE.STALE,
			reason: reasonText(primary),
			self: reasons.some((r) => r.kind === 'self_edited'),
			upstream: [...upstreamIds]
		};
	});

	// Markdown / non-code cells: n/a, so every cell in the notebook has an entry.
	for (const c of cells) if (!(c.id in result)) result[c.id] = { state: STALE_STATE.NA };
	return result;
}

/** Why a cell is stale. */
type ReasonKind =
	| 'self_edited'
	| 'upstream_edited'
	| 'upstream_reran'
	| 'upstream_unrun'
	| 'upstream_stale';

interface Reason {
	kind: ReasonKind;
	/** The upstream cell id (absent for `self_edited`). */
	id?: string;
}

/** Reason priority (lowest = most salient): a direct change beats an inherited one. */
const REASON_RANK: Record<ReasonKind, number> = {
	self_edited: 0,
	upstream_edited: 1,
	upstream_reran: 2,
	upstream_unrun: 3,
	upstream_stale: 4
};

/** The primary human-readable reason (the first, highest-priority, reason). */
function reasonText(r: Reason): string {
	switch (r.kind) {
		case 'self_edited':
			return 'edited after it last ran';
		case 'upstream_edited':
			return `cell ${shortId(r.id)} was edited after this ran`;
		case 'upstream_reran':
			return `cell ${shortId(r.id)} ran again after this`;
		case 'upstream_unrun':
			return `cell ${shortId(r.id)} (a dependency) has not run this session`;
		case 'upstream_stale':
			return `depends on cell ${shortId(r.id)}, which is stale`;
		default:
			return 'out of date';
	}
}

/** Ids of the stale code cells, in document order — what "Run all stale" runs. */
export function staleIdsInOrder(cells: readonly StaleCell[], staleness: StalenessMap): string[] {
	return cells.filter((c) => staleness[c.id]?.state === STALE_STATE.STALE).map((c) => c.id);
}
