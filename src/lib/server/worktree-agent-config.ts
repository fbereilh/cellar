/**
 * Write Cellar's agent config into an ADOPTED external worktree.
 *
 * An agent working in a review notebook rooted at a sibling worktree will run its
 * own tools with that worktree as the cwd, so without a `.mcp.json` there it
 * cannot reach the Cellar instance that is serving the notebook. This module
 * closes that, and nothing more.
 *
 * FOUR RULES, each of which was a decision rather than an implementation detail:
 *
 * 1. **ADOPTION-SCOPED — never on detection.** Only a worktree actually SET as a
 *    notebook's root is written to. Detection happens whenever a picker opens or
 *    an agent calls `list_roots`, so writing on detection would drop untracked
 *    files into every checkout of the repo as the side effect of a read.
 *
 * 2. **The EXISTING harness writer, never a second one.** `configureHarness(name,
 *    dir)` is already parameterised on a directory and carries every guarantee
 *    that matters here — merge rather than clobber, `already` => zero bytes
 *    written, symlink-following atomic replace, mode + CRLF preservation, and a
 *    refusal on anything it cannot edit confidently.
 *
 * 3. **The WORKSPACE's allow-list decides, and `--no-mcp-config` suppresses.**
 *    The workspace is where the user answered the harness question; a worktree
 *    has no independent answer and cannot be asked (the prompt is a launcher-time
 *    TTY interaction, and there is no TTY here). A launch that deliberately writes
 *    no `.mcp.json` into the workspace must not write one into a worktree.
 *
 * 4. **It may never abort a root change.** Agent wiring is a convenience; the root
 *    change is the user's actual request. A read-only mount, an EACCES, a
 *    malformed existing config — all are caught per harness and REPORTED on the
 *    result, never thrown.
 *
 * ── WHY THE `.git/info/exclude` WRITE IS PART OF THIS, NOT AN EXTRA ────────────
 *
 * `.mcp.json` is a tracked-by-convention file (it is committed in Cellar's own
 * repo) that nothing ignores, so writing one into a user's checkout makes it show
 * as `?? .mcp.json` in their `git status` — and Cellar's OWN sidebar Git section
 * then reports that worktree as dirty, i.e. Cellar dirtying a checkout it is also
 * reporting on. Worse, a `git add -A` in a review worktree would commit Cellar's
 * config onto the branch under review.
 *
 * So the write is paired with an entry in `info/exclude`.
 *
 * ITS SCOPE IS REPO-COMMON, NOT PER-WORKTREE — state that plainly rather than
 * glossing it. `info/` is in git's `common_list`, so git resolves `info/exclude`
 * through the COMMON git dir (`git rev-parse --git-common-dir`) whatever worktree
 * asks. A LINKED worktree's own `$GIT_DIR` is `<main>/.git/worktrees/<name>`, and
 * an `info/exclude` written THERE is read by nothing at all — verified against
 * real git (2.50.1): with the entry in that per-worktree location `git status` in
 * the worktree still reports `?? .mcp.json` and `git check-ignore` says it is not
 * ignored, while the same entry in `<main>/.git/info/exclude` does ignore it. So
 * the entry goes to the common dir, and it therefore applies to EVERY worktree of
 * that clone AND to the main checkout — one line ignoring one filename Cellar
 * itself writes, which is the cost of the mitigation working at all.
 *
 * What the on-by-default decision actually rests on is unchanged and still true:
 * `info/exclude` is never committed and never reaches teammates, so no `git add
 * -A` can put Cellar's config onto the branch under review and no collaborator
 * inherits the entry. It is written BEFORE the config, so the file is never
 * briefly visible as an untracked change.
 */
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { configureHarness, mcpJsonHarnessNames, harnessConfigPath, readAllowList } from './harness.js';
import { workspaceRoot } from './fstree';
import { getUiState } from './ui-state';
import { logWarn } from './logs';
// Declared in the browser-safe half so this and the Settings toggle share ONE
// constant rather than mirroring the literal across the boundary.
import { WORKTREE_AGENT_CONFIG_KEY } from '../notebookRoot';

export { WORKTREE_AGENT_CONFIG_KEY };

/** Whether an adopted worktree gets agent config written into it (default ON). */
export function worktreeAgentConfigEnabled(): boolean {
	// Only an explicit stored `false` disables it, so a store holding junk (or
	// nothing) behaves as the documented default rather than silently opting out.
	return getUiState()[WORKTREE_AGENT_CONFIG_KEY] !== false;
}

/** What was (or was not) written into an adopted worktree. */
export interface WorktreeAgentConfig {
	/** Absolute path of the config file, when one was addressed. */
	file?: string;
	/**
	 * `created`/`updated` — bytes were written. `already` — it was correct
	 * already. `skipped` — deliberately not written (disabled, not allow-listed,
	 * `--no-mcp-config`), or the writer refused a file it could not edit safely.
	 */
	status: 'created' | 'updated' | 'already' | 'skipped';
	/** Why, whenever the status alone does not say it. */
	message?: string;
}

/** The harnesses whose config file is `.mcp.json`, minus any this launch excludes. */
function targetHarnesses(): string[] {
	// `--no-mcp-config` is threaded to the app as CELLAR_NO_MCP_CONFIG, and the
	// harness it excludes is DERIVED from the registry rather than pinned by name —
	// the same rule the launch-path write follows.
	const excluded = process.env.CELLAR_NO_MCP_CONFIG ? new Set(mcpJsonHarnessNames()) : new Set<string>();
	// `readAllowList` already answers "allowed here", normalized against the
	// registry, so re-asking `isHarnessAllowed` per name only re-read and re-parsed
	// `.cellar/harness.json` to reach the same verdict.
	return readAllowList(workspaceRoot()).filter((name) => !excluded.has(name));
}

/**
 * Ensure `entry` is ignored inside `worktreeDir`, via the repo's COMMON
 * `info/exclude`. Best-effort and idempotent; returns false when it could not be
 * arranged (not a repo, unwritable), which is the caller's cue to say so rather
 * than to claim a clean checkout.
 *
 * `--git-common-dir`, never `--absolute-git-dir`: see the header — `info/` is in
 * git's `common_list`, so an exclude written to a linked worktree's own git dir is
 * read by nothing. Its output is relative to the git process's cwd (which `-C`
 * sets to `worktreeDir`) in a main checkout and absolute in a linked one, so it is
 * resolved against `worktreeDir` rather than trusted as absolute.
 */
function ensureGitExclude(worktreeDir: string, entry: string): boolean {
	const r = spawnSync('git', ['-C', worktreeDir, '--no-optional-locks', 'rev-parse', '--git-common-dir'], {
		encoding: 'utf8'
	});
	if (r.status !== 0) return false;
	const common = (r.stdout ?? '').trim();
	if (!common) return false;
	const file = join(resolve(worktreeDir, common), 'info', 'exclude');
	try {
		const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
		// Idempotent on the ENTRY, not on the whole line: a user may have added it
		// themselves with different spacing, and a second copy is noise in a file
		// they can read.
		if (existing.split('\n').some((line) => line.trim() === entry)) return true;
		mkdirSync(dirname(file), { recursive: true });
		const prefix = !existing || existing.endsWith('\n') ? '' : '\n';
		appendFileSync(file, `${prefix}# added by cellar: agent config for a notebook code root\n${entry}\n`);
		return true;
	} catch {
		return false;
	}
}

/**
 * Write agent config into a newly adopted external worktree.
 *
 * Returns `undefined` when nothing was addressed at all (the root is inside the
 * workspace, or the feature is off) so an ordinary root change carries no extra
 * field. Never throws — see rule 4 in the header.
 */
export function configureAdoptedWorktree(worktreeDir: string): WorktreeAgentConfig | undefined {
	if (!worktreeAgentConfigEnabled()) return undefined;
	const names = targetHarnesses();
	if (!names.length) {
		return process.env.CELLAR_NO_MCP_CONFIG
			? { status: 'skipped', message: 'agent config was not written: this instance was launched with --no-mcp-config.' }
			: undefined;
	}

	// The exclude first, so the config file is never momentarily visible as an
	// untracked change in the user's checkout.
	// Mapped THEN reduced, never `.every` directly: that short-circuits on the first
	// failure, so a harness whose exclude could not be arranged silently skipped the
	// attempt for every later one — and their config files were then written with no
	// ignore entry at all, though those excludes would have succeeded.
	const excluded = names
		.map((name) => {
			const file = harnessConfigPath(name, worktreeDir);
			return !file || ensureGitExclude(worktreeDir, file.slice(worktreeDir.length + 1));
		})
		.every(Boolean);

	const results: WorktreeAgentConfig[] = [];
	for (const name of names) {
		try {
			const r = configureHarness(name, worktreeDir);
			results.push({
				file: r.file,
				status: r.status === 'wrote' ? 'created' : (r.status as WorktreeAgentConfig['status']),
				message: r.message
			});
		} catch (err) {
			// Caught PER HARNESS: agent wiring may never abort a root change, and one
			// unwritable worktree must not hide a sibling that wrote fine.
			const message = err instanceof Error ? err.message : String(err);
			logWarn('roots', `agent config for ${name} in ${worktreeDir} failed: ${message}`);
			results.push({ status: 'skipped', message: `agent config could not be written: ${message}` });
		}
	}

	// One field, so the common single-harness case reads plainly; several are
	// summarised rather than dropped.
	const first = results[0];
	const wrote = results.find((r) => r.status === 'created' || r.status === 'updated') ?? first;
	if (!wrote) return undefined;
	if (!excluded && (wrote.status === 'created' || wrote.status === 'updated')) {
		return {
			...wrote,
			message:
				'agent config was written, but it could not be added to the repository\'s .git/info/exclude, so the checkout will show it as an untracked file.'
		};
	}
	return results.length > 1 ? { ...wrote, message: wrote.message ?? `${results.length} harnesses configured` } : wrote;
}
