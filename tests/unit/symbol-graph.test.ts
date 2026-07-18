/**
 * The extracted definer graph (`$lib/symbolGraph`) + the `find_symbol` resolver.
 *
 * Two things are proven here:
 *  1. STALENESS PARITY — `computeStaleness` was refactored to consume the extracted
 *     `buildDefinerGraph` instead of an inline copy of the same logic. A verbatim
 *     copy of the OLD inline definer graph is kept below and asserted, over many
 *     fixtures, to produce the identical `directUpstream` the extraction returns —
 *     a byte-for-byte proof the extraction changed no behavior — and the public
 *     `computeStaleness` verdicts are pinned on the report scenario.
 *  2. FIND_SYMBOL — `resolveSymbol` returns the report §3.1 shape: definitions +
 *     references (each bound to its nearest preceding definer), forward-reference
 *     null binding, builtins/undefined names, redefinition/duplicates, hidden
 *     definers, and kernel reconciliation (live_definer / live_in_kernel).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildDefinerGraph, resolveSymbol, resolveImpact, type Dataflow, type SymbolCell, type ImpactCell } from '../../src/lib/symbolGraph';
import { computeStaleness, STALE_STATE } from '../../src/lib/staleness';
import type { Cell, SessionId } from '../../src/lib/server/types';

// --- fixtures ---------------------------------------------------------------

// The report §4.1 scenario, as the real PROBE reports it. Keep it that way: these
// are hand-written fixtures, so nothing here fails when the probe's output moves —
// which is exactly how they once "codified" a blind spot the probe had already
// stopped having. `dataflow-load-before-store.test.ts` spawns the real probe; the
// values below are copied from it.
//   c4 is `df = featurize(clean(df))` — a read-then-rebind. It USES df: the load
//   happens before this cell binds df, so it reads c2's. That edge is what the old
//   `uses = referenced − defined` rule dropped.
const SCENARIO: Dataflow = {
	c1: { defines: ['np', 'pd'], uses: [] },
	c2: { defines: ['df'], uses: ['pd'] },
	c3: { defines: ['clean', 'featurize'], uses: ['np'] },
	c4: { defines: ['df'], uses: ['clean', 'df', 'featurize'] },
	c5: { defines: ['flag', 'model'], uses: ['df'] },
	c6: { defines: [], uses: ['df', 'model', 'print'] },
	c7: { defines: ['df'], uses: ['pd'] }
};
const SCENARIO_IDS = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'];

const symCell = (id: string, over: Partial<SymbolCell> = {}): SymbolCell => ({
	id,
	cell_type: 'code',
	hidden: false,
	lastRunSession: null,
	...over
});
const symCells = (ids: string[]): SymbolCell[] => ids.map((id) => symCell(id));

// --- 1. staleness parity ----------------------------------------------------

/** A verbatim copy of the OLD inline definer graph from staleness.ts (pre-extraction). */
function oldDirectUpstream(codeCells: readonly { id: string }[], df: Dataflow): Set<number>[] {
	const definers = new Map<string, number[]>();
	codeCells.forEach((c, i) => {
		for (const name of df[c.id]?.defines ?? []) {
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
			else break;
		}
		return best;
	}
	return codeCells.map((c, i) => {
		const ups = new Set<number>();
		for (const name of df[c.id]?.uses ?? []) {
			const j = definerBefore(name, i);
			if (j >= 0) ups.add(j);
		}
		return ups;
	});
}

const upstreamEqual = (a: Set<number>[], b: Set<number>[]): boolean =>
	a.length === b.length && a.every((s, i) => s.size === b[i].size && [...s].every((x) => b[i].has(x)));

describe('buildDefinerGraph — staleness parity', () => {
	// A spread of shapes: redefinition, duplicates, forward refs, cross-cell chains,
	// self-reassignment, and empty/undefined dataflow entries.
	const fixtures: Array<{ name: string; ids: string[]; df: Dataflow }> = [
		{ name: 'report scenario', ids: SCENARIO_IDS, df: SCENARIO },
		{
			name: 'linear chain a->b->c',
			ids: ['a', 'b', 'c'],
			df: { a: { defines: ['x'], uses: [] }, b: { defines: ['y'], uses: ['x'] }, c: { defines: [], uses: ['y'] } }
		},
		{
			name: 'redefinition, nearest preceding wins',
			ids: ['a', 'b', 'c', 'd'],
			df: {
				a: { defines: ['x'], uses: [] },
				b: { defines: ['x'], uses: [] },
				c: { defines: [], uses: ['x'] }, // -> b, not a
				d: { defines: ['x'], uses: [] }
			}
		},
		{
			name: 'forward reference (use before any definer)',
			ids: ['a', 'b'],
			df: { a: { defines: [], uses: ['z'] }, b: { defines: ['z'], uses: [] } }
		},
		{
			// b is `df = f(df)`: it both defines df and uses the df a defined.
			name: 'self-reassignment (df = f(df)) reads its upstream',
			ids: ['a', 'b'],
			df: { a: { defines: ['df'], uses: [] }, b: { defines: ['df'], uses: ['df'] } }
		},
		{ name: 'empty + missing entries', ids: ['a', 'b', 'c'], df: { a: {}, b: { uses: ['q'] } } }
	];

	for (const { name, ids, df } of fixtures) {
		it(`directUpstream matches the old inline logic: ${name}`, () => {
			const codeCells = ids.map((id) => ({ id }));
			const { directUpstream } = buildDefinerGraph(codeCells, df);
			expect(upstreamEqual(directUpstream, oldDirectUpstream(codeCells, df))).toBe(true);
		});
	}

	it('definers + definerBefore resolve to the nearest preceding definer', () => {
		const { definers, definerBefore } = buildDefinerGraph(SCENARIO_IDS.map((id) => ({ id })), SCENARIO);
		expect(definers.get('df')).toEqual([1, 3, 6]); // c2, c4, c7
		expect(definerBefore('df', 4)).toBe(3); // c5's df -> c4
		expect(definerBefore('df', 5)).toBe(3); // c6's df -> c4
		expect(definerBefore('df', 1)).toBe(-1); // c2 itself: no preceding definer
		expect(definerBefore('missing', 3)).toBe(-1);
	});
});

// A staleness fixture cell (the rule reads only these fields).
const staleCell = (
	id: string,
	over: { type?: string; lastRun?: { session: SessionId | null; at: number }; editedAt?: number } = {}
): Cell =>
	({
		id,
		cell_type: over.type ?? 'code',
		source: '',
		metadata: { cellar: { ...(over.lastRun ? { lastRun: over.lastRun } : {}), ...(over.editedAt != null ? { editedAt: over.editedAt } : {}) } }
	}) as unknown as Cell;

describe('computeStaleness — verdicts unchanged after the extraction', () => {
	const SID: SessionId = 5;

	it('propagates staleness through the definer graph', () => {
		// All ran this session at t=100 except c3, which was re-run at t=200 -> c4 (uses
		// clean/featurize from c3) is stale, and c5, c6 (transitively downstream) too.
		const cells = SCENARIO_IDS.map((id) =>
			staleCell(id, { lastRun: { session: SID, at: id === 'c3' ? 200 : 100 } })
		);
		const map = computeStaleness(cells, SCENARIO, SID);
		expect(map.c1.state).toBe(STALE_STATE.FRESH);
		expect(map.c2.state).toBe(STALE_STATE.FRESH);
		expect(map.c3.state).toBe(STALE_STATE.FRESH);
		expect(map.c4.state).toBe(STALE_STATE.STALE); // c3 ran again after c4
		expect(map.c4.upstream).toContain('c3');
		expect(map.c5.state).toBe(STALE_STATE.STALE); // depends on stale c4
		expect(map.c6.state).toBe(STALE_STATE.STALE);
		expect(map.c7.state).toBe(STALE_STATE.FRESH); // only uses pd (c1), untouched
	});

	it('a self-edit stales the cell and its dependents; an unrun cell is not_run', () => {
		const cells = SCENARIO_IDS.map((id) => {
			if (id === 'c7') return staleCell(id); // never ran this session
			// c3 edited (t=300) after it last ran (t=100)
			return staleCell(id, { lastRun: { session: SID, at: 100 }, ...(id === 'c3' ? { editedAt: 300 } : {}) });
		});
		const map = computeStaleness(cells, SCENARIO, SID);
		expect(map.c3.state).toBe(STALE_STATE.STALE);
		expect(map.c3.self).toBe(true);
		expect(map.c4.state).toBe(STALE_STATE.STALE);
		expect(map.c7.state).toBe(STALE_STATE.NOT_RUN);
	});
});

// --- 2. find_symbol (resolveSymbol) -----------------------------------------

describe('resolveSymbol — the report §4.1 scenario', () => {
	it("find_symbol('df') -> all definers, uses bound to the nearest preceding definer", () => {
		const r = resolveSymbol({ name: 'df', cells: symCells(SCENARIO_IDS), dataflow: SCENARIO, sid: null, kernelNames: null });
		expect(r.symbol).toBe('df');
		expect(r.defined_in).toEqual(['c2', 'c4', 'c7']);
		expect(r.used_in).toEqual([
			// c4 both defines df and appears here: `df = featurize(clean(df))` really
			// does read df, and it binds to the nearest PRECEDING definer (c2), never
			// to itself.
			{ cell: 'c4', binds_to: 'c2' },
			{ cell: 'c5', binds_to: 'c4' },
			{ cell: 'c6', binds_to: 'c4' }
		]);
		expect(r.live_in_kernel).toBeUndefined(); // no kernel -> absent
		expect(r.live_definer).toBeUndefined();
		expect(r.hidden_definer).toBeUndefined();
	});

	it("find_symbol('clean') -> defined in c3, used by c4", () => {
		const r = resolveSymbol({ name: 'clean', cells: symCells(SCENARIO_IDS), dataflow: SCENARIO, sid: null, kernelNames: null });
		expect(r.defined_in).toEqual(['c3']);
		expect(r.used_in).toEqual([{ cell: 'c4', binds_to: 'c3' }]);
	});

	it("find_symbol('model') -> defined in c5, used by c6", () => {
		const r = resolveSymbol({ name: 'model', cells: symCells(SCENARIO_IDS), dataflow: SCENARIO, sid: null, kernelNames: null });
		expect(r.defined_in).toEqual(['c5']);
		expect(r.used_in).toEqual([{ cell: 'c6', binds_to: 'c5' }]);
	});

	it('a builtin (print) is a use with no definer', () => {
		const r = resolveSymbol({ name: 'print', cells: symCells(SCENARIO_IDS), dataflow: SCENARIO, sid: null, kernelNames: null });
		expect(r.defined_in).toEqual([]);
		expect(r.used_in).toEqual([{ cell: 'c6', binds_to: null }]);
	});

	it('an undefined/never-mentioned name -> empty def + refs', () => {
		const r = resolveSymbol({ name: 'nowhere', cells: symCells(SCENARIO_IDS), dataflow: SCENARIO, sid: null, kernelNames: null });
		expect(r.defined_in).toEqual([]);
		expect(r.used_in).toEqual([]);
	});
});

describe('resolveSymbol — edge cases', () => {
	it('a forward reference binds to null', () => {
		const df: Dataflow = { a: { defines: [], uses: ['z'] }, b: { defines: ['z'], uses: [] } };
		const r = resolveSymbol({ name: 'z', cells: symCells(['a', 'b']), dataflow: df, sid: null, kernelNames: null });
		expect(r.defined_in).toEqual(['b']);
		expect(r.used_in).toEqual([{ cell: 'a', binds_to: null }]); // used before defined
	});

	it('markdown cells never join the graph', () => {
		const cells = [symCell('m', { cell_type: 'markdown' }), ...symCells(['c2'])];
		const df: Dataflow = { c2: { defines: ['df'], uses: [] } };
		const r = resolveSymbol({ name: 'df', cells, dataflow: df, sid: null, kernelNames: null });
		expect(r.defined_in).toEqual(['c2']);
	});

	it('a hidden definer is flagged and its binding is suppressed to null', () => {
		const cells = symCells(SCENARIO_IDS).map((c) => (c.id === 'c4' ? { ...c, hidden: true } : c));
		const r = resolveSymbol({ name: 'df', cells, dataflow: SCENARIO, sid: null, kernelNames: null });
		expect(r.defined_in).toEqual(['c2', 'c7']); // c4 hidden, dropped from the report
		expect(r.hidden_definer).toBe(true);
		// c5/c6 bind to c4 (hidden) -> null, not a misleading visible id
		expect(r.used_in).toEqual([
			{ cell: 'c5', binds_to: null },
			{ cell: 'c6', binds_to: null }
		]);
	});

	it('a hidden USING cell is not reported', () => {
		const cells = symCells(SCENARIO_IDS).map((c) => (c.id === 'c6' ? { ...c, hidden: true } : c));
		const r = resolveSymbol({ name: 'df', cells, dataflow: SCENARIO, sid: null, kernelNames: null });
		// c6 hidden, gone; c4 remains — it reads df as well as defining it.
		expect(r.used_in).toEqual([
			{ cell: 'c4', binds_to: 'c2' },
			{ cell: 'c5', binds_to: 'c4' }
		]);
	});
});

describe('resolveSymbol — kernel reconciliation', () => {
	const SID: SessionId = 7;

	it('live_definer = the last visible definer whose value is live this session', () => {
		// c4 ran this session, c2 ran an older session, c7 never ran -> live is c4.
		const cells = symCells(SCENARIO_IDS).map((c) => {
			if (c.id === 'c2') return { ...c, lastRunSession: 3 };
			if (c.id === 'c4') return { ...c, lastRunSession: SID };
			return c;
		});
		const r = resolveSymbol({ name: 'df', cells, dataflow: SCENARIO, sid: SID, kernelNames: new Set(['df', 'pd']) });
		expect(r.live_definer).toBe('c4');
		expect(r.live_in_kernel).toBe(true);
	});

	it('live_in_kernel is false when the name is not in the namespace', () => {
		const r = resolveSymbol({ name: 'model', cells: symCells(SCENARIO_IDS), dataflow: SCENARIO, sid: SID, kernelNames: new Set(['df']) });
		expect(r.live_in_kernel).toBe(false);
	});

	it('no live definer -> live_definer absent even with a running kernel', () => {
		// The name is defined in source but nothing ran this session.
		const r = resolveSymbol({ name: 'df', cells: symCells(SCENARIO_IDS), dataflow: SCENARIO, sid: SID, kernelNames: new Set(['df']) });
		expect(r.live_definer).toBeUndefined();
		expect(r.live_in_kernel).toBe(true);
	});
});

// --- 3. cell_impact (resolveImpact) -----------------------------------------

const impactCell = (id: string, over: Partial<ImpactCell> = {}): ImpactCell => ({
	id,
	cell_type: 'code',
	hidden: false,
	...over
});
const impactCells = (ids: string[]): ImpactCell[] => ids.map((id) => impactCell(id));

/** The real server source; the registered description strings are read from it. */
const serverSrc = () =>
	readFileSync(new URL('../../src/lib/server/mcp/server.ts', import.meta.url), 'utf8');

/** The single `registerTool('<name>', …)` line — the description an agent is served. */
const descriptionOf = (tool: string): string => {
	const line = serverSrc()
		.split('\n')
		.find((l) => l.includes(`registerTool('${tool}'`));
	if (!line) throw new Error(`no registerTool('${tool}') line found`);
	return line;
};

describe('resolveImpact — the report §4.1 scenario', () => {
	it("cell_impact('c3') -> depends_on=[c1], dependents=[c4,c5,c6] (edit clean/featurize -> 3 stale)", () => {
		const r = resolveImpact({ id: 'c3', cells: impactCells(SCENARIO_IDS), dataflow: SCENARIO });
		expect(r.cell).toBe('c3');
		expect(r.depends_on).toEqual(['c1']); // c3 uses np, defined in c1
		expect(r.dependents).toEqual(['c4', 'c5', 'c6']); // clean/featurize -> c4 -> df -> c5, c6
	});

	it("cell_impact('c2') -> dependents=[c4,c5,c6] through the self-reassignment in c4", () => {
		// The graph-level statement of the fix. c2 defines df; c4 is
		// `df = featurize(clean(df))`, which READS c2's df before rebinding it. That
		// read used to be masked (`uses = referenced − defined`), so this asserted
		// dependents=[] — editing c2 flagged NOTHING, and the notebook reported itself
		// in sync while c4/c5/c6 held values computed from the old df. The chain now
		// resolves: c2 -> c4 (df) -> c5/c6.
		const r = resolveImpact({ id: 'c2', cells: impactCells(SCENARIO_IDS), dataflow: SCENARIO });
		expect(r.depends_on).toEqual(['c1']); // c2 uses pd, defined in c1
		expect(r.dependents).toEqual(['c4', 'c5', 'c6']);
	});

	it('the cell_impact description warns about the under-report it still has', () => {
		// The honesty the tool ships on: its registered description must point at the
		// under-report and must address stale_state - which is NOT a backstop for it
		// (same static graph + timestamps, so it under-reports identically). The named
		// cause moves as the graph improves; that it names a REAL one must not.
		const line = descriptionOf('cell_impact');
		expect(line).toBeTruthy();
		expect(line).toMatch(/conditional bind|exec\/globals/);
		expect(line).toMatch(/under-report/i);
		expect(line).toMatch(/stale_state/);
	});

	it('NO tool description promises stale_state as a RUNTIME backstop (the false claim)', () => {
		// Regression guard for the docs fix. stale_state is computeStaleness(cells,
		// dataflow, sid) - the SAME static graph these tools use, plus lastRun
		// timestamps, which carry {at,durationMs,actor,status,session} and NO name
		// sets. So it can never "catch at run time" what the graph missed; the two
		// tests above prove that behaviourally. The prior wording ("the authoritative
		// post-hoc signal (it catches this at run time)") told an agent to trust a
		// signal that under-reports identically - the exact trap this must not regress
		// into. Scoped to the tool DESCRIPTIONS: that string is what reaches the agent.
		const descs = serverSrc().split('\n').filter((l) => l.includes('server.registerTool('));
		expect(descs.length).toBeGreaterThan(0);
		for (const line of descs) {
			expect(line).not.toMatch(/authoritative post-hoc signal/i);
			// The honest text legitimately reads "NOTHING catches this at run time",
			// so match the CLAIM (stale_state doing the catching), not the phrase.
			expect(line).not.toMatch(/(?<!NOTHING )\bit catches this at run time/i);
		}
	});

	it('cell_impact states the under-report is NOT caught at run time, and says what to do', () => {
		const line = descriptionOf('cell_impact');
		expect(line).toMatch(/NOTHING catches this at run time/i); // no false backstop
		expect(line).toMatch(/SAME static graph plus run timestamps/i); // what stale_state IS
		expect(line).toMatch(/never inspects the kernel namespace/i); // why it can't catch it
		expect(line).toMatch(/conditional bind/i); // a real remaining cause, named concretely
		expect(line).toMatch(/re-run the downstream cells yourself/i); // the actionable remedy
	});

	it('find_symbol no longer defers to stale_state as the backstop', () => {
		const line = descriptionOf('find_symbol');
		// The old trailing pointer: "For whether a change makes dependents out of
		// date, see get_notebook_map stale_state."
		expect(line).not.toMatch(/see get_notebook_map stale_state/i);
		expect(line).toMatch(/SAME static graph plus run timestamps/i);
		expect(line).toMatch(/treat none of the three as a runtime check of the kernel/i);
		expect(line).toMatch(/conditional bind/i); // a real remaining cause, named concretely
	});

	// Read-then-rebind (df = f(df), x = x + 10, count += 1) is FIXED by the
	// load-before-store walk in dataflow.ts. The agent-facing text must not keep
	// naming it as a limit: an agent told a fixed shape is broken re-runs cells it
	// need not, and an inaccurate limits list is what makes the accurate half ignorable.
	it('no agent-facing text still claims read-then-rebind is a limitation', () => {
		for (const name of ['cell_impact', 'find_symbol', 'get_notebook_map']) {
			const line = descriptionOf(name);
			expect(line, name).not.toMatch(/read-then-rebind|rebinds/i);
			expect(line, name).not.toMatch(/df = f\(df\)|count \+= 1/i);
		}
		expect(serverSrc()).not.toMatch(/reads a name it also\s+rebinds/i); // INSTRUCTIONS
	});
});

describe('resolveImpact — transitivity, order, cycles', () => {
	it('a multi-hop chain a->b->c->d flows transitively downstream in document order', () => {
		const df: Dataflow = {
			a: { defines: ['x'], uses: [] },
			b: { defines: ['y'], uses: ['x'] },
			c: { defines: ['z'], uses: ['y'] },
			d: { defines: [], uses: ['z'] }
		};
		const cells = impactCells(['a', 'b', 'c', 'd']);
		expect(resolveImpact({ id: 'a', cells, dataflow: df }).dependents).toEqual(['b', 'c', 'd']);
		expect(resolveImpact({ id: 'b', cells, dataflow: df }).dependents).toEqual(['c', 'd']);
		expect(resolveImpact({ id: 'd', cells, dataflow: df }).dependents).toEqual([]); // leaf
		expect(resolveImpact({ id: 'c', cells, dataflow: df }).depends_on).toEqual(['b']); // nearest definer of y
	});

	it('a diamond a->{b,c}->d reports each dependent once, in document order', () => {
		const df: Dataflow = {
			a: { defines: ['x'], uses: [] },
			b: { defines: ['y'], uses: ['x'] },
			c: { defines: ['w'], uses: ['x'] },
			d: { defines: [], uses: ['y', 'w'] }
		};
		const cells = impactCells(['a', 'b', 'c', 'd']);
		const r = resolveImpact({ id: 'a', cells, dataflow: df });
		expect(r.dependents).toEqual(['b', 'c', 'd']); // d reached via both b and c, listed once
		expect(resolveImpact({ id: 'd', cells, dataflow: df }).depends_on).toEqual(['b', 'c']);
	});

	it('redefinition does not create a false downstream edge past the new definer', () => {
		// c uses x -> binds to b (nearest preceding), so a's only dependent is b's
		// definer chain; a re-defined-then-used name does not make a a dependency of c.
		const df: Dataflow = {
			a: { defines: ['x'], uses: [] },
			b: { defines: ['x'], uses: [] },
			c: { defines: [], uses: ['x'] } // -> b
		};
		const cells = impactCells(['a', 'b', 'c']);
		expect(resolveImpact({ id: 'a', cells, dataflow: df }).dependents).toEqual([]); // c binds to b, not a
		expect(resolveImpact({ id: 'b', cells, dataflow: df }).dependents).toEqual(['c']);
	});

	it('a markdown / unknown / non-code target yields empty lists (never throws)', () => {
		const cells = [impactCell('m', { cell_type: 'markdown' }), ...impactCells(SCENARIO_IDS)];
		expect(resolveImpact({ id: 'm', cells, dataflow: SCENARIO })).toEqual({ cell: 'm', depends_on: [], dependents: [] });
		expect(resolveImpact({ id: 'nope', cells, dataflow: SCENARIO })).toEqual({ cell: 'nope', depends_on: [], dependents: [] });
	});
});

describe('resolveImpact — hidden cells', () => {
	it('traverses THROUGH a hidden intermediary but never reports it', () => {
		// a -> b(hidden) -> c: editing a still stales c, but b is suppressed.
		const df: Dataflow = {
			a: { defines: ['x'], uses: [] },
			b: { defines: ['y'], uses: ['x'] },
			c: { defines: [], uses: ['y'] }
		};
		const cells = [impactCell('a'), impactCell('b', { hidden: true }), impactCell('c')];
		const r = resolveImpact({ id: 'a', cells, dataflow: df });
		expect(r.dependents).toEqual(['c']); // b hidden, dropped; c still surfaces via b
	});

	it('a hidden direct dependency is excluded from depends_on', () => {
		const df: Dataflow = { a: { defines: ['x'], uses: [] }, b: { defines: [], uses: ['x'] } };
		const cells = [impactCell('a', { hidden: true }), impactCell('b')];
		expect(resolveImpact({ id: 'b', cells, dataflow: df }).depends_on).toEqual([]); // a hidden
	});
});
