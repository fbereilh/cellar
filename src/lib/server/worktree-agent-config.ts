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
 * that clone AND to the main checkout — one line ignoring one file Cellar itself
 * writes, which is the cost of the mitigation working at all.
 *
 * It is ANCHORED (`/.mcp.json`), so that scope is "the ROOT of every working tree
 * of this clone" and not "anywhere in it": a slashless gitignore pattern matches
 * at any depth, which would have made every untracked `.mcp.json` in the whole
 * clone invisible to `git status` and unaddable by `git add` — a wider and worse
 * surprise than the dirty checkout this removes.
 *
 * What the on-by-default decision actually rests on is unchanged and still true:
 * `info/exclude` is never committed and never reaches teammates, so no `git add
 * -A` can put Cellar's config onto the branch under review and no collaborator
 * inherits the entry. It is written BEFORE the config, so the file is never
 * briefly visible as an untracked change.
 *
 * AND IT IS TRANSACTIONAL, which that ordering makes necessary rather than
 * optional: the entry is in place before the writer has said whether it will write
 * anything, so a harness that comes back `skipped` — an existing `.mcp.json` the
 * writer refuses to edit, an unreadable one, an EACCES — would leave an ignore rule
 * for a file Cellar never wrote. Given the repo-common scope above, that hides the
 * user's OWN root `.mcp.json` from `git status` in every working tree of the clone
 * and makes `git add` refuse it. So a skipped harness's entry is taken back
 * (`revertGitExclude`), and ONLY the bytes this call appended: an entry the user or
 * an earlier adoption already had is never touched, and the file comes back
 * byte-identical. Cellar does not leave an ignore rule behind for a file it did not
 * write.
 */
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { writeFileAtomic } from './write-file-atomic.js';
import { spawnSync } from 'node:child_process';
import { join, dirname, relative, resolve } from 'node:path';
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
	/**
	 * The part a HUMAN must be shown — a harness that was NOT configured, or a
	 * config file left visible as an untracked change. Structural rather than
	 * inferred from `message`, which the writer sets on every outcome including the
	 * everyday successes: keyed off the message's presence, the one thing worth
	 * saying was buried in "added the cellar MCP server" on every adoption.
	 */
	warning?: string;
}

/**
 * Every harness this WORKSPACE allow-lists, and which of them this launch writes.
 *
 * NOT "the `.mcp.json` harnesses": `names` is whatever the workspace allows, so a
 * workspace where the user ran `cellar harness add codex` addresses
 * `.codex/config.toml` here too - which is the several-harness case `warnings()`
 * and `summarize()` below exist for. `--no-mcp-config` is the only thing that
 * subtracts, and it subtracts exactly the harnesses whose config file IS
 * `.mcp.json`, DERIVED from the registry rather than pinned by name (the same rule
 * the launch-path write follows).
 *
 * `allowed` rides along so the caller can tell an empty `names` caused by the flag
 * from one that was empty anyway: `readAllowList` already answers "allowed here",
 * normalized against the registry, so re-asking `isHarnessAllowed` per name only
 * re-read and re-parsed `.cellar/harness.json` to reach the same verdict.
 */
function targetHarnesses(): { allowed: string[]; names: string[] } {
	const excluded = process.env.CELLAR_NO_MCP_CONFIG ? new Set(mcpJsonHarnessNames()) : new Set<string>();
	const allowed = readAllowList(workspaceRoot());
	return { allowed, names: allowed.filter((name) => !excluded.has(name)) };
}

/** The comment line Cellar writes above its own exclude entry — its signature there. */
const EXCLUDE_MARKER = '# added by cellar: agent config for a notebook code root';

/**
 * Ensure `rel` — a path relative to a working tree's ROOT — is ignored, via the
 * repo's COMMON `info/exclude`. Best-effort and idempotent; `ok:false` says it
 * could not be arranged (not a repo, unwritable), which is the caller's cue to say
 * so rather than to claim a clean checkout, and `appended` records the exact bytes
 * THIS call added so the write can be taken back if the config never lands.
 *
 * `--git-common-dir`, never `--absolute-git-dir`: see the header — `info/` is in
 * git's `common_list`, so an exclude written to a linked worktree's own git dir is
 * read by nothing. Its output is relative to the git process's cwd (which `-C`
 * sets to `worktreeDir`) in a main checkout and absolute in a linked one, so it is
 * resolved against `worktreeDir` rather than trusted as absolute.
 *
 * ANCHORED WITH A LEADING SLASH, and that is not cosmetic. A gitignore pattern
 * with no slash in it matches at ANY DEPTH, so a bare `.mcp.json` — and this entry
 * lives in the repo-COMMON exclude — made every untracked `.mcp.json` anywhere in
 * every working tree of the clone invisible to `git status`, with `git add`
 * refusing it as ignored. That is far wider than the file Cellar writes, and it is
 * a worse surprise than the dirty checkout the mitigation exists to remove.
 * Anchored, it ignores the working-tree ROOT's file and nothing else — which also
 * makes the two harnesses consistent, since `.codex/config.toml` contains a slash
 * and was therefore already root-anchored.
 */
function ensureGitExclude(worktreeDir: string, rel: string): ExcludeWrite {
	const entry = `/${rel}`;
	const r = spawnSync('git', ['-C', worktreeDir, '--no-optional-locks', 'rev-parse', '--git-common-dir'], {
		encoding: 'utf8'
	});
	if (r.status !== 0) return { ok: false };
	const common = (r.stdout ?? '').trim();
	if (!common) return { ok: false };
	const file = join(resolve(worktreeDir, common), 'info', 'exclude');
	try {
		const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
		// Idempotent on the ENTRY, not on the whole line: a user may have added it
		// themselves with different spacing, and a second copy is noise in a file
		// they can read. An entry that was ALREADY there carries no `appended`, which
		// is what stops the revert below from removing a line this call did not write.
		if (existing.split('\n').some((line) => line.trim() === entry)) return { ok: true, file };
		mkdirSync(dirname(file), { recursive: true });
		const prefix = !existing || existing.endsWith('\n') ? '' : '\n';
		const appended = `${prefix}${EXCLUDE_MARKER}\n${entry}\n`;
		appendFileSync(file, appended);
		return { ok: true, file, appended };
	} catch {
		return { ok: false };
	}
}


/** What `ensureGitExclude` did, and exactly what a revert would have to undo. */
interface ExcludeWrite {
	/** Whether the entry is now present — false means nothing could be arranged. */
	ok: boolean;
	/** The exclude file, when one was reached. */
	file?: string;
	/** The exact bytes THIS call appended; absent when the entry was already there. */
	appended?: string;
}

/**
 * Take back an exclude entry this call added, because the config it was ignoring
 * was never written.
 *
 * WHY IT EXISTS: the entry lands in the repo-COMMON exclude, so it is an ignore
 * rule for `/.mcp.json` at the ROOT of every working tree of the clone, the main
 * checkout included. If the writer then REFUSES the config (an existing
 * `.mcp.json` it will not edit, an unreadable one, an EACCES), the entry is left
 * ignoring a file Cellar never wrote — the user's OWN untracked `.mcp.json`
 * silently disappears from `git status` and `git add` refuses it as ignored.
 * Cellar must not leave an ignore rule behind for a file it did not write.
 *
 * The ordering stays exclude-first (so the config is never momentarily visible as
 * an untracked change); this is what makes it transactional instead.
 *
 * ONLY the bytes THIS call appended are removed, spliced out by exact match, so a
 * line the user — or an earlier adoption, or the sibling harness in this same call
 * — put there is untouched, and an exclude that already held the entry is never
 * reverted at all (no `appended`). Removing the exact appended slice is also what
 * makes the file byte-identical to what it was before the call. Best-effort, like
 * the write: a revert that cannot be done leaves the warning the skip already
 * earns.
 */
function revertGitExclude(e: ExcludeWrite): void {
	if (!e.file || !e.appended) return;
	try {
		const content = readFileSync(e.file, 'utf8');
		const at = content.lastIndexOf(e.appended);
		if (at < 0) return;
		writeFileAtomic(e.file, content.slice(0, at) + content.slice(at + e.appended.length));
	} catch {
		/* best-effort: the skip's own warning is what the user acts on */
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
	const { allowed, names } = targetHarnesses();
	if (!names.length) {
		// ONLY THE FLAG MAY BE BLAMED FOR THE FLAG'S EFFECT. `cellar harness remove
		// claude` leaves an explicitly EMPTY allow-list, so `names` is empty there for a
		// reason that has nothing to do with `--no-mcp-config` - and this message rides
		// `agentConfigNotice` onto the root bar and the sidebar, where naming a cause
		// that did not happen is worse than saying nothing. An allow-list that was
		// empty anyway addressed nothing at all, which is what `undefined` says.
		return allowed.length
			? { status: 'skipped', message: 'agent config was not written: this instance was launched with --no-mcp-config.' }
			: undefined;
	}

	// The exclude first, so the config file is never momentarily visible as an
	// untracked change in the user's checkout.
	//
	// EVERY harness is attempted, and each one's verdict is KEPT AGAINST ITS OWN
	// NAME. A short-circuiting `.every` skipped the attempt for every harness after
	// the first failure, so their config files were written with no ignore entry
	// though those excludes would have succeeded; and a single AND'ed boolean then
	// made the warning name whichever file happened to be written FIRST, telling the
	// user that `.mcp.json` was untracked-dirty when the file that really was is
	// `.codex/config.toml`.
	const excludedByName = new Map<string, ExcludeWrite>();
	for (const name of names) {
		const file = harnessConfigPath(name, worktreeDir);
		excludedByName.set(name, file ? ensureGitExclude(worktreeDir, file.slice(worktreeDir.length + 1)) : { ok: true });
	}

	const results: HarnessOutcome[] = [];
	for (const name of names) {
		const wroteExclude = excludedByName.get(name) ?? { ok: false };
		const excluded = wroteExclude.ok;
		try {
			const r = configureHarness(name, worktreeDir);
			results.push({
				name,
				file: r.file,
				status: r.status === 'wrote' ? 'created' : (r.status as WorktreeAgentConfig['status']),
				message: r.message,
				excluded
			});
		} catch (err) {
			// Caught PER HARNESS: agent wiring may never abort a root change, and one
			// unwritable worktree must not hide a sibling that wrote fine.
			const message = err instanceof Error ? err.message : String(err);
			logWarn('roots', `agent config for ${name} in ${worktreeDir} failed: ${message}`);
			results.push({ name, status: 'skipped', message: `agent config could not be written: ${message}`, excluded });
		}
		// TRANSACTIONAL, per harness: the config was NOT written, so the ignore rule
		// this call added covers a file Cellar does not own — most likely the user's
		// own `.mcp.json`, which the writer refused to edit precisely because it is
		// theirs. See `revertGitExclude`. `already` keeps its entry: Cellar's config IS
		// there, so ignoring it is still correct.
		if (results[results.length - 1].status === 'skipped') revertGitExclude(wroteExclude);
	}

	const first = results[0];
	if (!first) return undefined;
	// The headline is the write that really happened; anything the headline does not
	// cover rides `warning` rather than being summarised away. The old aggregate
	// reported `${results.length} harnesses configured`, which CLAIMED both when one
	// was skipped and discarded the skipped one's reason — the actionable part — in
	// a module whose whole header is about not asserting more than was verified.
	const wrote = results.find((r) => r.status === 'created' || r.status === 'updated') ?? first;
	const warning = warnings(results, worktreeDir).join(' ') || undefined;
	return {
		file: wrote.file,
		status: wrote.status,
		message: summarize(results),
		...(warning ? { warning } : {})
	};
}

/** One harness's outcome, with the exclude verdict for ITS OWN file. */
interface HarnessOutcome {
	name: string;
	file?: string;
	status: WorktreeAgentConfig['status'];
	message?: string;
	excluded: boolean;
}

/**
 * The sentences a human must be shown, one per harness that earned one.
 *
 * THE CASE THAT MUST NEVER BE SILENT is the one that leaves the user's checkout
 * dirty — and whether it does is a fact about what is ON DISK, not about whether
 * THIS call wrote it. Gating it on `created`/`updated` said it exactly once: a
 * re-adoption takes the `already` path (the config is correct), so an exclude that
 * still could not be arranged — the entry deleted by hand, the common git dir gone
 * unwritable, or a first adoption that failed and is being retried — reported
 * nothing while `?? .mcp.json` really was there.
 *
 * A `skipped` harness earns one too, and it is named: the writer refused a file it
 * could not edit, so that file is not Cellar's config, and with several harnesses
 * the message must say which one it is talking about.
 */
function warnings(results: HarnessOutcome[], worktreeDir: string): string[] {
	const out: string[] = [];
	for (const r of results) {
		if (r.status === 'skipped') {
			if (r.message) out.push(results.length > 1 ? `${r.name}: ${r.message}` : r.message);
			continue;
		}
		if (!r.excluded && r.file && existsSync(r.file)) {
			// Named the way `git status` will show it, so the sentence points at the row
			// the user is about to see rather than at an absolute server path.
			const rel = relative(worktreeDir, r.file) || r.file;
			out.push(
				`Cellar's agent config (${rel}) is in this worktree, but it could not be added to the repository's .git/info/exclude, so the checkout will show it as an untracked file.`
			);
		}
	}
	return out;
}

/** What each harness reported, named when there is more than one to tell apart. */
function summarize(results: HarnessOutcome[]): string | undefined {
	if (results.length === 1) return results[0].message;
	return results.map((r) => `${r.name}: ${r.message ?? r.status}`).join('; ');
}
