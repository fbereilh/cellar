import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * E2E for the sidebar's Git section: several notebooks, several checkouts,
 * several DIFFERENT commits, visible at a glance.
 *
 * This is the payoff of notebook code roots. Two review notebooks are rooted at
 * two git worktrees of one repo while others declare no root and run at the
 * workspace. Nothing else in the app distinguishes them — that is exactly why the
 * section exists — so the assertions are what a human READS in the sidebar: the
 * branch, the short SHA and the subject each notebook's kernel is rooted at.
 *
 * EVERY test builds its own state (notebooks, worktree, open tabs). A failure
 * restarts the Playwright worker, which re-runs `beforeAll` into a BRAND-NEW
 * workspace, so a test leaning on one its predecessor created would fail for a
 * reason that has nothing to do with what it tests.
 *
 * Boots the REAL launcher against a throwaway workspace (see ./harness); SKIPS
 * when the kernel runtime or git is absent (local-only, like the other specs).
 */

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';
/** Short SHA of each checkout, captured at setup and asserted in the UI. */
const sha: Record<string, string> = {};

function git(cwd: string, ...args: string[]): string {
	const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
	if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
	return r.stdout.trim();
}

function gitAvailable(): boolean {
	return spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;
}

/** A worktree of the workspace repo at its own branch and its own commit. */
function addWorktree(name: string, subject: string): void {
	git(workspace, 'branch', name);
	git(workspace, 'worktree', 'add', '-q', join('roots', name), name);
	const wt = join(workspace, 'roots', name);
	writeFileSync(join(wt, 'probe.py'), `VALUE = '${name}'\n`);
	git(wt, 'commit', '-q', '-am', subject);
	sha[name] = git(wt, 'rev-parse', '--short', 'HEAD');
}

test.beforeAll(async () => {
	test.skip(
		!runtimeAvailable() || !gitAvailable(),
		'kernel runtime (uv + python3 + host-venv) or git not available — E2E is local-only'
	);
	workspace = mkdtempSync(join(tmpdir(), 'cellar-e2e-gitnb-'));

	git(workspace, 'init', '-q', '-b', 'main');
	git(workspace, 'config', 'user.email', 'e2e@example.com');
	git(workspace, 'config', 'user.name', 'E2E');
	// Ignoring `roots/` is the real setup: an un-ignored worktree directory is an
	// untracked change in the PARENT checkout, which would read as a dirty workspace
	// for a reason that has nothing to do with the notebook's own work.
	writeFileSync(join(workspace, '.gitignore'), 'roots/\n');
	writeFileSync(join(workspace, 'probe.py'), "VALUE = 'workspace'\n");
	git(workspace, 'add', '-A');
	git(workspace, 'commit', '-q', '-m', 'the workspace commit');
	sha.workspace = git(workspace, 'rev-parse', '--short', 'HEAD');

	addWorktree('pr-482', 'the change under review');
	addWorktree('baseline', 'the baseline commit');
	// Its own worktree, so the test that deletes one damages nothing else.
	addWorktree('doomed', 'a checkout about to vanish');

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

/** Create the notebook (idempotent) and declare its root — omit for none. */
async function makeNotebook(page: Page, rel: string, root?: string): Promise<void> {
	const created = await page.request.post(`${baseURL}/api/notebooks`, { data: { path: rel, create: true } });
	expect(created.ok(), await created.text()).toBeTruthy();
	if (root !== undefined) {
		const res = await page.request.post(`${baseURL}/api/notebooks/root`, { data: { root, path: rel } });
		expect(res.ok(), await res.text()).toBeTruthy();
	}
}

/**
 * Open each notebook's tab from the file tree, skipping any already open.
 * Retried per notebook: the server-owned tab-session restore lands at
 * hydration, after the first paint, so a dblclick landing before it is wiped
 * when the restored tab set replaces the tab it just opened - the documented
 * settle-before-probe race, and a cold start (first run after a rebuild)
 * widens the window enough to lose it reliably.
 */
async function ensureOpen(page: Page, names: string[]): Promise<void> {
	for (const nb of names) {
		const tab = page.getByTestId('tab').filter({ hasText: nb });
		await expect(async () => {
			if ((await tab.count()) === 0) {
				const item = page.getByTestId('tree-file').filter({ hasText: nb });
				await expect(item).toBeVisible({ timeout: 2_000 });
				await item.dblclick();
			}
			await expect(tab).toHaveCount(1, { timeout: 2_000 });
			// The restore can land AFTER the open was confirmed (observed in a trace
			// ~600ms post-load on a cold start, replacing the tab array wholesale),
			// so the tab must be seen to OUTLIVE that window before it is trusted.
			await page.waitForTimeout(800);
			await expect(tab).toHaveCount(1, { timeout: 200 });
		}).toPass({ timeout: 30_000 });
	}
}

/** Open the Git section (it ships collapsed) and wait for its body. */
async function openGitSection(page: Page): Promise<void> {
	if (!(await page.getByTestId('git-body').isVisible().catch(() => false))) {
		await page.getByTestId('section-git').click();
	}
	await expect(page.getByTestId('git-body')).toBeVisible();
}

/** The Git row for one notebook. */
function row(page: Page, nb: string) {
	return page.locator(`[data-testid="git-row"][data-nb-path="${nb}"]`);
}

test('shows the commit each notebook’s kernel is rooted at — one per checkout', async ({ page }) => {
	await page.goto(baseURL);
	await makeNotebook(page, 'review.ipynb', 'roots/pr-482');
	await makeNotebook(page, 'base.ipynb', 'roots/baseline');
	await makeNotebook(page, 'plain.ipynb');
	await ensureOpen(page, ['review.ipynb', 'base.ipynb', 'plain.ipynb']);
	await openGitSection(page);

	const review = row(page, 'review.ipynb');
	await expect(review.getByTestId('git-root')).toHaveText('roots/pr-482');
	await expect(review.getByTestId('git-branch-name')).toHaveText('pr-482');
	await expect(review.getByTestId('git-sha')).toHaveText(sha['pr-482']);
	await expect(review.getByTestId('git-subject')).toHaveText('the change under review');

	const base = row(page, 'base.ipynb');
	await expect(base.getByTestId('git-root')).toHaveText('roots/baseline');
	await expect(base.getByTestId('git-branch-name')).toHaveText('baseline');
	await expect(base.getByTestId('git-sha')).toHaveText(sha.baseline);
	await expect(base.getByTestId('git-subject')).toHaveText('the baseline commit');

	// A notebook with no root reads the workspace HEAD, and says "workspace" rather
	// than naming a root it does not have.
	const plain = row(page, 'plain.ipynb');
	await expect(plain.getByTestId('git-root')).toHaveText('workspace');
	await expect(plain.getByTestId('git-branch-name')).toHaveText('main');
	await expect(plain.getByTestId('git-sha')).toHaveText(sha.workspace);

	// The three SHAs really are different — that difference is the whole feature.
	expect(new Set([sha['pr-482'], sha.baseline, sha.workspace]).size).toBe(3);

	// Neither worktree has been touched, so neither reads dirty…
	await expect(review.getByTestId('git-dirty')).toHaveCount(0);
	await expect(base.getByTestId('git-dirty')).toHaveCount(0);
	// …while the workspace genuinely IS dirty: the notebooks just created are
	// untracked files in THAT checkout. Reporting per checkout rather than once for
	// the repository is the point — these rows disagree, correctly.
	await expect(plain.getByTestId('git-dirty')).toBeVisible();
});

test('marks a checkout dirty once it has uncommitted changes', async ({ page }) => {
	await page.goto(baseURL);
	await makeNotebook(page, 'dirty-review.ipynb', 'roots/pr-482');
	await makeNotebook(page, 'clean-review.ipynb', 'roots/baseline');
	await ensureOpen(page, ['dirty-review.ipynb', 'clean-review.ipynb']);
	await openGitSection(page);

	const dirty = row(page, 'dirty-review.ipynb');
	await expect(dirty.getByTestId('git-dirty')).toHaveCount(0);

	writeFileSync(join(workspace, 'roots', 'pr-482', 'probe.py'), "VALUE = 'edited, not committed'\n");
	// An edit made in a terminal notifies nothing, so window focus is the app's own
	// re-read trigger. Dispatched repeatedly because a single early re-read can
	// still be served from the server's short-lived status cache — which is exactly
	// what a real alt-tab does too.
	await expect(async () => {
		await page.evaluate(() => window.dispatchEvent(new Event('focus')));
		await expect(dirty.getByTestId('git-dirty')).toBeVisible({ timeout: 1500 });
	}).toPass({ timeout: 20_000 });
	// Only THAT checkout: the other worktree is untouched and still reads clean.
	await expect(row(page, 'clean-review.ipynb').getByTestId('git-dirty')).toHaveCount(0);
	// And a working-tree edit does not move the commit the notebook is rooted at.
	await expect(dirty.getByTestId('git-sha')).toHaveText(sha['pr-482']);
});

test('follows a root change live, with no reload', async ({ page }) => {
	await page.goto(baseURL);
	await makeNotebook(page, 'moved.ipynb');
	await ensureOpen(page, ['moved.ipynb']);
	await openGitSection(page);

	const moved = row(page, 'moved.ipynb');
	await expect(moved.getByTestId('git-branch-name')).toHaveText('main');

	// Repoint the notebook at a worktree, exactly as its own root picker does. The
	// section follows the `notebook:root` event — no reload, no refresh click.
	const res = await page.request.post(`${baseURL}/api/notebooks/root`, {
		data: { root: 'roots/baseline', path: 'moved.ipynb' }
	});
	expect(res.ok(), await res.text()).toBeTruthy();

	await expect(moved.getByTestId('git-root')).toHaveText('roots/baseline');
	await expect(moved.getByTestId('git-branch-name')).toHaveText('baseline');
	await expect(moved.getByTestId('git-sha')).toHaveText(sha.baseline);
});

test('reports a root that no longer exists instead of showing a commit', async ({ page }) => {
	// A worktree removed after the notebook declared it — the state a RUN of that
	// notebook is about to refuse, so the section says so rather than degrading to
	// the workspace's commit and claiming a checkout it is not on.
	await page.goto(baseURL);
	await makeNotebook(page, 'stale.ipynb', 'roots/doomed');
	await ensureOpen(page, ['stale.ipynb']);
	await openGitSection(page);
	await expect(row(page, 'stale.ipynb').getByTestId('git-sha')).toHaveText(sha.doomed);

	rmSync(join(workspace, 'roots', 'doomed'), { recursive: true, force: true });

	const stale = row(page, 'stale.ipynb');
	await expect(async () => {
		await page.evaluate(() => window.dispatchEvent(new Event('focus')));
		await expect(stale.getByTestId('git-root-error')).toContainText('roots/doomed', { timeout: 1500 });
	}).toPass({ timeout: 20_000 });
	await expect(stale.getByTestId('git-sha')).toHaveCount(0);
	// The declaration itself is still shown: it is what has to be fixed.
	await expect(stale.getByTestId('git-root')).toHaveText('roots/doomed');
});

test('folds and reorders like every other sidebar section', async ({ page }) => {
	await page.goto(baseURL);
	await openGitSection(page);

	// Collapsing unmounts the panel entirely — nothing is fetched while closed.
	await page.getByTestId('section-git').click();
	await expect(page.getByTestId('git-body')).toHaveCount(0);
	await page.getByTestId('section-git').click();
	await expect(page.getByTestId('git-body')).toBeVisible();

	// It carries the shared drag handle, so it joins section reordering…
	await expect(page.getByTestId('section-drag-git')).toBeVisible();
	// …and it ships directly under Files, where VS Code puts Source Control.
	const keys = await page
		.getByTestId('sidebar-section')
		.evaluateAll((els) => els.map((el) => el.getAttribute('data-section')));
	expect(keys.indexOf('git')).toBe(keys.indexOf('files') + 1);
});
