/**
 * Cellar — self-contained relative-time + duration formatters for the per-cell
 * run-metadata badge (`Cell.svelte`). No dependencies, no Intl locale coupling,
 * so the badge reads the same everywhere and needs only a ticking `now`.
 */

/**
 * Human "time ago" for a past timestamp `at` relative to `now` (both ms epoch).
 * `just now` under 5s, then s / m / h / d. Future or missing → `just now`.
 */
export function relativeTime(at, now = Date.now()) {
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
export function relativeTimeLong(at, now = Date.now()) {
	if (at == null) return '';
	const s = Math.max(0, Math.floor((now - at) / 1000));
	if (s < 30) return 'just now';
	if (s < 60) return `${s} seconds ago`;
	const units = [
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
export function formatDuration(ms) {
	if (ms == null || !Number.isFinite(ms)) return '';
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const s = ms / 1000;
	if (s < 60) return `${s.toFixed(1)}s`;
	const m = Math.floor(s / 60);
	const rem = Math.round(s % 60);
	return `${m}m ${rem}s`;
}
