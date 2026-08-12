/**
 * `listWorktreesAt` — the `git worktree list --porcelain` reader that backs the
 * out-of-workspace root admission rule.
 *
 * Driven against REAL repos with REAL `git worktree add`, never a fixture string:
 * the format is the contract with an external tool, and the two properties this
 * feature leans on hardest — that paths come back REALPATH'd, and that a REMOVED
 * worktree still lists — are facts about git's behavior that a hand-written
 * fixture would simply assume. Every stanza shape the parser handles is produced
 * by a real git command here, the awkward ones included (a locked worktree with a
 * reason, a bare repository, a prunable registration).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let ROOT: string;
let MAIN: string;
let gitmod: typeof import('../../src/lib/server/git');

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

beforeAll(async () => {
	gitmod = await import('../../src/lib/server/git');
	ROOT = mkdtempSync(join(tmpdir(), 'cellar-wt-list-'));
	MAIN = join(ROOT, 'main');
	mkdirSync(MAIN, { recursive: true });
	git(MAIN, 'init', '-q', '-b', 'main');
	writeFileSync(join(MAIN, 'f.txt'), 'hi\n');
	git(MAIN, 'add', 'f.txt');
	git(MAIN, 'commit', '-q', '-m', 'init');
	// A worktree whose PATH contains a space, under a non-ASCII branch name. Git
	// refuses a space in a ref, but a checkout directory may certainly have one —
	// and the `worktree` line's value is the REST OF THE LINE, so a `split(' ')`
	// parser truncates the path and the whole entry silently names a directory that
	// does not exist. (Unicode is fine in a ref, so the branch carries that half.)
	git(MAIN, 'branch', 'feat/née-bug');
	git(MAIN, 'worktree', 'add', '-q', join(ROOT, 'my sibling'), 'feat/née-bug');
	git(MAIN, 'worktree', 'add', '-q', '--detach', join(ROOT, 'detached'));
	git(MAIN, 'worktree', 'add', '-q', join(MAIN, 'roots', 'inside'), '-b', 'inside');
});

afterAll(() => {
	if (ROOT) rmSync(ROOT, { recursive: true, force: true });
});

describe('listWorktreesAt — the porcelain parser, over real repos', () => {
	it('lists the main checkout FIRST, then each linked worktree', () => {
		gitmod.invalidateGitCaches();
		const list = gitmod.listWorktreesAt(MAIN);
		expect(list.length).toBe(4);
		// The main checkout leads, which is what lets a caller identify and exclude it.
		expect(realpathSync(list[0].path)).toBe(realpathSync(MAIN));
		expect(list[0].branch).toBe('main');
	});

	it('reads a branch, a DETACHED head, and a PATH containing a space', () => {
		gitmod.invalidateGitCaches();
		const byName = new Map(gitmod.listWorktreesAt(MAIN).map((w) => [w.path.split('/').pop(), w]));

		const sibling = byName.get('my sibling');
		// The path survived intact (a `split(' ')` parser would have produced `my`),
		// and the ref kept its non-ASCII name with `refs/heads/` stripped.
		expect(sibling).toBeTruthy();
		expect(sibling?.branch).toBe('feat/née-bug');
		expect(sibling?.detached).toBe(false);
		expect(sibling?.head).toMatch(/^[0-9a-f]{40}$/);

		const detached = byName.get('detached');
		expect(detached?.detached).toBe(true);
		expect(detached?.branch).toBeNull();
		expect(detached?.head).toMatch(/^[0-9a-f]{40}$/);
	});

	it('returns REALPATH’d paths — the two-namespace hazard, stated as a test', () => {
		gitmod.invalidateGitCaches();
		const list = gitmod.listWorktreesAt(MAIN);
		// Every path git prints is already resolved, so comparing one lexically
		// against Cellar's own `resolve()`d workspace is what breaks on macOS (where
		// a `mkdtemp` workspace is `/var/folders/…` but resolves to
		// `/private/var/folders/…`). Asserted as identity-after-realpath, which is
		// exactly the comparison the admission rule makes.
		for (const w of list) expect(w.path).toBe(realpathSync(w.path));
	});

	it('a REMOVED worktree STILL LISTS (prunable) — listing is not existence', () => {
		// The load-bearing one: being listed authorises, but only `statSync` decides
		// usability, which is why the resolver keeps its own existence check.
		const doomed = join(ROOT, 'doomed');
		git(MAIN, 'worktree', 'add', '-q', doomed, '-b', 'doomed');
		rmSync(doomed, { recursive: true, force: true });

		gitmod.invalidateGitCaches();
		const entry = gitmod.listWorktreesAt(MAIN).find((w) => w.path.endsWith('doomed'));
		expect(entry).toBeTruthy();
		expect(entry?.prunable).toBe(true);

		git(MAIN, 'worktree', 'prune');
		gitmod.invalidateGitCaches();
		expect(gitmod.listWorktreesAt(MAIN).find((w) => w.path.endsWith('doomed'))).toBeUndefined();
	});

	it('reads a LOCKED worktree, whose flag carries a trailing reason', () => {
		const locked = join(ROOT, 'locked-tree');
		git(MAIN, 'worktree', 'add', '-q', locked, '-b', 'locked-branch');
		git(MAIN, 'worktree', 'lock', '--reason', 'held for review', locked);
		gitmod.invalidateGitCaches();
		const entry = gitmod.listWorktreesAt(MAIN).find((w) => w.path.endsWith('locked-tree'));
		// Matched as a PREFIX, not by equality: `locked <reason>` is a normal stanza.
		expect(entry?.locked).toBe(true);
		expect(entry?.branch).toBe('locked-branch');
		git(MAIN, 'worktree', 'unlock', locked);
		git(MAIN, 'worktree', 'remove', '--force', locked);
	});

	it('reads a BARE repository’s stanza, which carries no HEAD at all', () => {
		const bare = join(ROOT, 'bare.git');
		execFileSync('git', ['clone', '--bare', '-q', MAIN, bare], { stdio: 'pipe' });
		gitmod.invalidateGitCaches();
		const list = gitmod.listWorktreesAt(bare);
		expect(list[0].bare).toBe(true);
		// `bare` replaces the HEAD/branch lines entirely — a parser that assumed they
		// were always present would produce a half-built entry rather than this.
		expect(list[0].head).toBeNull();
		expect(list[0].branch).toBeNull();
		rmSync(bare, { recursive: true, force: true });
	});

	it('answers IDENTICALLY from any worktree of the repo', () => {
		// Which is why running it in the workspace is sufficient and canonical: the
		// admission rule never has to ask "from where".
		gitmod.invalidateGitCaches();
		const fromMain = gitmod.listWorktreesAt(MAIN).map((w) => w.path).sort();
		gitmod.invalidateGitCaches();
		const fromSibling = gitmod.listWorktreesAt(join(ROOT, 'my sibling')).map((w) => w.path).sort();
		expect(fromSibling).toEqual(fromMain);
	});

	it('a NON-repo answers an empty list, never a throw', () => {
		const plain = mkdtempSync(join(tmpdir(), 'cellar-not-a-repo-'));
		try {
			gitmod.invalidateGitCaches();
			expect(gitmod.listWorktreesAt(plain)).toEqual([]);
		} finally {
			rmSync(plain, { recursive: true, force: true });
		}
	});
});

describe('listWorktreesAt — caching', () => {
	it('collapses a burst to ONE spawn, and re-spawns after invalidation', () => {
		gitmod.invalidateGitCaches();
		gitmod.resetGitSpawnCount();
		// A picker open + `list_roots` + the sidebar all land inside one window.
		gitmod.listWorktreesAt(MAIN);
		gitmod.listWorktreesAt(MAIN);
		gitmod.listWorktreesAt(MAIN);
		expect(gitmod.gitSpawnCount()).toBe(1);
		// The SYNC reader must log like the async one, or every "this refused without
		// spawning" measurement in the suite silently stops meaning anything.
		expect(gitmod.gitSpawnLog()).toEqual(['worktree']);

		gitmod.invalidateGitCaches();
		gitmod.listWorktreesAt(MAIN);
		expect(gitmod.gitSpawnCount()).toBe(2);
	});

	it('is keyed per directory, so an unrelated repo gets its own answer', () => {
		const other = mkdtempSync(join(tmpdir(), 'cellar-other-repo-'));
		try {
			git(other, 'init', '-q', '-b', 'main');
			gitmod.invalidateGitCaches();
			expect(gitmod.listWorktreesAt(MAIN).length).toBeGreaterThan(1);
			// Same window, different directory: it must not be served the cached
			// listing of the repo asked about a moment earlier.
			expect(gitmod.listWorktreesAt(other).length).toBe(1);
		} finally {
			rmSync(other, { recursive: true, force: true });
		}
	});
});
