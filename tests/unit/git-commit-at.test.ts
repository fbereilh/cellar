import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	gitCommitAt,
	gitRefAt,
	invalidateGitCaches,
	invalidateGitStatusCache,
	gitSpawnCount,
	resetGitSpawnCount
} from '../../src/lib/server/git';

/**
 * `gitCommitAt` against REAL git, including real worktrees — the shape the Git
 * sidebar section renders per notebook.
 *
 * Real repos, not a mocked `execFile`: what is under test is how git actually
 * answers for a WORKTREE (its own HEAD, its own index, its own dirty state),
 * which is exactly the thing a mock would have to assume rather than prove.
 */
function git(cwd: string, ...args: string[]) {
	execFileSync('git', ['-C', cwd, ...args], {
		stdio: 'pipe',
		env: {
			...process.env,
			GIT_AUTHOR_NAME: 'Ada L',
			GIT_AUTHOR_EMAIL: 'ada@example.com',
			GIT_COMMITTER_NAME: 'Ada L',
			GIT_COMMITTER_EMAIL: 'ada@example.com'
		}
	});
}

function initRepo(dir: string) {
	git(dir, 'init', '-q');
	git(dir, 'config', 'user.email', 'ada@example.com');
	git(dir, 'config', 'user.name', 'Ada L');
	// A deterministic default branch name regardless of the host git config.
	git(dir, 'checkout', '-q', '-B', 'main');
}

function commitAll(dir: string, msg: string) {
	git(dir, 'add', '-A');
	git(dir, 'commit', '-q', '-m', msg);
}

let dirs: string[] = [];
function tempDir(): string {
	const d = mkdtempSync(join(tmpdir(), 'cellar-gitcommit-'));
	dirs.push(d);
	return d;
}

beforeEach(() => {
	dirs = [];
	// Each test builds fresh directories, so the caches can only carry noise;
	// clearing keeps a test's spawn accounting its own.
	invalidateGitCaches();
});
afterEach(() => {
	for (const d of dirs) {
		try {
			// A worktree holds an administrative link in the main repo; removing the
			// directory outright is fine for a throwaway.
			rmSync(d, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}
});

describe('gitCommitAt', () => {
	it('reports branch, short + full SHA, subject, author and commit time', async () => {
		const dir = tempDir();
		initRepo(dir);
		writeFileSync(join(dir, 'a.txt'), 'hi');
		commitAll(dir, 'add the first thing');

		const full = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD']).toString().trim();
		const short = execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD']).toString().trim();

		const at = await gitCommitAt(dir);
		expect(at.isRepo).toBe(true);
		expect(at.branch).toBe('main');
		expect(at.detached).toBe(false);
		expect(at.commit).toBe(full);
		expect(at.shortSha).toBe(short);
		expect(at.subject).toBe('add the first thing');
		expect(at.author).toBe('Ada L');
		expect(at.dirty).toBe(false);
		// Milliseconds, not seconds: a second-scale value would render as 1970.
		expect(at.commitTime).toBeGreaterThan(1_600_000_000_000);
		expect(at.commitTime! - Date.now()).toBeLessThan(60_000);
	});

	it('keeps a subject verbatim, whatever it contains', async () => {
		const dir = tempDir();
		initRepo(dir);
		writeFileSync(join(dir, 'a.txt'), 'hi');
		// Tabs and NUL-adjacent punctuation are exactly what a naive field split loses.
		commitAll(dir, 'fix: handle "quoted", tab\tseparated | piped input');

		const at = await gitCommitAt(dir);
		expect(at.subject).toBe('fix: handle "quoted", tab\tseparated | piped input');
	});

	it('flags a checkout dirty for a tracked edit, and for an untracked file alone', async () => {
		const dir = tempDir();
		initRepo(dir);
		writeFileSync(join(dir, 'a.txt'), 'hi');
		commitAll(dir, 'c');
		expect((await gitCommitAt(dir)).dirty).toBe(false);

		writeFileSync(join(dir, 'a.txt'), 'changed');
		invalidateGitStatusCache(); // a working-tree edit does not move the index
		expect((await gitCommitAt(dir)).dirty).toBe(true);

		// An untracked file alone still means "this checkout is not what HEAD says".
		git(dir, 'checkout', '--', 'a.txt');
		writeFileSync(join(dir, 'new.txt'), 'brand new');
		invalidateGitStatusCache();
		expect((await gitCommitAt(dir)).dirty).toBe(true);
	});

	it('THE HEADLINE: a worktree reports its OWN commit, not the main checkout’s', async () => {
		const main = tempDir();
		initRepo(main);
		writeFileSync(join(main, 'probe.py'), "VALUE = 'workspace'\n");
		commitAll(main, 'workspace copy');
		git(main, 'branch', 'under-review');

		// The review checkout, as `git worktree add roots/pr-482 <branch>` makes it.
		const wt = join(main, 'roots', 'pr-482');
		git(main, 'worktree', 'add', '-q', wt, 'under-review');
		writeFileSync(join(wt, 'probe.py'), "VALUE = 'under review'\n");
		commitAll(wt, 'the change under review');

		// The main checkout moves on independently, so neither commit is the other's.
		writeFileSync(join(main, 'probe.py'), "VALUE = 'workspace v2'\n");
		commitAll(main, 'unrelated workspace work');

		const [ws, review] = await Promise.all([gitCommitAt(main), gitCommitAt(wt)]);

		expect(ws.branch).toBe('main');
		expect(ws.subject).toBe('unrelated workspace work');
		expect(review.branch).toBe('under-review');
		expect(review.subject).toBe('the change under review');
		// The whole point of the panel: two directories of ONE repo, two commits.
		expect(review.commit).not.toBe(ws.commit);
		expect(review.dirty).toBe(false);
	});

	it('reads a worktree’s own dirty state, independently of the main checkout', async () => {
		const main = tempDir();
		initRepo(main);
		// `roots/` gitignored is the real-world setup: a worktree created INSIDE the
		// workspace is otherwise an untracked directory in the parent checkout, which
		// would (correctly, but uninterestingly) report the workspace itself dirty.
		writeFileSync(join(main, '.gitignore'), 'roots/\n');
		writeFileSync(join(main, 'a.txt'), 'hi');
		commitAll(main, 'c');
		git(main, 'branch', 'side');
		const wt = join(main, 'roots', 'side');
		git(main, 'worktree', 'add', '-q', wt, 'side');

		writeFileSync(join(wt, 'a.txt'), 'edited in the worktree only');
		invalidateGitStatusCache();

		expect((await gitCommitAt(wt)).dirty).toBe(true);
		expect((await gitCommitAt(main)).dirty).toBe(false);
	});

	it('reports the workspace dirty when a worktree under it is NOT ignored', async () => {
		// The flip side of the case above, pinned because it is what a user sees
		// before they gitignore `roots/`: the untracked worktree directory really is
		// an uncommitted change in the parent checkout, and the marker says so rather
		// than special-casing a directory git has no reason to treat as special.
		const main = tempDir();
		initRepo(main);
		writeFileSync(join(main, 'a.txt'), 'hi');
		commitAll(main, 'c');
		git(main, 'branch', 'side');
		git(main, 'worktree', 'add', '-q', join(main, 'roots', 'side'), 'side');
		invalidateGitStatusCache();

		expect((await gitCommitAt(main)).dirty).toBe(true);
	});

	it('reports a detached HEAD as detached, with no branch', async () => {
		const dir = tempDir();
		initRepo(dir);
		writeFileSync(join(dir, 'a.txt'), 'hi');
		commitAll(dir, 'c');
		const short = execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD']).toString().trim();
		git(dir, 'checkout', '-q', '--detach', 'HEAD');

		const at = await gitCommitAt(dir);
		expect(at.isRepo).toBe(true);
		expect(at.branch).toBeNull();
		expect(at.detached).toBe(true);
		expect(at.shortSha).toBe(short);
	});

	it('reports an unborn HEAD as a repo with a branch and no commit — not as detached', async () => {
		const dir = tempDir();
		initRepo(dir); // no commits yet
		const at = await gitCommitAt(dir);
		expect(at.isRepo).toBe(true);
		expect(at.branch).toBe('main');
		expect(at.detached).toBe(false);
		expect(at.commit).toBeNull();
		expect(at.shortSha).toBeNull();
		expect(at.subject).toBeNull();
		expect(at.commitTime).toBeNull();
	});

	it('degrades to isRepo:false for a plain directory — never throws', async () => {
		const dir = tempDir();
		const at = await gitCommitAt(dir);
		expect(at).toEqual({
			isRepo: false,
			branch: null,
			detached: false,
			shortSha: null,
			commit: null,
			subject: null,
			author: null,
			commitTime: null,
			dirty: false
		});
	});

	it('degrades to isRepo:false for a directory that does not exist', async () => {
		const at = await gitCommitAt(join(tempDir(), 'gone', 'missing'));
		expect(at.isRepo).toBe(false);
		expect(at.dirty).toBe(false);
	});

	it('serves a repeat read from cache instead of respawning git', async () => {
		const dir = tempDir();
		initRepo(dir);
		writeFileSync(join(dir, 'a.txt'), 'hi');
		commitAll(dir, 'c');
		await gitCommitAt(dir); // warm the preflight + the entry

		resetGitSpawnCount();
		const again = await gitCommitAt(dir);
		expect(gitSpawnCount()).toBe(0);
		expect(again.subject).toBe('c');
	});

	it('re-reads after an in-app write invalidates the status caches', async () => {
		const dir = tempDir();
		initRepo(dir);
		writeFileSync(join(dir, 'a.txt'), 'hi');
		commitAll(dir, 'c');
		await gitCommitAt(dir);

		writeFileSync(join(dir, 'a.txt'), 'dirty now');
		invalidateGitStatusCache();
		resetGitSpawnCount();
		expect((await gitCommitAt(dir)).dirty).toBe(true);
		expect(gitSpawnCount()).toBeGreaterThan(0);
	});
});

describe('gitRefAt (its own cheap two-spawn path — contract regression guard)', () => {
	it('names the branch a worktree holds', async () => {
		const main = tempDir();
		initRepo(main);
		writeFileSync(join(main, 'a.txt'), 'hi');
		commitAll(main, 'c');
		git(main, 'branch', 'pr-482');
		const wt = join(main, 'roots', 'pr-482');
		git(main, 'worktree', 'add', '-q', wt, 'pr-482');

		const short = execFileSync('git', ['-C', wt, 'rev-parse', '--short', 'HEAD']).toString().trim();
		expect(await gitRefAt(wt)).toEqual({ branch: 'pr-482', commit: short });
	});

	it('falls back to the short SHA as the branch when HEAD is detached', async () => {
		const dir = tempDir();
		initRepo(dir);
		writeFileSync(join(dir, 'a.txt'), 'hi');
		commitAll(dir, 'c');
		const short = execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD']).toString().trim();
		git(dir, 'checkout', '-q', '--detach', 'HEAD');

		expect(await gitRefAt(dir)).toEqual({ branch: short, commit: short });
	});

	it('returns null for a directory that is not a git checkout', async () => {
		expect(await gitRefAt(tempDir())).toBeNull();
	});
});
