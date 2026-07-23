/**
 * Cellar — what the shell's bottom status bar shows for the active tab's blame
 * (shared, browser-safe, types only).
 *
 * A blame is usually either a record or nothing, and nothing hides the bar. One
 * case must NOT hide it: a file past `MAX_DECORATION_BYTES` (see
 * `server/git.ts`) has its blame refused before git is ever spawned, and an
 * empty bar there would read as "untracked" — a different fact. So the reported
 * value is a union: a record, or the reason there is none.
 */
import type { BlameLine } from '$lib/server/git';

/** Why a target has no blame record, when the reason is worth saying out loud. */
export type BlameUnavailable = 'too_large';

/** What a tab reports up for the status bar: a record, or why there isn't one. */
export type BlameReport = BlameLine | { unavailable: BlameUnavailable };

/** Narrow a report to the "we know why there's no record" arm. */
export function isBlameUnavailable(r: BlameReport | null): r is { unavailable: BlameUnavailable } {
	return r != null && 'unavailable' in r;
}
