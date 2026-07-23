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

/**
 * Which report the status bar shows, chosen by WHICH TAB IS ACTIVE — never by
 * which value happens to be truthy.
 *
 * The distinction is the whole point: a focused file tab answers with its OWN
 * record or nothing, because `notebookPath` stays set (the shell falls back to the
 * canonical notebook whenever any notebook tab is open) and a LiveNotebook keeps
 * publishing its focused cell's record under that key. Falling through on a falsy
 * file record therefore attributed a notebook cell's author and date to the file —
 * and an untracked, correctly-null file is the common case here, since a generated
 * report is usually gitignored or never added.
 *
 * So every arm of the union renders as itself by construction: a record, the
 * too-large marker, or nothing (which the bar hides, meaning untracked).
 */
export function activeBlameFor(
	filePath: string | null,
	notebookPath: string | null,
	byPath: Record<string, BlameReport | null>
): BlameReport | null {
	if (filePath) return byPath[filePath] ?? null;
	if (notebookPath) return byPath[notebookPath] ?? null;
	return null;
}
