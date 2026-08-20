import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * THE HEADLINE: one Cellar instance serving code from SEVERAL checkouts of one
 * repo, concurrently.
 *
 * Two git worktrees under `roots/` hold the SAME module name with DIFFERENT
 * contents; two notebooks each declare one as their code root. Each must import
 * its own root's version and report that root as `os.getcwd()` — in one instance,
 * against one interpreter, at the same time. That is the whole review-notebook
 * workflow, and no unit test can prove it: it needs the real jupyter sidecar
 * resolving the kernel-start `path` under its `root_dir`, and two real Python
 * processes.
 *
 * The third notebook is the control: it declares no root, so it must behave
 * exactly as before — cwd = the workspace, importing the workspace's own copy.
 *
 * Driven through the REST API rather than the browser because what is under test
 * is where a KERNEL runs, not what a page paints. Needs the full runtime (uv +
 * python3 + host-venv), so it SKIPS when absent like the other E2E specs.
 */

let launcher: ChildProcess | null = null;
let workspace = '';
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
	workspace = mkdtempSync(join(tmpdir(), 'cellar-e2e-roots-'));

	// One repo, three states of the SAME module name. `probe.py` is what the
	// notebooks import; only its VALUE differs between the checkouts.
	git(workspace, 'init', '-q', '-b', 'main');
	git(workspace, 'config', 'user.email', 'e2e@example.com');
	git(workspace, 'config', 'user.name', 'E2E');
	writeFileSync(join(workspace, 'probe.py'), "VALUE = 'workspace'\n");
	git(workspace, 'add', 'probe.py');
	git(workspace, 'commit', '-q', '-m', 'workspace copy');
	git(workspace, 'branch', 'baseline');
	git(workspace, 'branch', 'under-review');
	// Give each branch its own VALUE by committing in its worktree below.
	git(workspace, 'worktree', 'add', '-q', join('roots', 'baseline'), 'baseline');
	git(workspace, 'worktree', 'add', '-q', join('roots', 'under-review'), 'under-review');
	for (const [dir, value] of [
		['baseline', 'from-baseline'],
		['under-review', 'from-under-review']
	]) {
		const wt = join(workspace, 'roots', dir);
		writeFileSync(join(wt, 'probe.py'), `VALUE = '${value}'\n`);
		git(wt, 'commit', '-q', '-am', `${dir} copy`);
	}

	const booted = await bootCellar(workspace);
	launcher = booted.proc;
	baseURL = booted.url;
});

test.afterAll(async () => {
	if (launcher) killCellar(launcher);
	launcher = null;
	if (workspace && existsSync(workspace)) {
		try {
			rmSync(workspace, { recursive: true, force: true });
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
		expect((await res.json()).root).toBe(root || null);
	}
	return rel;
}

/**
 * Open the default notebook from the empty state if it is showing. Settle on
 * whichever the shell paints FIRST - the empty state, or a notebook the
 * server-owned tab session (written by an earlier page test in this file)
 * already restored - before probing; a bare `empty-open-notebook` click waits
 * out the whole test timeout whenever the restore wins, which is a race on the
 * debounced tab-session write (the documented `openNotebook` settle rule).
 */
async function openNotebook(page: Page): Promise<void> {
	const openBtn = page.getByTestId('empty-open-notebook');
	await expect(openBtn.or(page.getByTestId('cell').first())).toBeVisible();
	if (await openBtn.isVisible().catch(() => false)) await openBtn.click();
	await expect(page.getByTestId('cell').first()).toBeVisible();
}

/** Add a code cell, run it, and return its concatenated stdout. */
async function runCode(api: APIRequestContext, nb: string, source: string): Promise<string> {
	const added = await api.post(`${baseURL}/api/cells`, { data: { cellType: 'code', nb, source } });
	expect(added.ok(), await added.text()).toBeTruthy();
	const id = (await added.json()).cell.id;
	// The run route streams NDJSON; the accumulated outputs are on the notebook
	// afterwards, so the body is only awaited to know the run finished.
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

const PROBE = 'import os, probe\nprint(os.getcwd())\nprint(probe.VALUE)';

test('two notebooks on two roots import their OWN checkout, in one instance', async ({ request }) => {
	const baselineNb = await makeNotebook(request, 'review-baseline.ipynb', 'roots/baseline');
	const reviewNb = await makeNotebook(request, 'review-change.ipynb', 'roots/under-review');

	// Run both. Each notebook has its own kernel, so these are two Python processes
	// alive at once — the concurrency the review workflow depends on.
	const [baselineOut, reviewOut] = await Promise.all([
		runCode(request, baselineNb, PROBE),
		runCode(request, reviewNb, PROBE)
	]);

	// os.getcwd() is the declared root's absolute path…
	expect(baselineOut).toContain(join(workspace, 'roots', 'baseline'));
	expect(reviewOut).toContain(join(workspace, 'roots', 'under-review'));
	// …and `import probe` resolved from THAT root, not from the workspace.
	expect(baselineOut).toContain('from-baseline');
	expect(reviewOut).toContain('from-under-review');
	expect(baselineOut).not.toContain('from-under-review');
	expect(reviewOut).not.toContain('from-baseline');
});

test('a notebook with NO root is unchanged: workspace cwd, workspace module', async ({ request }) => {
	const plain = await makeNotebook(request, 'plain.ipynb');
	const out = await runCode(request, plain, PROBE);
	expect(out).toContain(workspace);
	expect(out).toContain('workspace');
	expect(out).not.toContain('from-baseline');
});

test('changing a root re-roots the kernel and clears its namespace', async ({ request }) => {
	const nb = await makeNotebook(request, 'switcher.ipynb', 'roots/baseline');
	expect(await runCode(request, nb, PROBE)).toContain('from-baseline');
	// A variable that must NOT survive the switch: the kernel is freed, not restarted
	// in place, because a process's cwd is fixed when it spawns.
	await runCode(request, nb, 'marker = 42');

	const res = await request.post(`${baseURL}/api/notebooks/root`, {
		data: { root: 'roots/under-review', path: nb }
	});
	expect(res.ok(), await res.text()).toBeTruthy();
	const body = await res.json();
	expect(body).toMatchObject({ root: 'roots/under-review', changed: true, namespace_cleared: true });

	// The fresh kernel runs in the new root, and the old namespace is gone.
	expect(await runCode(request, nb, PROBE)).toContain('from-under-review');
	await expect(runCode(request, nb, 'print(marker)')).rejects.toThrow(/NameError/);
});

test('the notebook shows a Code root picker labelled with each root’s branch', async ({ page, request }) => {
	// The default notebook, so the shell's empty state opens it in one click.
	// VISIBILITY, stated explicitly: the bar is hidden by default (a Settings
	// preference this test never touches), and it renders here because this
	// notebook DECLARES a root - a set root is never hidden, since the bar is the
	// UI that explains a kernel running somewhere other than the workspace.
	await makeNotebook(request, 'notebook.ipynb', 'roots/baseline');
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);

	const bar = page.getByTestId('root-bar');
	await expect(bar).toBeVisible();
	const select = page.getByTestId('root-select');
	await expect(select).toHaveValue('roots/baseline');
	// The option LIST arrives from its own fetch, separate from the notebook load
	// that already satisfied the assertions above (the declared root's stand-in
	// option carries the same value), so it must be asserted with RETRYING
	// expectations - a one-shot `allTextContents()` snapshot raced that fetch and
	// caught the stand-in ("roots/baseline (missing)") instead of the list.
	// The workspace stays the first, default choice…
	await expect(select.locator('option').first()).toHaveText(/workspace root \(default\)/);
	// …and each root is labelled with the branch checked out there, which is the
	// whole point: you must be able to see WHICH code you are about to run.
	await expect(select).toContainText('roots/baseline — baseline');
	await expect(select).toContainText('roots/under-review — under-review');

	// The cost is stated BEFORE the click, not only afterwards in the feedback line:
	// selecting a root frees the kernel, so both facts (what a root reaches, and
	// what changing it costs) are on screen while the user decides.
	await expect(bar).toContainText(/files, git and checkpoints stay workspace-wide/i);
	await expect(bar).toContainText(/restarts the kernel - variables are cleared/i);

	// Switching in the UI re-roots the kernel and says the namespace went with it.
	await select.selectOption('roots/under-review');
	await expect(page.getByTestId('root-feedback')).toContainText(/variables cleared|new root/i);
	await expect(select).toHaveValue('roots/under-review');
	await page.screenshot({ path: 'test-results/root-bar.png' });
});

test('a notebook with no declared root renders no root control, even with roots on offer', async ({
	page,
	request
}) => {
	// The bar is hidden by default (the Settings "Show the code root bar"
	// preference is off, and this notebook declares no root). The STRONGER half of
	// that promise is now true BY CONSTRUCTION rather than by what a reply happens
	// to contain: the option list is fetched only once the bar can be SEEN, so this
	// workspace's real `roots/` checkouts cannot reach a notebook that declares
	// nothing - the page never even asks. That is why there is no forced-populated
	// response here to prove it against; a request that is never issued is a
	// stronger statement than one whose answer is ignored.
	await request.post(`${baseURL}/api/notebooks/root`, { data: { root: '', path: 'notebook.ipynb' } });
	const rootReads: (string | null)[] = [];
	page.on('request', (r) => {
		const u = new URL(r.url());
		if (r.method() === 'GET' && u.pathname === '/api/notebooks/root')
			rootReads.push(u.searchParams.get('path'));
	});
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	await expect(page.getByTestId('root-bar')).toHaveCount(0);
	// Filtered to this notebook: another restored tab that DOES declare a root
	// legitimately reads, and that is not what this test is about.
	expect(rootReads.filter((p) => p === 'notebook.ipynb')).toEqual([]);
});

test('a REFUSED root leaves the picker showing the root the notebook still runs at', async ({
	page,
	request
}) => {
	// The refusal is REAL and reached through the picker itself: the root list is
	// fetched when the notebook mounts, so a directory removed afterwards is still
	// an offered option - and selecting it is refused ("does not exist"). Because
	// the change is applied non-optimistically, the control must snap back to the
	// root actually in force rather than keep the rejected choice on screen.
	const scratch = join(workspace, 'roots', 'scratch');
	mkdirSync(scratch, { recursive: true });
	await request.post(`${baseURL}/api/notebooks/root`, {
		data: { root: 'roots/baseline', path: 'notebook.ipynb' }
	});
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);

	const select = page.getByTestId('root-select');
	await expect(select).toHaveValue('roots/baseline');
	await expect(select.locator('option[value="roots/scratch"]')).toHaveCount(1);

	rmSync(scratch, { recursive: true, force: true });
	await select.selectOption('roots/scratch');
	await expect(page.getByTestId('root-feedback')).toContainText(/does not exist/i);
	await expect(select).toHaveValue('roots/baseline');
	// ...and the hint line, derived from the same root, cannot describe a different
	// one: the notebook still runs at a root that is present, so nothing is missing.
	await expect(page.getByTestId('root-missing')).toHaveCount(0);
});

test('a root outside the workspace is REFUSED, and the notebook is untouched', async ({ request }) => {
	const nb = await makeNotebook(request, 'guarded.ipynb', 'roots/baseline');
	for (const bad of ['../escape', tmpdir(), 'roots/does-not-exist']) {
		const res = await request.post(`${baseURL}/api/notebooks/root`, { data: { root: bad, path: nb } });
		expect(res.status(), `expected a refusal for ${bad}`).toBe(400);
	}
	const view = await request.get(`${baseURL}/api/notebooks?path=${encodeURIComponent(nb)}`);
	expect((await view.json()).notebook.root).toBe('roots/baseline');
});
