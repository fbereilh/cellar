/**
 * Cellar — kernel-count soft cap (kernel-per-notebook, Phase 6).
 *
 * Each notebook gets its own kernel = its own Python process (100s of MB with
 * pandas/pyspark), so N open notebooks can add up fast. Past a soft cap the
 * Kernels sidebar warns about memory use — it is WARN-ONLY and never blocks a
 * run (a run still lazily starts its kernel). The cap is tunable via
 * `CELLAR_MAX_KERNELS`; `0` (or any non-positive/non-numeric value) disables the
 * warning.
 *
 * Browser-safe (no server imports): the parse half runs server-side in the SSR
 * load, the predicate half runs in the Sidebar.
 */

/** Default soft cap when `CELLAR_MAX_KERNELS` is unset. */
export const DEFAULT_MAX_KERNELS = 8;

/**
 * Parse `CELLAR_MAX_KERNELS` into a soft cap. Unset/empty → the default (8); a
 * positive integer → that value; anything non-positive or non-numeric → 0
 * (warning disabled).
 */
export function parseMaxKernels(raw: string | undefined | null): number {
	if (raw == null || raw === '') return DEFAULT_MAX_KERNELS;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Whether `count` live kernels is past the soft cap `max`. A cap of `0` (or less)
 * disables the warning entirely.
 */
export function isOverKernelCap(count: number, max: number): boolean {
	return max > 0 && count > max;
}
