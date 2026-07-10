/**
 * Cellar — kernel introspection (shell sidebar + MCP `kernel_state`).
 *
 * Introspects the live kernel's user namespace by running a small Python probe
 * through the existing execute() bridge (no new kernel wiring) and parsing the
 * JSON it prints. One shared probe buckets the namespace into imports /
 * functions / classes / variables; the sidebar inspector uses just the
 * variables bucket, the MCP tool uses all four. Read-only: the probe defines
 * only underscore-prefixed temporaries and deletes them, so it neither shows up
 * in nor pollutes the inspected namespace.
 */
import { execute, kernelStatus, kernelSession, currentSessionId } from './kernel.js';

// One probe, four buckets. We start from IPython's user namespace minus the
// names it already marks hidden (its injected builtins) and classify each name:
//   - modules            -> `imports` (plain `import x` / `import x as y`)
//   - imported callables  -> `imports` (from-imports; see the __module__ gotcha)
//   - user-defined funcs -> `functions`
//   - user-defined classes -> `classes`
//   - everything else     -> `variables` (data), dropping library scaffolding
// Everything the probe defines is underscore-prefixed, so it hides itself and
// never lands in any bucket.
const PROBE = `
import json as _cellar_json, inspect as _cellar_ins, sys as _cellar_sys
def _cellar_kernel_state():
    try:
        _ip = get_ipython()
        _ns = _ip.user_ns
        _hidden = set(_ip.user_ns_hidden)
    except Exception:
        _ns = globals()
        _hidden = set()
    _skip_type_mods = {'typing', 'abc', 'IPython.core.magic'}
    _imports, _functions, _classes, _variables = [], [], [], []
    for _k, _v in list(_ns.items()):
        if _k.startswith('_') or _k in _hidden:
            continue
        if _k in ('In', 'Out', 'exit', 'quit', 'get_ipython'):
            continue
        # Modules -> plain import; reconstruction is exact.
        if _cellar_ins.ismodule(_v):
            _mod = getattr(_v, '__name__', _k)
            _stmt = ('import ' + _mod) if _mod == _k else ('import ' + _mod + ' as ' + _k)
            _imports.append({'alias': _k, 'module': _mod, 'statement': _stmt})
            continue
        _is_func = (_cellar_ins.isfunction(_v) or _cellar_ins.isbuiltin(_v)
                    or _cellar_ins.isroutine(_v))
        _is_class = _cellar_ins.isclass(_v)
        if _is_func or _is_class:
            _owner = getattr(_v, '__module__', None)
            if _owner in (None, '__main__'):
                # Defined by the user in this notebook.
                if _is_class:
                    _classes.append({'name': _k})
                else:
                    try:
                        _sig = str(_cellar_ins.signature(_v))
                    except Exception:
                        _sig = ''
                    _functions.append({'name': _k, 'signature': _sig})
            else:
                # Brought in by a from-import. __module__ can be a private
                # submodule (e.g. Path -> pathlib._local on 3.13), so only emit a
                # runnable statement when the TOP-LEVEL package re-exports this
                # exact object; otherwise keep the name for display/dedup with a
                # null statement rather than a misleading one.
                _top = _owner.split('.')[0]
                _stmt = None
                try:
                    _topmod = _cellar_sys.modules.get(_top)
                    _orig = getattr(_v, '__name__', _k)
                    if _topmod is not None and getattr(_topmod, _orig, None) is _v:
                        _stmt = ('from ' + _top + ' import ' + _orig) if _orig == _k \
                            else ('from ' + _top + ' import ' + _orig + ' as ' + _k)
                except Exception:
                    _stmt = None
                _imports.append({'alias': _k, 'module': _top, 'statement': _stmt})
            continue
        # Data variable. Drop library scaffolding types (typing/abc/magics).
        if getattr(type(_v), '__module__', '') in _skip_type_mods:
            continue
        _shape = ''
        try:
            if hasattr(_v, 'shape'):
                _shape = 'x'.join(str(_d) for _d in _v.shape)
            elif isinstance(_v, (str, bytes)):
                _shape = str(len(_v))
            elif hasattr(_v, '__len__'):
                _shape = str(len(_v))
        except Exception:
            pass
        try:
            _p = repr(_v)
        except Exception:
            _p = '<unreprable>'
        _p = ' '.join(_p.split())
        if len(_p) > 140:
            _p = _p[:137] + '...'
        _entry = {'name': _k, 'type': type(_v).__name__, 'shape': _shape, 'preview': _p}
        try:
            if hasattr(_v, 'columns'):
                _entry['columns'] = [str(_c) for _c in list(_v.columns)[:100]]
        except Exception:
            pass
        _variables.append(_entry)
    _imports.sort(key=lambda _r: _r['alias'])
    _functions.sort(key=lambda _r: _r['name'])
    _classes.sort(key=lambda _r: _r['name'])
    _variables.sort(key=lambda _r: _r['name'])
    return {'imports': _imports, 'functions': _functions,
            'classes': _classes, 'variables': _variables}
print(_cellar_json.dumps(_cellar_kernel_state()))
del _cellar_kernel_state
`;

/**
 * Run an arbitrary read-only Python probe on the kernel and return its single
 * printed JSON line (the last non-empty stdout line, to be robust against stray
 * output) plus `session` - the kernel-session epoch the probe actually executed
 * in, taken from execute()'s `kernel` event. That epoch, not one sampled around
 * the await, is the one this namespace snapshot belongs to. Every namespace
 * introspection in Cellar goes through this one runner, so "run user code" and
 * "inspect the namespace" can never diverge. `internal` keeps the probe out of
 * `execs_this_session` and the run queue - it is Cellar's own bookkeeping, not a
 * cell the agent ran.
 */
async function execProbe(code) {
	let stdout = '';
	let errored = null;
	let session = null;
	const onEvent = (ev) => {
		if (ev.type === 'kernel') {
			session = ev.session;
		} else if (ev.type === 'output') {
			const o = ev.output;
			if (o.output_type === 'stream' && o.name === 'stdout') {
				stdout += Array.isArray(o.text) ? o.text.join('') : o.text;
			} else if (o.output_type === 'error') {
				errored = `${o.ename}: ${o.evalue}`;
			}
		}
	};
	await execute(code, onEvent, { internal: true });
	if (errored) throw new Error(errored);
	const line = stdout.trim().split('\n').filter(Boolean).at(-1);
	return { session, line };
}

/**
 * Run the shared bucketed-namespace probe and return the parsed state, tagged
 * with `session`.
 */
async function runProbe() {
	const { session, line } = await execProbe(PROBE);
	if (!line) return { session, imports: [], functions: [], classes: [], variables: [] };
	return { session, ...JSON.parse(line) };
}

/**
 * Sidebar variable inspector: the data-variable list only, in the original
 * `{ name, type, shape, preview }` shape (unchanged for the existing UI).
 */
export async function inspectVariables() {
	const state = await runProbe();
	return (state.variables || []).map(({ name, type, shape, preview }) => ({
		name,
		type,
		shape,
		preview
	}));
}

/**
 * MCP `kernel_state`: the full live namespace bucketed into imports / functions
 * / classes / variables. Short-circuits to `{ started: false }` when no kernel
 * has started — never force-boots one (mirrors getKernelInfo()). Imports are
 * deduped by normalized statement (falling back to module+alias when a
 * from-import has no safely reconstructable statement).
 *
 * This is the LIVE truth about what is defined. `session_id` is the epoch of the
 * kernel session the returned namespace was read from - the same epoch
 * `get_notebook_map`'s kernel header and each cell's `ran_this_session` flag are
 * computed against, so the two views can always be correlated. If the kernel is
 * restarted (or autorestarts) between the probe and the reply, `stale: true` is
 * set: the namespace below belongs to `session_id`, which is no longer live, so
 * nothing in it is defined any more.
 */
export async function kernelState() {
	const status = kernelStatus().status;
	if (status === 'not_started') return { started: false, session_id: null };
	if (status === 'busy') return { started: true, busy: true, session_id: kernelSession().session_id };
	const state = await runProbe();
	const seen = new Set();
	const imports = [];
	for (const imp of state.imports || []) {
		const key = imp.statement ?? `${imp.module}:${imp.alias}`;
		if (seen.has(key)) continue;
		seen.add(key);
		imports.push(imp);
	}
	const stale = state.session !== currentSessionId();
	return {
		started: true,
		session_id: state.session,
		...(stale ? { stale: true } : {}),
		imports,
		functions: state.functions || [],
		classes: state.classes || [],
		variables: state.variables || []
	};
}

// ---------------------------------------------------------------------------
// Agent variable inspection (MCP `list_variables` / `inspect_variable`).
//
// These need richer, schema-level detail than the bucketed `kernel_state` probe
// carries — per-column dtypes for a DataFrame, a small head sample for one
// variable — so they run their own probes. They still go through the SAME
// execProbe() runner and the same {internal:true} contract as every other
// introspection, so no user code is ever executed and exec counts are untouched.
// Detection is duck-typed on the type's module name (pandas / numpy / pyspark)
// so the probe is a harmless no-op when those libraries are absent, and never
// imports them itself. Spark DataFrames are described from `.schema` only — never
// collected — so inspecting one cannot trigger a job.
// ---------------------------------------------------------------------------

// Shared classifier that turns one (name, value) into a compact descriptor:
// {name, type, [module], repr_short, [size], [kind + schema]}.
const DESCRIBE_HELPER = `
def _cellar_describe(_k, _v):
    _t = type(_v)
    _tn = _t.__name__
    _mod = getattr(_t, '__module__', '') or ''
    _entry = {'name': _k, 'type': _tn}
    if _mod and _mod != 'builtins':
        _entry['module'] = _mod
    try:
        _r = repr(_v)
    except Exception:
        _r = '<unreprable>'
    _r = ' '.join(_r.split())
    if len(_r) > 140:
        _r = _r[:137] + '...'
    _entry['repr_short'] = _r
    try:
        if hasattr(_v, '__len__') and not (_mod.startswith('pyspark')):
            _entry['size'] = len(_v)
    except Exception:
        pass
    _pkg = _mod.split('.')[0]
    try:
        if _pkg == 'pandas' and _tn == 'DataFrame':
            _entry['kind'] = 'dataframe'
            _entry['shape'] = [int(_v.shape[0]), int(_v.shape[1])]
            _entry['columns'] = [{'name': str(_c), 'dtype': str(_dt)}
                                 for _c, _dt in list(zip(_v.columns, _v.dtypes))[:100]]
            if _v.shape[1] > 100:
                _entry['columns_truncated'] = True
        elif _pkg == 'pandas' and _tn == 'Series':
            _entry['kind'] = 'series'
            _entry['dtype'] = str(_v.dtype)
            _entry['shape'] = [int(_v.shape[0])]
        elif _pkg == 'numpy' and _tn == 'ndarray':
            _entry['kind'] = 'ndarray'
            _entry['dtype'] = str(_v.dtype)
            _entry['shape'] = [int(_d) for _d in _v.shape]
        elif _mod.startswith('pyspark') and _tn == 'DataFrame':
            _entry['kind'] = 'spark_dataframe'
            _entry['columns'] = [{'name': _f.name, 'dtype': _f.dataType.simpleString()}
                                 for _f in list(_v.schema.fields)[:200]]
    except Exception:
        pass
    return _entry
`;

// list_variables: every user DATA variable (skipping modules/functions/classes/
// dunders/library scaffolding — the same filter kernel_state uses) with its type
// and, for frames/arrays, its schema.
const LIST_VARS_PROBE = `
import json as _cj, inspect as _cellar_ins
${DESCRIBE_HELPER}
def _cellar_list_vars():
    try:
        _ip = get_ipython(); _ns = _ip.user_ns; _hidden = set(_ip.user_ns_hidden)
    except Exception:
        _ns = globals(); _hidden = set()
    _skip_type_mods = {'typing', 'abc', 'IPython.core.magic'}
    _out = []
    for _k, _v in list(_ns.items()):
        if _k.startswith('_') or _k in _hidden:
            continue
        if _k in ('In', 'Out', 'exit', 'quit', 'get_ipython'):
            continue
        try:
            if (_cellar_ins.ismodule(_v) or _cellar_ins.isfunction(_v)
                    or _cellar_ins.isbuiltin(_v) or _cellar_ins.isroutine(_v)
                    or _cellar_ins.isclass(_v)):
                continue
        except Exception:
            continue
        if getattr(type(_v), '__module__', '') in _skip_type_mods:
            continue
        try:
            _out.append(_cellar_describe(_k, _v))
        except Exception:
            pass
    _out.sort(key=lambda _r: _r['name'])
    return _out
print(_cj.dumps(_cellar_list_vars()))
del _cellar_list_vars, _cellar_describe
`;

// inspect_variable: one variable in detail. Bounded — a DataFrame/Series head is
// the first HEAD_ROWS rows, dict keys and sequence items are capped, an array's
// head is the first HEAD_ROWS flattened values. Prints {found:false} when the
// name is unset. The target name is injected as a JSON literal (valid Python).
const INSPECT_PROBE_HEAD = `
import json as _cj
def _cellar_inspect(_target):
    try:
        _ip = get_ipython(); _ns = _ip.user_ns
    except Exception:
        _ns = globals()
    _MISS = object()
    _v = _ns.get(_target, _MISS)
    if _v is _MISS:
        return {'found': False, 'name': _target}
    _N = 10
    _t = type(_v)
    _tn = _t.__name__
    _mod = getattr(_t, '__module__', '') or ''
    _pkg = _mod.split('.')[0]
    _entry = {'found': True, 'name': _target, 'type': _tn}
    if _mod and _mod != 'builtins':
        _entry['module'] = _mod
    try:
        _r = repr(_v)
    except Exception:
        _r = '<unreprable>'
    _r = ' '.join(_r.split())
    if len(_r) > 2000:
        _r = _r[:1997] + '...'
    _entry['repr'] = _r
    try:
        if _pkg == 'pandas' and _tn == 'DataFrame':
            _entry['kind'] = 'dataframe'
            _entry['shape'] = [int(_v.shape[0]), int(_v.shape[1])]
            _entry['columns'] = [{'name': str(_c), 'dtype': str(_dt)}
                                 for _c, _dt in list(zip(_v.columns, _v.dtypes))[:200]]
            _entry['index_names'] = [None if _n is None else str(_n) for _n in _v.index.names]
            _entry['head'] = _cj.loads(_v.head(_N).to_json(orient='records', date_format='iso', default_handler=str))
            _entry['head_rows'] = int(min(_N, _v.shape[0]))
        elif _pkg == 'pandas' and _tn == 'Series':
            _entry['kind'] = 'series'
            _entry['dtype'] = str(_v.dtype)
            _entry['size'] = int(_v.shape[0])
            _entry['head'] = _cj.loads(_v.head(_N).to_json(date_format='iso', default_handler=str))
        elif _pkg == 'numpy' and _tn == 'ndarray':
            _entry['kind'] = 'ndarray'
            _entry['dtype'] = str(_v.dtype)
            _entry['shape'] = [int(_d) for _d in _v.shape]
            _entry['size'] = int(_v.size)
            try:
                import numpy as _np
                if _v.size and _np.issubdtype(_v.dtype, _np.number):
                    _entry['stats'] = {'min': float(_np.nanmin(_v)),
                                       'max': float(_np.nanmax(_v)),
                                       'mean': float(_np.nanmean(_v))}
            except Exception:
                pass
            try:
                _entry['head'] = _cj.loads(_cj.dumps(_v.ravel()[:_N].tolist(), default=str))
            except Exception:
                pass
        elif _mod.startswith('pyspark') and _tn == 'DataFrame':
            _entry['kind'] = 'spark_dataframe'
            _entry['columns'] = [{'name': _f.name, 'dtype': _f.dataType.simpleString()}
                                 for _f in list(_v.schema.fields)[:200]]
            _entry['note'] = 'schema only; not collected to avoid triggering a Spark job. Use databricks_preview_table or .limit(N).toPandas().'
        elif isinstance(_v, dict):
            _entry['kind'] = 'dict'
            _entry['size'] = len(_v)
            _entry['keys'] = [str(_key) for _key in list(_v.keys())[:100]]
            if len(_v) > 100:
                _entry['keys_truncated'] = True
        elif isinstance(_v, (list, tuple, set, frozenset)):
            _entry['kind'] = 'sequence'
            _entry['size'] = len(_v)
            _head = []
            for _it in list(_v)[:_N]:
                try:
                    _ir = repr(_it)
                except Exception:
                    _ir = '<unreprable>'
                _ir = ' '.join(_ir.split())
                if len(_ir) > 200:
                    _ir = _ir[:197] + '...'
                _head.append(_ir)
            _entry['head'] = _head
        else:
            _entry['kind'] = 'scalar'
            try:
                if hasattr(_v, '__len__'):
                    _entry['size'] = len(_v)
            except Exception:
                pass
    except Exception as _e:
        _entry['detail_error'] = str(_e)
    return _entry
`;

/** Guard shared by the two agent inspection tools: never boot a kernel, never
 *  queue a probe behind a running cell. Returns a short-circuit payload or null. */
function inspectionGuard() {
	const status = kernelStatus().status;
	if (status === 'not_started') return { started: false, session_id: null };
	if (status === 'busy') return { started: true, busy: true, session_id: kernelSession().session_id };
	return null;
}

/**
 * MCP `list_variables`: the live kernel's data variables with type + schema
 * (DataFrame shape/columns/dtypes, numpy dtype/shape, container sizes). Read-only
 * introspection; reflects only the LIVE session (`session_id`, `stale`). Returns
 * `{ started: false }` when no kernel is running (never boots one).
 */
export async function listVariables() {
	const guard = inspectionGuard();
	if (guard) return guard;
	const { session, line } = await execProbe(LIST_VARS_PROBE);
	const stale = session !== currentSessionId();
	return {
		started: true,
		session_id: session,
		...(stale ? { stale: true } : {}),
		variables: line ? JSON.parse(line) : []
	};
}

/**
 * MCP `inspect_variable`: one variable in detail (full type, shape/len,
 * DataFrame columns + a small head sample, array stats, dict keys, …), bounded so
 * a huge object never floods the output. `found:false` when the name is unset in
 * the live namespace. Reflects only the LIVE session.
 */
export async function inspectVariable(name) {
	const guard = inspectionGuard();
	if (guard) return guard;
	const code = INSPECT_PROBE_HEAD + `\nprint(_cj.dumps(_cellar_inspect(${JSON.stringify(String(name))})))\ndel _cellar_inspect\n`;
	const { session, line } = await execProbe(code);
	const stale = session !== currentSessionId();
	const detail = line ? JSON.parse(line) : { found: false, name };
	return { started: true, session_id: session, ...(stale ? { stale: true } : {}), ...detail };
}
