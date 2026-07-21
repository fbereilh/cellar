/**
 * "Advertise a Databricks runtime" - pure toggle predicate, version accessor,
 * connection-scoped inject decision, and the env-set snippet.
 *
 * Setting `DATABRICKS_RUNTIME_VERSION` flips a notebook's import-time
 * `IS_DATABRICKS` gate to its interactive `dbutils.widgets` path. It defaults ON
 * but is SCOPED to a Databricks-connected notebook, so a purely-local kernel is
 * never told it is on Databricks (which would change mlflow & co.). These cover
 * the default, the env override, the connection scope, and the injected Python.
 */
import { describe, it, expect } from 'vitest';
import {
	DBX_RUNTIME_KEY,
	DBX_RUNTIME_VERSION_KEY,
	DBX_RUNTIME_VERSION_DEFAULT,
	databricksRuntimeEnabled,
	shouldInjectDatabricksRuntime,
	databricksRuntimeVersion,
	databricksRuntimeEnvCode
} from '../../src/lib/server/databricksRuntime';

describe('databricksRuntimeEnabled (toggle preference)', () => {
	it('defaults ON when the setting is unset', () => {
		expect(databricksRuntimeEnabled(undefined)).toBe(true);
		expect(databricksRuntimeEnabled(null)).toBe(true);
	});

	it('is ON unless the stored value is explicitly false', () => {
		expect(databricksRuntimeEnabled(true)).toBe(true);
		expect(databricksRuntimeEnabled(false)).toBe(false);
		// Any other truthy junk is still ON (default direction).
		expect(databricksRuntimeEnabled('yes')).toBe(true);
	});

	it('lets an env override win over the store, both directions', () => {
		expect(databricksRuntimeEnabled(true, '0')).toBe(false);
		expect(databricksRuntimeEnabled(true, 'false')).toBe(false);
		expect(databricksRuntimeEnabled(true, 'off')).toBe(false);
		expect(databricksRuntimeEnabled(false, '1')).toBe(true);
		expect(databricksRuntimeEnabled(false, 'true')).toBe(true);
		expect(databricksRuntimeEnabled(false, 'on')).toBe(true);
	});

	it('falls back to the store for an empty / unrecognized env value', () => {
		expect(databricksRuntimeEnabled(false, '')).toBe(false);
		expect(databricksRuntimeEnabled(true, '')).toBe(true);
		expect(databricksRuntimeEnabled(false, 'maybe')).toBe(false);
	});

	it('exposes stable store keys', () => {
		expect(DBX_RUNTIME_KEY).toBe('cellar-databricks-runtime');
		expect(DBX_RUNTIME_VERSION_KEY).toBe('cellar-databricks-runtime-version');
	});
});

describe('shouldInjectDatabricksRuntime (connection-scoped decision)', () => {
	it('default-ON injects ONLY for a bound (connected) notebook', () => {
		expect(shouldInjectDatabricksRuntime(undefined, undefined, true)).toBe(true);
		expect(shouldInjectDatabricksRuntime(undefined, undefined, false)).toBe(false);
		expect(shouldInjectDatabricksRuntime(true, undefined, true)).toBe(true);
		expect(shouldInjectDatabricksRuntime(true, undefined, false)).toBe(false);
	});

	it('a stored false never injects, even when bound', () => {
		expect(shouldInjectDatabricksRuntime(false, undefined, true)).toBe(false);
		expect(shouldInjectDatabricksRuntime(false, undefined, false)).toBe(false);
	});

	it('an explicit env override forces the decision, bypassing the connection scope', () => {
		// Forced ON even for an UNBOUND notebook (headless / CI / operator opt-in).
		expect(shouldInjectDatabricksRuntime(undefined, '1', false)).toBe(true);
		expect(shouldInjectDatabricksRuntime(false, 'true', false)).toBe(true);
		// Forced OFF even for a bound notebook.
		expect(shouldInjectDatabricksRuntime(true, '0', true)).toBe(false);
		expect(shouldInjectDatabricksRuntime(undefined, 'off', true)).toBe(false);
	});

	it('an empty / unrecognized env value falls back to the scoped default', () => {
		expect(shouldInjectDatabricksRuntime(undefined, '', true)).toBe(true);
		expect(shouldInjectDatabricksRuntime(undefined, 'maybe', false)).toBe(false);
	});
});

describe('databricksRuntimeVersion', () => {
	it('defaults to a recent LTS line when unset', () => {
		expect(databricksRuntimeVersion(undefined)).toBe(DBX_RUNTIME_VERSION_DEFAULT);
		expect(databricksRuntimeVersion(null)).toBe('15.4');
		expect(databricksRuntimeVersion('')).toBe('15.4');
	});

	it('uses a stored non-empty string, trimmed', () => {
		expect(databricksRuntimeVersion('14.3')).toBe('14.3');
		expect(databricksRuntimeVersion('  16.1  ')).toBe('16.1');
	});

	it('lets an env override win over the store', () => {
		expect(databricksRuntimeVersion('15.4', '13.3')).toBe('13.3');
		expect(databricksRuntimeVersion('15.4', '  17.0 ')).toBe('17.0');
		// Empty env falls back to the store.
		expect(databricksRuntimeVersion('15.4', '')).toBe('15.4');
	});
});

describe('databricksRuntimeEnvCode', () => {
	it('sets os.environ[DATABRICKS_RUNTIME_VERSION] to the version', () => {
		const code = databricksRuntimeEnvCode('15.4');
		expect(code).toContain('import os as _os');
		expect(code).toContain("_os.environ['DATABRICKS_RUNTIME_VERSION'] = \"15.4\"");
		expect(code).toContain('del _os');
	});

	it('embeds the version as a valid Python/JSON string literal (quotes escaped)', () => {
		const weird = '15.4"; import evil #';
		const code = databricksRuntimeEnvCode(weird);
		expect(code).toContain(JSON.stringify(weird));
		// The literal must be quote-safe so it never breaks the injected line.
		expect(JSON.parse(JSON.stringify(weird))).toBe(weird);
	});
});
