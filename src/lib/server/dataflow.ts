/**
 * Cellar — dataflow analysis (which names each cell DEFINES / USES).
 *
 * Feeds the staleness rule (`$lib/staleness.js`): B depends on A when B uses a
 * name A defines, so knowing each cell's defined + free names is enough to build
 * the per-notebook dependency graph.
 *
 * WHY A PYTHON SUBPROCESS, NOT A REGEX AND NOT THE KERNEL.
 *  - Regex cannot tell a module-level binding from a parameter, a comprehension
 *    variable, or a name inside a string, so it would invent dependencies. We need
 *    real order + scope analysis, which Python's own `ast` and `symtable` give for
 *    free (see the `PROBE` header for why the analysis needs BOTH).
 *  - The kernel is the wrong place for the same reasons `imports.js` avoids it: it
 *    would force-boot a kernel Cellar deliberately never boots on its own, queue
 *    behind a running cell, and make a purely static analysis depend on the
 *    runtime. Staleness must be computable with no kernel at all (a cell is simply
 *    "not run" then). So we shell out to the project interpreter, exactly like
 *    `databricks.js` does for its SDK calls. `ast` and `symtable` are both stdlib, so
 *    any Python 3 works — no package, and no dependency on the venv being set up.
 *
 * MAGIC-AWARE. A cell holding an IPython magic (`%%time`, `%matplotlib inline`,
 * `!pip …`) is not valid Python, so before analysis each cell's source is run
 * through `normalizeForAnalysis` (`magics.ts`): a Python-body cell magic
 * (`%%time\ndf = load()`) has its header stripped so `df` still registers as a
 * define; a non-Python cell magic (`%%bash`) yields no Python to analyze; line
 * magics / shell escapes are blanked so the surrounding Python still parses. The
 * cache is keyed by the ORIGINAL source, so identical cells still share a result.
 *
 * SQL-AWARE. A SQL cell is a `code` cell whose source is SQL, so it stays OUT of
 * the probe entirely (`ast` would misparse it) and gets a SYNTHETIC
 * contribution instead: `defines` is exactly the names `sql.ts` compiles the cell
 * to bind (`parseSqlCell().resultVars` - the `-- >> name` prefix line's name plus
 * the `_sql_df` alias, else `_sql_df` alone), so a Python cell reading a SQL result
 * gets its upstream edge and goes stale when the query is edited. `uses` stays
 * empty: reading table names out of SQL is lineage analysis, deliberately out of
 * scope, so a SQL cell is a graph SOURCE.
 *
 * IMPORT-BINDING SUBSET. Each entry also carries `imports`: the subset of `defines`
 * bound by a module-level import, which `staleness.js` uses to transmit change only
 * along the edges whose names could actually have moved (see `importBindings.ts`).
 * It is computed HERE, in JS, by the tokenizer rather than by the probe - it is a
 * tokenizer question, the probe is already the expensive part, and it must keep
 * working when the probe cannot run (its own `importCache`, so a probe failure or
 * backoff never costs it). An UNAVAILABLE cell has empty `defines`, hence no edges,
 * hence no exemption, so the backoff design's conservative-stale is unchanged. The
 * one gate is notebook-wide: `%autoreload` makes re-executing an import NON-idempotent
 * and arming it is a KERNEL-global act, so if ANY code cell mentions it, `imports` is
 * omitted for EVERY cell and no edge anywhere is exempt.
 *
 * The probe never raises: EVERY cell is analyzed behind its own catch-all, so a cell
 * that does not parse (it is mid-edit) — or one whose shape the walk mishandles — is
 * reported with empty defines/uses and degrades ALONE, rather than failing the whole
 * notebook's analysis. If no interpreter can be found or the process dies,
 * `analyzeDataflow` degrades to an empty map — staleness then still reports "not run"
 * and self-edit staleness (neither needs the graph), just not cross-cell dependency
 * staleness.
 *
 * Results are cached by source string, so an edit re-analyzes only the changed
 * cell and a run (no source change) re-analyzes nothing. ONLY a batch the probe
 * actually answered is cached: a failed run (no interpreter, timeout, `ok:false`)
 * returns empty entries for that pass WITHOUT writing them, because caching them
 * would serve a sticky, wrong "everything fresh" verdict until LRU eviction.
 *
 * TIMEOUT BACKOFF - why a failed batch must not simply re-spawn every pass.
 * Not caching a timed-out batch (above) is correct for a false-`fresh` but, on its
 * own, is a CPU trap: a notebook whose analysis genuinely exceeds `PROBE_TIMEOUT_MS`
 * (a big / pathological notebook) times out, caches nothing, and the next debounced
 * staleness pass (load, run-end, edit, structural change) resubmits the IDENTICAL
 * batch - which is deterministic, so it burns another ~10s and is SIGKILLed again,
 * forever, pinning a core with no convergence. So a timed-out batch is recorded in a
 * `backoff` store keyed by the batch's source signature and is NOT re-probed until an
 * exponential window elapses (capped) OR the batch actually changes (a real edit adds
 * / removes / rewrites a source ⇒ new signature ⇒ immediate re-probe). While backed
 * off (and only then), the batch's cells are reported UNAVAILABLE, which `staleness.js`
 * renders as a conservative `stale` - never a false `fresh` (the invariant this whole
 * file guards). ONLY a timed-out / backed-off batch is UNAVAILABLE: a NON-timeout
 * failure (missing interpreter, spawn error, probe crash/parse failure) is a DIFFERENT
 * case - it returns immediately (no CPU burn), may resolve once the venv is set up, so
 * it is deliberately NOT backed off AND NOT reported unavailable; those cells degrade to
 * empty dataflow (read as `fresh`) exactly as before this backoff existed, so nothing is
 * broadened. A single in-flight probe per batch signature is enforced too, so concurrent
 * UI+MCP staleness passes fold into one subprocess.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { currentSessionId } from './kernel';
import { listCells } from './notebook';
import { projectPython } from './databricks';
import { computeStaleness } from '../staleness';
import { isSqlCell } from '../cellLanguage';
import { hasAutoreloadMagic, normalizeForAnalysis } from './magics';
import { parseSqlCell } from './sql';
import { importBindingNames } from './importBindings';
import { LruCache } from './lru';
import type { CellView, SessionId } from './types';

/** The names a cell binds at module scope, and the module globals it reads. */
interface DataflowEntry {
	defines: string[];
	uses: string[];
	/**
	 * The subset of `defines` bound by a MODULE-LEVEL import, so their values are a
	 * pure function of the import statement (see `importBindings.ts`). Computed in
	 * JS, NOT by the probe: it is a tokenizer question, the probe is already the
	 * expensive part, and staleness must keep working when the probe cannot run.
	 */
	imports?: string[];
}

/** Per-cell dataflow, keyed by cell id (or source string in the cache). */
type DataflowMap = Record<string, DataflowEntry>;

/** The single `SENTINEL`-prefixed JSON line the `ast` + `symtable` probe prints. */
interface ProbeResult {
	ok: boolean;
	cells: DataflowMap;
	message?: string;
}

/**
 * One probe run's outcome. `ok` is EXPLICIT, never inferred from `cells` being empty:
 * a batch the probe genuinely answered with no dataflow is cacheable, a batch it never
 * ran is not, and the two are indistinguishable by shape alone.
 */
interface ProbeRun {
	ok: boolean;
	cells: DataflowMap;
}

/** One item submitted to the probe: a stable cache key + the source to analyze. */
interface ProbeItem {
	key: string;
	source: string;
}

const SENTINEL = '__CELLAR_DF__';

/**
 * A positive integer from `process.env[name]`, else `def`. Read per-call (not a
 * load-time const) so tests and ops can retune the knobs without re-importing -
 * the same pattern `kernel.ts` uses for its timeouts.
 */
function envInt(name: string, def: number): number {
	const v = process.env[name];
	const n = v == null || v === '' ? NaN : Number(v);
	return Number.isFinite(n) && n > 0 ? n : def;
}

/** How long a single probe subprocess may run before it is SIGKILLed. */
const probeTimeoutMs = (): number => envInt('CELLAR_DATAFLOW_PROBE_TIMEOUT_MS', 10000);
/** First backoff window after a batch times out; doubles per consecutive timeout. */
const backoffBaseMs = (): number => envInt('CELLAR_DATAFLOW_BACKOFF_BASE_MS', 30000);
/** Ceiling on the backoff window, so a persistently-slow notebook still re-probes rarely. */
const backoffMaxMs = (): number => envInt('CELLAR_DATAFLOW_BACKOFF_MAX_MS', 300000);

/**
 * Per submitted cell: an `ast` walk for module scope + one `symtable` pass for
 * nested scopes.
 *
 *   DEFINES — a name assigned or imported at MODULE scope (a def/class binds its
 *   name in the enclosing scope, so those count as assigned). From `symtable`, MINUS
 *   any name the cell only ever ANNOTATES (`x: int` with no value) and never binds:
 *   `symtable`'s `is_assigned()` is True for that, but at runtime it binds nothing, so
 *   calling it a define lets an annotation-only cell shadow the real definer and leave
 *   a later reader falsely `fresh`. The walk below is what knows the difference.
 *
 *   USES — a name the cell reads that some EARLIER cell must have defined.
 *
 * WHY AN `ast` WALK AND NOT `symtable` ALONE. The question "is this read another
 * cell's value?" is a question about ORDER, and `symtable` cannot express order. It
 * reports only that a name is referenced *somewhere* in a scope and assigned
 * *somewhere* in it — never which came first. So the two shapes below are
 * indistinguishable to it, while being exact opposites to us:
 *
 *     x = x + 10                 # x is LOADED BEFORE this cell bound it → upstream read
 *     df = pd.read_csv(f); df.head()   # df is bound HERE first → reads its own, no edge
 *
 * That forced a lose-lose choice. Subtracting assigned names (`uses = referenced -
 * defined`, what this was) drops the `x = x + 10` read entirely: no edge, so editing
 * the upstream cell left this one reported `fresh` while its output was already
 * wrong. Counting every reference instead over-reports the `df = read(); df.head()`
 * idiom — the single most common shape in any notebook — giving it an edge to every
 * earlier cell that assigned `df`, and since `staleness.ts`'s `upstream_unrun`
 * depends on the upstream's run state while `run_stale` only re-runs cells already
 * `stale`, that chip is permanent and uncleanable. A stale marker nobody can clear
 * teaches people to ignore staleness altogether.
 *
 * LOAD-BEFORE-STORE resolves both. Walk module-scope statements IN ORDER, tracking
 * the names bound so far in this cell; a `Load` of a name not yet bound here is a
 * use, a `Load` of one already bound is not. This also reaches what `symtable`
 * structurally could not: `count += 1` (`AugAssign`), whose target `symtable`
 * reports `is_referenced() == False` for — plainly wrong, since you cannot add to
 * something without reading it. The walk handles it explicitly as load-then-store.
 *
 * Evaluation order, not field order, drives the walk: `Assign._fields` is
 * (targets, value) but the RHS is evaluated first, and `For` evaluates `iter`
 * before binding `target`. Each such node is handled explicitly; everything else
 * falls back to `ast.iter_child_nodes`, whose order is evaluation order.
 *
 * THE RULE FOR NESTED SCOPES — order-INSENSITIVE, and still `symtable`'s job. A
 * function/lambda body is DEFERRED: it runs at call time, after the whole cell has
 * executed. So "bound so far" for a deferred body is "bound anywhere in this cell",
 * not "bound above the def" — which is exactly `used_nested - defines`, the rule
 * that was already here and is kept verbatim. It is what makes `def f(): return pd.x`
 * a use of `pd` (the reference never surfaces in the module symbol table) while a
 * recursive `def fact(): fact(n-1)` gains no self-edge. A closure's free variable
 * (`is_free()`, bound in an enclosing *function*) is deliberately NOT a use: it can
 * never be another cell's definition. Keeping `symtable` for this half is deliberate
 * — resolving global vs. local vs. free vs. `nonlocal` is precisely what it already
 * does correctly, and hand-rolling it in the ast walk would risk the nested behavior
 * this preserves. The ast walk therefore never descends into a def/lambda body, only
 * into the parts that DO evaluate at module scope: decorators, default arguments,
 * annotations, and base classes.
 *
 * Class bodies execute immediately rather than deferred, but are likewise left to
 * `symtable`. The imprecision is one-directional and harmless: a class body reading
 * a name the cell binds only LATER is a NameError at runtime anyway.
 *
 * KNOWN LIMITS, both narrow and both erring toward a needless re-run rather than a
 * missed one, except where noted:
 *  - A CONDITIONAL bind counts as bound (`if flag: df = load()` then `df.head()`
 *    records no use of `df`). A real join over branches would need may-bind vs.
 *    must-bind sets; the sequential rule matches what shipped before for this shape,
 *    so it regresses nothing.
 *  - An `AugAssign` to a name declared `global` INSIDE a function
 *    (`def g(): global c; c += 1`) is still missed: that read lives in a deferred
 *    body, so it is `symtable`'s half, and `symtable` has the same `is_referenced`
 *    blind spot there. Module-scope `count += 1` — the common shape — is fixed.
 *
 * Builtins fall out for free: nothing DEFINES `print`, so it never resolves to an
 * upstream cell even though it appears in `uses`.
 */
const PROBE = `
import ast, json, sys, symtable

def analyze(source):
    # Every cell is analyzed behind its own catch-all: the walk below reasons about
    # node shapes that differ across Python versions, so an unanticipated one must
    # cost THAT cell its dataflow, never the whole batch (main()'s handler reports
    # ok:False for every cell the notebook submitted, which reads as "no edges
    # anywhere" — i.e. every cell fresh, the one verdict staleness must never invent).
    try:
        return analyze_one(source)
    except Exception:
        return {'defines': [], 'uses': []}

def analyze_one(source):
    try:
        st = symtable.symtable(source, '<cell>', 'exec')
        tree = ast.parse(source)
    except (SyntaxError, ValueError, RecursionError):
        # RecursionError is not a ValueError: a pathologically nested cell must
        # degrade like an unparseable one, not escape.
        return {'defines': [], 'uses': []}

    # --- Nested scopes (deferred bodies): symtable, order-insensitive. ---
    defines, used_nested = set(), set()
    def visit_sym(table, top):
        for sym in table.get_symbols():
            name = sym.get_name()
            if top and (sym.is_assigned() or sym.is_imported()):
                defines.add(name)
            elif not top and sym.is_referenced() and sym.is_global():
                used_nested.add(name)
        for child in table.get_children():
            visit_sym(child, False)
    visit_sym(st, True)

    # --- Module scope: ast, load-before-store. ---
    bound, used_top = set(), set()
    # One set per comprehension scratch scope currently open: a walrus inside a
    # comprehension binds in the ENCLOSING scope, so it must survive the rollback.
    walrus = []
    # Names appearing as a BARE \`x: int\` target (annotation, no value). symtable's
    # is_assigned() is True for them, which is simply wrong — nothing binds — so any
    # such name the cell never actually binds is dropped from defines below.
    annotated_only = set()
    # Comprehension LOOP-target names (the \`for x in ...\` binding inside a comp). At
    # runtime these never leak to the enclosing scope on ANY Python version, but 3.12+
    # (PEP 709 inlines comprehensions) makes symtable report them is_assigned() in the
    # MODULE table - a phantom define. Collected here, subtracted from defines below,
    # so the verdict is both runtime-correct and version-stable. Walrus targets are
    # NOT collected here: they genuinely DO leak, and symtable reports them not-assigned.
    comp_targets = set()

    def load(name):
        if name not in bound:
            used_top.add(name)

    def walk(node):
        t = type(node).__name__
        if t == 'Name':
            # Store/Del both bind the name for what follows; only Load can be a read.
            (load if isinstance(node.ctx, ast.Load) else bound.add)(node.id)
        elif t == 'Assign':
            walk(node.value)  # RHS evaluates BEFORE the targets bind — the whole point
            for tgt in node.targets:
                walk(tgt)
        elif t == 'AugAssign':
            # \`count += 1\` reads count, then stores it. symtable cannot see the read.
            if isinstance(node.target, ast.Name):
                load(node.target.id)
                walk(node.value)
                bound.add(node.target.id)
            else:
                walk(node.target)  # obj.attr += 1 / d[k] += 1 → a real load of obj / d
                walk(node.value)
        elif t == 'AnnAssign':
            if node.value:
                walk(node.value)
            walk(node.annotation)
            if isinstance(node.target, ast.Name):
                # A bare \`x: int\` only records an annotation — it does NOT bind, so a
                # later \`print(x)\` reads upstream. It is not a load of x either.
                if node.value:
                    bound.add(node.target.id)
                else:
                    annotated_only.add(node.target.id)
            else:
                walk(node.target)  # obj.attr: T / d[k]: T → a real load of obj / d
        elif t == 'NamedExpr':
            walk(node.value)
            walk(node.target)
            if walrus and isinstance(node.target, ast.Name):
                walrus[-1].add(node.target.id)
        elif t in ('For', 'AsyncFor'):
            walk(node.iter)  # iter evaluates before the loop variable binds
            walk(node.target)
            for s in node.body + node.orelse:
                walk(s)
        elif t in ('FunctionDef', 'AsyncFunctionDef', 'Lambda'):
            # Body is DEFERRED → symtable's half. Only these evaluate at module scope.
            for d in getattr(node, 'decorator_list', []):
                walk(d)
            for d in node.args.defaults:
                walk(d)
            for d in node.args.kw_defaults:
                if d:
                    walk(d)
            for a in ast.walk(node.args):
                if isinstance(a, ast.arg) and a.annotation:
                    walk(a.annotation)
            if getattr(node, 'returns', None):
                walk(node.returns)
            if t != 'Lambda':
                bound.add(node.name)
        elif t == 'ClassDef':
            for d in node.decorator_list:
                walk(d)
            for b in node.bases:
                walk(b)
            for k in node.keywords:
                walk(k.value)
            bound.add(node.name)  # body left to symtable
        elif t in ('Import', 'ImportFrom'):
            for a in node.names:
                if a.name != '*':  # \`import *\` binds unknowable names; symtable sees none either
                    bound.add(a.asname or a.name.split('.')[0])
        elif t == 'ExceptHandler':
            if node.type:
                walk(node.type)
            if node.name:
                bound.add(node.name)  # \`except E as e\` — a plain identifier, not a Name node
            for s in node.body:
                walk(s)
        elif t in ('ListComp', 'SetComp', 'GeneratorExp', 'DictComp'):
            # A comprehension owns its target names: they must not shadow a later
            # module-scope read, so bind them in a scratch scope and roll back. A
            # walrus is the exception — it binds in the enclosing scope, so \`[y := f(i)
            # for i in xs]\` then \`print(y)\` must NOT record y as an upstream read.
            saved = set(bound)
            walrus.append(set())
            for gen in node.generators:
                walk(gen.iter)
                walk(gen.target)
                for i in gen.ifs:
                    walk(i)
            for part in ((node.key, node.value) if t == 'DictComp' else (node.elt,)):
                walk(part)
            leaked = walrus.pop()
            # Everything this comprehension newly bound, minus the walrus leaks, is its
            # loop targets - the names to strip from symtable's 3.12+ phantom defines.
            comp_targets.update((bound - saved) - leaked)
            bound.clear()
            bound.update(saved)
            bound.update(leaked)
            if walrus:
                walrus[-1].update(leaked)  # a nested comprehension's walrus keeps leaking outward
        elif t in ('MatchAs', 'MatchStar'):
            if getattr(node, 'pattern', None):
                walk(node.pattern)
            if node.name:
                bound.add(node.name)  # capture pattern — an identifier, not a Name node
        elif t == 'MatchMapping':
            for child in ast.iter_child_nodes(node):
                walk(child)
            if node.rest:
                bound.add(node.rest)
        elif t == 'Global':
            pass  # a module-scope \`global\` declaration binds and reads nothing
        else:
            for child in ast.iter_child_nodes(node):
                walk(child)

    try:
        for stmt in tree.body:
            walk(stmt)
    except RecursionError:
        # A pathologically nested cell must degrade alone, not fail the whole
        # notebook's analysis: keep its defines, drop its (incomplete) module uses.
        # \`bound\` is incomplete too, so trust symtable's defines wholesale rather than
        # drop one on a half-walked cell's evidence.
        used_top = set()
        annotated_only = set()
        comp_targets = set()

    # Strip symtable's phantom module-scope defines, keying off the ast walk which knows
    # what actually binds. Two sources, both scoped to names the walk never left in
    # \`bound\` (so a name legitimately re-bound at module scope survives):
    #  - a bare \`x: int\` annotation - symtable's is_assigned() is True, but nothing binds;
    #  - a comprehension loop target on 3.12+ - PEP 709 inlining makes symtable report it
    #    module-assigned though it never leaks at runtime (on <=3.11 it's absent already,
    #    so this is a no-op there - the subtraction is what keeps defines version-stable).
    # NOT a blanket \`defines & bound\`: that would also drop names the RecursionError path
    # leaves out of a half-walked \`bound\`, where we deliberately trust symtable wholesale.
    defines -= {n for n in (annotated_only | comp_targets) if n not in bound}

    return {'defines': sorted(defines), 'uses': sorted(used_top | (used_nested - defines))}

def main():
    try:
        # Payload arrives on STDIN, not argv: a large notebook's JSON would blow
        # ARG_MAX as a command-line argument, silently killing staleness for exactly
        # the big notebooks that most need it. Read stdin to completion, then analyze.
        req = json.loads(sys.stdin.read())
        out = {c['key']: analyze(c['source']) for c in req.get('cells', [])}
        sys.stdout.write('${SENTINEL}' + json.dumps({'ok': True, 'cells': out}) + '\\n')
    except Exception as e:
        sys.stdout.write('${SENTINEL}' + json.dumps({'ok': False, 'message': str(e)}) + '\\n')

main()
`;

/**
 * source string → { defines, uses }. A bounded LRU, not a `Map` we `.clear()` on
 * overflow: a full flush at the cap re-analyzes every hot cell on the next pass,
 * whereas the LRU evicts only the coldest source so the notebook's live cells
 * stay cached across the bound.
 */
const cache = new LruCache<string, DataflowEntry>(1000);

/**
 * source string → the module-level import bindings it provides. A separate cache
 * from `cache` on purpose: this is a cheap JS tokenizer pass, not the probe's
 * answer, so it must survive a probe failure/backoff (the whole point is that the
 * import-binding refinement never depends on the subprocess) and must never be
 * confused with a probe result when deciding what is cacheable.
 */
const importCache = new LruCache<string, string[]>(1000);

/** The names `source` provides as stable module-level import bindings, cached. */
function importNamesFor(source: string): string[] {
	const hit = importCache.get(source);
	if (hit) return hit;
	const names = importBindingNames(source);
	importCache.set(source, names);
	return names;
}

/**
 * source string → does it arm `%autoreload`. Cached for the same reason as
 * `importCache`: this one is scanned over EVERY code cell on every debounced pass
 * (the gate is notebook-wide), not just over cells whose analysis is missing.
 */
const autoreloadCache = new LruCache<string, boolean>(1000);

/** Does `source` arm `%autoreload` (a kernel-global act), cached. */
function armsAutoreload(source: string): boolean {
	const hit = autoreloadCache.get(source);
	if (hit !== undefined) return hit;
	const armed = hasAutoreloadMagic(source);
	autoreloadCache.set(source, armed);
	return armed;
}

/** A probe run's public outcome plus WHY it failed (a timeout is the one we back off). */
type RawProbe = ProbeRun & { timedOut: boolean };

/** One backed-off batch: do not re-probe until `until`, and how many consecutive timeouts. */
interface BackoffEntry {
	until: number;
	attempts: number;
}

/**
 * Batches (keyed by their source signature) that recently TIMED OUT and must not be
 * re-spawned until their window elapses. Bounded like the analysis cache: a distinct
 * timed-out batch is rare, but a session that edits a slow notebook repeatedly would
 * mint a new signature each time, so evict the coldest rather than grow forever. An
 * evicted entry only means one extra probe if that exact batch ever recurs - harmless.
 */
const backoff = new LruCache<string, BackoffEntry>(256);

/**
 * A `probeBatch` outcome. `unavailable` is TRUE only when the batch was backed off or
 * its fresh probe TIMED OUT - the conservative-stale cases. A non-timeout failure
 * (missing interpreter, spawn error, probe crash/parse failure) leaves it FALSE, so
 * those cells degrade to empty dataflow (read as `fresh`) exactly as before.
 */
type BatchRun = ProbeRun & { unavailable: boolean };

/** In-flight probes keyed by batch signature, so concurrent identical passes fold into one. */
const inflight = new Map<string, Promise<BatchRun>>();

/**
 * A stable, order-independent signature for the SET of source keys in a batch. Keyed
 * on the same source strings the cache uses, so the backoff resets EXACTLY when the
 * batch content changes (a real edit adds/removes/rewrites a source) and holds while
 * it does not (a run, a load, a structural pass that touches no source). Hashed so a
 * big notebook does not carry its whole concatenated source as a map key.
 */
function batchSignature(keys: readonly string[]): string {
	const h = createHash('sha1');
	for (const k of [...keys].sort()) {
		h.update(k);
		h.update('\u0000'); // unambiguous separator so ['ab','c'] != ['a','bc']
	}
	return h.digest('hex');
}

/** Exponential backoff window for the Nth consecutive timeout of a batch, capped. */
function backoffDelay(attempts: number): number {
	const base = backoffBaseMs();
	// 2**(attempts-1) grows fast; clamp the exponent so it can never overflow to Infinity.
	const scaled = base * 2 ** Math.min(Math.max(attempts - 1, 0), 20);
	return Math.min(scaled, backoffMaxMs());
}

/**
 * Run the probe over `items`, but converge instead of storming when a batch keeps
 * timing out. On a timeout the batch's signature is recorded with an exponential
 * window and is NOT re-probed until the window elapses or the batch changes; while
 * backed off it returns `{ ok: false, unavailable: true }` WITHOUT spawning (so a
 * persistently-slow notebook stops pinning a core). A success clears the backoff; a
 * non-timeout failure (missing interpreter) does not back off and is NOT `unavailable`
 * - it is cheap, may resolve, and keeps the prior degrade-to-empty behavior. A single
 * probe per signature is in flight at once, so concurrent UI+MCP passes share it.
 */
async function probeBatch(items: ProbeItem[]): Promise<BatchRun> {
	const sig = batchSignature(items.map((i) => i.key));
	const bo = backoff.get(sig);
	// Backed off: do NOT spawn. Conservative-stale, so unavailable:true.
	if (bo && Date.now() < bo.until) return { ok: false, cells: {}, unavailable: true };

	const pending = inflight.get(sig);
	if (pending) return pending; // single-flight: fold a concurrent identical probe

	const run = (async (): Promise<BatchRun> => {
		const raw = await runProbe(items);
		if (raw.ok) {
			backoff.delete(sig); // answered ⇒ clear any prior backoff for this batch
			return { ok: true, cells: raw.cells, unavailable: false };
		}
		if (raw.timedOut) {
			const attempts = (bo?.attempts ?? 0) + 1;
			backoff.set(sig, { until: Date.now() + backoffDelay(attempts), attempts });
			return { ok: false, cells: {}, unavailable: true }; // timeout ⇒ conservative-stale
		}
		// Non-timeout failure (missing interpreter, spawn/crash/parse): degrade to empty
		// dataflow (reads as fresh), NOT conservative-stale - the long-standing behavior.
		return { ok: false, cells: {}, unavailable: false };
	})();

	inflight.set(sig, run);
	try {
		return await run;
	} finally {
		inflight.delete(sig);
	}
}

/** Clear all module state (analysis cache + timeout backoff). Test-only. */
export function __resetDataflowState(): void {
	cache.clear();
	importCache.clear();
	autoreloadCache.clear();
	backoff.clear();
	inflight.clear();
}

/**
 * Run the probe over `items` ([{key, source}]).
 *
 * Never rejects: every failure path degrades to `{ ok: false, cells: {} }`, so a
 * caller reading `.cells` keeps the old degrade-to-empty contract while `ok` tells it
 * whether the answer is the probe's (cacheable) or an absence of one (not).
 */
function runProbe(items: ProbeItem[]): Promise<RawProbe> {
	const python = projectPython() || 'python3';
	const failed = (timedOut = false): RawProbe => ({ ok: false, cells: {}, timedOut });
	return new Promise<RawProbe>((resolve) => {
		let child: ChildProcess;
		try {
			// Payload goes over STDIN (not argv): a large notebook's JSON exceeds
			// ARG_MAX and the spawn fails, which used to silently drop staleness for
			// the biggest notebooks. stdin has no such ceiling.
			child = spawn(python, ['-c', PROBE], {
				stdio: ['pipe', 'pipe', 'pipe']
			});
		} catch {
			resolve(failed()); // spawn threw synchronously (bad interpreter) → degrade
			return;
		}
		let stdout = '';
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true; // remember WHY the child died: a timeout backs off, other deaths do not
			child.kill('SIGKILL');
		}, probeTimeoutMs());
		child.stdout?.on('data', (d) => (stdout += d)); // drain stdout so the pipe never blocks the child
		child.stderr?.on('data', () => {}); // drain, never fatal
		child.on('error', () => {
			clearTimeout(timer);
			resolve(failed()); // interpreter missing → degrade
		});
		// Feed the payload and close stdin so the probe's `sys.stdin.read()` returns.
		// The child reads stdin fully before writing stdout, and Node buffers our
		// write in-process (never blocking the event loop) while we already drain
		// stdout above, so a large payload can't deadlock the pipes. An EPIPE (child
		// died before reading) must not crash the app, so swallow stdin errors — the
		// 'error'/'close' handlers own the degrade path.
		const stdin = child.stdin;
		if (stdin) {
			stdin.on('error', () => {}); // e.g. EPIPE if the child exited early
			stdin.end(JSON.stringify({ cells: items }));
		}
		// 'close', not 'exit': a large notebook produces a large stdout, and 'exit'
		// can fire before that stdout is fully drained. 'close' waits for the stdio
		// streams to end, so `stdout` is complete when we parse it.
		child.on('close', () => {
			clearTimeout(timer);
			const line = stdout.split('\n').find((l) => l.startsWith(SENTINEL));
			if (!line) return resolve(failed(timedOut)); // killed by the timeout, or died before printing
			try {
				// The probe prints exactly one SENTINEL-prefixed ProbeResult JSON line.
				const parsed = JSON.parse(line.slice(SENTINEL.length)) as ProbeResult;
				resolve(parsed.ok === true ? { ok: true, cells: parsed.cells ?? {}, timedOut: false } : failed());
			} catch {
				resolve(failed());
			}
		});
	});
}

/** A dataflow map plus the code-cell ids whose analysis was unavailable this pass. */
interface DataflowResult {
	dataflow: DataflowMap;
	/** Code-cell ids the probe could not answer because it TIMED OUT or is backed off. */
	unavailable: Set<string>;
}

/**
 * Analyze a notebook's code cells, returning both the dataflow map AND the code-cell
 * ids whose analysis was unavailable this pass (the probe TIMED OUT or is backed off -
 * NOT a non-timeout failure, which degrades to empty dataflow like it always did).
 * `analyzeDataflow` exposes just the map; `getNotebookStaleness` uses `unavailable` to
 * mark those cells conservative-stale rather than let empty dataflow read as `fresh`.
 */
async function analyzeDataflowDetailed(cells: CellView[]): Promise<DataflowResult> {
	// SQL cells are code cells on disk but their source is SQL, not Python - `ast` /
	// `symtable` would misparse them, so they stay OUT of the probe and get a
	// SYNTHETIC contribution instead (below): their run really does bind names in the
	// kernel, so the graph must see those defines or a Python cell reading a SQL
	// result gets no upstream edge and never goes stale when the query is edited.
	const sql = cells.filter((c) => c.cell_type === 'code' && isSqlCell(c));
	const code = cells.filter((c) => c.cell_type === 'code' && !isSqlCell(c));
	// `%autoreload` is a KERNEL-GLOBAL setting, so its effect on the import-binding
	// exemption is notebook-wide, not cell-local: with it armed, re-running `import
	// mymod` re-imports a changed module instead of handing back the `sys.modules`
	// object, so dependents really do go stale and NO edge may be exempt. The
	// ubiquitous header arms it in its OWN cell (and Cellar's `ensureImportsCell`
	// makes that split the default, since it adopts a first cell only via
	// `isImportsOnly`), so a per-cell check alone would grant the exemption in
	// exactly the arrangement where autoreload is most commonly used. One hit
	// anywhere ⇒ omit `imports` everywhere ⇒ the whole notebook falls back to the
	// conservative cell-level rule.
	const autoreloadArmed = code.some((c) => armsAutoreload(c.source ?? ''));
	const missing: ProbeItem[] = [];
	for (const c of code) {
		const src = c.source ?? '';
		// Cache/lookup key = the ORIGINAL source; the probe analyzes the magic-normalized
		// source (a `%%time` body still contributes its defines; a `%%bash` body does not).
		if (!cache.has(src)) missing.push({ key: src, source: normalizeForAnalysis(src) });
	}
	// Source keys we could NOT resolve this pass (the probe failed or is backed off).
	const unresolved = new Set<string>();
	if (missing.length) {
		// De-duplicate identical cells before spawning (many empty cells, say), keyed by
		// their original source so each distinct cell maps back to its own cache entry.
		const byKey = new Map<string, ProbeItem>(missing.map((m) => [m.key, m]));
		const run = await probeBatch([...byKey.values()]);
		// Cache ONLY what the probe answered. A key it legitimately omitted from a
		// successful batch caches empty — that IS its answer — but a failed run caches
		// nothing, so the next pass re-analyzes instead of serving a false `fresh`
		// (every cell edge-less ⇒ every cell fresh) until the LRU evicts it.
		if (run.ok) {
			for (const [src, m] of byKey) {
				cache.set(src, run.cells[m.key] ?? { defines: [], uses: [] }); // LRU evicts the coldest source past the cap
			}
		} else if (run.unavailable) {
			// ONLY a timed-out / backed-off batch is unavailable: mark these sources
			// unresolved so their cells are reported UNAVAILABLE below (conservative-stale),
			// never cached as empty. A non-timeout failure (missing interpreter, spawn/crash)
			// falls through - it caches nothing but adds NO unavailable entry, so those cells
			// degrade to empty dataflow and read as `fresh`, exactly as before this backoff.
			for (const src of byKey.keys()) unresolved.add(src);
		}
	}
	const out: DataflowMap = {};
	const unavailable = new Set<string>();
	for (const c of code) {
		const src = c.source ?? '';
		const cached = cache.get(src);
		if (cached) out[c.id] = cached;
		else {
			out[c.id] = { defines: [], uses: [] };
			if (unresolved.has(src)) unavailable.add(c.id); // could not analyze this pass
		}
		// The import-binding subset, from the JS tokenizer rather than the probe, so it
		// is available even when the probe is not. Only names the probe also reports as
		// defines can be exempted downstream, so an unavailable cell (empty defines)
		// carries no exemption either - it stays conservative-stale as the backoff
		// design requires. Merged into a COPY: `cached` is the shared LRU entry.
		const imports = autoreloadArmed ? [] : importNamesFor(src);
		if (imports.length) out[c.id] = { ...out[c.id], imports };
	}
	// Synthetic dataflow for SQL cells: `sql.ts` compiles the cell to a `spark.sql()`
	// wrapper that binds its result (the `-- >> name` prefix line's name plus the
	// `_sql_df` alias, else `_sql_df` alone), so those names are exactly what the
	// cell DEFINES. `uses` stays empty on purpose: reading table names out of SQL is
	// lineage analysis, deliberately out of scope - a SQL cell is a graph SOURCE.
	// An empty cell, or one whose prefix line is unusable (it compiles to a `raise`),
	// binds nothing, so `resultVars` is empty and it defines nothing.
	for (const c of sql) out[c.id] = { defines: parseSqlCell(c.source ?? '').resultVars, uses: [] };
	return { dataflow: out, unavailable };
}

/**
 * Analyze a notebook's code cells into `{ id: { defines, uses, imports? } }`.
 *
 * Only cells whose source is not already cached are sent to the subprocess, so a
 * single edit costs one cheap `ast` + `symtable` pass over one cell, and a re-run
 * costs nothing. Markdown cells are skipped (they have no dataflow). A cell whose
 * analysis is unavailable this pass degrades to empty defines/uses (the long-standing
 * contract); `getNotebookStaleness` additionally treats it as conservative-stale.
 * `imports` (the module-level import subset of `defines`, absent when empty) rides
 * along from the JS tokenizer, so it is present even when the probe is not - and is
 * omitted for EVERY cell when any code cell arms `%autoreload`.
 *
 * @param cells the notebook's cells (code + markdown)
 * @returns per-code-cell `{ id: { defines, uses, imports? } }`
 */
export async function analyzeDataflow(cells: CellView[]): Promise<DataflowMap> {
	return (await analyzeDataflowDetailed(cells)).dataflow;
}

/**
 * The code cells that DEFINE at least one of `names`, in document order — used to
 * reflect a "wipe variables" (see kernel.ts `wipeKernelVariables`): after the
 * kernel drops those data variables, the cells that defined them must read "not
 * run this session" so staleness propagates to their dependents. Built from the
 * same cached dataflow `defines` sets that back the staleness graph, so the
 * attribution matches what the rest of Cellar believes each cell defines.
 *
 * `names` empty ⇒ no cells. Reads the live doc for `nb` (nullish ⇒ active).
 */
export async function cellsDefiningNames(names: readonly string[], nb?: string | null): Promise<string[]> {
	const wanted = new Set(names);
	if (wanted.size === 0) return [];
	const cells = listCells(nb);
	const dataflow = await analyzeDataflow(cells);
	return cells
		.filter((c) => c.cell_type === 'code' && (dataflow[c.id]?.defines ?? []).some((d) => wanted.has(d)))
		.map((c) => c.id);
}

/**
 * The staleness verdict for a whole notebook: analyze its dataflow, then apply the
 * pure rule against the live kernel session. Shared by the UI's staleness endpoint
 * and the MCP agent surface, so the human and the agent see the same verdict.
 *
 * `cells` is the full document (code + markdown); pass the notebook path to read
 * the live doc. The dependency graph is built over ALL code cells (a hidden cell
 * still defines names in the kernel); callers filter the *reported* set as they
 * see fit (MCP hides `hidden_from_agent` cells).
 *
 * @param nb notebook path (nullish ⇒ active notebook)
 */
export async function getNotebookStaleness(
	nb?: string | null
): Promise<{ sid: SessionId | null; cells: ReturnType<typeof computeStaleness> }> {
	const cells = listCells(nb);
	const { dataflow, unavailable } = await analyzeDataflowDetailed(cells);
	// Reconcile against THIS notebook's kernel epoch (each notebook has its own),
	// not the active one — so staleness is correct even for a non-active notebook.
	const sid = currentSessionId(nb);
	return { sid, cells: computeStaleness(cells, dataflow, sid, unavailable) };
}
