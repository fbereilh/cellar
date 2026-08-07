/**
 * `GET /api/fs/git/roots` — the Git sidebar section's whole payload: which commit
 * each open notebook's CODE ROOT is checked out at.
 *
 * Driven against the REAL route, the REAL notebook documents and REAL git
 * worktrees, because the thing under test is the JOIN: a notebook's declared
 * `metadata.cellar.root` resolved to a directory, and that directory's own HEAD.
 * Mocking either half would assume exactly the part that can be wrong.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let WS: string;
let nbmod: typeof import('../../src/lib/server/notebook');
let route: typeof import('../../src/routes/api/fs/git/roots/+server.js');

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

/** Call the route the way SvelteKit does, with `path` repeated once per notebook. */
async function get(...paths: string[]) {
	return (await raw(...paths)).json();
}

/** The same, keeping the Response so a refusal's status can be asserted. */
async function raw(...paths: string[]) {
	const url = new URL('http://localhost/api/fs/git/roots');
	for (const p of paths) url.searchParams.append('path', p);
	return route.GET({ url } as Parameters<typeof route.GET>[0]);
}

/** Create a notebook and declare its root, straight through the document layer. */
function notebookAt(rel: string, root: string | null) {
	nbmod.createNotebook(rel);
	if (root != null) nbmod.setNotebookRoot(root, rel);
	return rel;
}

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-git-roots-'));
	process.env.CELLAR_WORKSPACE = WS;

	// One repo, two worktrees under `roots/`, each at its own commit — the review
	// workflow this section exists to make legible.
	git(WS, 'init', '-q');
	git(WS, 'config', 'user.email', 'ada@example.com');
	git(WS, 'config', 'user.name', 'Ada L');
	git(WS, 'checkout', '-q', '-B', 'main');
	// Ignoring `roots/` is the real setup: an un-ignored worktree directory is an
	// untracked change in the parent, which would report the workspace dirty.
	writeFileSync(join(WS, '.gitignore'), 'roots/\n');
	writeFileSync(join(WS, 'probe.py'), "VALUE = 'workspace'\n");
	git(WS, 'add', '-A');
	git(WS, 'commit', '-q', '-m', 'the workspace commit');
	git(WS, 'branch', 'pr-482');
	git(WS, 'branch', 'baseline');

	for (const [dir, branch, msg] of [
		['pr-482', 'pr-482', 'the change under review'],
		['baseline', 'baseline', 'the baseline commit']
	]) {
		const wt = join(WS, 'roots', dir);
		git(WS, 'worktree', 'add', '-q', wt, branch);
		writeFileSync(join(wt, 'probe.py'), `VALUE = '${dir}'\n`);
		git(wt, 'add', '-A');
		git(wt, 'commit', '-q', '-m', msg);
	}

	// A root that is a real directory but not a worktree of its own.
	mkdirSync(join(WS, 'roots', 'plain'), { recursive: true });

	nbmod = await import('../../src/lib/server/notebook');
	route = await import('../../src/routes/api/fs/git/roots/+server.js');
});

describe('GET /api/fs/git/roots', () => {
	it('gives each notebook the commit of ITS OWN root — the headline', async () => {
		const review = notebookAt('review.ipynb', 'roots/pr-482');
		const base = notebookAt('base.ipynb', 'roots/baseline');
		const plain = notebookAt('plain.ipynb', null);

		const body = await get(review, base, plain);
		const by = Object.fromEntries(body.notebooks.map((n: { path: string }) => [n.path, n]));

		expect(by[review].root).toBe('roots/pr-482');
		expect(by[review].git.branch).toBe('pr-482');
		expect(by[review].git.subject).toBe('the change under review');

		expect(by[base].root).toBe('roots/baseline');
		expect(by[base].git.branch).toBe('baseline');
		expect(by[base].git.subject).toBe('the baseline commit');

		// Three notebooks, three DIFFERENT commits in one workspace: that difference
		// is the whole reason the panel exists.
		expect(by[review].git.commit).not.toBe(by[base].git.commit);
		expect(by[review].git.commit).not.toBe(by[plain].git.commit);
	});

	it('reports a notebook with no root against the workspace HEAD', async () => {
		const nb = notebookAt('no-root.ipynb', null);
		const body = await get(nb);
		const row = body.notebooks[0];

		expect(row.root).toBeNull();
		expect(row.error).toBeNull();
		expect(row.git.branch).toBe('main');
		expect(row.git.subject).toBe('the workspace commit');
		// The same commit the payload reports for the workspace itself — a no-root
		// notebook IS running at the workspace root.
		expect(row.git.commit).toBe(body.workspace.commit);
	});

	it('reports a root that is a plain SUBDIRECTORY against the workspace commit', async () => {
		// A root need not be a worktree: an ordinary directory inside the repo is a
		// perfectly usable code root, and it genuinely is at the workspace's commit —
		// git says so, and the row must not dress that up as an error or a blank.
		// (A root with no commit at all is the non-git-workspace case, which
		// `gitCommitAt` covers directly.)
		const nb = notebookAt('plain-root.ipynb', 'roots/plain');
		const body = await get(nb);
		const row = body.notebooks[0];

		expect(row.error).toBeNull();
		expect(row.root).toBe('roots/plain');
		expect(row.git.isRepo).toBe(true);
		expect(row.git.commit).toBe(body.workspace.commit);
	});

	it('reports an UNUSABLE declared root as an error, naming the root it holds', async () => {
		// The state a RUN of this notebook is about to refuse; hiding it here would
		// be the silent degrade the resolver exists to prevent.
		const nb = notebookAt('stale-root.ipynb', 'roots/deleted-worktree');
		const row = (await get(nb)).notebooks[0];

		expect(row.root).toBe('roots/deleted-worktree');
		expect(row.git).toBeNull();
		expect(row.error).toMatch(/does not exist/i);
		expect(row.error).toContain('roots/deleted-worktree');
	});

	it('reports an UNREADABLE notebook document on its own channel, claiming no root', async () => {
		// A notebook deleted or renamed outside Cellar while its tab stayed open. With
		// no document there is no declaration to read, so this must NOT ride the
		// root-refusal `error` channel: the row renders `root ?? 'workspace'`, which
		// would assert a root nothing here verified.
		const row = (await get('never-existed.ipynb')).notebooks[0];

		expect(row.unreadable).toBe(true);
		expect(row.error).toBeNull();
		expect(row.root).toBeNull();
		expect(row.git).toBeNull();

		// A REAL root refusal keeps the other channel, so the two stay distinguishable
		// structurally rather than by matching message text.
		const refused = (await get(notebookAt('gone-root.ipynb', 'roots/not-here'))).notebooks[0];
		expect(refused.unreadable).toBe(false);
		expect(refused.error).toContain('roots/not-here');
	});

	it('never leaks an absolute server path for an unreadable notebook', async () => {
		// The only thing the throw knows is `notebook not found: <abs path>`; the
		// client owns the wording precisely so that never rides to the browser.
		const row = (await get('also-never-existed.ipynb')).notebooks[0];
		expect(JSON.stringify(row)).not.toContain(WS);
	});

	it('reports the workspace HEAD even with no notebooks named', async () => {
		const body = await get();
		expect(body.notebooks).toEqual([]);
		expect(body.workspace.branch).toBe('main');
	});

	it('probes each DISTINCT directory once, however many notebooks share it', async () => {
		const a = notebookAt('share-a.ipynb', 'roots/pr-482');
		const b = notebookAt('share-b.ipynb', 'roots/pr-482');
		const c = notebookAt('share-c.ipynb', 'roots/pr-482');

		const gitmod = await import('../../src/lib/server/git');
		gitmod.invalidateGitCaches();
		gitmod.resetGitSpawnCount();
		const body = await get(a, b, c);

		// Two directories are involved (the shared root + the workspace), each read
		// with the three reads `gitCommitAt` makes. Per-notebook probing would be 4x
		// that, and the section is refetched on every window focus.
		expect(gitmod.gitSpawnCount()).toBeLessThanOrEqual(6);
		for (const row of body.notebooks) expect(row.git.branch).toBe('pr-482');
	});

	it('REFUSES an over-large request instead of fanning out, and reads nothing', async () => {
		// The fan-out is per path — a document load each (a blocking jupytext
		// conversion for a `.py` notebook) plus three `git` spawns per distinct root —
		// on the process carrying the kernel websockets and the SSE fan-out.
		const gitmod = await import('../../src/lib/server/git');
		gitmod.resetGitSpawnCount();
		const tooMany = Array.from({ length: 65 }, (_, i) => `bulk-${i}.ipynb`);
		const res = await raw(...tooMany);

		expect(res.status).toBe(400);
		expect((await res.json()).message).toMatch(/at most 64/);
		// Refused BEFORE any work: the point is not paying for it, not discarding it.
		expect(gitmod.gitSpawnCount()).toBe(0);

		// The bound counts DISTINCT paths, so a repeated one is not a way past it and
		// is not a way to trip it either.
		const one = notebookAt('dupe.ipynb', null);
		const dupes = Array.from({ length: 200 }, () => one);
		expect((await raw(...dupes)).status).toBe(200);
	});

	it('answers about the notebooks asked for, in the order asked', async () => {
		const a = notebookAt('order-a.ipynb', 'roots/baseline');
		const b = notebookAt('order-b.ipynb', null);
		expect((await get(a, b)).notebooks.map((n: { path: string }) => n.path)).toEqual([a, b]);
		expect((await get(b, a)).notebooks.map((n: { path: string }) => n.path)).toEqual([b, a]);
	});
});
