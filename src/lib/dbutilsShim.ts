/**
 * The `dbutils` SDK-import bypass: the shared rule and the shared copy.
 *
 * Cellar's native `dbutils.widgets` shim (`$lib/server/widgetsShim`) binds the
 * bare global `dbutils` and, while a Databricks runtime is advertised, also
 * repoints `databricks.sdk.runtime.dbutils` at that same instance - because
 * Databricks library code written to run both on and off a cluster reaches for
 * the SDK import, not the bare name. When that rebind is NOT in force the SDK's
 * own `IPyWidgetUtil` answers instead, and it DISCARDS an existing widget on
 * re-declaration: the idiomatic parser declares and reads in one pass, so an
 * edited value can never be observed, while the controls still render (the SDK
 * uses ipywidgets too). That is the whole reason this module exists - the failure
 * is invisible, so it has to be reported rather than left to be noticed.
 *
 * Browser-safe and dependency-free (the `databricksReauth.ts` precedent): the
 * server classifies a kernel probe with it and the sidebar renders the same
 * sentence, so the human and the agent can never be told different things about
 * one kernel.
 */

/**
 * The module whose `dbutils` attribute the SDK import path resolves. Named once,
 * so the kernel-side rebind, the probe and the copy cannot drift apart.
 */
export const SDK_RUNTIME_MODULE = 'databricks.sdk.runtime';

/**
 * Which `dbutils` the SDK import path resolves to in a live kernel:
 *
 *   - `shim`         - it IS this kernel's shim (the very instance the bare global
 *                      holds), so both paths share one value-preserving registry;
 *   - `foreign`      - the module is imported and its `dbutils` is something else,
 *                      so values entered on that path are discarded. The ONE state
 *                      worth warning about;
 *   - `not_imported` - the module has not been imported, so nothing can be wrong yet;
 *   - `unknown`      - not checked, or not determinable (no kernel, a busy kernel, a
 *                      failed probe, no advertised runtime). NEVER a warning: a
 *                      state nobody verified may not be reported as a defect.
 */
export type SdkDbutilsState = 'shim' | 'foreign' | 'not_imported' | 'unknown';

/**
 * The kernel probe's payload → the reported state. Pure, so the rule both
 * surfaces render is testable without a kernel. Anything unrecognized reads
 * `unknown`: over-reporting a defect nobody observed is the one direction this
 * must not fail in.
 */
export function classifySdkDbutils(probe: unknown): SdkDbutilsState {
	if (!probe || typeof probe !== 'object') return 'unknown';
	const p = probe as Record<string, unknown>;
	if (p.ok !== true) return 'unknown';
	if (p.sdk_imported !== true) return 'not_imported';
	return p.sdk_is_shim === true ? 'shim' : 'foreign';
}

/**
 * The one actionable sentence for the `foreign` state, rendered verbatim by the
 * Runtime card and returned verbatim by `databricks_status`. A kernel restart
 * re-runs the shim installer, which rebinds an already-imported module and arms
 * the import hook for one that has not happened yet - so it is the remedy in
 * every shape this can take.
 */
export const SDK_DBUTILS_FOREIGN_WARNING =
	`This kernel's \`${SDK_RUNTIME_MODULE}.dbutils\` is not Cellar's widgets shim, so parameter values ` +
	'entered in its widgets are discarded whenever a cell re-declares them - the controls render, but ' +
	'every edit is lost. Restart the kernel to rebind it.';
