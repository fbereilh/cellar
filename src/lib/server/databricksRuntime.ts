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
 *   1. **Default OFF, and additionally scoped to a Databricks-connected notebook.**
 *      Advertising a runtime is an OPT-IN: it changes behavior for ALL libraries,
 *      not just the user's own `IS_DATABRICKS` checks - notably mlflow's
 *      `is_in_databricks_runtime()` reads this exact var and will assume it is on a
 *      cluster - and turning it on costs a kernel restart (the namespace is
 *      cleared). So connecting a cluster deliberately does NOT enable it: a connect
 *      binds `spark`/`w` and leaves the kernel running, and the user opts in via the
 *      Runtime toggle, which is the ONLY thing that restarts the kernel for this
 *      setting. (This reverses an earlier "connect auto-enables it" behavior.) The
 *      connection scope is kept on top of the OFF default so a stored ON never
 *      spoofs the runtime for a notebook that is no longer bound to a cluster. An
 *      explicit env override (`CELLAR_DATABRICKS_RUNTIME`) forces the decision
 *      either way for headless / CI / operator opt-in, bypassing that scope.
 *   2. It applies at kernel start / restart ONLY (no live-apply): `IS_DATABRICKS`
 *      is an import-time gate, so setting the env in a kernel that already imported
 *      the user's package does not re-flip it. Restart to apply - which is what the
 *      toggle does, so the change lands immediately without a manual step.
 *
 * This module holds only the pure bits (no fs, no jupyter, no `$lib` server
 * imports) so they are cheap to unit-test: the toggle predicate, the version
 * accessor, the connection-scoped inject decision, and the idempotent Python
 * snippet that sets the env var.
 */

/** UI-state key for the per-workspace on/off toggle. Default value is FALSE (see below). */
export const DBX_RUNTIME_KEY = 'cellar-databricks-runtime';

/** UI-state key for the advertised runtime version string. Default `'15.4'`. */
export const DBX_RUNTIME_VERSION_KEY = 'cellar-databricks-runtime-version';

/** Advertised runtime version when the user has not set one. A recent LTS line. */
export const DBX_RUNTIME_VERSION_DEFAULT = '15.4';

/**
 * The env override's verdict: `true`/`false` when `CELLAR_DATABRICKS_RUNTIME` forces
 * the decision, `null` when it is unset / empty / unrecognized (so the store decides).
 *
 * Exported because the UI must be able to see that the decision is FORCED, not merely
 * what it resolved to: a forced decision cannot be changed by the toggle or by
 * restarting the kernel, so the Runtime card has to say the environment controls it
 * instead of offering an "Apply now" restart that would clear the namespace and
 * change nothing. Every consumer derives it here rather than re-parsing the env, so
 * the display and the inject decision can never disagree about what the operator set.
 */
export function databricksRuntimeOverride(envValue?: string | null): boolean | null {
	if (envValue == null || envValue === '') return null;
	const v = envValue.trim().toLowerCase();
	if (v === '0' || v === 'false' || v === 'off' || v === 'no') return false;
	if (v === '1' || v === 'true' || v === 'on' || v === 'yes') return true;
	return null;
}

/**
 * Resolve the effective toggle PREFERENCE (independent of connection). Default is
 * FALSE - advertising a runtime is an explicit opt-in, because it changes what
 * every library (not just the user's own gate) believes about its environment, and
 * engaging it restarts the kernel. Only an explicit stored `true` (or a truthy env
 * override) enables it, so connecting a cluster - which stores nothing - leaves it
 * off. An env override (`CELLAR_DATABRICKS_RUNTIME`) wins over the store so a
 * headless / CI run can force it either way. This is what the UI toggle reflects;
 * the runtime gate additionally requires a connected notebook (see
 * `shouldInjectDatabricksRuntime`).
 */
export function databricksRuntimeEnabled(storeValue: unknown, envValue?: string | null): boolean {
	const override = databricksRuntimeOverride(envValue);
	if (override !== null) return override;
	// Default OFF: only an explicit stored `true` enables it. Anything else - unset,
	// `false`, or junk left by an older build - reads as off, so the user's toggle is
	// the single thing that turns the runtime on.
	//
	// A stored `true` written by the OLD build's connect-time auto-enable is CARRIED
	// OVER on purpose: that workspace already had the runtime on and working, and
	// silently turning it off under the user would be its own surprise. Only NEW
	// connects default to off. Deliberately no one-time migration or reset - and the
	// Runtime card's state pill is live-derived from the kernel, so the display stays
	// honest whatever the store holds.
	return storeValue === true;
}

/**
 * Decide whether to actually inject `DATABRICKS_RUNTIME_VERSION` at kernel start
 * for a notebook. The stored preference is SCOPED to a Databricks-connected
 * notebook so a purely-local kernel is never told it is on Databricks:
 *
 *   - an explicit env override forces the decision either way (bypasses the scope,
 *     for headless / CI / operator opt-in);
 *   - an unset / `false` preference (the default, and what a plain connect leaves
 *     behind) never injects;
 *   - a stored `true` (the user turned the toggle on) injects, but only while the
 *     notebook is `bound` to a Databricks cluster.
 */
export function shouldInjectDatabricksRuntime(
	storeValue: unknown,
	envValue: string | null | undefined,
	bound: boolean
): boolean {
	// Reuse the preference resolver so the env-override / default-OFF logic lives in
	// one place. An explicit env override forces the decision either way AND bypasses
	// the connection scope; otherwise the resolved preference must be ON and the
	// notebook must be `bound` to a cluster.
	return databricksRuntimeEnabled(storeValue, envValue) && (databricksRuntimeOverride(envValue) !== null || bound);
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
