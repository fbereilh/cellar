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

/**
 * Wait until the SERVER holds the code-root preference, not just the tab: the UI
 * store PUTs on a debounce, so a test that flips it and ends leaves the write in
 * flight and the NEXT test's page is seeded from the stale value - which is a
 * cross-test leak, since this preference decides whether the root bar renders at
 * all. Asserting the persistence, never the debounce window.
 */
async function expectCodeRootPref(page: Page, value: boolean): Promise<void> {
	await expect
		.poll(async () => {
			const res = await page.request.get(`${baseURL}/api/ui-state`);
			return ((await res.json()) as Record<string, unknown>)['cellar-show-code-root'] === true;
		})
		.toBe(value);
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

	// Marking a cell still writes the module: choosing what is IN the module is one
	// of the three EXPLICIT export actions (an ordinary save is not - see
	// `tests/unit/export-explicit-only.test.ts`, and the case below).
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
	await expectCodeRootPref(page, true);
	await page.reload();
	// Same settle rule, with the `:visible` cell locator this test needs (several
	// notebooks are mounted by now, and a hidden one must not answer for the page).
	await expect(
		page.getByTestId('empty-open-notebook').or(page.locator('[data-testid="cell"]:visible').first())
	).toBeVisible();
	await page.locator('[data-testid="tree-file"][data-path="notebook.ipynb"]').click();
	await expect(page.locator('[data-testid="root-bar"]:visible')).toBeVisible();

	// Off again: the bar leaves (this notebook still declares no root). Waited out
	// on the SERVER too, so the next test's page is not seeded from a stale `true`.
	await openSettings(page);
	await page.getByTestId('settings-show-code-root').click();
	await closeSettings(page);
	await expect(page.locator('[data-testid="root-bar"]:visible')).toHaveCount(0);
	await expectCodeRootPref(page, false);
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

/**
 * The base select and the target input write to ONE document, and clicking (or
 * tabbing into) the select BLURS the input - which fires its `change`. So the
 * everyday "type the path, then pick the base" gesture puts both writes on the
 * wire at once, and whichever reply landed first won while the other was thrown
 * away by the `superseded` guard.
 *
 * The set-target reply is HELD here so the interleaving is deterministic rather
 * than a race: the server then sees set-base FIRST, over a document that holds no
 * target - an honest no-op reporting `{target:null, base:'workspace'}`. Adopted,
 * that emptied the field the user had just typed into AND discarded the base they
 * had just picked, while the notebook on disk really did hold the path. The base
 * change must instead WAIT for the path commit and re-express what was stored.
 */
test('picking a base right after typing a path waits for the path commit', async ({
	page,
	request
}) => {
	const nb = await makeNotebook(request, 'ordering.ipynb');
	await page.route('**/api/notebooks/export-py', async (route) => {
		if (route.request().postDataJSON()?.op === 'set-target')
			await new Promise((r) => setTimeout(r, 700));
		await route.continue();
	});
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await page.locator('[data-testid="tree-file"][data-path="ordering.ipynb"]').click();
	await expect(page.locator('[data-testid="cell"]:visible').first()).toBeVisible();

	const select = page.locator('[data-testid="export-base-select"]:visible');
	const input = page.locator('[data-testid="export-target-input"]:visible');
	await expect(input).toHaveValue('');
	await expect(select).toHaveValue('workspace');

	// Type the path, then reach for the select. Reaching for it BLURS the input,
	// which is what fires its `change` and puts the path commit on the wire - so
	// the blur is issued explicitly here, because Playwright's synthetic
	// `selectOption` moves no focus and would never produce it.
	await input.fill('ordering_mod.py');
	await input.blur();
	await select.selectOption('git');

	// Both halves survive: the path is stored, then RE-EXPRESSED under the base
	// that was picked (the git root is this workspace's PARENT, so the same file
	// gains its repo-relative spelling).
	await expect(input).toHaveValue('analysis/ordering_mod.py');
	await expect(select).toHaveValue('git');
	await expect(page.locator('[data-testid="export-resolved"]:visible')).toHaveText(
		'→ ordering_mod.py'
	);
	await expect.poll(() => diskCellar(nb)).toMatchObject({
		export_target: 'analysis/ordering_mod.py',
		export_base: 'git'
	});
});

/**
 * A hand-edited `export_base` the resolver does not know is SHOWN unmatched by
 * the select (never masquerading as workspace) and refuses to resolve, and every
 * refusal names the same repair: clear the target, then set the path again.
 *
 * That repair used to LOOP. Clearing deletes both keys and answers with no target
 * held, and the base is adopted only when one IS - so the tab kept the dead base
 * and sent it with the very next path commit, which was refused with the advice
 * just followed. The clear must leave the tab able to set a path again.
 */
test('the documented repair for an unknown hand-edited base terminates', async ({ page }) => {
	// Written straight to disk, never through the API: the point is a base no
	// setter would ever store, on a document the server has not yet loaded.
	const rel = 'weirdbase.ipynb';
	writeFileSync(
		join(workspace, rel),
		JSON.stringify(
			{
				cells: [
					{
						cell_type: 'code',
						execution_count: null,
						id: 'aaaaaaaa',
						metadata: {},
						outputs: [],
						source: ['x = 1']
					}
				],
				metadata: {
					cellar: { export_target: 'mod.py', export_base: 'weird' },
					kernelspec: { display_name: 'python3', language: 'python', name: 'python3' }
				},
				nbformat: 4,
				nbformat_minor: 5
			},
			null,
			1
		)
	);

	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await page.locator(`[data-testid="tree-file"][data-path="${rel}"]`).click();
	await expect(page.locator('[data-testid="cell"]:visible').first()).toBeVisible();

	const select = page.locator('[data-testid="export-base-select"]:visible');
	const input = page.locator('[data-testid="export-target-input"]:visible');
	await expect(input).toHaveValue('mod.py');
	// Unmatched, not workspace: no option carries this value, so the select shows none.
	await expect(select).toHaveValue('');
	await expect(page.locator('[data-testid="export-resolve-error"]:visible')).toContainText(
		'unknown export base'
	);

	// The repair, step one: clearing is allowed under ANY stored base and deletes
	// both keys.
	await input.fill('');
	await input.press('Enter');
	await expect.poll(() => 'export_target' in diskCellar(rel)).toBe(false);
	expect('export_base' in diskCellar(rel)).toBe(false);

	// Step two: setting the path again LANDS, rather than being refused for the
	// base that is no longer there.
	await input.fill('mod.py');
	await input.press('Enter');
	await expect.poll(() => diskCellar(rel)).toMatchObject({ export_target: 'mod.py' });
	expect('export_base' in diskCellar(rel)).toBe(false);
	await expect(select).toHaveValue('workspace');
	await expect(page.locator('[data-testid="export-resolve-error"]:visible')).toHaveCount(0);
});

/**
 * The root list costs a `git worktree list` (a blocking `spawnSync`) plus a
 * resolve per candidate, on the process carrying the kernel websockets and the
 * SSE fan-out - and it decides only whether the root bar's PICKER is offered. Now
 * that the bar is opt-in chrome, the default configuration must not pay for it on
 * every notebook open; flipping the preference on must still populate the picker
 * with no reload.
 *
 * Counted by exact pathname and filtered to THIS notebook: other restored tabs
 * are mounted too, and one of them declares a root, so it legitimately reads.
 */
test('a hidden root bar costs no root read, and the toggle populates the picker', async ({
	page,
	request
}) => {
	const rel = 'quiet.ipynb';
	await makeNotebook(request, rel);
	const reads: (string | null)[] = [];
	page.on('request', (r) => {
		const u = new URL(r.url());
		if (r.method() === 'GET' && u.pathname === '/api/notebooks/root')
			reads.push(u.searchParams.get('path'));
	});
	const readsFor = () => reads.filter((p) => p === rel).length;

	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await page.locator(`[data-testid="tree-file"][data-path="${rel}"]`).click();
	// The export bar is unconditional, so its arrival proves this notebook loaded.
	await expect(page.locator('[data-testid="export-bar"]:visible')).toBeVisible();
	await expect(page.locator('[data-testid="root-bar"]:visible')).toHaveCount(0);
	expect(readsFor()).toBe(0);

	await openSettings(page);
	const toggle = page.getByTestId('settings-show-code-root');
	await expect(toggle).not.toBeChecked();
	await toggle.click();
	await closeSettings(page);

	// Revealed, and POPULATED - the workspace really has a `roots/pr-1` worktree,
	// and no reload happened.
	const select = page.locator('[data-testid="root-select"]:visible');
	await expect(select).toBeVisible();
	await expect(select).toContainText('roots/pr-1');
	expect(readsFor()).toBe(1);

	// Leave the preference as this file found it, durably.
	await openSettings(page);
	await page.getByTestId('settings-show-code-root').click();
	await closeSettings(page);
	await expect(page.locator('[data-testid="root-bar"]:visible')).toHaveCount(0);
	await expectCodeRootPref(page, false);
});

/**
 * A failed PERSIST is not a refusal, and the base select's write must say so the
 * way the path commit already does. `setExportBase` validates before it mutates,
 * so a 500 carrying `writeFailed` means the document HOLDS the re-expressed
 * target under the new base and only the save failed - and that reply carries no
 * `message`, so a client deciding by the message alone denied a change the select
 * was visibly showing and blamed a server that had answered.
 *
 * The disk failure is injected at the reply rather than by breaking the real
 * workspace: what is under test is which of the route's two 5xx-shaped outcomes
 * the tab reports, not the filesystem.
 */
test('a base change the server accepted but could not save says exactly that', async ({
	page,
	request
}) => {
	const nb = await makeNotebook(request, 'diskbase.ipynb');
	const target = await request.post(`${baseURL}/api/notebooks/export-py`, {
		data: { op: 'set-target', target: 'lib/diskbase.py', path: nb }
	});
	expect(target.ok(), await target.text()).toBeTruthy();

	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await page.locator(`[data-testid="tree-file"][data-path="${nb}"]`).click();
	await expect(page.locator('[data-testid="cell"]:visible').first()).toBeVisible();

	const select = page.locator('[data-testid="export-base-select"]:visible');
	const input = page.locator('[data-testid="export-target-input"]:visible');
	await expect(select).toHaveValue('workspace');
	await expect(input).toHaveValue('lib/diskbase.py');

	// The route's own failed-write shape: the held state is the NEW one, and there
	// is no `message` field at all.
	await page.route('**/api/notebooks/export-py', async (route) => {
		if (route.request().postDataJSON()?.op !== 'set-base') return route.continue();
		await route.fulfill({
			status: 500,
			json: {
				ok: false,
				writeFailed: 'ENOSPC: no space left on device, write',
				target: 'diskbase_mod.py',
				base: 'notebook',
				resolved: 'diskbase_mod.py',
				resolveError: null
			}
		});
	});
	await select.selectOption('notebook');

	// Read the toast ONCE (it self-dismisses), then assert the whole sentence: the
	// absence of the unreachable wording is half the point, and a locator that has
	// since gone would not answer for it.
	const notice = page.getByTestId('app-notice');
	await expect(notice).toContainText('accepted but not saved');
	const said = (await notice.innerText()).trim();
	expect(said).toContain('ENOSPC');
	expect(said).not.toContain('could not be reached');
	expect(said).not.toContain('not changed');
	// The change the notice describes is the one on screen: the select and the
	// input keep the state the document holds.
	await expect(select).toHaveValue('notebook');
	await expect(input).toHaveValue('diskbase_mod.py');
});

/**
 * The compile-hazard warning, in a real browser.
 *
 * Cellar writes a module whose `from __future__ import ...` shares a line with
 * another statement - it cannot hoist that line without reordering the statement
 * riding with it - so the module does not compile. The fix is that no surface
 * calls that a success, and the surface that MATTERS is the standing one. A hazard
 * is a fact about the MARKED CELLS, not about the file on disk, so a save is
 * exactly what creates one - and the export itself is now explicit, so the warning
 * has to arrive with no reload and no click or the user reaches the button already
 * holding a module that will not import.
 */
test('a module that will not import says so in the bar, live, and clears when fixed', async ({
	page,
	request
}) => {
	const nb = await makeNotebook(request, 'hazard.ipynb');
	const cellId = await firstCellId(request, nb);
	const target = await request.post(`${baseURL}/api/notebooks/export-py`, {
		data: { op: 'set-target', target: 'lib/hazard.py', path: nb }
	});
	expect(target.ok(), await target.text()).toBeTruthy();

	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await page.locator(`[data-testid="tree-file"][data-path="${nb}"]`).click();
	await expect(page.locator('[data-testid="cell"]:visible').first()).toBeVisible();

	// Nothing marked yet: no module, so nothing to warn about.
	const hazard = page.locator('[data-testid="export-hazard"]:visible');
	await expect(hazard).toHaveCount(0);

	// Mark a cell holding the construct, from OUTSIDE this tab (an agent, or the
	// user's own save). The bar must learn about it through the live push.
	const patched = await request.patch(`${baseURL}/api/cells/${cellId}`, {
		data: { source: 'from __future__ import annotations; x = 1', export: true, nb }
	});
	expect(patched.ok(), await patched.text()).toBeTruthy();

	await expect(hazard).toBeVisible();
	await expect(hazard).toContainText('will not import');
	await expect(hazard).toContainText('line of its own');
	// The module really was written - refusing would have left nothing to explain.
	await expect.poll(() => existsSync(join(workspace, 'lib', 'hazard.py'))).toBe(true);

	// The manual export reports it too, rather than "Exported 1 cell → ...".
	await page.locator('[data-testid="export-run"]:visible').click();
	const feedback = page.locator('[data-testid="export-feedback"]:visible');
	await expect(feedback).toContainText('will not import');
	await expect(feedback).not.toContainText('Exported 1 cell');

	// Fixing the cell clears the warning, with no reload: a warning that only ever
	// appears is one nobody can act on.
	const fixed = await request.patch(`${baseURL}/api/cells/${cellId}`, {
		data: { source: 'from __future__ import annotations\nx = 1', nb }
	});
	expect(fixed.ok(), await fixed.text()).toBeTruthy();
	await expect(hazard).toHaveCount(0);
});

test('a save leaves the module alone; the button exports, and reports a refusal on the click', async ({
	page,
	request
}) => {
	// The behaviour this pins in a REAL browser: the module is written by an
	// explicit export and by nothing else, and when an explicit export is REFUSED
	// the reason reaches the person who pressed the button. The unit half lives in
	// `tests/unit/export-explicit-only.test.ts`; only this level can show the
	// refusal landing on the shell's notice line.
	const nb = await makeNotebook(request, 'explicit.ipynb');
	const cellId = await firstCellId(request, nb);
	const modulePath = join(workspace, 'lib', 'explicit.py');

	const target = await request.post(`${baseURL}/api/notebooks/export-py`, {
		data: { op: 'set-target', target: 'lib/explicit.py', path: nb }
	});
	expect(target.ok(), await target.text()).toBeTruthy();

	// Marking is explicit, so the module lands now, holding the first source.
	const marked = await request.patch(`${baseURL}/api/cells/${cellId}`, {
		data: { source: 'def first():\n    return 1', export: true, nb }
	});
	expect(marked.ok(), await marked.text()).toBeTruthy();
	await expect.poll(() => existsSync(modulePath)).toBe(true);
	expect(readFileSync(modulePath, 'utf8')).toContain('def first():');

	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await page.locator(`[data-testid="tree-file"][data-path="${nb}"]`).click();
	const cell = page.locator('[data-testid="cell"]:visible').first();
	await expect(cell).toBeVisible();

	// EDIT the marked cell and let the debounced autosave land. The notebook moves;
	// the module must not. The click on the CARD is what summons the editor - cells
	// render a static stand-in until then - and the second one puts the caret in it,
	// since typing in command mode would drive the modal keyboard instead.
	await cell.click();
	const editor = cell.locator('.cm-content');
	await expect(editor).toBeVisible();
	await editor.click();
	await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
	await page.keyboard.type('def second():\n    return 2');
	await expect
		.poll(async () => {
			const view = await request.get(`${baseURL}/api/notebooks?path=${encodeURIComponent(nb)}`);
			return ((await view.json()).notebook.cells[0].source as string).includes('def second');
		})
		.toBe(true);
	expect(readFileSync(modulePath, 'utf8')).toContain('def first():');
	expect(readFileSync(modulePath, 'utf8')).not.toContain('def second():');

	// The BUTTON is what writes it.
	await page.locator('[data-testid="export-run"]:visible').click();
	const feedback = page.locator('[data-testid="export-feedback"]:visible');
	await expect(feedback).toContainText('Exported 1 cell');
	expect(readFileSync(modulePath, 'utf8')).toContain('def second():');

	// Now the nbdev-repository case, the one that made export explicit: the target
	// holds a module Cellar did not generate. The clobber guard refuses, and the
	// refusal has to reach THIS click - it used to be recorded where no human
	// surface reads it, once per save, forever.
	writeFileSync(modulePath, '# AUTOGENERATED BY NBDEV\n\ndef theirs():\n    pass\n');
	await page.locator('[data-testid="export-run"]:visible').click();
	const notice = page.getByTestId('app-notice');
	await expect(notice).toBeVisible();
	await expect(notice).toContainText('refusing to overwrite');
	await expect(notice).toContainText('not a Cellar-generated module');
	// ...and their file is intact.
	expect(readFileSync(modulePath, 'utf8')).toContain('def theirs():');
});

test('the export waits for the edit it raced, and says so when that edit never lands', async ({
	page,
	request
}) => {
	// THE RACE, driven deterministically. Pressing "Export to .py" blurs the editor,
	// so `Cell.svelte` flushes the pending edit fire-and-forget; the export POST then
	// travels on its own connection and CAN be serviced first, writing the module
	// from the pre-edit source and reporting "Exported 1 cell" over it. An ordinary
	// save used to re-export and heal that - nothing does now. The sibling test above
	// cannot see it: it polls the server view for the edit before it clicks. Holding
	// the PATCH open forces the losing interleaving every run.
	const nb = await makeNotebook(request, 'export-race.ipynb');
	const cellId = await firstCellId(request, nb);
	const modulePath = join(workspace, 'lib', 'race.py');

	const target = await request.post(`${baseURL}/api/notebooks/export-py`, {
		data: { op: 'set-target', target: 'lib/race.py', path: nb }
	});
	expect(target.ok(), await target.text()).toBeTruthy();
	const marked = await request.patch(`${baseURL}/api/cells/${cellId}`, {
		data: { source: 'def before():\n    return 1', export: true, nb }
	});
	expect(marked.ok(), await marked.text()).toBeTruthy();
	await expect.poll(() => existsSync(modulePath)).toBe(true);

	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await page.locator(`[data-testid="tree-file"][data-path="${nb}"]`).click();
	const cell = page.locator('[data-testid="cell"]:visible').first();
	await expect(cell).toBeVisible();

	// Hold every cell PATCH open long enough that an export issued without waiting
	// for it is certainly serviced first.
	let held = 0;
	await page.route('**/api/cells/**', async (route) => {
		if (route.request().method() !== 'PATCH') return route.fallback();
		held += 1;
		await new Promise((r) => setTimeout(r, 1500));
		await route.continue();
	});

	await cell.click();
	const editor = cell.locator('.cm-content');
	await expect(editor).toBeVisible();
	await editor.click();
	await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
	await page.keyboard.type('def after():\n    return 2');
	// Straight to the button - no poll, no settle. The blur is what flushes the edit,
	// and the export must not overtake it.
	await page.locator('[data-testid="export-run"]:visible').click();

	const feedback = page.locator('[data-testid="export-feedback"]:visible');
	await expect(feedback).toContainText('Exported 1 cell');
	expect(held).toBeGreaterThan(0);
	// The module holds the source the notebook HAS, not the one it had.
	expect(readFileSync(modulePath, 'utf8')).toContain('def after():');
	expect(readFileSync(modulePath, 'utf8')).not.toContain('def before():');

	// And an edit that never lands must not be exported over in silence: the module
	// would then hold the source the SERVER still has while the bar reported success.
	await page.unroute('**/api/cells/**');
	// Held OPEN and then failed, for the same determinism: the export must find the
	// write still in flight, not already settled and dropped.
	await page.route('**/api/cells/**', async (route) => {
		if (route.request().method() !== 'PATCH') return route.fallback();
		await new Promise((r) => setTimeout(r, 1500));
		await route.abort();
	});
	await editor.click();
	await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
	await page.keyboard.type('def never():\n    return 3');
	await page.locator('[data-testid="export-run"]:visible').click();

	const notice = page.getByTestId('app-notice');
	await expect(notice).toBeVisible();
	await expect(notice).toContainText('could not be saved');
	expect(readFileSync(modulePath, 'utf8')).toContain('def after():');
	expect(readFileSync(modulePath, 'utf8')).not.toContain('def never():');
	await page.unroute('**/api/cells/**');
});
