/**
 * How the shell decides whether windowed ("virtualized") cell rendering is on.
 *
 * Since P5 windowing is **on by default** for every notebook (the engine itself
 * still full-mounts whenever every cell fits the viewport + overscan, so a small
 * notebook renders exactly as it always did - see `$lib/virtualization`). What is
 * left to decide is only how a user, or a support session, turns it OFF.
 *
 * Two inputs, in strict precedence order:
 *   1. the `?virtualize=` URL param - the deterministic override. It ALWAYS wins,
 *      so `?virtualize=0` reliably un-windows a notebook whatever is persisted,
 *      and `?virtualize=1` forces it back on. A run decided this way is `forced`,
 *      which is what lets the UI lock its toggle rather than offering a switch
 *      that silently changes nothing.
 *   2. the persisted viewer preference (`$lib/uiState`, the per-project store the
 *      follow-running-cell / sidebar-width prefs use - NOT `localStorage`, which
 *      resets on every relaunch because the port is dynamic).
 * With neither set, windowing is on.
 *
 * Pure + DOM-free so the precedence rule is unit-testable
 * (`tests/unit/virtualize-pref.test.ts`) and cannot drift from the shell.
 */

/** Persisted viewer preference key (per-project UI-state store). */
export const VIRTUALIZE_PREF_KEY = 'cellar-virtualize-cells';

/** Windowing is on unless something explicitly turns it off (P5). */
export const VIRTUALIZE_DEFAULT = true;

export interface VirtualizeChoice {
	/** Whether to window this session's notebooks. */
	enabled: boolean;
	/** A URL param decided it, so the in-app toggle must not pretend to. */
	forced: boolean;
}

/**
 * Read a `?virtualize=` value as an override: `true`/`false`, or `null` for "no
 * opinion". An unrecognized value (including the bare `?virtualize` form, which
 * URLSearchParams reports as `''`) deliberately yields `null` rather than an
 * arbitrary side - an override nobody can spell is worse than no override, and
 * falling through to the preference is the honest reading.
 */
export function parseVirtualizeParam(raw: string | null | undefined): boolean | null {
	if (raw == null) return null;
	const v = raw.trim().toLowerCase();
	if (v === '1' || v === 'true' || v === 'on' || v === 'yes') return true;
	if (v === '0' || v === 'false' || v === 'off' || v === 'no') return false;
	return null;
}

/**
 * Resolve the session's windowing state from the URL param and the stored
 * preference. The param wins; a non-boolean stored value (hand-edited store, an
 * older build) is ignored in favour of the default.
 */
export function resolveVirtualize(
	param: string | null | undefined,
	stored: unknown
): VirtualizeChoice {
	const override = parseVirtualizeParam(param);
	if (override !== null) return { enabled: override, forced: true };
	return { enabled: typeof stored === 'boolean' ? stored : VIRTUALIZE_DEFAULT, forced: false };
}
