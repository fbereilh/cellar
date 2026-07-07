/**
 * Cellar — kernel variable inspector (shell sidebar).
 *
 * Introspects the live kernel's user namespace by running a small Python probe
 * through the existing execute() bridge (no new kernel wiring) and parsing the
 * JSON it prints. Reports name / type / shape / short preview for each
 * user-defined variable, Jupyter-inspector style. Read-only: the probe defines
 * only underscore-prefixed temporaries and deletes them, so it neither shows up
 * in nor pollutes the inspected namespace.
 */
import { execute } from './kernel.js';

// Report only user-defined *data* variables, Jupyter-inspector style. We start
// from IPython's user namespace minus the names it already marks hidden (its
// injected builtins), then drop modules / functions / classes and library
// scaffolding (typing constructs, magics) that startup code leaves in globals.
// Everything the probe defines is underscore-prefixed, so it hides itself.
const PROBE = `
import json as _cellar_json, inspect as _cellar_ins
def _cellar_inspect():
    try:
        _ip = get_ipython()
        _ns = _ip.user_ns
        _hidden = set(_ip.user_ns_hidden)
    except Exception:
        _ns = globals()
        _hidden = set()
    _skip_type_mods = {'typing', 'abc', 'IPython.core.magic'}
    _out = []
    for _k, _v in list(_ns.items()):
        if _k.startswith('_') or _k in _hidden:
            continue
        if _k in ('In', 'Out', 'exit', 'quit', 'get_ipython'):
            continue
        if (_cellar_ins.ismodule(_v) or _cellar_ins.isfunction(_v)
                or _cellar_ins.isbuiltin(_v) or _cellar_ins.isroutine(_v)
                or _cellar_ins.isclass(_v)):
            continue
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
        _out.append({'name': _k, 'type': type(_v).__name__, 'shape': _shape, 'preview': _p})
    _out.sort(key=lambda _r: _r['name'])
    return _out
print(_cellar_json.dumps(_cellar_inspect()))
del _cellar_inspect
`;

/** Run the probe on the kernel and return the parsed variable list. */
export async function inspectVariables() {
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
	if (!line) return [];
	return JSON.parse(line);
}
