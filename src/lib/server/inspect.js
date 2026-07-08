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
import { execute, kernelStatus } from './kernel.js';

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

/** Run the shared probe on the kernel and return the parsed bucketed state. */
async function runProbe() {
	let stdout = '';
	let errored = null;
	await execute(PROBE, (ev) => {
		if (ev.type === 'output') {
			const o = ev.output;
			if (o.output_type === 'stream' && o.name === 'stdout') {
				stdout += Array.isArray(o.text) ? o.text.join('') : o.text;
			} else if (o.output_type === 'error') {
				errored = `${o.ename}: ${o.evalue}`;
			}
		}
	});
	if (errored) throw new Error(errored);
	// The probe prints exactly one JSON line; take the last non-empty line to be
	// robust against any stray output.
	const line = stdout.trim().split('\n').filter(Boolean).at(-1);
	if (!line) return { imports: [], functions: [], classes: [], variables: [] };
	return JSON.parse(line);
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
 */
export async function kernelState() {
	const status = kernelStatus().status;
	if (status === 'not_started') return { started: false };
	if (status === 'busy') return { started: true, busy: true };
	const state = await runProbe();
	const seen = new Set();
	const imports = [];
	for (const imp of state.imports || []) {
		const key = imp.statement ?? `${imp.module}:${imp.alias}`;
		if (seen.has(key)) continue;
		seen.add(key);
		imports.push(imp);
	}
	return {
		started: true,
		imports,
		functions: state.functions || [],
		classes: state.classes || [],
		variables: state.variables || []
	};
}
