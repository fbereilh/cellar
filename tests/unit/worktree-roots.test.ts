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

/**
 * The two-namespace rule for EVERY path that can mint or accept a declaration,
 * over a workspace whose path traverses a symlink.
 *
 * This rule has now been got wrong once per site that re-derived it, always the
 * same way — measuring the hop as `relative(lexicalWorkspace, gitReportedPath)` —
 * and always silently, because the wrong form still resolves. What made each fix
 * look verified was that its test passed a LEXICAL path (`mkdtemp` returns one),
 * so the two namespaces coincided and nothing could tell the two rules apart.
 *
 * So the input here is the path GIT ITSELF PRINTS, taken from the listing rather
 * than reconstructed, which is also what a user pastes out of `git worktree add`.
 * Every surface that produces or consumes a declaration is asserted to agree on
 * ONE spelling: two that disagree still work individually, which is exactly why
 * this needs asserting — a divergence shows up only as a machine-specific path in
 * a committed `.ipynb`, and as a sidebar that keeps offering "Use as root" for a
 * worktree the notebook is already rooted at.
 */
describe('the two-namespace rule, over a SYMLINKED workspace', () => {
	let LINK_ROOT: string;
	let LINK_WS: string;
	/** The path git reports for the sibling worktree — realpath'd, as git always is. */
	let GIT_SIBLING: string;
	/** The path git reports for a worktree that lives INSIDE the workspace, under `roots/`. */
	let GIT_INSIDE: string;
	/** The path git reports for the MAIN CHECKOUT — the first line of `git worktree list`. */
	let GIT_MAIN: string;
	let prevWs: string | undefined;

	beforeAll(() => {
		LINK_ROOT = mkdtempSync(join(tmpdir(), 'cellar-ns-all-'));
		const realDir = join(LINK_ROOT, 'real');
		mkdirSync(realDir, { recursive: true });
		symlinkSync(realDir, join(LINK_ROOT, 'link'));

		const wsReal = join(realDir, 'ws');
		mkdirSync(wsReal, { recursive: true });
		git(wsReal, 'init', '-q', '-b', 'main');
		writeFileSync(join(wsReal, 'probe.py'), "VALUE = 'ws'\n");
		git(wsReal, 'add', 'probe.py');
		git(wsReal, 'commit', '-q', '-m', 'init');
		git(wsReal, 'worktree', 'add', '-q', join(realDir, 'sib'), '-b', 'sib');
		// And one INSIDE the workspace, which is what makes `kind` testable here: it is
		// a registered worktree AND a workspace subdirectory at once.
		git(wsReal, 'worktree', 'add', '-q', join(wsReal, 'roots', 'inside'), '-b', 'inside');

		prevWs = process.env.CELLAR_WORKSPACE;
		// The workspace addressed THROUGH the symlink — the lexical namespace Cellar
		// and jupyter both live in, and the one git never reports back.
		process.env.CELLAR_WORKSPACE = join(LINK_ROOT, 'link', 'ws');
		gitmod.invalidateGitCaches();
		const listed = gitmod.listWorktreesAt(join(LINK_ROOT, 'link', 'ws'));
		GIT_SIBLING = listed.find((w) => w.path.endsWith('sib'))!.path;
		GIT_INSIDE = listed.find((w) => w.path.endsWith(join('roots', 'inside')))!.path;
		GIT_MAIN = listed.find((w) => !w.path.endsWith('sib') && !w.path.endsWith(join('roots', 'inside')))!.path;
		// The premise of every assertion below: the path git prints is NOT the one a
		// lexical `relative()` from the workspace would measure against.
		expect(GIT_SIBLING).toBe(join(realpathSync(join(LINK_ROOT, 'real')), 'sib'));
		// …and the workspace ITSELF has two spellings here, which is what makes the
		// main-checkout case below reachable at all.
		expect(GIT_MAIN).toBe(realpathSync(join(LINK_ROOT, 'link', 'ws')));
		expect(GIT_MAIN).not.toBe(resolve(join(LINK_ROOT, 'link', 'ws')));
		expect(relative(resolve(join(LINK_ROOT, 'link', 'ws')), GIT_SIBLING)).not.toBe('../sib');
		expect(relative(resolve(join(LINK_ROOT, 'link', 'ws')), GIT_INSIDE)).not.toBe(join('roots', 'inside'));
	});

	afterAll(() => {
		process.env.CELLAR_WORKSPACE = prevWs;
		gitmod.invalidateGitCaches();
		if (LINK_ROOT) rmSync(LINK_ROOT, { recursive: true, force: true });
	});

	it('RESOLVE FROM ABSOLUTE: the path git printed persists as the portable ..-relative form', () => {
		// The very input this branch accepts absolute paths FOR. Measured lexically it
		// stores `../../../private/var/folders/…` — machine-specific, useless on any
		// other checkout, and in a file the user COMMITS.
		const r = rootmod.resolveRootDir(GIT_SIBLING);
		expect(r?.kind).toBe('worktree');
		expect(r?.rel).toBe('../sib');
		expect(r?.apiPath).toBe('../sib');
		expect(realpathSync(r!.dir)).toBe(realpathSync(GIT_SIBLING));
	});

	it('KIND FOLLOWS THE DIRECTORY, not the shape that was typed', () => {
		// `roots/inside` is a registered worktree AND a workspace subdirectory. Declared
		// by the absolute path git printed, the raw candidate fails the lexical guard (a
		// symlink separates the two namespaces), so the worktree gate is what admits it
		// — and `kind` read off that branch came back `'worktree'` while `rel`
		// normalized straight back to `roots/inside`. Both of `kind`'s consumers act on
		// it: agent config would be written into a workspace subdirectory, and the
		// kernel start would run its external-root cwd verification. Worse, the SAME
		// directory declared relatively classified as `'workspace'`, so one directory
		// had two kinds depending on how it was typed.
		const viaAbs = rootmod.resolveRootDir(GIT_INSIDE);
		expect(viaAbs?.rel).toBe('roots/inside');
		expect(viaAbs?.kind).toBe('workspace');
		expect(rootmod.resolveRootDir('roots/inside')).toEqual(viaAbs);
		// The label every surface renders is that same one rule, so it agrees too.
		expect(rootmod.isOutsideWorkspace(viaAbs!.dir)).toBe(false);
		expect(rootmod.isOutsideWorkspace(rootmod.resolveRootDir(GIT_SIBLING)!.dir)).toBe(true);
	});

	it('THE MAIN CHECKOUT, exactly as git prints it, is NO ROOT — never kind:"worktree"', () => {
		// `git worktree list`'s FIRST line is the main checkout, realpath'd, and this
		// branch accepts absolute paths precisely so that a user can paste what git
		// printed. Compared LEXICALLY, the "this declaration IS the workspace"
		// short-circuit missed it here (the two namespaces differ), so it reached the
		// worktree gate — which MATCHED, the main checkout being a listed worktree and
		// nothing there excluding it. What came back was a root that IS the workspace,
		// declared `../../../private/var/…` in a COMMITTED `.ipynb` and labelled
		// `kind:'worktree'`: `initKernel` would run its external-root cwd verification
		// against the workspace, and `setNotebookRootAndRestart` would write agent
		// config INTO it — rewriting the very `<ws>/.mcp.json` that "an ordinary
		// workspace launch is untouched" is a promise about.
		expect(rootmod.resolveRootDir(GIT_MAIN)).toBeNull();
		expect(rootmod.resolveRootDir(`${GIT_MAIN}/`)).toBeNull();
		// The lexical spelling was always answered by the free fast path, and still is.
		expect(rootmod.resolveRootDir(join(LINK_ROOT, 'link', 'ws'))).toBeNull();
	});

	it('RESOLVE FROM ..: the same declaration, and the SAME resolved directory', () => {
		// One directory, one declaration, whichever spelling it was typed as — which is
		// what lets the no-op test compare resolved directories at all.
		const viaRel = rootmod.resolveRootDir('../sib');
		const viaAbs = rootmod.resolveRootDir(GIT_SIBLING);
		expect(viaRel?.rel).toBe('../sib');
		expect(viaAbs).toEqual(viaRel);
	});

	it('DETECTION: the picker offers that same one spelling', async () => {
		const actions = await import('../../src/lib/server/notebook-root-actions');
		gitmod.invalidateGitCaches();
		const roots = await actions.listWorkspaceRoots();
		const sib = roots.find((r) => r.source === 'worktree');
		expect(sib?.path).toBe('../sib');
		expect(sib?.external).toBe(true);
	});

	it('THE ROUTE: an adopted worktree reads as the notebook’s CURRENT root, not as one to adopt', async () => {
		// The sidebar decides "already adopted" by comparing the notebook's stored root
		// against the worktree row's path. Both are declarations, so two spellings of
		// one checkout leave the row offering "Use as root" for the root it is already
		// on — and clicking it would tear down a perfectly good kernel.
		const route = await import('../../src/routes/api/fs/git/roots/+server.js');
		const rel = `ns-${Math.random().toString(36).slice(2, 8)}.ipynb`;
		nbmod.createNotebook(rel);
		// Declared the way a user pastes it: the absolute path git printed.
		await (await import('../../src/lib/server/notebook-root-actions')).setNotebookRootAndRestart(GIT_SIBLING, rel);

		gitmod.invalidateGitCaches();
		const url = new URL('http://localhost/api/fs/git/roots');
		url.searchParams.append('path', rel);
		const body = await (await route.GET({ url } as Parameters<typeof route.GET>[0])).json();

		const row = body.notebooks.find((n: { path: string }) => n.path === rel);
		const wt = body.worktrees.find((w: { path: string }) => w.path.endsWith('sib'));
		expect(row.root).toBe('../sib');
		expect(wt.path).toBe('../sib');
		expect(row.root).toBe(wt.path);
		expect(wt.external).toBe(true);
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

	it('SOURCE GUARD: notebookRoot.ts keeps NO containment rule of its own', () => {
		// The doctrine says the untouched workspace guard is the authority for the
		// inside branch. A local copy of its lexical prefix test deciding the branch —
		// and then calling the guard inside it, unreachably — made that true only for
		// as long as the two rules happened to agree, which is not an invariant, it is
		// a coincidence. So this module must ASK the guard and treat its throw as the
		// outside branch, and hold no prefix test at all.
		const src = readFileSync(new URL('../../src/lib/server/notebookRoot.ts', import.meta.url), 'utf8');
		expect(src).not.toMatch(/startsWith\([^)]*\+ sep\)/);
		expect(src).not.toMatch(/function insideWorkspace/);
		expect(src).toMatch(/resolveInWorkspace\(toRel\(dir\)\)/);
	});

	it('SOURCE GUARD: workspace IDENTITY is compared canonically, not only lexically', () => {
		// The guard above watched the CONTAINMENT rule and nothing else, which is why
		// the last lexical IDENTITY comparison in this module survived six rounds: it
		// is a different question with the same failure mode, since git reports the
		// main checkout realpath'd while Cellar's workspace is the lexical resolve. A
		// bare `===` may be a fast path in front of the canonical test — identical
		// strings really are the same directory — but it may never BE the test, so the
		// canonical one is asserted present rather than the lexical one absent.
		const src = readFileSync(new URL('../../src/lib/server/notebookRoot.ts', import.meta.url), 'utf8');
		expect(src).toMatch(/canonDir === canonicalPath\(wsDir\)/);
		// And the module has no OTHER workspace comparison that reads `ws()` inline: the
		// two that decide something both go through `canonicalPath`/`isWorktreeAt`.
		expect(src).not.toMatch(/[!=]== ws\(\)/);
	});

	it('SOURCE GUARD: no OTHER module keeps a copy of that containment rule either', () => {
		// The guard above watched ONE file, and the rule was then written again in two
		// others — `notebook-root-actions.ts` comparing LEXICAL paths and the sidebar
		// route comparing REALPATH'd ones. Both decide the user-facing `external`
		// label, so for a root reached through a symlink the picker could call a
		// checkout internal while the sidebar called the same checkout external, which
		// is exactly the misreading that tag exists to prevent. So every site asks the
		// ONE exported helper, and none of them holds a prefix test.
		for (const rel of ['src/lib/server/notebook-root-actions.ts', 'src/routes/api/fs/git/roots/+server.js']) {
			const src = readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
			expect(src, rel).not.toMatch(/startsWith\([^)]*\+ sep\)/);
			expect(src, rel).toMatch(/isOutsideWorkspace\(/);
		}
	});

	it('SOURCE GUARD: the root bar is not opened by a merely DETECTED worktree', () => {
		// The chrome promise: "a workspace that never adopts roots renders exactly what
		// it always did". `git worktree list` is populated by work that has nothing to
		// do with Cellar (a worktree-per-task agent workflow, a PR checkout), so keying
		// the bar off `rootOptions.length` put a picker on every notebook of every
		// multi-worktree repo. Detected worktrees still POPULATE the picker whenever it
		// is shown, and the sidebar's WORKTREES block is the discovery surface, so
		// nothing became unreachable. A source guard because vitest runs without the
		// SvelteKit plugin and this component cannot be mounted here.
		const src = readFileSync(new URL('../../src/lib/Notebook.svelte', import.meta.url), 'utf8');
		expect(src).toMatch(/rootsInUse = \$derived\(rootOptions\.some\(\(o\) => o\.source !== 'worktree'\)\)/);
		expect(src).toMatch(/showRootBar = \$derived\(rootsInUse && !isPy\)/);
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

	it('a BURST of refusals costs ONE forced spawn, not one per refusal', () => {
		// The re-read is unbounded per MISS, and misses come in bursts: the roots route
		// resolves every open notebook in ONE request (up to `MAX_PATHS`), and that
		// panel refetches on mount, on `sse:open`, on `fsRefreshSignal` and on every
		// window focus — so a workspace with a few pruned roots paid a blocking
		// `spawnSync` per notebook per focus, on the process carrying the kernel
		// websockets and the SSE fan-out.
		gitmod.invalidateGitCaches();
		gitmod.resetGitSpawnCount();
		for (let i = 0; i < 10; i++) {
			expect(() => rootmod.resolveRootDir('../never-registered')).toThrow(/not a registered git worktree/i);
		}
		// One ordinary listing (the first, cold) plus at most one FORCED re-read.
		expect(gitmod.gitSpawnCount()).toBeLessThanOrEqual(2);
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
