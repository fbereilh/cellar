/**
 * Cellar — the definer graph (pure, browser-safe).
 *
 * A notebook's dependency structure is fully determined by which names each code
 * cell DEFINES and USES (computed by `server/dataflow.ts`, a Python `symtable`
 * pass). This module owns the two derivations built on top of that:
 *
 *   - the DEFINER GRAPH — per name, the document-ordered code cells that bind it,
 *     and the "nearest preceding definer" a use resolves to; and
 *   - `resolveSymbol` — the symbol-navigation answer (where a name is defined +
 *     which cells reference it), reconciled with the live kernel namespace.
 *
 * Both the staleness rule (`$lib/staleness.ts`) and the MCP `find_symbol` tool
 * (`server/mcp/service.ts`) consume the graph, so the "who defines the `df` this
 * cell sees" rule is defined exactly ONCE — no drift between the correctness
 * signal the UI shows and the navigation an agent queries.
 *
 * INHERITED LIMITS (identical to those `staleness.ts` documents; this module adds
 * NO new blind spots):
 *  - A read-then-rebind masks the read: `df = f(df)`, `x = x + 10`, `count += 1` -
 *    any cell reading a name it also rebinds - records `defines=[df]`, `uses=[]`
 *    (the probe computes `uses = referenced − defined`), so that cell does not
 *    appear to *use* `df` and gets no upstream edge.
 *  - Dynamic names (`exec`, `globals()[...]=`, star-imports) never reach the graph;
 *    the live kernel namespace (`kernel_state`) is the fallback for those.
 *  - A forward reference (a use with no *preceding* definer) resolves to -1 / null.
 *  - `def`/`class` and a plain variable are both bare names in `defines`; the graph
 *    cannot label a symbol's kind.
 */

import type { SessionId } from '$lib/server/types';

/** Per-cell dataflow (what each cell defines / uses); missing entry ⇒ no dataflow. */
export type Dataflow = Record<string, { defines?: string[]; uses?: string[] } | undefined>;

/** The minimal cell shape the graph needs: an id (dataflow is keyed by it). */
interface GraphCell {
	id: string;
}

/** The definer graph over a document-ordered list of code cells. */
export interface DefinerGraph {
	/** name → ascending list of code-cell indices that define it. */
	definers: Map<string, number[]>;
	/** The nearest code-cell index < `i` that defines `name`, or -1. */
	definerBefore(name: string, i: number): number;
	/** For each code cell (by index), the set of upstream code-cell indices it reads. */
	directUpstream: Set<number>[];
}

/**
 * Build the definer graph for a list of code cells in document order.
 *
 * `codeCells` must already be filtered to code cells (the caller owns that filter
 * so the indices it gets back line up with its own array). `dataflow` is keyed by
 * cell id; a cell with no entry contributes no defines/uses.
 */
export function buildDefinerGraph(
	codeCells: readonly GraphCell[],
	dataflow: Dataflow
): DefinerGraph {
	// Per name, the document-ordered indices of the code cells that define it, so a
	// use resolves to its nearest preceding definer.
	const definers = new Map<string, number[]>();
	codeCells.forEach((c, i) => {
		for (const name of dataflow[c.id]?.defines ?? []) {
			if (!definers.has(name)) definers.set(name, []);
			definers.get(name)!.push(i);
		}
	});

	function definerBefore(name: string, i: number): number {
		const list = definers.get(name);
		if (!list) return -1;
		let best = -1;
		for (const j of list) {
			if (j < i) best = j;
			else break; // list is ascending, so no later index can be < i
		}
		return best;
	}

	// The set of upstream code-cell indices each code cell directly depends on: each
	// name it uses, resolved to that name's nearest preceding definer.
	const directUpstream = codeCells.map((c, i) => {
		const ups = new Set<number>();
		for (const name of dataflow[c.id]?.uses ?? []) {
			const j = definerBefore(name, i);
			if (j >= 0) ups.add(j);
		}
		return ups;
	});

	return { definers, definerBefore, directUpstream };
}

/** The cell shape `resolveSymbol` reads: id, type, agent-visibility, last-run epoch. */
export interface SymbolCell {
	id: string;
	cell_type: string;
	/** Hidden from the agent (`metadata.cellar.hidden_from_agent`) — never reported. */
	hidden: boolean;
	/** The kernel-session epoch this cell last ran in, or null. */
	lastRunSession: SessionId | null | undefined;
}

/** One reference to the symbol: a using cell + the definition it binds to. */
export interface SymbolReference {
	/** The visible cell handle that uses the name. */
	cell: string;
	/** The nearest preceding definer's handle, or null (forward ref / hidden definer). */
	binds_to: string | null;
}

/** The `find_symbol` answer (report §3.1). */
export interface SymbolInfo {
	symbol: string;
	/** Visible cells that DEFINE the name, in document order. */
	defined_in: string[];
	/** Visible cells that USE the name, each resolved to its binding definer. */
	used_in: SymbolReference[];
	/** At least one definer is hidden from the agent (so some info is suppressed). */
	hidden_definer?: boolean;
	/** The last VISIBLE definer whose value is live in the current session. */
	live_definer?: string;
	/** Whether the name is in the running kernel's namespace (absent = no live kernel). */
	live_in_kernel?: boolean;
}

/**
 * Resolve a Python name across a notebook by dataflow: the cells that DEFINE it
 * (document order) and the cells that USE it (each resolved to its nearest
 * preceding definer), reconciled with the live kernel namespace.
 *
 * The graph is built over ALL code cells (a hidden cell still defines names in the
 * kernel), but only agent-visible cells are reported; a hidden definer is flagged.
 *
 * @param name          the symbol to locate
 * @param cells         ALL notebook cells in document order (code + markdown)
 * @param dataflow      per-code-cell `{defines, uses}`, keyed by cell id
 * @param sid           current kernel-session epoch, or null when no kernel runs
 * @param kernelNames   names live in the kernel namespace now, or null when unknown
 *                      (no kernel / busy / stale) — omits `live_in_kernel`
 * @param toHandle      full cell id → short agent handle
 */
export function resolveSymbol(opts: {
	name: string;
	cells: readonly SymbolCell[];
	dataflow: Dataflow;
	sid: SessionId | null;
	kernelNames: Set<string> | null;
	toHandle?: (id: string) => string;
}): SymbolInfo {
	const { name, cells, dataflow, sid, kernelNames } = opts;
	const toHandle = opts.toHandle ?? ((x) => x);

	const codeCells = cells.filter((c) => c.cell_type === 'code');
	const { definers, definerBefore } = buildDefinerGraph(codeCells, dataflow);

	const definerIdx = definers.get(name) ?? [];
	const defined_in: string[] = [];
	let hidden_definer = false;
	let live_definer: string | undefined;
	for (const j of definerIdx) {
		const cell = codeCells[j];
		if (cell.hidden) {
			hidden_definer = true;
			continue;
		}
		defined_in.push(toHandle(cell.id));
		// The live definer is the LAST (latest doc-order) visible definer whose value
		// is actually live in the current session (definerIdx is ascending).
		if (sid != null && cell.lastRunSession === sid) live_definer = toHandle(cell.id);
	}

	// References: every visible code cell that uses the name, in document order,
	// bound to its nearest preceding definer (null = forward ref or hidden definer).
	const used_in: SymbolReference[] = [];
	codeCells.forEach((cell, i) => {
		if (cell.hidden) return;
		if (!(dataflow[cell.id]?.uses ?? []).includes(name)) return;
		const j = definerBefore(name, i);
		const binder = j >= 0 ? codeCells[j] : null;
		used_in.push({
			cell: toHandle(cell.id),
			binds_to: binder && !binder.hidden ? toHandle(binder.id) : null
		});
	});

	const info: SymbolInfo = { symbol: name, defined_in, used_in };
	if (hidden_definer) info.hidden_definer = true;
	if (live_definer) info.live_definer = live_definer;
	if (kernelNames) info.live_in_kernel = kernelNames.has(name);
	return info;
}

/** The cell shape `resolveImpact` reads: an id and whether it is agent-visible. */
export interface ImpactCell {
	id: string;
	cell_type: string;
	/** Hidden from the agent (`metadata.cellar.hidden_from_agent`) — never reported. */
	hidden: boolean;
}

/** The `cell_impact` answer (report §3.2). */
export interface ImpactInfo {
	/** The queried cell's handle (echoed back). */
	cell: string;
	/** Visible cells whose definitions this cell reads (its direct upstream). */
	depends_on: string[];
	/** Visible cells that would go STALE if this cell is edited (transitive downstream). */
	dependents: string[];
}

/**
 * The dependency blast radius of one cell, off the SAME definer graph as
 * staleness (and `resolveSymbol`): its `depends_on` (the cells whose definitions
 * this cell reads — its direct upstream) and its `dependents` (the transitive
 * downstream cells that would go STALE if this cell is edited), both in document
 * order. This answers "what will run_stale re-run after I touch this cell" BEFORE
 * the edit — the downstream direction nothing else surfaces.
 *
 * The graph is built over ALL code cells and traversed THROUGH hidden cells (a
 * hidden cell still propagates a dependency in the kernel), but only agent-visible
 * cells are reported. A non-code / unknown target yields empty lists.
 *
 * Inherits the definer graph's limits (see this module's header): a read-then-rebind
 * - a self-reassignment (`df = f(df)`), an augmented assignment, or any cell reading
 * a name it also rebinds - hides that cell's read, so a data cell's `dependents` can
 * UNDER-report.
 *
 * There is NO runtime backstop for this. `get_notebook_map`'s `stale_state` is
 * `computeStaleness(cells, dataflow, sid)` - this same static graph plus `lastRun`
 * timestamps - and `lastRun` carries only `{at, session, ...}`, never the name sets
 * a cell read or wrote. So staleness under-reports identically and cannot catch what
 * the graph missed. (`lastRun.session` IS runtime-derived and correctly invalidates
 * everything across a kernel restart, but that is epoch tracking, not name tracking.)
 *
 * @param id       the full cell id to query
 * @param cells    ALL notebook cells in document order (code + markdown)
 * @param dataflow per-code-cell `{defines, uses}`, keyed by cell id
 * @param toHandle full cell id → short agent handle
 */
export function resolveImpact(opts: {
	id: string;
	cells: readonly ImpactCell[];
	dataflow: Dataflow;
	toHandle?: (id: string) => string;
}): ImpactInfo {
	const { id, cells, dataflow } = opts;
	const toHandle = opts.toHandle ?? ((x) => x);

	const codeCells = cells.filter((c) => c.cell_type === 'code');
	const targetIdx = codeCells.findIndex((c) => c.id === id);
	// A markdown / unknown / non-code target has no dataflow edges.
	if (targetIdx < 0) return { cell: toHandle(id), depends_on: [], dependents: [] };

	const { directUpstream } = buildDefinerGraph(codeCells, dataflow);

	// depends_on: the direct upstream, in document order, visible cells only.
	const depends_on = [...directUpstream[targetIdx]]
		.sort((a, b) => a - b)
		.filter((j) => !codeCells[j].hidden)
		.map((j) => toHandle(codeCells[j].id));

	// dependents: transitive downstream. Reverse the upstream edges (j ∈ upstream[i]
	// ⇒ i is a dependent of j), then BFS from the target. The graph is acyclic
	// (upstream indices are always < the cell's own, i.e. earlier in the document),
	// so this always terminates; `seen` is belt-and-suspenders. Traversal passes
	// THROUGH hidden cells so a dependent behind a hidden one still surfaces; only
	// the emitted list excludes hidden cells.
	const downstream: Set<number>[] = codeCells.map(() => new Set<number>());
	directUpstream.forEach((ups, i) => {
		for (const j of ups) downstream[j].add(i);
	});
	const seen = new Set<number>([targetIdx]);
	const found = new Set<number>();
	const queue = [targetIdx];
	while (queue.length) {
		const i = queue.shift()!;
		for (const d of downstream[i]) {
			if (seen.has(d)) continue;
			seen.add(d);
			found.add(d);
			queue.push(d);
		}
	}
	const dependents = [...found]
		.sort((a, b) => a - b)
		.filter((j) => !codeCells[j].hidden)
		.map((j) => toHandle(codeCells[j].id));

	return { cell: toHandle(id), depends_on, dependents };
}
