/**
 * Cellar — the app-wide reactive "now", ticking on shared timers.
 *
 * TWO module-level `$state`s, each fed by ONE ref-counted `createNowTicker`
 * interval (see `nowTicker.ts`), because the app asks two questions at two very
 * different cadences and neither may pay for the other:
 *
 *  - `nowMs()` / `subscribeNow()` @ `NOW_TICK_MS` (15s) — the SETTLED run badge
 *    ("ran 2m ago"). Every cell with a past run reads it, so the cadence is set by
 *    the coarsest unit that label can show; ticking it every second would wake
 *    every idle badge in a 200-cell notebook to redraw unchanged text.
 *  - `runNowMs()` / `subscribeRunNow()` @ `RUN_TICK_MS` (1s) — the LIVE elapsed
 *    clock on the cell that is executing right now ("running 12s"). At most one
 *    cell per notebook is running, and its label genuinely changes every second.
 *
 * Both follow the same discipline: a consumer subscribes inside an `$effect` and
 * returns the release as the effect's cleanup, so each interval runs only while ≥1
 * consumer needs it and stops with the last one. In particular NO timer ticks
 * while nothing is running. This replaced the previous per-cell `setInterval`
 * (one timer per cell); do not reintroduce one for the elapsed clock either.
 *
 * Both values are reassigned, so per Svelte's cross-module rules they are exposed
 * through getters rather than exported directly, so consumers stay reactive.
 */
import { createNowTicker, RUN_TICK_MS } from './nowTicker';

let now = $state(Date.now());

const ticker = createNowTicker(() => {
	now = Date.now();
});

/** Reactive current wall-clock in ms; read inside a `$derived`/`$effect` to stay live. */
export function nowMs(): number {
	return now;
}

/**
 * Ref-count the shared ticker. Call inside an `$effect` and return the result as
 * the effect's cleanup, so the single app-wide interval runs only while at least
 * one cell needs a live relative-time label.
 */
export function subscribeNow(): () => void {
	return ticker.subscribe();
}

/** Live subscriber count (introspection/tests). */
export function nowTickerSubscriberCount(): number {
	return ticker.count;
}

/** Whether the shared interval is currently running (introspection/tests). */
export function isNowTickerRunning(): boolean {
	return ticker.running;
}

// ---- The fast ticker: live elapsed for a cell that is executing NOW ----------

let runNow = $state(Date.now());

const runTicker = createNowTicker(() => {
	runNow = Date.now();
}, RUN_TICK_MS);

/**
 * Reactive current wall-clock in ms on the 1s cadence; read inside a
 * `$derived`/`$effect` to stay live. Pair every read with `subscribeRunNow()` in
 * an `$effect` under the SAME condition — read without a live subscription this is
 * frozen at whenever the last runner released it (which `formatElapsed` renders as
 * `0s`, and the immediate tick on the next subscribe corrects within a frame).
 */
export function runNowMs(): number {
	return runNow;
}

/**
 * Ref-count the fast ticker. Call inside an `$effect` and return the result as the
 * effect's cleanup, so the single 1s interval runs only while at least one cell is
 * actually executing and stops the moment the last run ends.
 */
export function subscribeRunNow(): () => void {
	return runTicker.subscribe();
}

/** Live subscriber count for the fast ticker (introspection/tests). */
export function runTickerSubscriberCount(): number {
	return runTicker.count;
}

/** Whether the fast interval is currently running (introspection/tests). */
export function isRunTickerRunning(): boolean {
	return runTicker.running;
}
