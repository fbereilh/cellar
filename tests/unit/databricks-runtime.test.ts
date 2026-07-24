/**
 * "Advertise a Databricks runtime" - pure toggle predicate, version accessor,
 * connection-scoped inject decision, and the env-set snippet.
 *
 * Setting `DATABRICKS_RUNTIME_VERSION` flips a notebook's import-time
 * `IS_DATABRICKS` gate to its interactive `dbutils.widgets` path. It defaults OFF -
 * an explicit opt-in via the sidebar toggle, so CONNECTING a cluster (which stores
 * nothing) leaves it off and never restarts the kernel - and is additionally SCOPED
 * to a Databricks-connected notebook, so a purely-local kernel is never told it is
 * on Databricks (which would change mlflow & co.). These cover the default, the env
 * override, the connection scope, and the injected Python.
 */
import { describe, it, expect } from 'vitest';
import {
	DBX_RUNTIME_KEY,
	DBX_RUNTIME_VERSION_KEY,
	DBX_RUNTIME_VERSION_DEFAULT,
	databricksRuntimeEnabled,
	databricksRuntimeOverride,
	shouldInjectDatabricksRuntime,
	databricksRuntimeVersion,
	databricksRuntimeVersionOverride,
	databricksRuntimeEnvCode
} from '../../src/lib/server/databricksRuntime';

describe('databricksRuntimeEnabled (toggle preference)', () => {
	it('defaults OFF when the setting is unset', () => {
		expect(databricksRuntimeEnabled(undefined)).toBe(false);
		expect(databricksRuntimeEnabled(null)).toBe(false);
	});

	it('is OFF unless the stored value is explicitly true', () => {
		expect(databricksRuntimeEnabled(true)).toBe(true);
		expect(databricksRuntimeEnabled(false)).toBe(false);
		// Truthy junk is NOT an opt-in: only the toggle's own `true` turns it on, so a
		// stray value can never advertise a runtime the user did not ask for.
		expect(databricksRuntimeEnabled('yes')).toBe(false);
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
		expect(databricksRuntimeEnabled(undefined, 'maybe')).toBe(false);
	});

	it('exposes stable store keys', () => {
		expect(DBX_RUNTIME_KEY).toBe('cellar-databricks-runtime');
		expect(DBX_RUNTIME_VERSION_KEY).toBe('cellar-databricks-runtime-version');
	});
});

/**
 * The override's verdict is exported on its own because the UI needs to know the
 * decision is FORCED, not merely what it resolved to: neither the toggle nor a kernel
 * restart can move an env-forced decision, so a card that could not see it would
 * offer an "Apply now" restart that wipes the namespace and changes nothing.
 */
describe('databricksRuntimeOverride (who decides)', () => {
	it('reports the forced value for every recognized spelling', () => {
		for (const on of ['1', 'true', 'on', 'yes', ' TRUE ']) expect(databricksRuntimeOverride(on)).toBe(true);
		for (const off of ['0', 'false', 'off', 'no', ' OFF ']) expect(databricksRuntimeOverride(off)).toBe(false);
	});

	it('reports null when nothing is forced, so the store decides', () => {
		expect(databricksRuntimeOverride(undefined)).toBe(null);
		expect(databricksRuntimeOverride(null)).toBe(null);
		expect(databricksRuntimeOverride('')).toBe(null);
		expect(databricksRuntimeOverride('maybe')).toBe(null);
	});

	it('agrees with the resolvers it backs - it IS their override parser', () => {
		for (const env of ['1', '0', '', 'maybe', undefined]) {
			const forced = databricksRuntimeOverride(env);
			if (forced !== null) {
				expect(databricksRuntimeEnabled(!forced, env)).toBe(forced);
				// A forced decision bypasses the connection scope, in both directions.
				expect(shouldInjectDatabricksRuntime(!forced, env, false)).toBe(forced);
			} else {
				expect(databricksRuntimeEnabled(true, env)).toBe(true);
				expect(databricksRuntimeEnabled(false, env)).toBe(false);
			}
		}
	});
});

describe('shouldInjectDatabricksRuntime (connection-scoped decision)', () => {
	it('an opted-in (stored true) preference injects ONLY for a bound notebook', () => {
		expect(shouldInjectDatabricksRuntime(true, undefined, true)).toBe(true);
		expect(shouldInjectDatabricksRuntime(true, undefined, false)).toBe(false);
	});

	// THE connect-leaves-runtime-off invariant, at the layer that decides what the
	// kernel gets: connecting stores nothing, so a bound notebook whose user never
	// touched the toggle must NOT be told it is on Databricks.
	it('an unset preference never injects, bound or not (connect does not opt in)', () => {
		expect(shouldInjectDatabricksRuntime(undefined, undefined, true)).toBe(false);
		expect(shouldInjectDatabricksRuntime(undefined, undefined, false)).toBe(false);
		expect(shouldInjectDatabricksRuntime(null, undefined, true)).toBe(false);
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
		expect(shouldInjectDatabricksRuntime(true, '', true)).toBe(true);
		expect(shouldInjectDatabricksRuntime(undefined, '', true)).toBe(false);
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

/**
 * The VERSION override's verdict is exported for the same reason its on/off sibling is:
 * the card must know the version is FORCED, not merely what it resolved to. Without it
 * the version input keeps offering an edit whose apply-restart clears the user's
 * namespace to advertise a value the override throws away.
 *
 * The two overrides are INDEPENDENT - either can be set alone - so they stay separate
 * facts and are never collapsed into one flag.
 */
describe('databricksRuntimeVersionOverride (who decides the version)', () => {
	it('reports the forced version, trimmed', () => {
		expect(databricksRuntimeVersionOverride('13.3')).toBe('13.3');
		expect(databricksRuntimeVersionOverride('  17.0 ')).toBe('17.0');
	});

	it('reports null when nothing is forced, so the store decides', () => {
		expect(databricksRuntimeVersionOverride(undefined)).toBe(null);
		expect(databricksRuntimeVersionOverride(null)).toBe(null);
		expect(databricksRuntimeVersionOverride('')).toBe(null);
		expect(databricksRuntimeVersionOverride('   ')).toBe(null);
	});

	it('agrees with the resolver it backs - it IS its override parser', () => {
		for (const env of ['13.3', '  17.0 ', '', undefined]) {
			const forced = databricksRuntimeVersionOverride(env);
			if (forced !== null) expect(databricksRuntimeVersion('15.4', env)).toBe(forced);
			else expect(databricksRuntimeVersion('15.4', env)).toBe('15.4');
		}
	});

	it('is independent of the on/off override - either can be in force alone', () => {
		// A forced version with no on/off override: the store still decides on/off.
		expect(databricksRuntimeOverride(undefined)).toBe(null);
		expect(databricksRuntimeVersionOverride('13.3')).toBe('13.3');
		// A forced on/off with no version override: the store still decides the version.
		expect(databricksRuntimeOverride('1')).toBe(true);
		expect(databricksRuntimeVersionOverride(undefined)).toBe(null);
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
