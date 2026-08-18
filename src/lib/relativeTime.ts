/**
 * Cellar — self-contained relative-time + duration formatters for the per-cell
 * run-metadata badge (`Cell.svelte`). No dependencies, no Intl locale coupling,
 * so the badge reads the same everywhere and needs only a ticking `now`.
 */

/**
 * Human "time ago" for a past timestamp `at` relative to `now` (both ms epoch).
 * `just now` under 5s, then s / m / h / d. Future or missing → `just now`.
 */
export function relativeTime(at: number | null | undefined, now: number = Date.now()): string {
	if (at == null) return '';
	const diff = Math.max(0, now - at);
	const s = Math.floor(diff / 1000);
	if (s < 5) return 'just now';
	if (s < 60) return `${s}s ago`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	const d = Math.floor(h / 24);
	return `${d}d ago`;
}

/**
 * Longer-horizon "time ago" for git blame dates (GitLens-style): seconds up to
 * years, with weeks/months/years so a line last touched long ago reads sensibly
 * ("3 days ago", "2 weeks ago", "5 months ago"). Future or missing → `just now`.
 */
export function relativeTimeLong(at: number | null | undefined, now: number = Date.now()): string {
	if (at == null) return '';
	const s = Math.max(0, Math.floor((now - at) / 1000));
	if (s < 30) return 'just now';
	if (s < 60) return `${s} seconds ago`;
	const units: [number, string][] = [
		[60, 'minute'],
		[60, 'hour'],
		[24, 'day'],
		[7, 'week'],
		[4.348, 'month'],
		[12, 'year']
	];
	let val = s / 60; // minutes
	let name = 'minute';
	for (let i = 1; i < units.length; i++) {
		if (val < units[i][0]) break;
		val /= units[i][0];
		name = units[i][1];
	}
	const n = Math.floor(val);
	return `${n} ${name}${n === 1 ? '' : 's'} ago`;
}

/**
 * Compact wall-clock duration for a run: `820ms` under a second, `1.2s` under a
 * minute, `1m 5s` beyond. Used for the `· 1.2s` segment of the run badge.
 */
export function formatDuration(ms: number | null | undefined): string {
	if (ms == null || !Number.isFinite(ms)) return '';
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const s = ms / 1000;
	if (s < 60) return `${s.toFixed(1)}s`;
	const m = Math.floor(s / 60);
	const rem = Math.round(s % 60);
	return `${m}m ${rem}s`;
}

/**
 * The LIVE sibling of `formatDuration`: elapsed wall-clock for a run that is still
 * going (`running 12s` beside the cell's spinner), ticking once a second.
 *
 * Deliberately not a second duration vocabulary — the minutes tier DELEGATES to
 * `formatDuration`, so `1m 5s` is spelled in exactly one place and the live clock
 * and the settled badge that replaces it cannot drift. Only the sub-minute tier
 * differs, and it has to: `formatDuration`'s `1.2s`/`820ms` are written for a
 * value that has stopped moving, whereas a once-a-second clock rendering them
 * would read `1.0s`, `2.0s`, … (a decimal that is always `.0`) and jitter the row
 * width as the digit count changes. So under a minute this floors to whole
 * seconds. Both then agree on the units either side of the handover: `12s` becomes
 * `12.3s`, `1m 5s` stays `1m 5s`.
 *
 * The delegation is fed a WHOLE second (`ms` floored), which is also what keeps
 * `formatDuration`'s `Math.round(s % 60)` from ever rendering the impossible
 * `1m 60s` here — with an integer second the round is the identity.
 *
 * Anything not a usable positive duration reads `0s`, never a negative or a blank:
 * the one way to get there is reading a `runNowMs()` frozen since before this run
 * started (see `now.svelte.ts`), which is a just-started run — exactly `0s`.
 */
export function formatElapsed(ms: number | null | undefined): string {
	if (ms == null || !Number.isFinite(ms) || ms <= 0) return '0s';
	const whole = Math.floor(ms / 1000) * 1000;
	if (whole < 60000) return `${whole / 1000}s`;
	return formatDuration(whole);
}
