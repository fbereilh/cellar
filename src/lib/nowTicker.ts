/**
 * Cellar — a single shared, ref-counted wall-clock ticker.
 *
 * Every cell's "ran 2m ago" run badge needs a `now` that refreshes on a ~15s
 * cadence so its relative label stays fresh. Running one `setInterval` per cell
 * meant ~200 timers in a 200-cell notebook. This factors the timer management
 * into one pure, runtime-agnostic primitive: it starts a SINGLE interval on the
 * first subscriber and stops it on the last, so at most one timer runs regardless
 * of cell count, and it never double-starts or leaks. The reactive `now` value
 * lives in `now.svelte.ts`, which wires this ticker's tick callback to a Svelte
 * rune; keeping the timer logic here (no runes) is what makes it unit-testable
 * under node (vitest runs without the Svelte compiler).
 */

/** Default refresh cadence for the run-badge relative labels. */
export const NOW_TICK_MS = 15000;

/**
 * Cadence for the LIVE elapsed clock on a cell that is executing right now
 * (`running 12s`). Deliberately a SECOND ticker instance rather than a faster
 * `NOW_TICK_MS`: the 15s cadence exists because "ran 2m ago" cannot get staler
 * than its own unit, and dropping it to 1s would wake every idle run badge in the
 * notebook 15x more often to redraw text that has not changed. A running cell is
 * the opposite case - its label changes every second and there is at most one such
 * cell per notebook - so it gets its own ref-counted instance that runs ONLY while
 * something is executing and stops with the last run (see `now.svelte.ts`).
 *
 * 1000ms matches the whole-second display (`formatElapsed`); a faster cadence
 * would redraw the same string, a slower one would visibly skip numbers.
 */
export const RUN_TICK_MS = 1000;

export interface NowTicker {
	/**
	 * Register interest in a live `now`. Starts the single interval on the first
	 * subscriber. Returns an idempotent cleanup that drops this subscription and
	 * stops the interval once the last subscriber releases. Call it inside an
	 * `$effect` and return the result as the effect's cleanup.
	 */
	subscribe(): () => void;
	/** Live subscriber count (introspection/tests). */
	readonly count: number;
	/** Whether the single interval is currently running (introspection/tests). */
	readonly running: boolean;
}

/**
 * Build a ref-counted ticker. `onTick` fires once immediately when the interval
 * starts (so a fresh subscriber is never up to `intervalMs` stale) and then every
 * `intervalMs`. Injecting `onTick`/`intervalMs` keeps this free of runes and of a
 * hardwired cadence, so it is testable with fake timers.
 */
export function createNowTicker(onTick: () => void, intervalMs: number = NOW_TICK_MS): NowTicker {
	let subscribers = 0;
	let interval: ReturnType<typeof setInterval> | null = null;

	function start() {
		if (interval != null) return; // already ticking — never double-start
		onTick(); // refresh immediately so a just-mounted cell isn't stale
		interval = setInterval(onTick, intervalMs);
	}
	function stop() {
		if (interval == null) return;
		clearInterval(interval);
		interval = null;
	}

	return {
		subscribe() {
			subscribers++;
			if (subscribers === 1) start();
			let released = false;
			return () => {
				if (released) return; // idempotent — a double cleanup can't over-decrement
				released = true;
				subscribers--;
				if (subscribers === 0) stop();
			};
		},
		get count() {
			return subscribers;
		},
		get running() {
			return interval != null;
		}
	};
}
