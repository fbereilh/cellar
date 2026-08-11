import { test, expect, type APIRequestContext } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * THE HEADLINE: a notebook whose code root is a git worktree OUTSIDE the
 * workspace runs its kernel THERE, and imports resolve from there.
 *
 * This is the only level that can prove it. The mechanism is a `..`-relative
 * kernel-start `path` handed to the real jupyter sidecar, which resolves it under
 * its `root_dir` with no containment check — an absence in an upstream library
 * that no unit test can exercise. Everything below therefore runs against a real
 * launcher, a real sidecar and a real Python process.
 *
 * And THE SECURITY ASSERTION, which belongs here for the same reason: that a
 * worktree root grants the kernel a working directory and NOT one byte of file
 * reach is a statement about the whole app, not about one module — so it is
 * asserted through the app's own file surfaces (`/api/fs/tree`, `/api/fs/file`).
 *
 * Driven through the REST API rather than the browser: what is under test is
 * where a KERNEL runs, not what a page paints.
 */

let launcher: ChildProcess | null = null;
/** The OUTER directory: the workspace and its sibling worktree both live here. */
let outer = '';
let workspace = '';
let sibling = '';
let baseURL = '';

/** `git` at `cwd`, failing loudly — a half-built worktree would fake a pass. */
function git(cwd: string, ...args: string[]): void {
	const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
	if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
}

function gitAvailable(): boolean {
	return spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;
}

test.beforeAll(async () => {
	test.skip(
		!runtimeAvailable() || !gitAvailable(),
		'kernel runtime (uv + python3 + host-venv) or git not available — E2E is local-only'
	);
	// The sibling MUST live outside the workspace, or this tests nothing at all.
	outer = mkdtempSync(join(tmpdir(), 'cellar-e2e-wt-'));
	workspace = join(outer, 'workspace');
	sibling = join(outer, 'pr-398');

	spawnSync('mkdir', ['-p', workspace]);
	git(workspace, 'init', '-q', '-b', 'main');
	git(workspace, 'config', 'user.email', 'e2e@example.com');
	git(workspace, 'config', 'user.name', 'E2E');
	// The same module name, with different contents in each checkout: which one an
	// `import` resolves is the whole question.
	writeFileSync(join(workspace, 'probe.py'), "VALUE = 'workspace'\n");
	writeFileSync(join(workspace, '.gitignore'), 'roots/\n');
	git(workspace, 'add', '-A');
	git(workspace, 'commit', '-q', '-m', 'workspace copy');
	git(workspace, 'branch', 'under-review');
	// A SIBLING worktree — the layout `git worktree add ../name <branch>` produces,
	// and the one the whole feature exists for.
	git(workspace, 'worktree', 'add', '-q', sibling, 'under-review');
	writeFileSync(join(sibling, 'probe.py'), "VALUE = 'from-sibling-worktree'\n");
	writeFileSync(join(sibling, 'secret.txt'), 'this file must not be readable through cellar\n');
	git(sibling, 'commit', '-q', '-am', 'sibling copy');

	// An INSIDE worktree too, so the no-regression case rides the same instance.
	git(workspace, 'worktree', 'add', '-q', join('roots', 'baseline'), '-b', 'baseline');
	writeFileSync(join(workspace, 'roots', 'baseline', 'probe.py'), "VALUE = 'from-baseline'\n");
	git(join(workspace, 'roots', 'baseline'), 'commit', '-q', '-am', 'baseline copy');

	const booted = await bootCellar(workspace);
	launcher = booted.proc;
	baseURL = booted.url;
});

test.afterAll(async () => {
	if (launcher) killCellar(launcher);
	launcher = null;
	if (outer && existsSync(outer)) {
		try {
			rmSync(outer, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}
});

/** Create the notebook, declare its root (omit for none), and return its rel path. */
async function makeNotebook(api: APIRequestContext, rel: string, root?: string): Promise<string> {
	const created = await api.post(`${baseURL}/api/notebooks`, { data: { path: rel, create: true } });
	expect(created.ok(), await created.text()).toBeTruthy();
	if (root !== undefined) {
		const res = await api.post(`${baseURL}/api/notebooks/root`, { data: { root, path: rel } });
		expect(res.ok(), await res.text()).toBeTruthy();
	}
	return rel;
}

/** Add a code cell, run it, and return its concatenated stdout. */
async function runCode(api: APIRequestContext, nb: string, source: string): Promise<string> {
	const added = await api.post(`${baseURL}/api/cells`, { data: { cellType: 'code', nb, source } });
	expect(added.ok(), await added.text()).toBeTruthy();
	const id = (await added.json()).cell.id;
	const ran = await api.post(`${baseURL}/api/cells/${id}/run`, { data: { source, nb }, timeout: 120_000 });
	expect(ran.ok(), await ran.text()).toBeTruthy();
	await ran.body();
	const view = await api.get(`${baseURL}/api/notebooks?path=${encodeURIComponent(nb)}`);
	const cell = (await view.json()).notebook.cells.find((c: { id: string }) => c.id === id);
	const outs = (cell?.outputs ?? []) as { output_type: string; text?: string | string[]; ename?: string; evalue?: string }[];
	const err = outs.find((o) => o.output_type === 'error');
	if (err) throw new Error(`cell raised ${err.ename}: ${err.evalue}`);
	return outs
		.filter((o) => o.output_type === 'stream')
		.map((o) => (Array.isArray(o.text) ? o.text.join('') : (o.text ?? '')))
		.join('');
}

const PROBE = 'import os, probe\nprint(os.path.realpath(os.getcwd()))\nprint(probe.VALUE)';

test('a notebook rooted at a SIBLING worktree runs there and imports from it', async ({ request }) => {
	const nb = await makeNotebook(request, 'review.ipynb', '../pr-398');
	const out = await runCode(request, nb, PROBE);

	// The kernel's real cwd IS the sibling worktree — outside the workspace.
	// Compared by REALPATH on both sides deliberately: on macOS Python reports
	// `/private/var/…` while the harness holds `/var/…`, and the existing roots spec
	// only passes because one CONTAINS the other as a substring. An out-of-workspace
	// path shares no such accident, so the comparison is made honestly.
	expect(out.split('\n')[0]).toBe(realpathSync(sibling));
	// …and `import probe` resolved from THAT checkout, not from the workspace.
	expect(out).toContain('from-sibling-worktree');
	expect(out).not.toContain("VALUE = 'workspace'");
	expect(out).not.toContain('from-baseline');
});

test('the root is PERSISTED ..-relative, whichever form was declared', async ({ request }) => {
	// Declared ABSOLUTE — what a user pastes from `git worktree add`'s own output.
	const nb = await makeNotebook(request, 'absolute-decl.ipynb');
	const res = await request.post(`${baseURL}/api/notebooks/root`, { data: { root: sibling, path: nb } });
	expect(res.ok(), await res.text()).toBeTruthy();
	// The route reports the STORED form, so no client keeps a divergent copy…
	expect((await res.json()).root).toBe('../pr-398');

	// …and that is what is in the file that gets committed: portable, and leaking
	// no home directory into a shared repo.
	const view = await request.get(`${baseURL}/api/notebooks?path=${encodeURIComponent(nb)}`);
	expect((await view.json()).notebook.root).toBe('../pr-398');

	// It really runs there, so the stored form is not merely cosmetic.
	expect(await runCode(request, nb, PROBE)).toContain('from-sibling-worktree');
});

test('a notebook with NO root, and one on an INSIDE root, are unchanged', async ({ request }) => {
	const plain = await makeNotebook(request, 'plain.ipynb');
	const plainOut = await runCode(request, plain, PROBE);
	expect(plainOut.split('\n')[0]).toBe(realpathSync(workspace));
	expect(plainOut).toContain('workspace');

	const inside = await makeNotebook(request, 'inside.ipynb', 'roots/baseline');
	const insideOut = await runCode(request, inside, PROBE);
	expect(insideOut.split('\n')[0]).toBe(realpathSync(join(workspace, 'roots', 'baseline')));
	expect(insideOut).toContain('from-baseline');
});

test('switching from an inside root to a sibling worktree clears the namespace', async ({ request }) => {
	const nb = await makeNotebook(request, 'switcher.ipynb', 'roots/baseline');
	expect(await runCode(request, nb, PROBE)).toContain('from-baseline');
	await runCode(request, nb, 'marker = 42');

	const res = await request.post(`${baseURL}/api/notebooks/root`, { data: { root: '../pr-398', path: nb } });
	expect(res.ok(), await res.text()).toBeTruthy();
	expect(await res.json()).toMatchObject({ root: '../pr-398', changed: true, namespace_cleared: true });

	// A process's cwd is fixed at spawn, so the kernel is FREED rather than
	// restarted — the fresh one runs in the new checkout and the old namespace
	// is honestly gone.
	expect(await runCode(request, nb, PROBE)).toContain('from-sibling-worktree');
	await expect(runCode(request, nb, 'print(marker)')).rejects.toThrow(/NameError/);
});

test('THE SECURITY ASSERTION: no file surface gains reach into the worktree', async ({ request }) => {
	// The kernel runs in the sibling; every FILE path in the app stays
	// workspace-scoped, resolving through the untouched `resolveInWorkspace`.
	await makeNotebook(request, 'security.ipynb', '../pr-398');

	// The file tree lists the workspace only — the worktree's files are absent.
	const tree = await request.get(`${baseURL}/api/fs/tree`);
	expect(tree.ok()).toBeTruthy();
	const treeJson = JSON.stringify(await tree.json());
	expect(treeJson).toContain('probe.py');
	expect(treeJson).not.toContain('secret.txt');

	// And reading INTO it is refused, by every spelling: the `..`-relative form the
	// ROOT is allowed to use, and the absolute path.
	for (const path of ['../pr-398/secret.txt', join(sibling, 'secret.txt'), '../pr-398/probe.py']) {
		const res = await request.get(`${baseURL}/api/fs/file?path=${encodeURIComponent(path)}`);
		expect(res.ok(), `reading ${path} must be refused`).toBeFalsy();
		expect(await res.text()).not.toContain('must not be readable');
	}

	// Writing is refused the same way — the guard is the one authority for both.
	const write = await request.put(`${baseURL}/api/fs/file`, {
		data: { path: '../pr-398/injected.txt', content: 'nope' }
	});
	expect(write.ok()).toBeFalsy();
	expect(existsSync(join(sibling, 'injected.txt'))).toBe(false);
});

test('a worktree removed mid-session makes the next run FAIL LOUDLY', async ({ request }) => {
	// Never a silent fallback to the workspace: that is the exact failure mode this
	// feature exists to remove, and it would answer from the wrong branch.
	const nb = await makeNotebook(request, 'vanishing.ipynb');
	git(workspace, 'worktree', 'add', '-q', join(outer, 'temporary'), '-b', 'temporary');
	const set = await request.post(`${baseURL}/api/notebooks/root`, { data: { root: '../temporary', path: nb } });
	expect(set.ok(), await set.text()).toBeTruthy();
	expect(await runCode(request, nb, 'print("alive")')).toContain('alive');

	// Free the kernel first (a live one keeps running in the directory), then remove
	// the worktree behind git's back — the `prunable` state.
	await request.post(`${baseURL}/api/kernel/shutdown`, { data: { path: nb } });
	rmSync(join(outer, 'temporary'), { recursive: true, force: true });

	const added = await request.post(`${baseURL}/api/cells`, { data: { cellType: 'code', nb, source: 'print(1)' } });
	const id = (await added.json()).cell.id;
	const ran = await request.post(`${baseURL}/api/cells/${id}/run`, { data: { source: 'print(1)', nb }, timeout: 60_000 });
	const body = await ran.text();
	// The refusal names the path and the repair, rather than quietly answering from
	// the workspace.
	expect(body).toMatch(/no longer exists|not a registered git worktree/i);
	expect(body).toContain('temporary');
});

test('the sidebar lists the sibling worktree, labelled external', async ({ request }) => {
	const roots = await request.get(`${baseURL}/api/fs/git/roots`);
	expect(roots.ok()).toBeTruthy();
	const body = await roots.json();
	const row = body.worktrees.find((w: { path: string }) => w.path === '../pr-398');
	expect(row).toBeTruthy();
	expect(row).toMatchObject({ external: true, exists: true, branch: 'under-review' });
	// The inside worktree is listed too, and is NOT external.
	const inside = body.worktrees.find((w: { path: string }) => w.path === 'roots/baseline');
	expect(inside).toMatchObject({ external: false, branch: 'baseline' });

	// The picker's own list offers it as a detected, external root. Its notebook is
	// created HERE rather than borrowed from an earlier test: a failure restarts the
	// worker into a fresh workspace, so a spec that leans on another test's leftovers
	// fails for a reason that has nothing to do with what it is asserting.
	const nb = await makeNotebook(request, 'picker.ipynb');
	const picker = await request.get(`${baseURL}/api/notebooks/root?path=${encodeURIComponent(nb)}`);
	expect(picker.ok(), await picker.text()).toBeTruthy();
	const opts = (await picker.json()).roots as { path: string; external: boolean; source: string }[];
	expect(opts.find((o) => o.path === '../pr-398')).toMatchObject({ external: true, source: 'worktree' });
});
