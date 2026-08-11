/**
 * Databricks-style parameter widgets — a Cellar-native `dbutils.widgets` shim
 * injected at kernel start.
 *
 * WHAT IT IS. Databricks notebooks declare parameters with
 * `dbutils.widgets.text/dropdown/combobox/multiselect(...)` and read them with
 * `.get(...)`. That API is, in the `databricks-sdk`, itself a thin wrapper over
 * **ipywidgets** (`IPyWidgetUtil`). Cellar already has a complete bidirectional
 * ipywidgets rail (the same one the Spark progress bar rides), so we own a native
 * `dbutils`-compatible object backed by ipywidgets. The upshot: on ANY plain
 * ipykernel — no Databricks auth, no cluster — `dbutils.widgets.text("p","x")`
 * renders a real interactive control inline (via `IPython.display`, riding the
 * existing widget comm) and `dbutils.widgets.get("p")` reads the live value.
 *
 * RETURN-TYPE PARITY. Databricks `.get()` always returns **strings**, and
 * `multiselect` is **comma-joined**. `_cellar_widget_value` matches that exactly
 * so `int(dbutils.widgets.get("n"))` behaves as users expect.
 *
 * GUARDED / SILENT NO-OP. Cellar only guarantees `ipykernel`, not `ipywidgets`.
 * When `ipywidgets` is absent the shim degrades to a **value-only** registry (the
 * SDK's `DefaultValueOnlyWidgetUtils` behavior): declarations store their default,
 * `.get()` returns it, nothing renders — never a hard failure, matching the Spark
 * progress bar's guard. `dbutils` is always bound so Databricks code never
 * NameErrors.
 *
 * DATABRICKS INTERACTION. The native shim is the default `dbutils` EVERYWHERE. On
 * a Databricks connect Cellar binds `spark`/`w` but deliberately does NOT rebind
 * `dbutils` (see `databricks.ts` `CONNECT_CODE`), so the native shim keeps owning
 * the bare `dbutils.widgets.*` name that pasted Databricks code uses, and the
 * SDK's own `w.dbutils` stays untouched and reachable. No double-binding.
 *
 * THE SDK IMPORT PATH (and why binding the bare global is not enough). Databricks
 * library code that must run both on and off a cluster does not use the bare name -
 * it writes `from databricks.sdk.runtime import dbutils`. Off a cluster that yields
 * the SDK's own `RemoteDbUtils` -> `IPyWidgetUtil`, which on re-declaration
 * DISCARDS the existing widget and builds a fresh one at the default
 * (`databricks/sdk/_widgets/ipywidgets_utils.py`). The idiomatic parser declares
 * and reads in one pass, so on that path an edited value can never be observed -
 * not on re-run, not ever - while the controls still render (the SDK uses
 * ipywidgets too). That is SILENT inertness: rendered controls are exactly the
 * signal a user reads as "this works". So when Cellar is advertising a Databricks
 * runtime (`DATABRICKS_RUNTIME_VERSION`, the whole point of which is to send
 * `IS_DATABRICKS`-gated code down its `dbutils.widgets` path), the installer ALSO
 * points `databricks.sdk.runtime.dbutils` at this same shim instance, so both
 * access paths share one value-preserving registry. Scoped to the advertised
 * runtime deliberately: mutating a third-party module's attribute is defensible
 * exactly where Cellar is already emulating the runtime that module is written
 * for. `w.dbutils` is a DIFFERENT object and stays untouched (above).
 *
 * TESTABILITY (mirrors `SPARK_PROGRESS_CORE_PY`). The pure core is
 * parameterized by an injected widget factory (`_ipw`) and `display`, so
 * `tests/unit/widgets-shim.test.ts` drives it with a FAKE ipywidgets module — no
 * real ipywidgets needed to prove the value/return-type behavior.
 */

// The module name, the probe→state rule and the user-facing sentence live in the
// browser-safe `$lib/dbutilsShim` so the sidebar renders the same copy this file's
// probe drives (the `databricksReauth.ts` precedent).
import { SDK_RUNTIME_MODULE } from '../dbutilsShim';

/**
 * The pure, ipywidgets-agnostic core: the value coercion + the `_CellarWidgets`
 * registry, parameterized by an injected `_ipw` (the ipywidgets module, or None
 * for value-only) and `_display`. Defines no imports; the installer supplies them.
 */
export const WIDGETS_SHIM_CORE_PY = `
def _cellar_widget_value(_raw):
    # Databricks parity: values are always strings; a list/tuple (multiselect)
    # is comma-joined; None stays None.
    if _raw is None or isinstance(_raw, str):
        return _raw
    if isinstance(_raw, (list, tuple)):
        return ','.join(str(_x) for _x in _raw)
    return str(_raw)


class _CellarValueHolder:
    # Stand-in "widget" for the value-only (no-ipywidgets) mode: just holds a value.
    def __init__(self, value):
        self.value = value


class _CellarWidgets:
    # ipywidgets-backed when _ipw/_display are provided; value-only otherwise.
    def __init__(self, _ipw=None, _display=None):
        self._ipw = _ipw
        self._display = _display
        self._widgets = {}
        self._meta = {}

    def _preserved_value(self, name, kind, opts):
        # Databricks parity: re-declaring an existing widget PRESERVES the current
        # value instead of resetting to the default, but only when the new spec is
        # compatible. Returns (True, value) to carry a value over, else (False, None)
        # to keep the new default. Kept independent of the widget backend so the
        # value-only mode reconciles identically to the ipywidgets mode.
        _old = self._widgets.get(name)
        _oldmeta = self._meta.get(name)
        if _old is None or _oldmeta is None:
            return (False, None)
        if _oldmeta[0] != kind:
            return (False, None)
        _cur = _old.value
        if kind == 'multiselect':
            return (True, tuple(_x for _x in _cur if _x in opts))
        if kind in ('dropdown', 'combobox'):
            return (True, _cur) if _cur in opts else (False, None)
        return (True, _cur)

    def _register(self, name, kind, value_widget, label, opts=None):
        _carry, _val = self._preserved_value(name, kind, opts)
        if _carry:
            try:
                value_widget.value = _val
            except Exception:
                pass
        self._widgets[name] = value_widget
        self._meta[name] = (kind, opts)
        if self._ipw is not None and self._display is not None:
            try:
                _lbl = self._ipw.Label(value=(label if label is not None else name))
                self._display(self._ipw.HBox([_lbl, value_widget]))
            except Exception:
                pass

    def text(self, name, defaultValue='', label=None):
        _v = str(defaultValue)
        _w = self._ipw.Text(value=_v) if self._ipw is not None else _CellarValueHolder(_v)
        self._register(name, 'text', _w, label)

    def dropdown(self, name, defaultValue, choices, label=None):
        _opts = [str(_c) for _c in choices]
        _v = str(defaultValue)
        _w = self._ipw.Dropdown(value=_v, options=_opts) if self._ipw is not None else _CellarValueHolder(_v)
        self._register(name, 'dropdown', _w, label, _opts)

    def combobox(self, name, defaultValue, choices, label=None):
        _opts = [str(_c) for _c in choices]
        _v = str(defaultValue)
        _w = self._ipw.Combobox(value=_v, options=_opts) if self._ipw is not None else _CellarValueHolder(_v)
        self._register(name, 'combobox', _w, label, _opts)

    def multiselect(self, name, defaultValue, choices, label=None):
        _opts = [str(_c) for _c in choices]
        _dv = str(defaultValue)
        _init = (_dv,) if _dv in _opts else ()
        _w = self._ipw.SelectMultiple(value=_init, options=_opts) if self._ipw is not None else _CellarValueHolder(_init)
        self._register(name, 'multiselect', _w, label, _opts)

    def get(self, name):
        if name not in self._widgets:
            raise KeyError("No input widget named '%s' is defined" % name)
        return _cellar_widget_value(self._widgets[name].value)

    def getArgument(self, name, defaultValue=None):
        try:
            return self.get(name)
        except Exception:
            return defaultValue

    def getAll(self):
        return {_k: _cellar_widget_value(_w.value) for _k, _w in self._widgets.items()}

    def remove(self, name):
        self._widgets.pop(name, None)
        self._meta.pop(name, None)

    def removeAll(self):
        self._widgets.clear()
        self._meta.clear()


class _CellarUndefinedOption:
    # A Scala-\`Option\`-like "None". Databricks driver APIs return \`Option[str]\`
    # (apiUrl/apiToken/...), and libraries probe them with .isDefined()/.get()/
    # .getOrElse() before use. There is no real Databricks driver behind Cellar,
    # so every option is honestly UNDEFINED - that is what lets a probing library
    # (mlflow first) fall through its "not really on a driver" branch instead of
    # trusting a fabricated URL/token. It is falsy so a bare truthiness check also
    # reads empty.
    def isDefined(self):
        return False
    def isEmpty(self):
        return True
    def nonEmpty(self):
        return False
    def get(self):
        return None
    def getOrElse(self, _default=None):
        return _default
    def orNull(self):
        return None
    def map(self, _f):
        return self
    def foreach(self, _f):
        return None
    def __bool__(self):
        return False
    def __getattr__(self, _name):
        # Any other Option method (.exists/.filter/.flatMap/.orElse/.contains/
        # .fold/.toList/...) → a callable returning this same undefined option, so
        # a chain stays falsy/undefined and never raises mid-chain.
        return lambda *a, **k: self


class _CellarNotebookContext:
    # entry_point.getDbutils().notebook().getContext(). Its values (apiUrl,
    # apiToken, notebookId, clusterId, ...) are all Scala Options in a real
    # runtime, so any getter here returns an undefined option - never raises.
    def __getattr__(self, _name):
        return lambda *a, **k: _CellarUndefinedOption()


class _CellarNotebookProxy:
    def getContext(self, *a, **k):
        return _CellarNotebookContext()
    def __getattr__(self, _name):
        return lambda *a, **k: None


class _CellarDbutilsProxy:
    # entry_point.getDbutils()
    def notebook(self, *a, **k):
        return _CellarNotebookProxy()
    def __getattr__(self, _name):
        return lambda *a, **k: None


class _CellarDriverConf:
    def workflowSslTrustAll(self, *a, **k):
        return False
    def __getattr__(self, _name):
        return lambda *a, **k: None


class _CellarEntryPoint:
    # A faithful "no real Databricks driver" \`dbutils.entry_point\`. Cellar sets
    # DATABRICKS_RUNTIME_VERSION so a library believes it is on a runtime and then
    # reaches for the driver-only entry point (e.g. mlflow's module-level
    # _init_databricks_dynamic_token_config_provider(dbutils.entry_point) in
    # databricks_utils.py). Every method a probing library reaches for must exist
    # and return an honest undefined/None so attribute/method access never raises;
    # otherwise the AttributeError propagates and kills the import (mlflow only
    # catches _NoDbutilsError). See AGENTS.md.
    def getDbutils(self, *a, **k):
        return _CellarDbutilsProxy()
    def getDriverConf(self, *a, **k):
        return _CellarDriverConf()
    def __getattr__(self, _name):
        # getLogger / getNonUcApiToken / getReplId / getJobGroupId /
        # clearMlflowProperties / get{Repl,User}{Local,NFS}TempDir / ... - all
        # undefined here → a callable returning None, never a missing attribute.
        return lambda *a, **k: None


class _CellarDbUtils:
    def __init__(self, widgets):
        self.widgets = widgets
        # A compatible entry_point so driver-API-probing libraries (mlflow, ...)
        # see honest undefined/None values instead of an AttributeError at import.
        self.entry_point = _CellarEntryPoint()


_CELLAR_SDK_RUNTIME = '${SDK_RUNTIME_MODULE}'


class _CellarSdkRuntimeLoader:
    # Wraps the REAL loader for \`databricks.sdk.runtime\` and repoints its
    # \`dbutils\` the instant the module finishes executing - i.e. before the
    # \`from ... import dbutils\` that triggered the import reads the attribute.
    # Python has no built-in post-import hook (PEP 369 was withdrawn), so wrapping
    # the loader is the mechanism; everything else is delegated untouched.
    def __init__(self, inner, bind):
        self._inner = inner
        self._bind = bind

    def create_module(self, spec):
        return self._inner.create_module(spec)

    def exec_module(self, module):
        self._inner.exec_module(module)
        self._bind(module)

    def __getattr__(self, name):
        return getattr(self._inner, name)


class _CellarSdkRuntimeFinder:
    # A meta-path finder that claims ONLY \`databricks.sdk.runtime\`, re-resolves it
    # through the normal machinery (skipping itself via _busy, so the real spec is
    # found) and hands back the same spec with a wrapping loader. Anything it
    # cannot resolve it declines, so a workspace without databricks-sdk imports
    # exactly as before. This is the half that covers an import happening AFTER
    # the shim ran; the installer covers a module already in sys.modules.
    #
    # SELF-CONTAINED ON PURPOSE: this instance lives in \`sys.meta_path\`, which
    # OUTLIVES the kernel's user namespace, so it must never read a module-level
    # name. A namespace clear that is not a process restart (\`%reset -f\` being the
    # everyday one) removes the shim's globals while leaving this finder installed;
    # resolving the module name or the loader class as globals then raised NameError
    # on the very first comparison, and the import system does not swallow a
    # finder's exception - so EVERY import in the kernel failed, not just this one.
    # Everything it needs is captured on the instance in __init__, and the body is
    # additionally wrapped so a broken finder can only ever DECLINE.
    _cellar_sdk_runtime_finder = True

    def __init__(self, name, loader_cls, bind):
        self._name = name
        self._loader_cls = loader_cls
        self._bind = bind
        self._busy = False

    def find_spec(self, fullname, path=None, target=None):
        try:
            if fullname != self._name or self._busy:
                return None
            import importlib.util as _util
            self._busy = True
            try:
                _spec = _util.find_spec(fullname)
            except Exception:
                return None
            finally:
                self._busy = False
            if _spec is None or getattr(_spec, 'loader', None) is None:
                return None
            _spec.loader = self._loader_cls(_spec.loader, self._bind)
            return _spec
        except Exception:
            return None


def _cellar_bind_sdk_dbutils(_db):
    # Make \`from databricks.sdk.runtime import dbutils\` reach the SAME shim
    # instance as the bare global - whether that module is imported BEFORE this
    # runs (patch it in place) or AFTER (the finder above). Best-effort
    # throughout: a failure here must never break kernel bring-up, and the
    # detect-and-report probe surfaces a binding that did not take.
    import sys as _sys

    # Read the module name and the loader class HERE, while the shim's globals are
    # known to exist, and hand them to the finder as instance state: the finder
    # outlives this namespace (see its own note), so it may not look them up later.
    _name = _CELLAR_SDK_RUNTIME
    _loader_cls = _CellarSdkRuntimeLoader

    def _bind(_mod):
        try:
            _mod.dbutils = _db
        except Exception:
            pass

    _mod = _sys.modules.get(_name)
    if _mod is not None:
        _bind(_mod)
    # Idempotent: drop a finder left by an earlier install (it closes over a stale
    # shim instance) rather than stacking a second one.
    _sys.meta_path[:] = [
        _f for _f in _sys.meta_path
        if getattr(_f, '_cellar_sdk_runtime_finder', False) is not True
    ]
    _sys.meta_path.insert(0, _CellarSdkRuntimeFinder(_name, _loader_cls, _bind))
`;

/**
 * The guarded installer: import ipywidgets + IPython.display (silent value-only
 * degrade if either is absent), build the registry, bind the global `dbutils`, and
 * - only while a Databricks runtime is being advertised - point the SDK import
 * path at that same shim. Runs on every fresh start AND after a restart (which
 * clears the namespace), so `dbutils` is always present and a restart resets the
 * widget registry.
 *
 * The runtime gate reads `DATABRICKS_RUNTIME_VERSION` straight from the
 * environment rather than taking a flag from TypeScript: `kernel.ts` injects that
 * env var (from `shouldInjectDatabricksRuntime`) as the FIRST startup part of the
 * same coalesced exec, so the env IS the decision - reading it here cannot drift
 * from it, and it needs no new plumbing.
 */
export const WIDGETS_SHIM_INSTALL_PY = `
def _cellar_install_widgets():
    _g = globals()
    try:
        import ipywidgets as _ipw
    except Exception:
        _ipw = None
    _display = None
    if _ipw is not None:
        try:
            from IPython.display import display as _display
        except Exception:
            _ipw = None
            _display = None
    _db = _CellarDbUtils(_CellarWidgets(_ipw, _display))
    _g['dbutils'] = _db
    import os as _os
    if _os.environ.get('DATABRICKS_RUNTIME_VERSION'):
        try:
            _cellar_bind_sdk_dbutils(_db)
        except Exception:
            pass
_cellar_install_widgets()
del _cellar_install_widgets
`;

/**
 * Kernel-side probe for the above. Self-contained on purpose - it looks every
 * shim name up through `globals()` rather than calling into the shim, so it still
 * answers honestly when the shim install itself failed (`shim: false`) instead of
 * dying with a NameError. Prints ONE `sentinel`-prefixed JSON line, like the
 * Databricks `PROBE`/`PING_CODE` it is run alongside, and cleans up after itself.
 */
export function dbutilsBindingProbeCode(sentinel: string): string {
	return `
import json as _cellar_json, sys as _cellar_sys

def _cellar_dbutils_binding():
    _g = globals()
    _cls = _g.get('_CellarDbUtils')
    _db = _g.get('dbutils')
    _is_shim = _cls is not None and isinstance(_db, _cls)
    _mod = _cellar_sys.modules.get('${SDK_RUNTIME_MODULE}')
    if _mod is None:
        return {'ok': True, 'shim': _is_shim, 'sdk_imported': False, 'sdk_is_shim': None}
    return {'ok': True, 'shim': _is_shim, 'sdk_imported': True,
            'sdk_is_shim': _is_shim and getattr(_mod, 'dbutils', None) is _db}

try:
    print('${sentinel}' + _cellar_json.dumps(_cellar_dbutils_binding()))
except Exception as _e:
    print('${sentinel}' + _cellar_json.dumps(
        {'ok': False, 'message': '%s: %s' % (type(_e).__name__, _e)}))
finally:
    del _cellar_dbutils_binding, _cellar_json, _cellar_sys
`;
}


/**
 * Full injection: the core (classes) + the installer that binds `dbutils`. Added
 * to `initKernel`'s coalesced startup exec alongside the matplotlib magic, the
 * DataFrame formatter, and the `%restart_python` magic.
 */
export const WIDGETS_SHIM_CODE = `${WIDGETS_SHIM_CORE_PY}\n${WIDGETS_SHIM_INSTALL_PY}`;
