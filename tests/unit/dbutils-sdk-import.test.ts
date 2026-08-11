/**
 * The `dbutils` SDK-import bypass - `from databricks.sdk.runtime import dbutils`
 * must reach Cellar's value-preserving shim, not the SDK's own object.
 *
 * WHY THIS EXISTS. Binding the bare global `dbutils` (which the shim always did)
 * covers pasted Databricks notebook code, but library code written to run both on
 * and off a cluster imports the name instead. Off a cluster that import yields the
 * SDK's `RemoteDbUtils` -> `IPyWidgetUtil`, whose `_register` DISCARDS an existing
 * widget and rebuilds it at the default. The idiomatic parser declares and reads
 * in one pass, so on that path an edited value can NEVER be observed - while the
 * controls still render, because the SDK uses ipywidgets too. Silent inertness.
 *
 * HOW IT IS TESTED. Like `widgets-shim.test.ts`, these spawn the REAL kernel-side
 * Python (`WIDGETS_SHIM_CORE_PY` + `WIDGETS_SHIM_INSTALL_PY`, the exact strings
 * `initKernel` injects) rather than re-implementing anything - but against a FAKE
 * `databricks.sdk.runtime` package written to a temp dir and put first on
 * `sys.path`. Faking it as a real importable package (not a `sys.modules` entry)
 * is the point: the fix's hard half is covering an import that happens AFTER the
 * shim ran, which only the real import machinery can exercise. The fake's
 * `dbutils` reproduces the SDK's reset-on-re-declare behavior, so a test that
 * passes proves the value survived BECAUSE of the rebind.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WIDGETS_SHIM_CORE_PY, WIDGETS_SHIM_INSTALL_PY, dbutilsBindingProbeCode } from '../../src/lib/server/widgetsShim';
import { classifySdkDbutils, SDK_DBUTILS_FOREIGN_WARNING, SDK_RUNTIME_MODULE } from '../../src/lib/dbutilsShim';

/**
 * A stand-in for `databricks/sdk/runtime/__init__.py`. Its `dbutils.widgets`
 * mirrors the ONE behavior this whole feature turns on - databricks-sdk's
 * `IPyWidgetUtil._register` (`if name in self._widgets: self.remove(name)`, then a
 * brand-new widget at the default) - so "the edit survived" can only ever mean
 * "Cellar's shim answered". `_CELLAR_MODULE_EXECUTED` proves the wrapping loader
 * really delegated to the real one instead of replacing the module.
 */
const FAKE_SDK_RUNTIME_PY = `
class _SdkWidgets:
    def __init__(self):
        self._widgets = {}

    def text(self, name, defaultValue='', label=None):
        # databricks-sdk IPyWidgetUtil._register: no carry-over of the live value.
        if name in self._widgets:
            del self._widgets[name]
        self._widgets[name] = str(defaultValue)

    def get(self, name):
        return self._widgets[name]


class _SdkDbUtils:
    def __init__(self):
        self.widgets = _SdkWidgets()


dbutils = _SdkDbUtils()
_CELLAR_MODULE_EXECUTED = True
`;

let fakeRoot: string;

beforeAll(() => {
	fakeRoot = mkdtempSync(join(tmpdir(), 'cellar-sdk-fake-'));
	const runtimeDir = join(fakeRoot, 'databricks', 'sdk', 'runtime');
	mkdirSync(runtimeDir, { recursive: true });
	writeFileSync(join(fakeRoot, 'databricks', '__init__.py'), '');
	writeFileSync(join(fakeRoot, 'databricks', 'sdk', '__init__.py'), '');
	writeFileSync(join(runtimeDir, '__init__.py'), FAKE_SDK_RUNTIME_PY);
});

afterAll(() => rmSync(fakeRoot, { recursive: true, force: true }));

const SENTINEL = '__CELLAR_TEST__';

/**
 * Run `body` in a fresh Python process on top of the real shim source, with the
 * fake package importable. `runtime` decides whether `DATABRICKS_RUNTIME_VERSION`
 * is set BEFORE the installer runs - exactly how `kernel.ts` orders it (the env
 * snippet is the first part of the same coalesced exec), and the gate the rebind
 * gets scoped by. Returns the parsed `out` JSON blob the body prints.
 */
function run(body: string, { runtime = true }: { runtime?: boolean } = {}): Record<string, unknown> {
	const driver = `
import sys, json
sys.path.insert(0, ${JSON.stringify(fakeRoot)})

${WIDGETS_SHIM_CORE_PY}

out = {}
${body}
print(json.dumps(out))
`;
	const env: NodeJS.ProcessEnv = { ...process.env };
	delete env.DATABRICKS_RUNTIME_VERSION;
	if (runtime) env.DATABRICKS_RUNTIME_VERSION = '15.4';
	const stdout = execFileSync('python3', ['-'], { input: driver, encoding: 'utf8', env });
	return JSON.parse(stdout.trim().split('\n').pop() as string);
}

/** The installer, as a body fragment (it is what binds `dbutils` and rebinds the module). */
const INSTALL = WIDGETS_SHIM_INSTALL_PY;

describe('dbutils SDK import path - the rebind', () => {
	it('binds the import path to the same shim when the module is imported AFTER the shim runs', () => {
		const out = run(`
${INSTALL}

from databricks.sdk.runtime import dbutils as imported
import databricks.sdk.runtime as mod

out['same_object'] = imported is dbutils
out['module_attr_is_shim'] = mod.dbutils is dbutils
out['is_cellar_shim'] = isinstance(imported, _CellarDbUtils)
# the wrapping loader must DELEGATE, never replace: the real module body ran
out['module_body_executed'] = getattr(mod, '_CELLAR_MODULE_EXECUTED', False)
`);
		expect(out.same_object).toBe(true);
		expect(out.module_attr_is_shim).toBe(true);
		expect(out.is_cellar_shim).toBe(true);
		expect(out.module_body_executed).toBe(true);
	});

	it('binds the import path when the module was already imported BEFORE the shim runs', () => {
		const out = run(`
import databricks.sdk.runtime as mod
out['sdk_before'] = type(mod.dbutils).__name__

${INSTALL}

from databricks.sdk.runtime import dbutils as imported
out['same_object'] = imported is dbutils
out['is_cellar_shim'] = isinstance(imported, _CellarDbUtils)
`);
		// It really was the SDK's object until the shim ran.
		expect(out.sdk_before).toBe('_SdkDbUtils');
		expect(out.same_object).toBe(true);
		expect(out.is_cellar_shim).toBe(true);
	});

	it('PRESERVES an edited value across a re-declare on the import path (the reported bug)', () => {
		const out = run(`
${INSTALL}

from databricks.sdk.runtime import dbutils

# the idiomatic Databricks parser: declare and read in one pass
dbutils.widgets.text('mode', 'default')
out['initial'] = dbutils.widgets.get('mode')

# the user edits the rendered control
dbutils.widgets._widgets['mode'].value = 'edited'

# re-run the same cell: the SDK would discard the widget and read back 'default'
dbutils.widgets.text('mode', 'default')
out['after_redeclare'] = dbutils.widgets.get('mode')

# and it is byte-identical to what the bare global gives
dbutils.widgets.text('other', 'x')
globals()['dbutils'].widgets._widgets['other'].value = 'y'
globals()['dbutils'].widgets.text('other', 'x')
out['bare_global_after_redeclare'] = dbutils.widgets.get('other')
out['one_registry'] = dbutils.widgets is globals()['dbutils'].widgets
`);
		expect(out.initial).toBe('default');
		expect(out.after_redeclare).toBe('edited');
		expect(out.bare_global_after_redeclare).toBe('y');
		expect(out.one_registry).toBe(true);
	});

	it('leaves the SDK module alone when no runtime is advertised (the scope of the rebind)', () => {
		const out = run(
			`
${INSTALL}

from databricks.sdk.runtime import dbutils as imported
out['import_is_shim'] = isinstance(imported, _CellarDbUtils)
out['bare_is_shim'] = isinstance(globals()['dbutils'], _CellarDbUtils)

# unpatched, the SDK object discards the edit - which is exactly the bug, and what
# makes the preserved-value assertions above mean something.
imported.widgets.text('mode', 'default')
imported.widgets._widgets['mode'] = 'edited'
imported.widgets.text('mode', 'default')
out['sdk_discards_edit'] = imported.widgets.get('mode')
`,
			{ runtime: false }
		);
		expect(out.import_is_shim).toBe(false);
		expect(out.bare_is_shim).toBe(true);
		expect(out.sdk_discards_edit).toBe('default');
	});

	it('is idempotent across re-installs: one import hook, pointing at the current shim', () => {
		const out = run(`
${INSTALL}
_first = dbutils

${INSTALL}

import sys
out['hooks'] = sum(
    1 for f in sys.meta_path if getattr(f, '_cellar_sdk_runtime_finder', False) is True
)
out['fresh_shim'] = dbutils is not _first
from databricks.sdk.runtime import dbutils as imported
# the surviving hook must bind the LATEST shim, not the one it closed over first
out['binds_current'] = imported is dbutils
`);
		expect(out.hooks).toBe(1);
		expect(out.fresh_shim).toBe(true);
		expect(out.binds_current).toBe(true);
	});

	it('declines every other module, so an unrelated import is untouched', () => {
		const out = run(`
${INSTALL}

import json as _j, textwrap as _tw
out['unrelated_imports_ok'] = _tw.dedent('  x') == 'x'
import sys
out['finder_first'] = getattr(sys.meta_path[0], '_cellar_sdk_runtime_finder', False) is True
out['finder_declines'] = sys.meta_path[0].find_spec('textwrap') is None
`);
		expect(out.unrelated_imports_ok).toBe(true);
		expect(out.finder_first).toBe(true);
		expect(out.finder_declines).toBe(true);
	});

	it('never breaks kernel bring-up when databricks-sdk is not installed at all', () => {
		// No fake package on sys.path: the import must simply fail as it always did,
		// and the shim must still have bound the bare global.
		const driver = `
import sys, json
${WIDGETS_SHIM_CORE_PY}
${WIDGETS_SHIM_INSTALL_PY}
out = {}
out['bare_is_shim'] = isinstance(dbutils, _CellarDbUtils)
try:
    import databricks.sdk.runtime  # noqa
    out['import_raised'] = False
except ImportError:
    out['import_raised'] = True
print(json.dumps(out))
`;
		const env: NodeJS.ProcessEnv = { ...process.env, DATABRICKS_RUNTIME_VERSION: '15.4' };
		const stdout = execFileSync('python3', ['-'], { input: driver, encoding: 'utf8', env, cwd: tmpdir() });
		const out = JSON.parse(stdout.trim().split('\n').pop() as string);
		expect(out.bare_is_shim).toBe(true);
		expect(out.import_raised).toBe(true);
	});
});

describe('dbutils SDK import path - detect and report', () => {
	/** Run the REAL probe code and return its parsed sentinel line. */
	function probe(body: string, opts?: { runtime?: boolean }): Record<string, unknown> {
		const out = run(
			`
${body}

import io, contextlib
_buf = io.StringIO()
with contextlib.redirect_stdout(_buf):
${dbutilsBindingProbeCode(SENTINEL)
	.trim()
	.split('\n')
	.map((l) => `    ${l}`)
	.join('\n')}
_line = [l for l in _buf.getvalue().split('\\n') if l.startswith('${SENTINEL}')][0]
out['probe'] = json.loads(_line[len('${SENTINEL}'):])
`,
			opts
		);
		return out.probe as Record<string, unknown>;
	}

	it('reports `not_imported` before any cell imports the SDK', () => {
		const p = probe(INSTALL);
		expect(p.ok).toBe(true);
		expect(p.shim).toBe(true);
		expect(p.sdk_imported).toBe(false);
		expect(classifySdkDbutils(p)).toBe('not_imported');
	});

	it('reports `shim` once the import path resolves to Cellar’s shim', () => {
		const p = probe(`${INSTALL}\nfrom databricks.sdk.runtime import dbutils as _imported`);
		expect(p.sdk_imported).toBe(true);
		expect(p.sdk_is_shim).toBe(true);
		expect(classifySdkDbutils(p)).toBe('shim');
	});

	it('reports `foreign` when the module holds anything else - the silent-inertness case', () => {
		// The shape this really takes in the wild: a kernel started by a build without
		// the rebind, or a module whose `dbutils` was replaced afterwards.
		const p = probe(`
${INSTALL}
import databricks.sdk.runtime as _mod
_mod.dbutils = _mod._SdkDbUtils()
`);
		expect(p.sdk_imported).toBe(true);
		expect(p.sdk_is_shim).toBe(false);
		expect(classifySdkDbutils(p)).toBe('foreign');
	});

	it('reports `foreign` with no rebind installed (a runtime-advertising kernel without the fix)', () => {
		// The install ran with no runtime advertised, so nothing rebound the module -
		// then the notebook imported it. Precisely the reported bug's end state.
		const p = probe(`${INSTALL}\nimport databricks.sdk.runtime as _mod`, { runtime: false });
		expect(classifySdkDbutils(p)).toBe('foreign');
	});

	it('answers honestly when the shim itself never installed (no NameError)', () => {
		// The probe is self-contained on purpose: it must still answer when the
		// namespace has no shim at all, rather than dying and reporting nothing.
		const p = probe('');
		expect(p.ok).toBe(true);
		expect(p.shim).toBe(false);
		expect(classifySdkDbutils(p)).toBe('not_imported');
	});

	it('leaves the namespace clean (the probe is bookkeeping, not a user cell)', () => {
		const out = run(`
${INSTALL}

import io, contextlib
_buf = io.StringIO()
with contextlib.redirect_stdout(_buf):
${dbutilsBindingProbeCode(SENTINEL)
	.trim()
	.split('\n')
	.map((l) => `    ${l}`)
	.join('\n')}
_probe_names = ('_cellar_dbutils_binding', '_cellar_json', '_cellar_sys')
out['leaked'] = sorted(n for n in _probe_names if n in globals())
# the shim's own core globals are untouched by it
out['shim_intact'] = isinstance(dbutils, _CellarDbUtils)
`);
		expect(out.leaked).toEqual([]);
		expect(out.shim_intact).toBe(true);
	});
});

describe('classifySdkDbutils - the pure rule', () => {
	it('maps the probe payload onto the reported state', () => {
		expect(classifySdkDbutils({ ok: true, sdk_imported: true, sdk_is_shim: true })).toBe('shim');
		expect(classifySdkDbutils({ ok: true, sdk_imported: true, sdk_is_shim: false })).toBe('foreign');
		expect(classifySdkDbutils({ ok: true, sdk_imported: false, sdk_is_shim: null })).toBe('not_imported');
	});

	it('reads anything it cannot understand as `unknown`, never as a defect', () => {
		// Over-reporting is the one direction this must not fail in: a warning shown
		// over a reading nobody obtained sends the user restarting a healthy kernel.
		expect(classifySdkDbutils(null)).toBe('unknown');
		expect(classifySdkDbutils(undefined)).toBe('unknown');
		expect(classifySdkDbutils('nope')).toBe('unknown');
		expect(classifySdkDbutils({})).toBe('unknown');
		expect(classifySdkDbutils({ ok: false, message: 'boom' })).toBe('unknown');
		// a truthy-but-not-true flag is not a confirmation either
		expect(classifySdkDbutils({ ok: true, sdk_imported: true, sdk_is_shim: 1 })).toBe('foreign');
	});

	it('names the module and the remedy in the shared warning', () => {
		expect(SDK_DBUTILS_FOREIGN_WARNING).toContain(SDK_RUNTIME_MODULE);
		expect(SDK_DBUTILS_FOREIGN_WARNING).toMatch(/[Rr]estart the kernel/);
	});
});
