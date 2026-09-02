// Pure rules for the per-cell render error boundary (`Notebook.svelte`'s `cellRow`).
//
// Cellar renders ARBITRARY kernel output, so a renderer that throws is a recurring
// failure class rather than a one-off. Svelte flushes the whole document in one pass
// and nothing in `src/` used to mount a boundary, so an uncaught throw in one cell
// took the ENTIRE notebook's render tree with it - with windowing on everything
// below the offending cell stayed permanently blank (and arrow-key navigation and the
// jump-to-running-cell spinner died with it), and with "Render all cells" on it threw
// at load and NOTHING rendered. Diagnosed in
// `data/cellar-virt-55cell-bugs-w7/report.md` §7b; the trigger it was found through
// (a pandas index keyed into an `{#each}`) is fixed in `DataFrameGrid.svelte`, and
// this bounds the NEXT unknown one to a single cell.
//
// The two decisions worth stating live here rather than as template expressions, on
// the `cellSelection.ts` / `virtualization.ts` precedent: vitest deliberately runs
// without the SvelteKit plugin (see `vitest.config.ts`), so a rule kept inside the
// component cannot be executed by the only suite CI and the no-mistakes gate run, and
// e2e is absent from both.

import { estimateHeight, type HeightCell } from '$lib/virtualization';

/**
 * The height (px) a failed cell's placeholder must RESERVE.
 *
 * This is the load-bearing half of the boundary, not decoration. Windowed rendering
 * plans the document's flow from a cache of measured card heights, so a placeholder
 * that collapsed to the height of its own message would yank the viewport up by the
 * failed cell's whole extent the instant it threw - trading a fatal bug for exactly
 * the height-cache mismatch class the windowing work exists to avoid. Reserving what
 * the flow already had makes the failure invisible to the scroll position.
 *
 * Precedence, and both halves matter:
 *   - the cell's last MEASURED height, when it ever rendered (the honest number, and
 *     the one a spacer would have reproduced had it scrolled out instead of failing);
 *   - otherwise the SAME estimate the window would have planned it at, so a cell that
 *     throws on its very first mount - the common case - still reserves the space its
 *     spacer was standing in for.
 *
 * The caller pairs this with measuring the placeholder's own box back into the same
 * cache, so what the plan believes converges on what the DOM renders rather than
 * being frozen at a height nothing occupies.
 */
export function reservedFailureHeight(
	cell: HeightCell,
	heights: ReadonlyMap<string, number>,
	collapsed = false
): number {
	const measured = heights.get(cell.id);
	if (measured != null && measured > 0) return measured;
	return Math.max(0, estimateHeight(cell, collapsed));
}

/** Longest cause the placeholder will show before eliding. */
export const FAILURE_DETAIL_MAX = 200;

/**
 * One line of cause for the placeholder: the error's own message, never its STACK.
 *
 * A stack has no business on the page - it is diagnostic, not user-facing - so it
 * goes to the console instead (the boundary's `onerror`), which is also what keeps a
 * future render regression detectable: several E2E specs assert on console errors,
 * and a boundary that made a broken renderer survivable while saying nothing would
 * make it silently undetectable too.
 *
 * `String(error)` of an `Error` is `"<name>: <message>"` - the name is worth keeping
 * (`TypeError` says a great deal on its own) and no stack rides along. Anything whose
 * conversion throws (a null-prototype object, a hostile proxy) degrades to no detail,
 * since a placeholder that cannot render is the one failure this must never have.
 */
export function failureDetail(error: unknown, max: number = FAILURE_DETAIL_MAX): string {
	if (error == null) return '';
	let raw: string;
	try {
		raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	} catch {
		return '';
	}
	const msg = (raw.split('\n')[0] ?? '').trim();
	if (max <= 0) return '';
	return msg.length > max ? `${msg.slice(0, max - 1)}…` : msg;
}
