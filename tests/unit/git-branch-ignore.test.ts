import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitBranch, gitStatus } from '../../src/lib/server/git';
import { makeIgnoredMatcher } from '../../src/lib/gitIgnored';

// git.ts reads workspaceRoot() = process.env.CELLAR_WORKSPACE at call time, so
// each test points it at a throwaway repo (or a non-repo dir).
function git(cwd: string, ...args: string[]) {
	execFileSync('git', ['-C', cwd, ...args], {
		stdio: 'pipe',
		env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' }
	});
}

function initRepo(dir: string) {
	git(dir, 'init', '-q');
	git(dir, 'config', 'user.email', 't@t');
	git(dir, 'config', 'user.name', 'T');
	// Force a deterministic default branch name regardless of the host git config.
	git(dir, 'checkout', '-q', '-B', 'main');
}

function commitAll(dir: string, msg = 'c') {
	git(dir, 'add', '-A');
	git(dir, 'commit', '-q', '-m', msg);
}

let dirs: string[] = [];
function tempDir(): string {
	const d = mkdtempSync(join(tmpdir(), 'cellar-git-'));
	dirs.push(d);
	return d;
}

const savedWs = process.env.CELLAR_WORKSPACE;
beforeEach(() => {
	dirs = [];
});
afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	if (savedWs === undefined) delete process.env.CELLAR_WORKSPACE;
	else process.env.CELLAR_WORKSPACE = savedWs;
});

describe('gitBranch', () => {
	it('reports the current branch name', async () => {
		const dir = tempDir();
		initRepo(dir);
		writeFileSync(join(dir, 'a.txt'), 'hi');
		commitAll(dir);
		process.env.CELLAR_WORKSPACE = dir;
		expect(await gitBranch()).toEqual({ isRepo: true, branch: 'main', detached: false });

		git(dir, 'checkout', '-q', '-b', 'feature/x');
		expect(await gitBranch()).toEqual({ isRepo: true, branch: 'feature/x', detached: false });
	});

	it('reports a branch even before the first commit (unborn HEAD)', async () => {
		const dir = tempDir();
		initRepo(dir);
		process.env.CELLAR_WORKSPACE = dir;
		expect(await gitBranch()).toEqual({ isRepo: true, branch: 'main', detached: false });
	});

	it('reports a short SHA when HEAD is detached', async () => {
		const dir = tempDir();
		initRepo(dir);
		writeFileSync(join(dir, 'a.txt'), 'hi');
		commitAll(dir);
		const sha = execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD']).toString().trim();
		git(dir, 'checkout', '-q', '--detach', 'HEAD');
		process.env.CELLAR_WORKSPACE = dir;
		const res = await gitBranch();
		expect(res.isRepo).toBe(true);
		expect(res.detached).toBe(true);
		expect(res.branch).toBe(sha);
	});

	it('returns isRepo:false for a non-git directory', async () => {
		const dir = tempDir();
		process.env.CELLAR_WORKSPACE = dir;
		expect(await gitBranch()).toEqual({ isRepo: false, branch: null, detached: false });
	});
});

describe('gitStatus ignored list', () => {
	it('lists an ignored file and a wholly-ignored directory', async () => {
		const dir = tempDir();
		initRepo(dir);
		writeFileSync(join(dir, '.gitignore'), 'secret.txt\nbuild/\n');
		writeFileSync(join(dir, 'tracked.txt'), 'ok');
		commitAll(dir);
		writeFileSync(join(dir, 'secret.txt'), 'shh');
		mkdirSync(join(dir, 'build'));
		writeFileSync(join(dir, 'build', 'out.js'), 'x');
		process.env.CELLAR_WORKSPACE = dir;

		const res = await gitStatus();
		expect(res.isRepo).toBe(true);
		expect(res.ignored).toContain('secret.txt');
		// A wholly-ignored directory collapses to one trailing-slash entry.
		expect(res.ignored).toContain('build/');
		// Tracked files never appear in the ignored list.
		expect(res.ignored).not.toContain('tracked.txt');
		expect(res.files['tracked.txt']).toBeUndefined(); // committed & unchanged
	});

	it('returns an empty ignored list for a non-git directory', async () => {
		const dir = tempDir();
		process.env.CELLAR_WORKSPACE = dir;
		expect(await gitStatus()).toEqual({ isRepo: false, files: {}, ignored: [] });
	});
});

describe('makeIgnoredMatcher', () => {
	it('matches ignored files exactly', () => {
		const m = makeIgnoredMatcher(['secret.txt', '.env']);
		expect(m('secret.txt')).toBe(true);
		expect(m('.env')).toBe(true);
		expect(m('secret.txt.bak')).toBe(false);
		expect(m('other.txt')).toBe(false);
	});

	it('matches an ignored directory and everything under it', () => {
		const m = makeIgnoredMatcher(['build/']);
		expect(m('build')).toBe(true); // the directory node itself
		expect(m('build/out.js')).toBe(true); // a file inside
		expect(m('build/nested/deep.js')).toBe(true);
		expect(m('builder')).toBe(false); // prefix must respect the slash boundary
		expect(m('src/main.js')).toBe(false);
	});

	it('is empty/false for no ignored entries', () => {
		expect(makeIgnoredMatcher([])('anything')).toBe(false);
		expect(makeIgnoredMatcher(undefined)('anything')).toBe(false);
		expect(makeIgnoredMatcher(null)('')).toBe(false);
	});
});
