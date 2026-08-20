import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * The export-target SECTION: always visible, base-aware, honest about
 * importability - plus the root bar's new opt-in visibility.
 *
 * The workspace is a SUBDIRECTORY of its git repo (`cd repo/analysis && cellar`),
 * because that is where the workspace and git bases genuinely SPELL one file two
 * ways - which is what makes a base switch observable as re-expression rather
 * than as a no-op. A `roots/pr-1` worktree gives the importability warning a real
 * declared code root to measure against.
 */

let launcher: ChildProcess | null = null;
let parentRepo = '';
let workspace = '';
let baseURL = '';

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
		'kernel runtime (uv + python3 + host-venv) or git not available - E2E is local-only'
	);
	parentRepo = mkdtempSync(join(tmpdir(), 'cellar-e2e-export-base-'));
	git(parentRepo, 'init', '-q', '-b', 'main');
	git(parentRepo, 'config', 'user.email', 'e2e@example.com');
	git(parentRepo, 'config', 'user.name', 'E2E');
	writeFileSync(join(parentRepo, 'seed.txt'), 'seed\n');
	git(parentRepo, 'add', 'seed.txt');
	git(parentRepo, 'commit', '-q', '-m', 'seed');
	workspace = join(parentRepo, 'analysis');
	mkdirSync(workspace);
	// A code root for the importability test, and a .gitignore so the worktree
	// does not read as untracked noise (the real-world setup).
	writeFileSync(join(workspace, '.gitignore'), 'roots/\n');
	git(parentRepo, 'worktree', 'add', '-q', '-b', 'pr-1', join(workspace, 'roots', 'pr-1'), 'main');

	const booted = await bootCellar(workspace);
	launcher = booted.proc;
	baseURL = booted.url;
});

test.afterAll(async () => {
	if (launcher) killCellar(launcher);
	launcher = null;
	if (parentRepo && existsSync(parentRepo)) {
		try {
			rmSync(parentRepo, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}
});

function diskCellar(rel: string): Record<string, unknown> {
	return JSON.parse(readFileSync(join(workspace, rel), 'utf8')).metadata?.cellar ?? {};
}

async function makeNotebook(api: APIRequestContext, rel: string): Promise<string> {
	const created = await api.post(`${baseURL}/api/notebooks`, { data: { path: rel, create: true } });
	expect(created.ok(), await created.text()).toBeTruthy();
	return rel;
}

async function firstCellId(api: APIRequestContext, nb: string): Promise<string> {
	const view = await api.get(`${baseURL}/api/notebooks?path=${encodeURIComponent(nb)}`);
	return (await view.json()).notebook.cells[0].id as string;
}

async function openDefaultNotebook(page: Page): Promise<void> {
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await settleDefaultNotebook(page);
}

/**
 * Settle before probing: the shell paints either the empty state or an
 * already-open notebook (the openNotebook-helper rule from AGENTS.md), so a bare
 * `cell` probe reports the button invisible, turns the click into a no-op and then
 * times out for 30s on a notebook nothing ever opened. Needed after a RELOAD as
 * much as after a goto - the tab session decides which of the two is painted, so
 * probing the cell alone is a race whichever way the page was entered.
 */
async function settleDefaultNotebook(page: Page): Promise<void> {
	const openBtn = page.getByTestId('empty-open-notebook');
	const cell = page.getByTestId('cell').first();
	await expect(openBtn.or(cell)).toBeVisible();
	if (await openBtn.isVisible()) await openBtn.click();
	await expect(cell).toBeVisible();
}

async function openSettings(page: Page): Promise<void> {
	await page.getByTestId('app-menu').click();
	await page.getByTestId('open-settings').click();
	await expect(page.getByTestId('settings-modal')).toBeVisible();
}

async function closeSettings(page: Page): Promise<void> {
	await page.getByTestId('settings-close').click();
	await expect(page.getByTestId('settings-modal')).toHaveCount(0);
	await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

test('a fresh notebook offers the section; a (base, path) choice writes the module and survives reopen', async ({
	page,
	request
}) => {
	const nb = await makeNotebook(request, 'notebook.ipynb');
	const cellId = await firstCellId(request, nb);
	// Give the cell exportable source BEFORE marking, so the regenerated module
	// has content to prove itself with.
	const patched = await request.patch(`${baseURL}/api/cells/${cellId}`, {
		data: { source: 'def fresh():\n    return 1', nb }
	});
	expect(patched.ok(), await patched.text()).toBeTruthy();

	await openDefaultNotebook(page);

	// PRESENT BY DEFAULT: no target, nothing marked - the section is how a target
	// is set before any cell is marked.
	const bar = page.getByTestId('export-bar');
	await expect(bar).toBeVisible();
	await expect(page.getByTestId('export-base-select')).toHaveValue('workspace');
	await expect(page.getByTestId('export-target-input')).toHaveValue('');
	await expect(page.getByTestId('export-count')).toHaveText('0 cells marked');
	// The root bar, by contrast, is OPT-IN and this notebook declares no root.
	await expect(page.getByTestId('root-bar')).toHaveCount(0);

	// Choose the base FIRST (client-held until a path exists), then state the path.
	await page.getByTestId('export-base-select').selectOption('notebook');
	await page.getByTestId('export-target-input').fill('mods/frombook.py');
	await page.getByTestId('export-target-input').press('Enter');
	// A non-workspace base states the workspace file it resolves to.
	await expect(page.getByTestId('export-resolved')).toHaveText('→ mods/frombook.py');
	await expect.poll(() => diskCellar(nb)).toMatchObject({
		export_target: 'mods/frombook.py',
		export_base: 'notebook'
	});

	// Marking a cell still writes the module - through the same auto-export path.
	const marked = await request.patch(`${baseURL}/api/cells/${cellId}`, {
		data: { export: true, nb }
	});
	expect(marked.ok(), await marked.text()).toBeTruthy();
	await expect.poll(() => existsSync(join(workspace, 'mods', 'frombook.py'))).toBe(true);
	expect(readFileSync(join(workspace, 'mods', 'frombook.py'), 'utf8')).toContain('def fresh():');
	await expect(page.getByTestId('export-count')).toHaveText('1 cell marked');

	// REOPEN: both halves of the choice come back.
	await page.reload();
	await settleDefaultNotebook(page);
	await expect(page.getByTestId('export-base-select')).toHaveValue('notebook');
	await expect(page.getByTestId('export-target-input')).toHaveValue('mods/frombook.py');
	await expect(page.getByTestId('export-resolved')).toHaveText('→ mods/frombook.py');
});

test('switching bases re-expresses the SAME file, and workspace restores the legacy key shape', async ({
	page
}) => {
	await openDefaultNotebook(page);
	const input = page.getByTestId('export-target-input');
	await expect(input).toHaveValue('mods/frombook.py');

	// notebook -> git: the git root is the PARENT repo, so the same file gains its
	// repo-relative spelling - visibly a re-expression, not a retarget.
	await page.getByTestId('export-base-select').selectOption('git');
	await expect(input).toHaveValue('analysis/mods/frombook.py');
	await expect(page.getByTestId('export-resolved')).toHaveText('→ mods/frombook.py');
	await expect.poll(() => diskCellar('notebook.ipynb')).toMatchObject({
		export_target: 'analysis/mods/frombook.py',
		export_base: 'git'
	});

	// git -> workspace: same file again, the hint (an echo under this base) goes,
	// and the base key is DELETED - the absent-key legacy spelling of the default.
	await page.getByTestId('export-base-select').selectOption('workspace');
	await expect(input).toHaveValue('mods/frombook.py');
	await expect(page.getByTestId('export-resolved')).toHaveCount(0);
	await expect
		.poll(() => 'export_base' in diskCellar('notebook.ipynb'))
		.toBe(false);
	expect(diskCellar('notebook.ipynb').export_target).toBe('mods/frombook.py');
});

test('the importability warning tracks whether the module lands under the declared code root', async ({
	page,
	request
}) => {
	const nb = await makeNotebook(request, 'review.ipynb');
	const rooted = await request.post(`${baseURL}/api/notebooks/root`, {
		data: { root: 'roots/pr-1', path: nb }
	});
	expect(rooted.ok(), await rooted.text()).toBeTruthy();
	const target = await request.post(`${baseURL}/api/notebooks/export-py`, {
		data: { op: 'set-target', target: 'lib/helper.py', path: nb }
	});
	expect(target.ok(), await target.text()).toBeTruthy();

	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await page.getByText('review.ipynb').first().dblclick();
	await expect(
		page.locator('[data-testid="cell"]:visible').first()
	).toBeVisible();

	// A DECLARED root always shows the bar (the preference stays off).
	await expect(page.locator('[data-testid="root-bar"]:visible')).toBeVisible();
	// The module resolves outside `roots/pr-1`, so the kernel cannot import it -
	// said exactly when it applies.
	const warning = page.locator('[data-testid="export-import-warning"]:visible');
	await expect(warning).toBeVisible();
	await expect(warning).toContainText('cannot import');
	await expect(warning).toContainText('roots/pr-1');

	// Re-point the module UNDER the root: the warning has nothing to say.
	const input = page.locator('[data-testid="export-target-input"]:visible');
	await input.fill('roots/pr-1/helper.py');
	await input.press('Enter');
	await expect(page.locator('[data-testid="export-import-warning"]:visible')).toHaveCount(0);
});

/** Focus the ROOTLESS default notebook: the restored active tab may be review.ipynb. */
async function activateDefaultNotebook(page: Page): Promise<void> {
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await page.locator('[data-testid="tree-file"][data-path="notebook.ipynb"]').click();
	await expect(page.locator('[data-testid="cell"]:visible').first()).toBeVisible();
	await expect(page.locator('[data-testid="export-target-input"]:visible')).toHaveValue(
		'mods/frombook.py'
	);
}

test('the Settings toggle reveals the root bar on a rootless notebook, and persists', async ({
	page
}) => {
	await activateDefaultNotebook(page);
	await expect(page.locator('[data-testid="root-bar"]:visible')).toHaveCount(0);

	await openSettings(page);
	const toggle = page.getByTestId('settings-show-code-root');
	await expect(toggle).not.toBeChecked();
	await toggle.click();
	await expect(toggle).toBeChecked();
	await closeSettings(page);
	await expect(page.locator('[data-testid="root-bar"]:visible')).toBeVisible();

	// The preference is server-held UI state, so it survives a reload - but the
	// client store PUTs on a debounce, so wait for the server to really hold it
	// before reloading (asserting the persistence, not the debounce window).
	await expect
		.poll(async () => {
			const res = await page.request.get(`${baseURL}/api/ui-state`);
			return ((await res.json()) as Record<string, unknown>)['cellar-show-code-root'];
		})
		.toBe(true);
	await page.reload();
	// Same settle rule, with the `:visible` cell locator this test needs (several
	// notebooks are mounted by now, and a hidden one must not answer for the page).
	await expect(
		page.getByTestId('empty-open-notebook').or(page.locator('[data-testid="cell"]:visible').first())
	).toBeVisible();
	await page.locator('[data-testid="tree-file"][data-path="notebook.ipynb"]').click();
	await expect(page.locator('[data-testid="root-bar"]:visible')).toBeVisible();

	// Off again: the bar leaves (this notebook still declares no root).
	await openSettings(page);
	await page.getByTestId('settings-show-code-root').click();
	await closeSettings(page);
	await expect(page.locator('[data-testid="root-bar"]:visible')).toHaveCount(0);
});

/**
 * A base chosen BEFORE any path is client-local (a base alone is meaningless
 * server-side, so it rides up with the first path commit). That makes a REFUSED
 * first commit the one moment it can be lost: the reply reports the state the
 * document holds, and with nothing stored that base is a meaningless `workspace`.
 * Adopting it there snapped the select back, and the corrected retype then stored
 * the path under a base the user never chose - a DIFFERENT file, with only the
 * select having flickered to say so.
 *
 * Driven with the `git` base, whose root is the PARENT of this workspace, so the
 * two spellings genuinely name two different files from one typed path.
 */
test('a refused first commit keeps the base the user chose, so the retype lands the file they picked', async ({
	page,
	request
}) => {
	const nb = await makeNotebook(request, 'prechoice.ipynb');
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await page.locator('[data-testid="tree-file"][data-path="prechoice.ipynb"]').click();
	await expect(page.locator('[data-testid="cell"]:visible').first()).toBeVisible();

	const select = page.locator('[data-testid="export-base-select"]:visible');
	const input = page.locator('[data-testid="export-target-input"]:visible');
	await expect(input).toHaveValue('');
	await select.selectOption('git');

	// Refused: not a `.py` module. Nothing is stored, so the reply's base says
	// nothing about this notebook - and the pre-choice is the only copy there is.
	await input.fill('analysis/helpers');
	await input.press('Enter');
	await expect(select).toHaveValue('git');
	expect('export_target' in diskCellar(nb)).toBe(false);

	// The corrected retype lands under the base that was chosen: from the git root,
	// `analysis/helpers.py` IS this workspace's `helpers.py`. Read as workspace it
	// would have been `analysis/helpers.py` inside the workspace - another file.
	await input.fill('analysis/helpers.py');
	await input.press('Enter');
	await expect(page.locator('[data-testid="export-resolved"]:visible')).toHaveText('→ helpers.py');
	await expect.poll(() => diskCellar(nb)).toMatchObject({
		export_target: 'analysis/helpers.py',
		export_base: 'git'
	});
});
