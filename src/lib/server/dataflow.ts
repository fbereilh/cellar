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
 *    real scope analysis, which Python's `symtable` gives for free.
 *  - The kernel is the wrong place for the same reasons `imports.js` avoids it: it
 *    would force-boot a kernel Cellar deliberately never boots on its own, queue
 *    behind a running cell, and make a purely static analysis depend on the
 *    runtime. Staleness must be computable with no kernel at all (a cell is simply
 *    "not run" then). So we shell out to the project interpreter, exactly like
 *    `databricks.js` does for its SDK calls. `symtable` is stdlib, so any Python 3
 *    works — no package, and no dependency on the venv being set up.
 *
 * The probe never raises: a cell whose source does not parse (it is mid-edit) is
 * reported with empty defines/uses rather than failing the whole analysis. If no
 * interpreter can be found or the process dies, `analyzeDataflow` degrades to an
 * empty map — staleness then still reports "not run" and self-edit staleness
 * (neither needs the graph), just not cross-cell dependency staleness.
 *
 * Results are cached by source string, so an edit re-analyzes only the changed
 * cell and a run (no source change) re-analyzes nothing.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { currentSessionId } from './kernel';
import { listCells } from './notebook';
import { projectPython } from './databricks';
import { computeStaleness } from '../staleness';
import { isSqlCell } from '../cellLanguage';
import type { CellView, SessionId } from './types';

/** The names a cell binds at module scope, and the module globals it reads. */
interface DataflowEntry {
	defines: string[];
	uses: string[];
}

/** Per-cell dataflow, keyed by cell id (or source string in the cache). */
type DataflowMap = Record<string, DataflowEntry>;

/** The single `SENTINEL`-prefixed JSON line the `symtable` probe prints. */
interface ProbeResult {
	ok: boolean;
	cells: DataflowMap;
	message?: string;
}

/** One item submitted to the probe: a stable cache key + the source to analyze. */
interface ProbeItem {
	key: string;
	source: string;
}

const SENTINEL = '__CELLAR_DF__';
const PROBE_TIMEOUT_MS = 10000;

/**
 * One `symtable` pass per submitted cell, recursing into nested scopes.
 *
 *   DEFINES — a name assigned or imported at MODULE scope (a def/class binds its
 *   name in the enclosing scope, so those count as assigned).
 *
 *   USES — a name the cell references but does not define. At module scope: any
 *   name referenced but not assigned/imported/parameter. Inside a nested function
 *   or class body: a name that resolves to a module GLOBAL (`is_global()`) — this
 *   is what catches `def f(): return pd.x`, whose reference to `pd` never surfaces
 *   in the module symbol table. A closure's free variable (`is_free()`, bound in an
 *   enclosing *function*) is deliberately NOT a use: it can never be another cell's
 *   definition. Names the cell defines itself are subtracted, so a global read
 *   inside a function the same cell defines is not a spurious cross-cell dependency.
 *
 * Builtins fall out for free: nothing DEFINES `print`, so it never resolves to an
 * upstream cell even though it appears in `uses`.
 */
const PROBE = `
import json, sys, symtable

def analyze(source):
    try:
        st = symtable.symtable(source, '<cell>', 'exec')
    except (SyntaxError, ValueError):
        return {'defines': [], 'uses': []}
    defines, used = set(), set()
    def visit(table, top):
        for sym in table.get_symbols():
            name = sym.get_name()
            if top and (sym.is_assigned() or sym.is_imported()):
                defines.add(name)
            if not sym.is_referenced():
                continue
            if top:
                if not (sym.is_assigned() or sym.is_imported() or sym.is_parameter()):
                    used.add(name)
            elif sym.is_global():
                used.add(name)
        for child in table.get_children():
            visit(child, False)
    visit(st, True)
    return {'defines': sorted(defines), 'uses': sorted(used - defines)}

def main():
    try:
        req = json.loads(sys.argv[1])
        out = {c['key']: analyze(c['source']) for c in req.get('cells', [])}
        sys.stdout.write('${SENTINEL}' + json.dumps({'ok': True, 'cells': out}) + '\\n')
    except Exception as e:
        sys.stdout.write('${SENTINEL}' + json.dumps({'ok': False, 'message': str(e)}) + '\\n')

main()
`;

/** source string → { defines, uses }. Bounded so a long session can't grow it forever. */
const cache = new Map<string, DataflowEntry>();
const CACHE_MAX = 1000;

/** Run the probe over `items` ([{key, source}]) and merge results into the cache. */
function runProbe(items: ProbeItem[]): Promise<DataflowMap> {
	const python = projectPython() || 'python3';
	return new Promise<DataflowMap>((resolve) => {
		let child: ChildProcess;
		try {
			child = spawn(python, ['-c', PROBE, JSON.stringify({ cells: items })], {
				stdio: ['ignore', 'pipe', 'pipe']
			});
		} catch {
			resolve({}); // spawn threw synchronously (bad interpreter) → degrade
			return;
		}
		let stdout = '';
		const timer = setTimeout(() => child.kill('SIGKILL'), PROBE_TIMEOUT_MS);
		child.stdout?.on('data', (d) => (stdout += d));
		child.stderr?.on('data', () => {}); // drain, never fatal
		child.on('error', () => {
			clearTimeout(timer);
			resolve({}); // interpreter missing → degrade
		});
		child.on('exit', () => {
			clearTimeout(timer);
			const line = stdout.split('\n').find((l) => l.startsWith(SENTINEL));
			if (!line) return resolve({});
			try {
				// The probe prints exactly one SENTINEL-prefixed ProbeResult JSON line.
				const parsed = JSON.parse(line.slice(SENTINEL.length)) as ProbeResult;
				resolve(parsed.ok ? parsed.cells : {});
			} catch {
				resolve({});
			}
		});
	});
}

/**
 * Analyze a notebook's code cells into `{ id: { defines, uses } }`.
 *
 * Only cells whose source is not already cached are sent to the subprocess, so a
 * single edit costs one cheap `symtable` pass over one cell, and a re-run costs
 * nothing. Markdown cells are skipped (they have no dataflow).
 *
 * @param cells the notebook's cells (code + markdown)
 * @returns per-code-cell `{ id: { defines, uses } }`
 */
export async function analyzeDataflow(cells: CellView[]): Promise<DataflowMap> {
	// SQL cells are code cells on disk but their source is SQL, not Python - a
	// `symtable` pass would misparse them. Skip them: they get no defines/uses, so
	// they never join the Python dependency graph (self-edit staleness still works
	// via lastRun/editedAt, since they run and stamp like any code cell).
	const code = cells.filter((c) => c.cell_type === 'code' && !isSqlCell(c));
	const missing: ProbeItem[] = [];
	for (const c of code) {
		const src = c.source ?? '';
		if (!cache.has(src)) missing.push({ key: src, source: src });
	}
	if (missing.length) {
		// De-duplicate identical sources before spawning (many empty cells, say).
		const bySource = new Map<string, ProbeItem>(missing.map((m) => [m.source, m]));
		const results = await runProbe([...bySource.values()]);
		for (const [src, m] of bySource) {
			cache.set(src, results[m.key] ?? { defines: [], uses: [] });
		}
		if (cache.size > CACHE_MAX) cache.clear(); // simple bound; correctness is unaffected
	}
	const out: DataflowMap = {};
	for (const c of code) out[c.id] = cache.get(c.source ?? '') ?? { defines: [], uses: [] };
	return out;
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
	const dataflow = await analyzeDataflow(cells);
	const sid = currentSessionId();
	return { sid, cells: computeStaleness(cells, dataflow, sid) };
}
