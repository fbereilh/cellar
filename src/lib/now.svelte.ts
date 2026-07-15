/**
 * Cellar — the app-wide reactive "now", ticking on one shared timer.
 *
 * A single module-level `$state` fed by the one ref-counted `createNowTicker`
 * interval (see `nowTicker.ts`). Every cell's run badge reads `nowMs()` inside a
 * `$derived` to keep its "ran 2m ago" label fresh, and subscribes via
 * `subscribeNow()` inside an `$effect` only while it has a run to show — so the
 * single interval runs only while ≥1 cell needs it and stops otherwise. This
 * replaced the previous per-cell `setInterval` (one timer per cell).
 *
 * `now` is reassigned, so per Svelte's cross-module rules it is exposed through a
 * getter (`nowMs`) rather than exported directly, so consumers stay reactive.
 */
import { createNowTicker } from './nowTicker';

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
