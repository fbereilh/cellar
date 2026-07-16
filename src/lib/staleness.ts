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
 * (`server/dataflow.js`, a Python `symtable` analysis) and handed in as
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
 * WHAT THIS IS NOT: a runtime check of the kernel. The verdict is STATIC ANALYSIS
 * (the definer graph, built from `symtable` output) PLUS TIMESTAMPS (`lastRun`,
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
 *  - A read-then-rebind hides the read: the probe computes `uses = referenced −
 *    defined`, so a cell that reads a name it also rebinds records `defines=[x]`,
 *    `uses=[]` and gets NO upstream edge. This covers self-reassignment
 *    (`df = f(df)`, `x = x + 10`) and augmented assignment (`count += 1`) alike.
 *    Editing that cell's upstream therefore leaves it reported `fresh` while its
 *    output is already out of date - the widest under-report in practice.
 *  - The definer is the nearest *preceding* cell (document order) that binds the
 *    name; a name defined only by a later cell is treated as external.
 *  - Redefinition resolves to that nearest preceding definer, which is correct
 *    for the common top-to-bottom notebook and approximate for out-of-order runs.
 */

import type { Cell, LastRun, SessionId } from '$lib/server/types';
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
 */
export function computeStaleness(
	cells: readonly StaleCell[],
	dataflow: Dataflow | null | undefined,
	sid: SessionId | null
): StalenessMap {
	const df: Dataflow = dataflow || {};
	const result: StalenessMap = {};

	// The graph is over CODE cells only. The definer graph (per name, the
	// document-ordered defining cells; each use's nearest preceding definer) is
	// built by `$lib/symbolGraph`, so the exact same rule backs the MCP find_symbol
	// tool — one definition, no drift.
	const codeCells = cells.filter((c) => c.cell_type === 'code');
	const { directUpstream } = buildDefinerGraph(codeCells, df);

	// Process in document order: an upstream (nearest preceding definer) always has
	// a smaller index, so its verdict is already known — transitive staleness
	// propagates in one pass, and the preceding-definer graph is acyclic by
	// construction (no need to guard against cycles).
	const stale: boolean[] = new Array(codeCells.length).fill(false);
	codeCells.forEach((cell, i) => {
		if (!ranThisSession(cell, sid)) {
			result[cell.id] = { state: STALE_STATE.NOT_RUN };
			return;
		}
		const at = lastRunOf(cell)?.at ?? 0;
		const reasons: Reason[] = [];
		const upstreamIds = new Set<string>();

		const selfEdited = editedAtOf(cell);
		if (selfEdited != null && selfEdited > at) reasons.push({ kind: 'self_edited' });

		for (const j of directUpstream[i]) {
			const up = codeCells[j];
			const upEdited = editedAtOf(up);
			const upAt = lastRunOf(up)?.at ?? 0;
			let kind: ReasonKind | null = null;
			if (upEdited != null && upEdited > at) kind = 'upstream_edited';
			else if (ranThisSession(up, sid) && upAt > at) kind = 'upstream_reran';
			else if (!ranThisSession(up, sid)) kind = 'upstream_unrun';
			else if (stale[j]) kind = 'upstream_stale';
			if (kind) {
				reasons.push({ kind, id: up.id });
				upstreamIds.add(up.id);
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
