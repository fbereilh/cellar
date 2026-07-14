/**
 * Cellar — workspace git status (shell sidebar file tree decorations) and
 * git-HEAD baselines (editor gutter + notebook cell change decorations).
 *
 * `gitStatus()` reports per-file status so the file tree can decorate entries
 * the way VS Code does (colored name + status letter, folder rollup).
 * `gitHeadFile()` hands out one file's content at HEAD, which the browser diffs
 * the live buffer against (see `src/lib/gitdiff.js`) — diffing client-side keeps
 * the markers live as you type without a `git` process per keystroke.
 *
 * Everything degrades gracefully when the workspace is not a git repository:
 * `isRepo:false`, never an error.
 *
 * Independent of the notebook document/kernel — this only shells out to `git`
 * with the workspace root as the working directory.
 */
import { execFile } from 'node:child_process';
import { workspaceRoot, resolveInWorkspace } from './fstree';

const MAX_GIT_BUFFER = 8 * 1024 * 1024;

/** Single-letter git decoration, matching VS Code's convention. */
export type GitStatusLetter = 'M' | 'A' | 'D' | 'R' | 'U' | 'C';

/** Result of `gitStatus()`: whether the workspace is a repo + its file decorations. */
export interface GitStatusResult {
	isRepo: boolean;
	files: Record<string, GitStatusLetter>;
	/**
	 * Git-ignored paths (workspace-relative), so the file tree can grey them the
	 * way VS Code does. A whole ignored directory is one entry WITH a trailing
	 * slash (`build/`); individually-ignored files carry no slash (`secret.txt`).
	 * The client greys a node when its path matches an entry exactly or sits under
	 * an ignored directory prefix (see `$lib/gitIgnored`).
	 */
	ignored: string[];
}

/** Result of `gitBranch()`: the current branch (or short SHA when detached). */
export interface GitBranchResult {
	isRepo: boolean;
	/** Branch name on a normal HEAD, short commit SHA when detached, else null. */
	branch: string | null;
	/** True when HEAD is detached — the client renders the SHA in parentheses. */
	detached: boolean;
}

/** Result of `gitHeadFile()`: one file's content as of git HEAD. */
export interface GitHeadFileResult {
	isRepo: boolean;
	tracked: boolean;
	content: string | null;
}

/** One parsed `git blame --line-porcelain` line record. */
export interface BlameLine {
	commit: string;
	shortSha: string | null;
	author: string;
	authorTime: number | null;
	summary: string;
	notCommitted: boolean;
}

/** Result of `gitBlameFile()`. */
export interface GitBlameFileResult {
	isRepo: boolean;
	tracked: boolean;
	lines: BlameLine[];
}

/**
 * Collapse a two-char porcelain XY code into a single display letter, matching
 * VS Code's git decorations:
 *   M modified · A added · D deleted · R renamed · U untracked · C conflict
 */
function classify(xy: string): GitStatusLetter {
	const x = xy[0];
	const y = xy[1];
	if (xy === '??') return 'U'; // untracked
	// Unmerged / conflict states (both sides touched, or an unmerged marker).
	if (x === 'U' || y === 'U' || xy === 'DD' || xy === 'AA') return 'C';
	// Prefer the working-tree change, then the staged one.
	const c = y !== ' ' && y !== '?' ? y : x;
	if (c === 'A') return 'A';
	if (c === 'M') return 'M';
	if (c === 'D') return 'D';
	if (c === 'R') return 'R';
	if (c === 'C') return 'A'; // copied → treat as added
	if (c === 'T') return 'M'; // type change → modified
	return 'M';
}

/**
 * Run `git status --porcelain` at the workspace root (NUL-delimited).
 * `--ignored=matching` folds ignored paths into the same output as `!!` entries
 * (a wholly-ignored directory collapses to one `dir/` entry, scattered ignored
 * files list individually) so status + ignore come back in one git call.
 */
function runStatus(root: string): Promise<string | null> {
	return new Promise((resolve) => {
		execFile(
			'git',
			['-C', root, 'status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching', '-z', '--', '.'],
			{ maxBuffer: 8 * 1024 * 1024 },
			(err, stdout) => {
				if (err) {
					// Not a repo, or git missing → no decorations, no error.
					resolve(null);
					return;
				}
				resolve(stdout);
			}
		);
	});
}

/**
 * The workspace path relative to the git repo root (e.g. `sub/deep/`, with a
 * trailing slash, or `''` when the workspace *is* the repo root). Porcelain
 * paths are repo-root-relative, so we strip this to key the map by the same
 * workspace-relative paths the file tree uses.
 */
function runPrefix(root: string): Promise<string> {
	return new Promise((resolve) => {
		execFile('git', ['-C', root, 'rev-parse', '--show-prefix'], (err, stdout) => {
			if (err) {
				resolve('');
				return;
			}
			resolve(stdout.trim());
		});
	});
}

/**
 * Parse NUL-delimited porcelain v1 output into a { relPath: letter } map.
 * Rename entries in `-z` mode emit two NUL-separated fields (new, then orig);
 * we key the new path and skip the trailing original.
 *
 * @param {string} stdout NUL-delimited porcelain output.
 * @param {string} prefix Workspace path relative to the repo root (trailing
 *   slash), stripped so keys are workspace-relative. Paths outside the
 *   workspace subtree are dropped.
 * @returns Status letters keyed by path, plus the list of git-ignored paths
 *   (`!!` entries; directories keep their trailing slash).
 */
function parse(stdout: string, prefix: string): { files: Record<string, GitStatusLetter>; ignored: string[] } {
	const map: Record<string, GitStatusLetter> = {};
	const ignored: string[] = [];
	const parts = stdout.split('\0');
	for (let i = 0; i < parts.length; i++) {
		const entry = parts[i];
		if (!entry) continue;
		const xy = entry.slice(0, 2);
		let path = entry.slice(3); // skip "XY "
		// A rename/copy carries the original path in the next field — consume it.
		if (xy[0] === 'R' || xy[0] === 'C') i++;
		if (!path) continue;
		if (prefix) {
			if (!path.startsWith(prefix)) continue; // outside the workspace subtree
			path = path.slice(prefix.length);
		}
		if (!path) continue;
		if (xy === '!!') ignored.push(path); // git-ignored (dirs keep trailing slash)
		else map[path] = classify(xy);
	}
	return { files: map, ignored };
}

/**
 * Git status for the workspace.
 * @returns {Promise<{isRepo: boolean, files: Record<string,string>}>}
 */
export async function gitStatus(): Promise<GitStatusResult> {
	const root = workspaceRoot();
	const stdout = await runStatus(root);
	if (stdout == null) return { isRepo: false, files: {}, ignored: [] };
	const prefix = await runPrefix(root);
	const { files, ignored } = parse(stdout, prefix);
	return { isRepo: true, files, ignored };
}

/**
 * The current git branch for the workspace.
 *
 * A normal (even unborn/no-commits-yet) branch resolves via `symbolic-ref`; a
 * detached HEAD makes that fail, so we fall back to the short commit SHA and
 * flag `detached` (the client renders it parenthesized, VS Code-style). A
 * non-repo returns `{isRepo:false, branch:null}` so the header shows no chip.
 */
export async function gitBranch(): Promise<GitBranchResult> {
	const root = workspaceRoot();
	// Succeeds on any real branch (including one with no commits yet); `--quiet`
	// makes a detached HEAD exit non-zero silently → runGit resolves null.
	const sym = await runGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
	if (sym != null) {
		const branch = sym.trim();
		return { isRepo: true, branch: branch || null, detached: false };
	}
	// Either detached HEAD or not a repo — a short SHA distinguishes them.
	const sha = await runGit(root, ['rev-parse', '--short', 'HEAD']);
	if (sha != null) return { isRepo: true, branch: sha.trim(), detached: true };
	// No SHA: confirm whether this is even a repo (an empty/detached repo is rare).
	const inside = await runGit(root, ['rev-parse', '--is-inside-work-tree']);
	return { isRepo: inside != null, branch: null, detached: false };
}

/** Run a git subcommand at the workspace root; `null` on any failure. */
function runGit(root: string, args: string[]): Promise<string | null> {
	return new Promise((resolve) => {
		execFile('git', ['-C', root, ...args], { maxBuffer: MAX_GIT_BUFFER }, (err, stdout) => {
			resolve(err ? null : stdout);
		});
	});
}

/**
 * One workspace file's content as of git HEAD — the baseline the editor and the
 * notebook diff against.
 *
 * `tracked:false` (with `content:null`) covers every case where HEAD has nothing
 * to compare against: not a repo, no commits yet, an untracked or newly-added
 * file, or a binary blob. Callers show no decorations then, exactly as VS Code
 * leaves a brand-new file's gutter empty — the file tree's `U`/`A` letter is
 * already the whole story.
 *
 * @param {string} relPath Workspace-relative path (path-guarded).
 * @returns {Promise<{isRepo: boolean, tracked: boolean, content: string|null}>}
 */
export async function gitHeadFile(relPath: string): Promise<GitHeadFileResult> {
	const root = workspaceRoot();
	resolveInWorkspace(relPath); // throws if the path escapes the workspace
	const rel = String(relPath ?? '').replace(/\\/g, '/');
	if (!rel) throw new Error('path required');

	if ((await runGit(root, ['rev-parse', '--is-inside-work-tree'])) == null) {
		return { isRepo: false, tracked: false, content: null };
	}
	// Porcelain paths (and `git show`'s object syntax) are repo-root-relative.
	const prefix = await runPrefix(root);
	const content = await runGit(root, ['show', `HEAD:${prefix}${rel}`]);
	if (content == null) return { isRepo: true, tracked: false, content: null };
	// A NUL byte means a binary blob; there is no line diff to draw.
	if (content.includes('\0')) return { isRepo: true, tracked: false, content: null };
	return { isRepo: true, tracked: true, content };
}

/** The 40-char all-zero SHA git blame uses for not-yet-committed local lines. */
const ZERO_SHA = '0000000000000000000000000000000000000000';

/**
 * Parse `git blame --line-porcelain` into one record per line, in file order.
 * `--line-porcelain` repeats the full commit header for every line, so we never
 * have to remember a commit block across lines — each line is self-describing.
 *
 * A line with local (uncommitted) modifications is blamed against the all-zero
 * SHA with author `Not Committed Yet`; we flag it `notCommitted` so the UI can
 * say "You · uncommitted" instead of a bogus author/date.
 */
function parseBlame(stdout: string): BlameLine[] {
	const lines: BlameLine[] = [];
	let cur: { commit: string; author: string; authorTime: number; summary: string; notCommitted: boolean } | null =
		null;
	for (const raw of stdout.split('\n')) {
		// A header line "<sha> <orig> <final> [count]" opens a new line's block.
		if (/^[0-9a-f]{40} \d+ \d+/.test(raw)) {
			const sha = raw.slice(0, 40);
			cur = { commit: sha, author: '', authorTime: 0, summary: '', notCommitted: sha === ZERO_SHA };
			continue;
		}
		if (!cur) continue;
		if (raw.startsWith('author ')) cur.author = raw.slice(7);
		else if (raw.startsWith('author-time ')) cur.authorTime = Number(raw.slice(12)) * 1000;
		else if (raw.startsWith('summary ')) cur.summary = raw.slice(8);
		else if (raw.startsWith('\t')) {
			// The tab-prefixed content line closes the block — commit the record.
			lines.push({
				commit: cur.commit,
				shortSha: cur.notCommitted ? null : cur.commit.slice(0, 7),
				author: cur.author,
				authorTime: cur.authorTime || null,
				summary: cur.summary,
				notCommitted: cur.notCommitted
			});
			cur = null;
		}
	}
	return lines;
}

/**
 * Per-line git blame for one workspace file — who last touched each line and when.
 * Blames the working-tree file, so locally-modified (unsaved-to-git) lines come
 * back flagged `notCommitted` ("Not Committed Yet"), matching VS Code/GitLens.
 *
 * `tracked:false` (empty `lines`) covers every no-blame case: not a repo, no
 * commits, an untracked file, or a binary blob — the caller then shows nothing.
 *
 * @param {string} relPath Workspace-relative path (path-guarded).
 * @returns {Promise<{isRepo: boolean, tracked: boolean, lines: Array<object>}>}
 */
export async function gitBlameFile(relPath: string): Promise<GitBlameFileResult> {
	const root = workspaceRoot();
	resolveInWorkspace(relPath); // throws if the path escapes the workspace
	const rel = String(relPath ?? '').replace(/\\/g, '/');
	if (!rel) throw new Error('path required');

	if ((await runGit(root, ['rev-parse', '--is-inside-work-tree'])) == null) {
		return { isRepo: false, tracked: false, lines: [] };
	}
	// `--incremental` off; `-w` ignores whitespace-only reblame noise. A file with
	// no HEAD blob (untracked / newly added) makes blame fail → tracked:false.
	const out = await runGit(root, ['blame', '--line-porcelain', '-w', '--', rel]);
	if (out == null) return { isRepo: true, tracked: false, lines: [] };
	return { isRepo: true, tracked: true, lines: parseBlame(out) };
}
