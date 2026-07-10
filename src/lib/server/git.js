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
import { workspaceRoot, resolveInWorkspace } from './fstree.js';

const MAX_GIT_BUFFER = 8 * 1024 * 1024;

/**
 * Collapse a two-char porcelain XY code into a single display letter, matching
 * VS Code's git decorations:
 *   M modified · A added · D deleted · R renamed · U untracked · C conflict
 */
function classify(xy) {
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

/** Run `git status --porcelain` at the workspace root (NUL-delimited). */
function runStatus(root) {
	return new Promise((resolve) => {
		execFile(
			'git',
			['-C', root, 'status', '--porcelain=v1', '--untracked-files=all', '-z', '--', '.'],
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
function runPrefix(root) {
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
 */
function parse(stdout, prefix) {
	const map = {};
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
		map[path] = classify(xy);
	}
	return map;
}

/**
 * Git status for the workspace.
 * @returns {Promise<{isRepo: boolean, files: Record<string,string>}>}
 */
export async function gitStatus() {
	const root = workspaceRoot();
	const stdout = await runStatus(root);
	if (stdout == null) return { isRepo: false, files: {} };
	const prefix = await runPrefix(root);
	return { isRepo: true, files: parse(stdout, prefix) };
}

/** Run a git subcommand at the workspace root; `null` on any failure. */
function runGit(root, args) {
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
export async function gitHeadFile(relPath) {
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
function parseBlame(stdout) {
	const lines = [];
	let cur = null;
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
export async function gitBlameFile(relPath) {
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
