/**
 * "Advertise a Databricks runtime" - pure logic.
 *
 * Databricks-notebook code commonly gates on
 * `IS_DATABRICKS = os.getenv("DATABRICKS_RUNTIME_VERSION") is not None`
 * (evaluated at import time) and, when true, takes an interactive
 * `dbutils.widgets` path - declaring/reading parameters through real ipywidgets,
 * which Cellar already renders. Off a cluster the same code falls back to a local
 * CLI (e.g. `tyro`, needing `sys.argv`) that does not fit a notebook. Setting the
 * env var flips that gate so the widgets path runs, giving the Databricks-notebook
 * parameter dev experience inside Cellar.
 *
 * The whole feature reduces to setting `DATABRICKS_RUNTIME_VERSION` in the kernel
 * environment BEFORE the user's first import (see the design report,
 * `firstmate/data/cellar-dbx-runtime-emulation-e4/report.md`). It is a
 * per-workspace setting, persisted in the UI-state store and honored at
 * kernel-start time (see `kernel.ts`).
 *
 * Two deliberate divergences from the sibling `projectRoot.ts` toggle:
 *
 *   1. **Scoped to a Databricks-connected notebook, default ON there.** When a
 *      notebook is bound to a Databricks cluster you generally want its
 *      `IS_DATABRICKS`-gated code to behave as on-Databricks (widgets, not the
 *      CLI path), so the default is ON - but ONLY for a connected notebook. A
 *      purely-local kernel is never told it is on Databricks, because setting this
 *      env advertises a runtime to ALL libraries, not just the user's own
 *      `IS_DATABRICKS` checks - notably mlflow's `is_in_databricks_runtime()`
 *      reads this exact var and will assume it is on a cluster. Scoping the
 *      default to the connected context is how we default on without spoofing the
 *      runtime for local work. An explicit env override (`CELLAR_DATABRICKS_RUNTIME`)
 *      forces the decision either way for headless / CI / operator opt-in,
 *      bypassing the connection scope.
 *   2. It applies at kernel start / restart ONLY (no live-apply): `IS_DATABRICKS`
 *      is an import-time gate, so setting the env in a kernel that already imported
 *      the user's package does not re-flip it. Restart to apply. (This composes
 *      naturally with Databricks Connect: connect binds the notebook to a cluster,
 *      then a kernel restart both re-establishes `spark`/`w` and injects the env
 *      before the fresh imports.)
 *
 * This module holds only the pure bits (no fs, no jupyter, no `$lib` server
 * imports) so they are cheap to unit-test: the toggle predicate, the version
 * accessor, the connection-scoped inject decision, and the idempotent Python
 * snippet that sets the env var.
 */

/** UI-state key for the per-workspace on/off toggle. Default value is TRUE (see below). */
export const DBX_RUNTIME_KEY = 'cellar-databricks-runtime';

/** UI-state key for the advertised runtime version string. Default `'15.4'`. */
export const DBX_RUNTIME_VERSION_KEY = 'cellar-databricks-runtime-version';

/** Advertised runtime version when the user has not set one. A recent LTS line. */
export const DBX_RUNTIME_VERSION_DEFAULT = '15.4';

/**
 * Parse an env override to an explicit boolean, or `null` when unset / empty /
 * unrecognized (so the caller falls back to the store).
 */
function parseBoolEnv(envValue?: string | null): boolean | null {
	if (envValue == null || envValue === '') return null;
	const v = envValue.trim().toLowerCase();
	if (v === '0' || v === 'false' || v === 'off' || v === 'no') return false;
	if (v === '1' || v === 'true' || v === 'on' || v === 'yes') return true;
	return null;
}

/**
 * Resolve the effective toggle PREFERENCE (independent of connection). Default is
 * TRUE - a connected notebook wants the Databricks parameter experience by
 * default. Only an explicit `false` (stored value, or a falsey env override)
 * disables it. An env override (`CELLAR_DATABRICKS_RUNTIME`) wins over the store so
 * a headless / CI run can force it either way. This is what the UI checkbox
 * reflects; the runtime gate additionally requires a connected notebook (see
 * `shouldInjectDatabricksRuntime`).
 */
export function databricksRuntimeEnabled(storeValue: unknown, envValue?: string | null): boolean {
	const override = parseBoolEnv(envValue);
	if (override !== null) return override;
	// Default ON: anything but an explicit `false` enables it.
	return storeValue !== false;
}

/**
 * Decide whether to actually inject `DATABRICKS_RUNTIME_VERSION` at kernel start
 * for a notebook. The default-ON behavior is SCOPED to a Databricks-connected
 * notebook so a purely-local kernel is never told it is on Databricks:
 *
 *   - an explicit env override forces the decision either way (bypasses the scope,
 *     for headless / CI / operator opt-in);
 *   - a stored `false` (user turned the toggle off) never injects;
 *   - otherwise the default is ON, but only when the notebook is `bound` to a
 *     Databricks cluster.
 */
export function shouldInjectDatabricksRuntime(
	storeValue: unknown,
	envValue: string | null | undefined,
	bound: boolean
): boolean {
	const override = parseBoolEnv(envValue);
	if (override !== null) return override; // explicit override wins, bypasses the connection scope
	if (storeValue === false) return false; // user turned it off
	return bound; // default ON, but only for a connected notebook
}

/**
 * Resolve the version string to advertise. A stored non-empty string wins; an env
 * override (`CELLAR_DATABRICKS_RUNTIME_VERSION`) wins over that; otherwise the
 * default LTS line. The value is only ever advertised - Cellar does not connect a
 * cluster (that is Databricks Connect's job), so it need not match any real runtime.
 */
export function databricksRuntimeVersion(storeValue: unknown, envValue?: string | null): string {
	if (typeof envValue === 'string' && envValue.trim() !== '') return envValue.trim();
	if (typeof storeValue === 'string' && storeValue.trim() !== '') return storeValue.trim();
	return DBX_RUNTIME_VERSION_DEFAULT;
}

/**
 * Idempotent Python that sets `os.environ['DATABRICKS_RUNTIME_VERSION']` to
 * `version`. Injected as the FIRST startup part so the env is present before every
 * other injected snippet AND before any user cell's imports (see `kernel.ts`).
 * `version` is embedded as a JSON string literal so it is always quote-safe.
 */
export function databricksRuntimeEnvCode(version: string): string {
	return [
		'import os as _os',
		`_os.environ['DATABRICKS_RUNTIME_VERSION'] = ${JSON.stringify(version)}`,
		'del _os'
	].join('\n');
}
