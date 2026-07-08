/**
 * Cellar — workspace git status (shell sidebar file tree decorations).
 *
 * Reports per-file git status for the workspace so the file tree can decorate
 * entries the way VS Code does (colored name + status letter, folder rollup).
 * Everything degrades gracefully when the workspace is not a git repository:
 * `isRepo:false` and an empty map, never an error.
 *
 * Independent of the notebook document/kernel — this only shells out to `git`
 * with the workspace root as the working directory.
 */
import { execFile } from 'node:child_process';
import { workspaceRoot } from './fstree.js';

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
