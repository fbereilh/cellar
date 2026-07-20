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
 * TESTABILITY (mirrors `SPARK_PROGRESS_CORE_PY`). The pure core is
 * parameterized by an injected widget factory (`_ipw`) and `display`, so
 * `tests/unit/widgets-shim.test.ts` drives it with a FAKE ipywidgets module — no
 * real ipywidgets needed to prove the value/return-type behavior.
 */

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

    def _register(self, name, value_widget, label):
        self._widgets[name] = value_widget
        if self._ipw is not None and self._display is not None:
            try:
                _lbl = self._ipw.Label(value=(label if label is not None else name))
                self._display(self._ipw.HBox([_lbl, value_widget]))
            except Exception:
                pass

    def text(self, name, defaultValue='', label=None):
        _v = str(defaultValue)
        _w = self._ipw.Text(value=_v) if self._ipw is not None else _CellarValueHolder(_v)
        self._register(name, _w, label)

    def dropdown(self, name, defaultValue, choices, label=None):
        _opts = [str(_c) for _c in choices]
        _v = str(defaultValue)
        _w = self._ipw.Dropdown(value=_v, options=_opts) if self._ipw is not None else _CellarValueHolder(_v)
        self._register(name, _w, label)

    def combobox(self, name, defaultValue, choices, label=None):
        _opts = [str(_c) for _c in choices]
        _v = str(defaultValue)
        _w = self._ipw.Combobox(value=_v, options=_opts) if self._ipw is not None else _CellarValueHolder(_v)
        self._register(name, _w, label)

    def multiselect(self, name, defaultValue, choices, label=None):
        _opts = [str(_c) for _c in choices]
        _dv = str(defaultValue)
        _init = (_dv,) if _dv in _opts else ()
        _w = self._ipw.SelectMultiple(value=_init, options=_opts) if self._ipw is not None else _CellarValueHolder(_init)
        self._register(name, _w, label)

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

    def removeAll(self):
        self._widgets.clear()


class _CellarDbUtils:
    def __init__(self, widgets):
        self.widgets = widgets
`;

/**
 * The guarded installer: import ipywidgets + IPython.display (silent value-only
 * degrade if either is absent), build the registry, bind the global `dbutils`.
 * Runs on every fresh start AND after a restart (which clears the namespace), so
 * `dbutils` is always present and a restart resets the widget registry.
 */
const WIDGETS_SHIM_INSTALL_PY = `
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
    _g['dbutils'] = _CellarDbUtils(_CellarWidgets(_ipw, _display))
_cellar_install_widgets()
del _cellar_install_widgets
`;

/**
 * Full injection: the core (classes) + the installer that binds `dbutils`. Added
 * to `initKernel`'s coalesced startup exec alongside the matplotlib magic, the
 * DataFrame formatter, and the `%restart_python` magic.
 */
export const WIDGETS_SHIM_CODE = `${WIDGETS_SHIM_CORE_PY}\n${WIDGETS_SHIM_INSTALL_PY}`;
