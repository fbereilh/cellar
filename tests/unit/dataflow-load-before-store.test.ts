/**
 * Dataflow probe — LOAD-BEFORE-STORE at module scope.
 *
 * THE REGRESSION GUARD for a High-severity staleness bug, and for the over-report
 * that a first attempt at fixing it caused. The probe's job is to answer "does this
 * cell read a name an EARLIER cell defined?", which is a question about ORDER.
 * `symtable` cannot express order — it reports only that a name is referenced
 * somewhere in a scope and assigned somewhere in it — so both of the rules available
 * to it are wrong, in opposite directions:
 *
 *   `uses = referenced − defined` (what shipped): drops the read in `x = x + 10`
 *   entirely. No edge, so editing `x = 1` → `x = 100` left `x = x + 10` marked
 *   FRESH, `run_stale` skipped it, and the notebook claimed to be in sync while the
 *   correct value was 110, the kernel held 100, and the screen showed 11.
 *
 *   `uses = referenced` (the rejected fix): rescues that, but gives
 *   `df = pd.read_csv(f); df.head()` — the most common shape in any notebook — an
 *   edge to EVERY earlier cell that assigned `df`. Because `staleness.ts`'s
 *   `upstream_unrun` depends only on the upstream's run state and `run_stale` only
 *   re-runs cells already stale, that chip is permanent and uncleanable.
 *
 * Load-before-store answers both: walk module scope IN ORDER, and a `Load` of a name
 * this cell has not yet bound is a use. So the two halves of this file are ONE
 * contract — the positives (a real upstream read is recorded) and the negatives (a
 * cell reading its own binding records nothing) fail in opposite directions, and a
 * rule that satisfies only one of them is not a fix.
 *
 * These tests spawn the REAL probe. No hand-written dataflow fixtures: that is the
 * mistake that let `symbol-graph.test.ts` "codify" this gap while never executing it,
 * so it kept passing while describing a reality the probe did not produce. `uses` is
 * asserted EXACTLY — `toContain`/`arrayContaining` is additive, so it cannot catch a
 * spurious extra use, which is precisely the failure mode being guarded against.
 */
import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import type { CellView } from '../../src/lib/server/types';

// The probe spawns `projectPython() || 'python3'`; null ⇒ the real python3. `ast` and
// `symtable` are both stdlib, so this needs no venv and no package. Mutable (via
// vi.hoisted, so it exists before the hoisted vi.mock factory runs) so the degradation
// tests can point the probe at an interpreter that cannot spawn.
const py = vi.hoisted(() => ({ path: null as string | null }));
vi.mock('../../src/lib/server/databricks', () => ({ projectPython: () => py.path }));

// Imported AFTER the mock is registered (vitest hoists vi.mock above imports).
import { analyzeDataflow } from '../../src/lib/server/dataflow';

const cell = (id: string, source: string): CellView =>
	({ id, cell_type: 'code', source, metadata: {}, outputs: [] }) as unknown as CellView;

/** Run the real probe over one source and return its `{defines, uses}`. */
async function analyze(source: string) {
	const df = await analyzeDataflow([cell('probe', source)]);
	return df.probe;
}

/** The interpreter the probe will actually spawn — `match` needs 3.10+ to parse. */
const pyMinor = (() => {
	try {
		return Number(execFileSync('python3', ['-c', 'import sys; print(sys.version_info[1])']).toString().trim());
	} catch {
		return 0;
	}
})();

describe('dataflow probe — a read BEFORE the cell binds the name is a use', () => {
	it('x = x + 10 records the read of the upstream x (THE bug)', async () => {
		// The exact repro. uses:[] here is the bug; uses:['x'] is the fix.
		expect(await analyze('x = x + 10')).toEqual({ defines: ['x'], uses: ['x'] });
	});

	it('df = df.assign(...) records the read of df (mainline pandas)', async () => {
		expect(await analyze('df = df.assign(b=1)')).toEqual({ defines: ['df'], uses: ['df'] });
	});

	it('count += 1 records the read (AugAssign — symtable reports is_referenced()==False)', async () => {
		// symtable is simply wrong here: you cannot add to something without reading
		// it. Unreachable via symtable at all, which is why this needs the ast walk.
		expect(await analyze('count += 1')).toEqual({ defines: ['count'], uses: ['count'] });
	});

	it('an augmented assign through an attribute/subscript reads the container', async () => {
		expect(await analyze('obj.hits += 1')).toEqual({ defines: [], uses: ['obj'] });
		expect(await analyze('tally[k] += 1')).toEqual({ defines: [], uses: ['k', 'tally'] });
	});

	it('a use BEFORE the cell rebinds the name is recorded (order, not membership)', async () => {
		// The clearest statement of the rule: same name, same cell, both a load and a
		// store — and the load comes first, so it can only have come from upstream.
		expect(await analyze('print(z)\nz = 1')).toEqual({ defines: ['z'], uses: ['print', 'z'] });
	});

	it('an accumulator with no initializer reads its upstream', async () => {
		expect(await analyze('for i in range(3):\n    total = total + i')).toEqual({
			defines: ['i', 'total'],
			uses: ['range', 'total']
		});
	});

	it('a BARE annotation neither binds nor defines, so a later read IS upstream', async () => {
		// `x: int` only records an annotation — at runtime it binds nothing, so the
		// read below can only resolve to an earlier cell's x (else it is a NameError).
		// The annotation itself evaluates at module scope, hence the load of `int`
		// (a builtin, so nothing DEFINES it and it never resolves to an upstream cell).
		// x is absent from `defines` too: symtable's is_assigned() says otherwise, but
		// letting an annotation-only cell claim the define would shadow the cell that
		// really assigns x, leaving its readers falsely fresh when that cell is edited.
		expect(await analyze('x: int\nprint(x)')).toEqual({ defines: [], uses: ['int', 'print', 'x'] });
	});

	it('a bare annotation the same cell later assigns still defines the name', async () => {
		// Only an annotation-ONLY name is dropped: the assignment below really binds x.
		expect(await analyze('x: int\nx = 5')).toEqual({ defines: ['x'], uses: ['int'] });
	});

	it('an annotated assignment DOES bind, so the later read is its own', async () => {
		expect(await analyze('x: int = 1\nprint(x)')).toEqual({ defines: ['x'], uses: ['int', 'print'] });
	});

	it('a bare annotation does not satisfy a deferred body reading the name', async () => {
		// The nested half reads `used_nested - defines`, so dropping the phantom define
		// is what keeps `f`'s read of x pointed at the cell that actually assigns it.
		expect(await analyze('x: int\ndef f():\n    return x')).toEqual({ defines: ['f'], uses: ['int', 'x'] });
	});

	it('an annotation through an attribute/subscript reads the container', async () => {
		expect(await analyze('obj.total: int')).toEqual({ defines: [], uses: ['int', 'obj'] });
		expect(await analyze('d[k]: int')).toEqual({ defines: [], uses: ['d', 'int', 'k'] });
	});
});

describe('dataflow probe — a read AFTER the cell binds the name is NOT a use', () => {
	it('df = pd.read_csv(...); df.head() does not depend on an earlier df', async () => {
		// THE over-report that sank the previous attempt. `df` is bound by this cell
		// before it is read, so an earlier `df = ...` cell is not its upstream. An
		// edge here made every such cell permanently, uncleanably stale.
		expect(await analyze("df = pd.read_csv('b.csv')\ndf.head()")).toEqual({
			defines: ['df'],
			uses: ['pd']
		});
	});

	it('fig, ax = plt.subplots(); ax.plot(...) does not depend on an earlier ax', async () => {
		expect(await analyze('fig, ax = plt.subplots()\nax.plot(series)')).toEqual({
			defines: ['ax', 'fig'],
			uses: ['plt', 'series']
		});
	});

	it('a loop variable is bound by the loop, not read from upstream', async () => {
		expect(await analyze('for i in range(3):\n    print(i)')).toEqual({
			defines: ['i'],
			uses: ['print', 'range']
		});
	});

	it('except ... as e binds e for the handler body', async () => {
		// `e` is a bare identifier on the handler, not a Name node — it binds only
		// because the walk handles ExceptHandler explicitly.
		expect(await analyze('try:\n    pass\nexcept ValueError as e:\n    print(e)')).toEqual({
			defines: ['e'],
			uses: ['ValueError', 'print']
		});
	});

	it('with open(p) as fh binds fh for the body', async () => {
		expect(await analyze('with open(p) as fh:\n    data = fh.read()')).toEqual({
			defines: ['data', 'fh'],
			uses: ['open', 'p']
		});
	});

	it('a self-contained accumulator reads nothing upstream', async () => {
		// `total` is initialized before the loop reads it. The rejected fix could not
		// tell this from `x = x + 10` and gave it a spurious edge to any earlier `total`.
		expect(await analyze('total = 0\nfor i in range(3):\n    total = total + i')).toEqual({
			defines: ['i', 'total'],
			uses: ['range']
		});
	});

	it('a comprehension target does not leak out of the comprehension', async () => {
		// Bound in a scratch scope and rolled back: `q` must neither be reported as a
		// use inside, nor shadow a module-scope read of `q` after.
		const r = await analyze('res = [q for q in items]');
		expect(r.uses).toEqual(['items']);
		expect(await analyze('[q for q in items]\nprint(q)')).toMatchObject({
			uses: ['items', 'print', 'q']
		});
	});

	it('a walrus inside a comprehension DOES leak out, so the later read is its own', async () => {
		// The exception to the rollback above: a NamedExpr binds in the ENCLOSING
		// scope. Rolling `y` back would report a use of y — an edge to every earlier
		// cell assigning y — the over-report direction this whole rule exists to avoid.
		// (`y` is absent from `defines` because symtable reports it not-assigned in the
		// module table; that half is symtable's and is unchanged here.)
		expect(await analyze('rows = [(y := f(i)) for i in xs]\nprint(y)')).toEqual({
			defines: ['rows'],
			uses: ['f', 'print', 'xs']
		});
	});

	it("a nested comprehension's walrus keeps leaking outward to module scope", async () => {
		expect(await analyze('m = [[(w := g(j)) for j in row] for row in grid]\nprint(w)')).toEqual({
			defines: ['m'],
			uses: ['g', 'grid', 'print']
		});
	});

	it.skipIf(pyMinor < 10)('a match capture pattern binds its name', async () => {
		// MatchAs/MatchStar/MatchMapping carry plain identifier strings, not Name
		// nodes, so a generic walk would report the capture as an unbound read.
		expect(await analyze('match cmd:\n    case {"k": v}:\n        print(v)')).toEqual({
			defines: ['v'],
			uses: ['cmd', 'print']
		});
		expect(await analyze('match cmd:\n    case [a, b]:\n        print(a)')).toEqual({
			defines: ['a', 'b'],
			uses: ['cmd', 'print']
		});
	});
});

describe('dataflow probe — nested scopes stay order-INSENSITIVE (deferred bodies)', () => {
	// A function body runs at CALL time, after the whole cell has executed, so
	// "bound so far" for it is "bound anywhere in this cell" — not "bound above the
	// def". This half is symtable's, and load-before-store must not disturb it.

	it('def f(): return pd.x depends on whatever imported pd', async () => {
		// The load is BELOW nothing and the reference never surfaces in the module
		// symbol table at all. A module-scope-only ast walk would lose this.
		expect(await analyze('def f():\n    return pd.x')).toEqual({ defines: ['f'], uses: ['pd'] });
	});

	it('a cell that imports pd itself gains no edge from its own function body', async () => {
		expect(await analyze('import pandas as pd\ndef f():\n    return pd.x')).toEqual({
			defines: ['f', 'pd'],
			uses: []
		});
	});

	it('a def BELOW the body that reads it still counts as bound (deferred, not ordered)', async () => {
		// `helper` is called in `main`'s body but defined after it. At call time both
		// exist, so this is not an upstream read — proof the nested half is not
		// subject to the module-scope ordering rule.
		expect(await analyze('def main():\n    return helper()\ndef helper():\n    return 1')).toEqual({
			defines: ['helper', 'main'],
			uses: []
		});
	});

	it('a recursive function gains no self-edge', async () => {
		expect(await analyze('def fact(n):\n    return n * fact(n - 1)')).toEqual({
			defines: ['fact'],
			uses: []
		});
	});

	it("a closure's free variable is not a use (it can never be another cell's define)", async () => {
		expect(await analyze('def outer():\n    v = 1\n    def inner():\n        return v\n    return inner')).toEqual({
			defines: ['outer'],
			uses: []
		});
	});

	it('a lambda body reads module globals', async () => {
		expect(await analyze('f = lambda: pd.x')).toEqual({ defines: ['f'], uses: ['pd'] });
	});

	it('a class body reads a global, but not one the same cell defines', async () => {
		expect(await analyze('class C:\n    v = CONST')).toEqual({ defines: ['C'], uses: ['CONST'] });
		expect(await analyze('CONST = 5\nclass C:\n    v = CONST')).toEqual({
			defines: ['C', 'CONST'],
			uses: []
		});
	});

	it('decorators, defaults and annotations DO evaluate at module scope', async () => {
		// These are the parts of a def that run when the def runs, so they are the
		// ast walk's business even though the body is not.
		expect(await analyze('@register\ndef f(limit=DEFAULT_LIMIT):\n    return 1')).toEqual({
			defines: ['f'],
			uses: ['DEFAULT_LIMIT', 'register']
		});
	});
});

describe('dataflow probe — degradation', () => {
	it('a cell mid-edit (SyntaxError) reports empty, never throws', async () => {
		expect(await analyze('df = pd.read_csv(')).toEqual({ defines: [], uses: [] });
	});

	it('one unparseable cell does not poison its neighbours in the same batch', async () => {
		const df = await analyzeDataflow([cell('bad', 'def ('), cell('good', 'y = x + 1')]);
		expect(df.bad).toEqual({ defines: [], uses: [] });
		expect(df.good).toEqual({ defines: ['y'], uses: ['x'] });
	});

	it('a FAILED probe run is not cached, so the next pass re-analyzes', async () => {
		// The sticky-wrong-verdict trap: a run that never happened (no interpreter,
		// timeout, ok:false) yields no edges, and no edges reads as `fresh` for every
		// cell. Caching that serves a false "everything is in sync" until LRU eviction,
		// long after the interpreter is healthy again — so only an answer the probe
		// actually produced may be cached.
		const src = 'w = v + 1';
		py.path = '/nonexistent/python-that-cannot-spawn';
		expect(await analyze(src)).toEqual({ defines: [], uses: [] });

		py.path = null; // interpreter healthy again
		expect(await analyze(src)).toEqual({ defines: ['w'], uses: ['v'] });
	});
});
