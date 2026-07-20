/**
 * Databricks-style parameter widgets — the native `dbutils.widgets` shim's
 * value/return-type behavior.
 *
 * These spawn the REAL kernel-side Python (`WIDGETS_SHIM_CORE_PY` from
 * `widgetsShim.ts`, the exact string injected at kernel start) driven by a FAKE
 * ipywidgets module, mirroring `spark-progress.test.ts` / `dataflow-*.test.ts`:
 * no hand-written re-implementation of the logic, so the test can only pass if
 * the code the kernel actually runs behaves as claimed — and it needs no real
 * `ipywidgets` installed (the core is parameterized by an injected widget
 * factory).
 *
 * The contract under test is Databricks `.get()` parity:
 *   - every value is returned as a STRING;
 *   - `multiselect` is COMMA-JOINED;
 *   - `getArgument` falls back on a missing widget, `getAll`/`remove`/`removeAll`
 *     behave; and the value-only degrade (no ipywidgets) still returns defaults.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { WIDGETS_SHIM_CORE_PY } from '../../src/lib/server/widgetsShim';

/**
 * A Python driver: exec the real core, drive it with a call-recording fake
 * ipywidgets module (each fake widget just holds a `.value`, exactly the trait
 * `.get()` reads), and print one JSON blob of results.
 */
const DRIVER = `
${WIDGETS_SHIM_CORE_PY}
import json


class _FakeText:
    def __init__(self, value=''):
        self.value = value


class _FakeDropdown:
    def __init__(self, value=None, options=None):
        self.value = value
        self.options = options


class _FakeCombobox:
    def __init__(self, value=None, options=None):
        self.value = value
        self.options = options


class _FakeSelectMultiple:
    def __init__(self, value=(), options=None):
        self.value = tuple(value)
        self.options = options


class _FakeLabel:
    def __init__(self, value=''):
        self.value = value


class _FakeHBox:
    def __init__(self, children):
        self.children = children


class _FakeIpw:
    Text = _FakeText
    Dropdown = _FakeDropdown
    Combobox = _FakeCombobox
    SelectMultiple = _FakeSelectMultiple
    Label = _FakeLabel
    HBox = _FakeHBox


_displayed = []


def _fake_display(w):
    _displayed.append(w)


out = {}

# --- value coercion parity ---
out['coerce'] = {
    'none': _cellar_widget_value(None),
    'str': _cellar_widget_value('hi'),
    'int': _cellar_widget_value(5),
    'bool': _cellar_widget_value(True),
    'tuple': _cellar_widget_value(('a', 'b')),
    'list': _cellar_widget_value(['x', 'y', 'z']),
    'empty_tuple': _cellar_widget_value(()),
}

# --- ipywidgets-backed registry ---
wg = _CellarWidgets(_FakeIpw, _fake_display)
wg.text('name', 'Alice', label='Your name')
wg.dropdown('color', 'red', ['red', 'green', 'blue'])
wg.combobox('city', 'NYC', ['NYC', 'LA'])
wg.multiselect('tags', 'a', ['a', 'b', 'c'])

out['get_text'] = wg.get('name')
out['get_dropdown'] = wg.get('color')
out['get_combobox'] = wg.get('city')
out['get_multiselect_default'] = wg.get('tags')

# user changes the multiselect (kernel derives .value from index)
wg._widgets['tags'].value = ('a', 'c')
out['get_multiselect_multi'] = wg.get('tags')

# user edits the text
wg._widgets['name'].value = 'Bob'
out['get_text_after_edit'] = wg.get('name')

out['getAll'] = wg.getAll()
out['getArgument_present'] = wg.getArgument('color', 'fallback')
out['getArgument_missing'] = wg.getArgument('nope', 'fallback')

try:
    wg.get('nope')
    out['get_missing_raises'] = False
except Exception:
    out['get_missing_raises'] = True

wg.remove('color')
out['after_remove'] = sorted(wg.getAll().keys())
wg.removeAll()
out['after_removeAll'] = wg.getAll()

out['displayed_count'] = len(_displayed)

# --- value-only degrade (no ipywidgets) ---
vo = _CellarWidgets(None, None)
vo.text('t', 42)
vo.dropdown('d', 'x', ['x', 'y'])
vo.multiselect('m', 'b', ['a', 'b'])
out['vo_text'] = vo.get('t')
out['vo_dropdown'] = vo.get('d')
out['vo_multiselect'] = vo.get('m')
out['vo_displayed_unchanged'] = len(_displayed)

# --- the dbutils wrapper ---
db = _CellarDbUtils(_CellarWidgets(None, None))
db.widgets.text('p', 'v')
out['dbutils_get'] = db.widgets.get('p')

print(json.dumps(out))
`;

function runShim(): Record<string, unknown> {
	const stdout = execFileSync('python3', ['-'], { input: DRIVER, encoding: 'utf8' });
	return JSON.parse(stdout);
}

describe('dbutils.widgets shim — value/return-type parity', () => {
	const out = runShim();

	it('coerces every value to a Databricks-parity string (multiselect comma-joined)', () => {
		expect(out.coerce).toEqual({
			none: null,
			str: 'hi',
			int: '5',
			bool: 'True',
			tuple: 'a,b',
			list: 'x,y,z',
			empty_tuple: ''
		});
	});

	it('reads live widget values back as strings', () => {
		expect(out.get_text).toBe('Alice');
		expect(out.get_dropdown).toBe('red');
		expect(out.get_combobox).toBe('NYC');
		expect(out.get_multiselect_default).toBe('a');
	});

	it('reflects user changes (multiselect comma-joins the selection)', () => {
		expect(out.get_multiselect_multi).toBe('a,c');
		expect(out.get_text_after_edit).toBe('Bob');
	});

	it('supports getAll / getArgument / remove / removeAll', () => {
		expect(out.getAll).toEqual({ name: 'Bob', color: 'red', city: 'NYC', tags: 'a,c' });
		expect(out.getArgument_present).toBe('red');
		expect(out.getArgument_missing).toBe('fallback');
		expect(out.get_missing_raises).toBe(true);
		expect(out.after_remove).toEqual(['city', 'name', 'tags']);
		expect(out.after_removeAll).toEqual({});
	});

	it('displays one widget per registration (interactive mode)', () => {
		expect(out.displayed_count).toBe(4);
	});

	it('degrades to value-only when ipywidgets is absent (defaults, no display)', () => {
		expect(out.vo_text).toBe('42');
		expect(out.vo_dropdown).toBe('x');
		expect(out.vo_multiselect).toBe('b');
		expect(out.vo_displayed_unchanged).toBe(4); // unchanged: value-only never displays
	});

	it('exposes the registry through the dbutils wrapper', () => {
		expect(out.dbutils_get).toBe('v');
	});
});
