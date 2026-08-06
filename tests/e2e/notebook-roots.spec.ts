import { test, expect, type APIRequestContext } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
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
	await makeNotebook(request, 'notebook.ipynb', 'roots/baseline');
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await page.getByTestId('empty-open-notebook').click();
	await expect(page.getByTestId('cell').first()).toBeVisible();

	const bar = page.getByTestId('root-bar');
	await expect(bar).toBeVisible();
	const select = page.getByTestId('root-select');
	await expect(select).toHaveValue('roots/baseline');
	const options = await select.locator('option').allTextContents();
	// The workspace stays the first, default choice…
	expect(options[0]).toMatch(/workspace root \(default\)/);
	// …and each root is labelled with the branch checked out there, which is the
	// whole point: you must be able to see WHICH code you are about to run.
	expect(options.join('|')).toContain('roots/baseline — baseline');
	expect(options.join('|')).toContain('roots/under-review — under-review');

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

test('a workspace with no roots renders no root control at all', async ({ page, request }) => {
	// The picker must cost an untouched workspace no chrome. Proved by serving the
	// client the answer such a workspace gives — an empty root list — for a notebook
	// that declares none, which is exactly the shipped default.
	await request.post(`${baseURL}/api/notebooks/root`, { data: { root: '', path: 'notebook.ipynb' } });
	await page.route('**/api/notebooks/root?*', (route) =>
		route.fulfill({ json: { ok: true, root: null, roots: [] } })
	);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await page.getByTestId('empty-open-notebook').click();
	await expect(page.getByTestId('cell').first()).toBeVisible();
	await expect(page.getByTestId('root-bar')).toHaveCount(0);
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
