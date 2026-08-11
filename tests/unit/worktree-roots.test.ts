/**
 * A notebook code root that points at a git worktree OUTSIDE the workspace.
 *
 * The subject is the SECOND admission rule: a path outside the workspace is
 * admitted only when `git worktree list --porcelain`, run in the workspace, names
 * that exact directory. Everything here runs against REAL repos and REAL
 * `git worktree add`, because the rule is a statement about what git reports —
 * a mocked listing would assume precisely the part that can be wrong.
 *
 * The invariant this whole feature rests on is that the app-wide path guard is
 * NOT what changed. `resolveInWorkspace` is asserted unchanged both behaviourally
 * and as a SOURCE GUARD below: e2e is deliberately absent from CI and the
 * no-mistakes gate, so the security-shaped invariant needs a unit-level assertion
 * that runs on every push.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';

let ROOT: string;
let WS: string;
let SIBLING: string;
let nbmod: typeof import('../../src/lib/server/notebook');
let rootmod: typeof import('../../src/lib/server/notebookRoot');
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
	// The workspace is a repo; the sibling worktree lives OUTSIDE it, which is the
	// layout `git worktree add ../name <branch>` produces and the one the whole
	// feature exists for.
	ROOT = mkdtempSync(join(tmpdir(), 'cellar-wt-roots-'));
	WS = join(ROOT, 'workspace');
	SIBLING = join(ROOT, 'pr-398');
	mkdirSync(WS, { recursive: true });
	git(WS, 'init', '-q', '-b', 'main');
	writeFileSync(join(WS, 'probe.py'), "VALUE = 'workspace'\n");
	git(WS, 'add', 'probe.py');
	git(WS, 'commit', '-q', '-m', 'init');
	git(WS, 'branch', 'under-review');
	git(WS, 'worktree', 'add', '-q', SIBLING, 'under-review');
	// A worktree INSIDE the workspace too: the no-regression case.
	git(WS, 'worktree', 'add', '-q', join(WS, 'roots', 'pr-1'), '-b', 'pr-1');

	process.env.CELLAR_WORKSPACE = WS;
	nbmod = await import('../../src/lib/server/notebook');
	rootmod = await import('../../src/lib/server/notebookRoot');
	gitmod = await import('../../src/lib/server/git');
});

afterAll(() => {
	if (ROOT) rmSync(ROOT, { recursive: true, force: true });
});

beforeEach(() => {
	// The listing is cached on a 1.5s TTL, and these tests add and remove worktrees
	// far faster than that.
	gitmod.invalidateGitCaches();
});

describe('admitting a registered sibling worktree', () => {
	it('resolves it, stores the ..-relative form, and marks it kind:"worktree"', () => {
		const r = rootmod.resolveRootDir('../pr-398');
		expect(r).toMatchObject({ rel: '../pr-398', apiPath: '../pr-398', kind: 'worktree' });
		expect(realpathSync(r!.dir)).toBe(realpathSync(SIBLING));
	});

	it('accepts an ABSOLUTE path but PERSISTS the ..-relative form', () => {
		// What a user pastes is the absolute path `git worktree add` printed. What
		// lands in the committed `.ipynb` must be portable and must leak no home
		// directory — the nbdev export-target decision, for the same reasons.
		const r = rootmod.resolveRootDir(SIBLING);
		expect(r?.rel).toBe('../pr-398');
		expect(r?.kind).toBe('worktree');
	});

	it('NEVER yields an absolute apiPath, whichever form was declared', () => {
		// The load-bearing one. An absolute API path does not merely fail — jupyter's
		// `to_os_path` strips the leading slash and joins it onto `root_dir`, so it
		// collapses INTO the workspace and `cwd_for_path` then walks up, silently
		// starting the kernel somewhere else.
		for (const declared of [SIBLING, '../pr-398', `${SIBLING}/`]) {
			const r = rootmod.resolveRootDir(declared);
			expect(r?.apiPath.startsWith('/')).toBe(false);
			expect(r?.apiPath).toBe(r?.rel);
		}
	});

	it('keeps a root INSIDE the workspace exactly as it was — the no-regression case', () => {
		// `roots/pr-1` is BOTH a registered worktree and inside the workspace. It must
		// still resolve through the untouched guard, keep its `roots/…` declaration,
		// and report `kind:'workspace'` — existing notebooks' stored values are stable.
		expect(rootmod.resolveRootDir('roots/pr-1')).toEqual({
			rel: 'roots/pr-1',
			dir: join(resolve(WS), 'roots', 'pr-1'),
			apiPath: 'roots/pr-1',
			kind: 'workspace'
		});
	});
});

describe('refusing what is not a registered worktree of this repo', () => {
	it('REFUSES a plain directory outside the workspace, naming what IS registered', () => {
		const plain = join(ROOT, 'not-a-worktree');
		mkdirSync(plain, { recursive: true });
		expect(() => rootmod.resolveRootDir(plain)).toThrow(/not a registered git worktree/i);
		// Naming what was found is what makes the message actionable rather than a
		// wall, and it is nearly free — the listing was just fetched to decide.
		expect(() => rootmod.resolveRootDir(plain)).toThrow(/pr-398/);
	});

	it('REFUSES a worktree of a DIFFERENT repository', () => {
		// Same-repo only: `git worktree list` run in the workspace reports only this
		// repo's checkouts, so the admission set is authored by the user's own
		// `git worktree add` runs against THIS repo.
		const other = join(ROOT, 'other-repo');
		const otherWt = join(ROOT, 'other-wt');
		mkdirSync(other, { recursive: true });
		git(other, 'init', '-q', '-b', 'main');
		writeFileSync(join(other, 'x.txt'), 'x\n');
		git(other, 'add', 'x.txt');
		git(other, 'commit', '-q', '-m', 'init');
		git(other, 'worktree', 'add', '-q', otherWt, '-b', 'feat');

		expect(() => rootmod.resolveRootDir(otherWt)).toThrow(/not a registered git worktree/i);
	});

	it('REFUSES a registered worktree whose DIRECTORY is gone (prunable)', () => {
		// Being LISTED is not being on disk. The listing authorises; `statSync` still
		// decides usability, and the message names the repair for THIS kind.
		const doomed = join(ROOT, 'doomed');
		git(WS, 'worktree', 'add', '-q', doomed, '-b', 'doomed');
		rmSync(doomed, { recursive: true, force: true });
		gitmod.invalidateGitCaches();

		// It really is still listed — which is the point of the case.
		expect(gitmod.listWorktreesAt(WS).some((w) => w.path.endsWith('doomed'))).toBe(true);
		expect(() => rootmod.resolveRootDir('../doomed')).toThrow(/no longer exists/i);
		expect(() => rootmod.resolveRootDir('../doomed')).toThrow(/prune/i);

		git(WS, 'worktree', 'prune');
	});

	it('names the NEW path when a worktree was MOVED', () => {
		const from = join(ROOT, 'movable');
		const to = join(ROOT, 'moved-here');
		git(WS, 'worktree', 'add', '-q', from, '-b', 'movable');
		git(WS, 'worktree', 'move', from, to);
		gitmod.invalidateGitCaches();

		// `git worktree move` is an ordinary thing to do, and the listing already in
		// hand makes the new path free to name — turning a dead end into a one-line
		// fix. Deliberately NOT auto-followed: rewriting a committed `.ipynb` because
		// a directory moved would be a silent change made on a guess.
		expect(() => rootmod.resolveRootDir('../movable')).toThrow(/was moved to/i);
		expect(() => rootmod.resolveRootDir('../movable')).toThrow(/moved-here/);

		git(WS, 'worktree', 'remove', '--force', to);
	});

	it('a "~" path is still refused outright, before anything else', () => {
		expect(() => rootmod.resolveRootDir('~/elsewhere')).toThrow(/home-relative/i);
	});
});

describe('the two-namespace rule', () => {
	it('matches a worktree through a SYMLINKED workspace path (the macOS /tmp case)', () => {
		// `git worktree list` returns REALPATH'd paths while `CELLAR_WORKSPACE` is the
		// lexical `resolve()`d string. On macOS every `mkdtemp` workspace is exactly
		// this shape (`/var/folders/…` -> `/private/var/folders/…`), so without
		// realpath IDENTITY on both sides, matching fails for real users and for the
		// e2e harness alike. Reproduced explicitly here so it is covered on Linux too.
		const linkRoot = mkdtempSync(join(tmpdir(), 'cellar-ns-'));
		const realDir = join(linkRoot, 'real');
		mkdirSync(realDir, { recursive: true });
		const linked = join(linkRoot, 'link');
		symlinkSync(realDir, linked);

		const wsReal = join(realDir, 'ws');
		mkdirSync(wsReal, { recursive: true });
		git(wsReal, 'init', '-q', '-b', 'main');
		writeFileSync(join(wsReal, 'f.txt'), 'x\n');
		git(wsReal, 'add', 'f.txt');
		git(wsReal, 'commit', '-q', '-m', 'init');
		git(wsReal, 'worktree', 'add', '-q', join(realDir, 'sib'), '-b', 'sib');

		const prev = process.env.CELLAR_WORKSPACE;
		// The workspace addressed THROUGH the symlink — the lexical namespace.
		process.env.CELLAR_WORKSPACE = join(linked, 'ws');
		try {
			gitmod.invalidateGitCaches();
			const r = rootmod.resolveRootDir('../sib');
			// Verification succeeded across the namespaces…
			expect(r?.kind).toBe('worktree');
			// …while what is BOUND and PERSISTED stays LEXICAL: jupyter's `to_os_path`
			// joins onto the lexical `root_dir` without resolving symlinks, so the
			// realpath'd `../../private/…` form would be machine-specific noise in a
			// committed `.ipynb` — and would not even be the shortest path.
			expect(r?.rel).toBe('../sib');
			expect(r?.dir).toBe(join(linked, 'sib'));
		} finally {
			process.env.CELLAR_WORKSPACE = prev;
			gitmod.invalidateGitCaches();
			rmSync(linkRoot, { recursive: true, force: true });
		}
	});
});

describe('the app-wide path guard is NOT what changed', () => {
	it('resolveInWorkspace still refuses every out-of-workspace path', async () => {
		const { resolveInWorkspace } = await import('../../src/lib/server/fstree');
		// The sibling worktree that a ROOT may now name is still not reachable as a
		// FILE — which is the entire security argument: a worktree root grants a cwd,
		// not one byte of file access.
		expect(() => resolveInWorkspace('../pr-398')).toThrow(/escapes workspace/i);
		expect(() => resolveInWorkspace(SIBLING)).toThrow(/escapes workspace/i);
		expect(() => resolveInWorkspace('../pr-398/probe.py')).toThrow(/escapes workspace/i);
	});

	it('SOURCE GUARD: fstree.ts has no worktree branch and no git import', () => {
		// The invariant that matters most, asserted where CI can see it: the guard is
		// widened by EDITING it, and the review signal is that this file knows nothing
		// about worktrees. e2e proves the behavior end to end but runs neither in CI
		// nor in the no-mistakes gate.
		const src = readFileSync(new URL('../../src/lib/server/fstree.ts', import.meta.url), 'utf8');
		expect(src).not.toMatch(/worktree/i);
		expect(src).not.toMatch(/listWorktreesAt/);
		expect(src).not.toMatch(/from '\.\/git'/);
		// And the guard itself is still the plain lexical prefix test.
		expect(src).toMatch(/abs !== root && !abs\.startsWith\(root \+ sep\)/);
	});
});

describe('declaring one end to end', () => {
	it('persists the ..-relative form into the notebook and reads back resolved', async () => {
		const actions = await import('../../src/lib/server/notebook-root-actions');
		const nb = nbmod.createNotebook(`wt-${Math.random().toString(36).slice(2, 8)}.ipynb`).path;

		// Declared ABSOLUTE, stored RELATIVE — and the result reports the stored form,
		// so no caller keeps a divergent copy.
		const res = await actions.setNotebookRootAndRestart(SIBLING, nb);
		expect(res.root).toBe('../pr-398');
		const onDisk = JSON.parse(readFileSync(nb, 'utf8'));
		expect(onDisk.metadata.cellar.root).toBe('../pr-398');
		expect(onDisk.metadata.cellar.root.startsWith('/')).toBe(false);

		await actions.setNotebookRootAndRestart(null, nb);
	});

	it('re-declaring the SAME root in the other form is a no-op', async () => {
		// One directory has two legal spellings. Re-declaring the root you are already
		// on must not free the kernel and cost the user their variables — and a pure
		// text comparison cannot see it, which is why the resolved DIRECTORIES are
		// what decide.
		const actions = await import('../../src/lib/server/notebook-root-actions');
		const nb = nbmod.createNotebook(`wt-same-${Math.random().toString(36).slice(2, 8)}.ipynb`).path;

		await actions.setNotebookRootAndRestart('../pr-398', nb);
		const before = readFileSync(nb, 'utf8');

		const again = await actions.setNotebookRootAndRestart(SIBLING, nb);
		expect(again.changed).toBe(false);
		expect(again.namespace_cleared).toBe(false);
		expect(again.root).toBe('../pr-398');
		// Nothing was rewritten, so there is no git diff either.
		expect(readFileSync(nb, 'utf8')).toBe(before);

		await actions.setNotebookRootAndRestart(null, nb);
	});

	it('lists the sibling worktree as an EXTERNAL, detected root', async () => {
		const actions = await import('../../src/lib/server/notebook-root-actions');
		gitmod.invalidateGitCaches();
		const roots = await actions.listWorkspaceRoots();
		const byPath = Object.fromEntries(roots.map((r) => [r.path, r]));

		const sibling = byPath['../pr-398'];
		expect(sibling).toBeTruthy();
		// Detected from the listing, labelled external so nobody adopts a sibling
		// checkout believing it sits inside the workspace…
		expect(sibling.source).toBe('worktree');
		expect(sibling.external).toBe(true);
		expect(sibling.exists).toBe(true);
		// …and its branch/HEAD come from the porcelain stanza, so detection costs no
		// extra `git` spawn per root.
		expect(sibling.branch).toBe('under-review');

		// The workspace's OWN checkout is excluded: it would duplicate the picker's
		// existing "workspace root (default)" entry.
		expect(roots.some((r) => r.path === '' || r.path === '.')).toBe(false);
		expect(roots.some((r) => realpathSync(r.absolute) === realpathSync(WS))).toBe(false);

		// A worktree under `roots/` is deduped by REALPATH and keeps its
		// workspace-relative declaration — the better thing to persist.
		expect(byPath['roots/pr-1']).toBeTruthy();
		expect(byPath['roots/pr-1'].external).toBe(false);
		expect(roots.filter((r) => realpathSync(r.absolute) === realpathSync(join(WS, 'roots', 'pr-1'))).length).toBe(1);

		// Workspace-internal roots come first, so a workspace that already uses
		// `roots/` sees no reordering of what it had.
		const firstExternal = roots.findIndex((r) => r.external);
		const lastInternal = roots.map((r) => r.external).lastIndexOf(false);
		expect(firstExternal).toBeGreaterThan(lastInternal);
	});

	it('ENUMERATES a symlinked root directory (the one-line Mechanism B fix)', async () => {
		// Such a root already RESOLVES and already runs — the guard is lexical and
		// `statSync` follows the link — so the picker was the one surface that could
		// not see a root the rest of the app happily uses. A `readdirSync` dirent
		// reports a symlink as `isDirectory() === false`, which is what hid it.
		const actions = await import('../../src/lib/server/notebook-root-actions');
		const target = join(ROOT, 'symlink-target');
		mkdirSync(target, { recursive: true });
		mkdirSync(join(WS, 'roots'), { recursive: true });
		const link = join(WS, 'roots', 'linked');
		symlinkSync(target, link);
		try {
			gitmod.invalidateGitCaches();
			const roots = await actions.listWorkspaceRoots();
			const entry = roots.find((r) => r.path === 'roots/linked');
			expect(entry).toBeTruthy();
			expect(entry?.exists).toBe(true);
			// And it still resolves, exactly as it did before this change.
			expect(rootmod.resolveRootDir('roots/linked')?.kind).toBe('workspace');
		} finally {
			rmSync(link, { force: true });
		}
	});
});

// The `.py`-refuses-FIRST case lives in `notebook-root-py.test.ts`, which already
// stubs the jupytext bridge — reading a real `.py` notebook shells out to the
// project venv's python, which a root test has no business needing.

describe('a JUST-CREATED worktree is admitted immediately', () => {
	it('re-reads a stale listing before refusing, so the TTL is not a dead window', () => {
		// The listing is cached for 1.5s. Pointing a notebook at a worktree is
		// literally the next thing a user does after `git worktree add`, so without a
		// re-read that cache is a window in which Cellar reports a checkout the user
		// just made as "not a registered worktree" — a refusal that is simply wrong.
		gitmod.invalidateGitCaches();
		// Warm the cache BEFORE the worktree exists, exactly as any picker open or
		// sidebar refresh would.
		expect(gitmod.listWorktreesAt(resolve(WS)).some((w) => w.path.endsWith('just-made'))).toBe(false);

		git(WS, 'worktree', 'add', '-q', join(ROOT, 'just-made'), '-b', 'just-made');
		// No cache invalidation here, and none in the product either: the resolver
		// itself must not be fooled by the listing it warmed a moment ago.
		expect(rootmod.resolveRootDir('../just-made')?.kind).toBe('worktree');

		git(WS, 'worktree', 'remove', '--force', join(ROOT, 'just-made'));
	});

	it('the re-read costs NOTHING on the happy path', () => {
		// The refresh is on the refusal path only: a root that matches the cached
		// listing must not pay a second spawn on every kernel start.
		gitmod.invalidateGitCaches();
		gitmod.listWorktreesAt(resolve(WS));
		gitmod.resetGitSpawnCount();
		expect(rootmod.resolveRootDir('../pr-398')?.kind).toBe('worktree');
		expect(gitmod.gitSpawnCount()).toBe(0);
	});
});

describe('detection is not authorisation', () => {
	it('re-verifies on EVERY resolve, so a worktree removed since the listing is refused', () => {
		const temp = join(ROOT, 'transient');
		git(WS, 'worktree', 'add', '-q', temp, '-b', 'transient');
		gitmod.invalidateGitCaches();
		expect(rootmod.resolveRootDir('../transient')?.kind).toBe('worktree');

		// Properly removed: gone from the listing entirely, so the message is the
		// "not registered" one rather than the prunable "no longer exists".
		git(WS, 'worktree', 'remove', '--force', temp);
		gitmod.invalidateGitCaches();
		expect(() => rootmod.resolveRootDir('../transient')).toThrow(/not a registered git worktree/i);
	});
});

describe('relative()-based declarations stay portable', () => {
	it('the stored form is what a sibling layout reproduces on another machine', () => {
		// `git worktree add ../name` IS what produces this layout, so the ..-relative
		// form is portable wherever it is reproduced — and it is the exact string
		// jupyter needs, so `rel` and `apiPath` never drift.
		const r = rootmod.resolveRootDir(SIBLING);
		expect(r?.rel).toBe(relative(resolve(WS), SIBLING));
	});
});
