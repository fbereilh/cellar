import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar, removeWorkspace } from './harness';
import { tabPanelDomId } from '../../src/lib/tabIds';

/**
 * E2E: the notebook toolbar's Export and Restart buttons, and its sticky compact form.
 *
 *  - Export with a target writes the module, says so on the notice line and
 *    shows the new file in the tree. A hazard is worded in full on that line.
 *  - The menu's own Export button shows a new module in the tree too.
 *  - The navbar Options menu no longer offers the export.
 *  - The editor keeps the cursor below the pinned toolbar, and a completion on
 *    a cell's first line still shows.
 *  - Export with no target writes nothing: it opens the language-and-export menu
 *    with the cursor in the target field.
 *  - Restart sends the existing kernel restart for THIS notebook.
 *  - Scrolled past, the same toolbar stays pinned at the top of the pane as icons,
 *    and a click there runs the same action. Scrolled back, it returns to full form.
 *  - Where the full form wraps onto two rows, turning compact moves no cell.
 *
 * Every locator is scoped to one notebook's pane: each open notebook stays mounted.
 */

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

const NB = {
	target: 'target.ipynb',
	bare: 'bare.ipynb',
	long: 'long.ipynb',
	menu: 'menu.ipynb',
	hazard: 'hazard.ipynb',
	tall: 'tall.ipynb'
} as const;

const EXPORTED = 'def add(a, b):\n    return a + b';

function notebook(cellCount: number, target: string | null, first = EXPORTED): string {
	const cells = Array.from({ length: cellCount }, (_, i) => ({
		cell_type: 'code',
		id: `c${i}`,
		metadata: i === 0 ? { cellar: { export: true } } : {},
		execution_count: null,
		outputs: [],
		source: [i === 0 ? first : `# cell ${i}\nx${i} = ${i}\nprint(x${i})`]
	}));
	return JSON.stringify({
		cells,
		metadata: target ? { cellar: { export_target: target } } : {},
		nbformat: 4,
		nbformat_minor: 5
	});
}

function paneFor(page: Page, file: string) {
	return page.locator(`[id="${tabPanelDomId('file:' + file)}"]`);
}

async function openNotebook(page: Page, file: string): Promise<void> {
	await page.goto(baseURL);
	await page.getByTestId('tree-file').filter({ hasText: file }).first().click();
	const pane = paneFor(page, file);
	await expect(pane.getByTestId('cell').first()).toBeVisible({ timeout: 30_000 });
	await expect(pane.getByTestId('toolbar-export')).toBeVisible();
}

/** Forget the persisted tab session, so each test starts from an empty tab set. */
async function clearTabSession(page: Page): Promise<void> {
	const state = await (await page.request.get(`${baseURL}/api/ui-state`)).json();
	const cleared: Record<string, null> = {};
	for (const key of Object.keys(state ?? {})) if (key.startsWith('cellar-tabs:')) cleared[key] = null;
	if (Object.keys(cleared).length) await page.request.put(`${baseURL}/api/ui-state`, { data: cleared });
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-toolbar-export-'));
	writeFileSync(join(workspace, NB.target), notebook(2, 'mod_target.py'));
	writeFileSync(join(workspace, NB.bare), notebook(2, null));
	writeFileSync(join(workspace, NB.long), notebook(60, 'mod_long.py'));
	writeFileSync(join(workspace, NB.menu), notebook(2, 'mod_menu.py'));
	// A `__future__` import sharing its line cannot be hoisted: the export writes
	// the module and reports that hazard.
	writeFileSync(join(workspace, NB.hazard), notebook(2, 'mod_hazard.py', 'x = 1; from __future__ import annotations'));
	const tall = Array.from({ length: 200 }, (_, i) => `line_${i} = ${i}`).join('\n');
	writeFileSync(join(workspace, NB.tall), notebook(1, null, tall));
	const boot = await bootCellar(workspace);
	launcher = boot.proc;
	baseURL = boot.url;
});

test.afterAll(async () => {
	if (launcher) killCellar(launcher);
	removeWorkspace(workspace);
});

test.beforeEach(async ({ page }) => {
	await clearTabSession(page);
});

test('Export with a target writes the module and says so', async ({ page }) => {
	await openNotebook(page, NB.target);
	const button = paneFor(page, NB.target).getByTestId('toolbar-export');
	await expect(button).toHaveAttribute('title', 'Export the marked cells to mod_target.py');
	await button.click();
	await expect(page.getByTestId('app-notice')).toContainText('Exported 1 cell', { timeout: 30_000 });
	expect(readFileSync(join(workspace, 'mod_target.py'), 'utf8')).toContain('def add(a, b):');
	// The new file shows in the tree without a manual refresh.
	await expect(page.getByTestId('tree-file').filter({ hasText: 'mod_target.py' })).toBeVisible();
	// The menu stays closed: the click exported, it did not open settings.
	await expect(page.locator('[data-testid="notebook-settings-menu"]:popover-open')).toHaveCount(0);
});

test('the menu Export button shows the new module in the file tree', async ({ page }) => {
	await openNotebook(page, NB.menu);
	const pane = paneFor(page, NB.menu);
	await pane.getByTestId('notebook-settings').click();
	await pane.getByTestId('export-run').click();
	await expect.poll(() => existsSync(join(workspace, 'mod_menu.py')), { timeout: 30_000 }).toBe(true);
	await expect(page.getByTestId('tree-file').filter({ hasText: 'mod_menu.py' })).toBeVisible();
});

test('Export with a hazard words the warning in full on the notice line', async ({ page }) => {
	await openNotebook(page, NB.hazard);
	await paneFor(page, NB.hazard).getByTestId('toolbar-export').click();
	const notice = page.getByTestId('app-notice');
	await expect(notice).toContainText('Wrote mod_hazard.py, but', { timeout: 30_000 });
	// The menu that holds the standing warning is closed, so the line may not point at it.
	await expect(notice).not.toContainText('see the warning');
});

test('the navbar Options menu does not offer Export to module', async ({ page }) => {
	await openNotebook(page, NB.target);
	await page.getByTestId('app-menu').click();
	await expect(page.getByTestId('save-as-py')).toBeVisible();
	await expect(page.getByRole('button', { name: /Export to module/ })).toHaveCount(0);
});

test('the editor keeps the cursor below the pinned toolbar', async ({ page }) => {
	await openNotebook(page, NB.tall);
	const pane = paneFor(page, NB.tall);
	const bar = pane.getByTestId('notebook-toolbar');
	// Put the cursor on the last line, then walk it up past the top of the pane.
	await pane.getByTestId('cell').first().getByTestId('editor-scroll').click();
	await page.keyboard.press('ControlOrMeta+End');
	await expect(bar).toHaveAttribute('data-compact', '');
	for (let i = 0; i < 120; i++) await page.keyboard.press('ArrowUp');
	await expect(bar).toHaveAttribute('data-compact', '');
	const [barBottom, cursorTop] = await Promise.all([
		bar.evaluate((el) => el.getBoundingClientRect().bottom),
		pane.locator('.cm-focused .cm-activeLine').evaluate((el) => el.getBoundingClientRect().top)
	]);
	expect(cursorTop, 'the cursor line is under the toolbar').toBeGreaterThanOrEqual(barBottom);
});

test('a completion on the first line of a cell shows on screen', async ({ page }) => {
	await openNotebook(page, NB.bare);
	const cell = paneFor(page, NB.bare).getByTestId('cell').nth(1);
	await cell.getByTestId('editor-scroll').click();
	await expect(cell.locator('.cm-content')).toBeVisible();
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.type('pri');
	// CodeMirror parks a tooltip it decides to hide far off screen, so on-screen is the check.
	const popup = cell.locator('.cm-tooltip-autocomplete');
	await expect(popup.locator('li').filter({ hasText: 'print' }).first()).toBeInViewport({ timeout: 30_000 });
});

test('Export with no target opens the menu at the target field and writes nothing', async ({ page }) => {
	let exportPosts = 0;
	await page.route('**/api/notebooks/export-py', async (route) => {
		if (JSON.parse(route.request().postData() ?? '{}').op === 'export') exportPosts++;
		await route.continue();
	});
	await openNotebook(page, NB.bare);
	const pane = paneFor(page, NB.bare);
	await pane.getByTestId('toolbar-export').click();
	await expect(pane.locator('[data-testid="notebook-settings-menu"]:popover-open')).toHaveCount(1);
	await expect(pane.getByTestId('export-target-input')).toBeFocused();
	expect(exportPosts, 'the button exported with no target set').toBe(0);
});

test('Restart sends the kernel restart for this notebook', async ({ page }) => {
	const posted: string[] = [];
	await page.route('**/api/kernel/restart', async (route) => {
		posted.push(JSON.parse(route.request().postData() ?? '{}').path);
		await route.continue();
	});
	await openNotebook(page, NB.target);
	const button = paneFor(page, NB.target).getByTestId('restart-kernel');
	await button.click();
	await expect.poll(() => posted, { timeout: 30_000 }).toEqual([NB.target]);
	await expect(button).toBeEnabled({ timeout: 30_000 });
});

test('scrolled past, the toolbar stays on screen as icons and still acts', async ({ page }) => {
	rmSync(join(workspace, 'mod_long.py'), { force: true });
	await openNotebook(page, NB.long);
	const pane = paneFor(page, NB.long);
	const bar = pane.getByTestId('notebook-toolbar');
	await expect(bar).not.toHaveAttribute('data-compact');
	await expect(pane.getByTestId('run-all')).toContainText('Run all');

	await pane.evaluate((el) => (el.scrollTop = el.scrollHeight));
	await expect(bar).toHaveAttribute('data-compact', '');
	// Pinned to the top of the pane, and the labels gave way to icons.
	const [paneTop, barTop] = await Promise.all([
		pane.evaluate((el) => el.getBoundingClientRect().top),
		bar.evaluate((el) => el.getBoundingClientRect().top)
	]);
	expect(Math.abs(barTop - paneTop)).toBeLessThanOrEqual(1);
	await expect(pane.getByTestId('run-all').getByText('Run all')).toBeHidden();
	await expect(pane.getByTestId('toolbar-export')).toHaveAttribute('aria-label', 'Export to mod_long.py');

	await pane.getByTestId('toolbar-export').click();
	await expect(page.getByTestId('app-notice')).toContainText('Exported 1 cell', { timeout: 30_000 });
	expect(existsSync(join(workspace, 'mod_long.py'))).toBe(true);

	await pane.evaluate((el) => (el.scrollTop = 0));
	await expect(bar).not.toHaveAttribute('data-compact');
	await expect(pane.getByTestId('run-all')).toContainText('Run all');
});

test('a wrapped toolbar turning compact does not move the cells', async ({ page }) => {
	await page.setViewportSize({ width: 640, height: 720 });
	await openNotebook(page, NB.long);
	const pane = paneFor(page, NB.long);
	const bar = pane.getByTestId('notebook-toolbar');
	const cell = pane.getByTestId('cell').first();
	const barHeight = () => bar.evaluate((el) => el.getBoundingClientRect().height);
	// Where the cell sits in the pane's content, whatever the scroll position is.
	const cellOffset = () =>
		pane.evaluate(
			(el) => el.querySelector('[data-testid="cell"]')!.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop
		);
	await expect(bar).not.toHaveAttribute('data-compact');
	const fullHeight = await barHeight();
	const before = await cellOffset();

	await pane.evaluate((el) => (el.scrollTop = 150));
	await expect(bar).toHaveAttribute('data-compact', '');
	await expect(cell).toBeAttached();
	// The full form took more than the one compact row, so the switch had a height to lose.
	expect(fullHeight - (await barHeight()), 'the full toolbar did not wrap at this width').toBeGreaterThan(20);
	await expect.poll(cellOffset).toBeCloseTo(before, 0);
	await expect(bar).toHaveAttribute('data-compact', '');

	// Widened while compact, the full form fits one row: the two-row measure may not outlive it.
	await page.setViewportSize({ width: 1400, height: 720 });
	await pane.evaluate((el) => (el.scrollTop = 0));
	await expect(bar).not.toHaveAttribute('data-compact');
	const oneRow = await cellOffset();
	expect(await barHeight(), 'the full toolbar still wraps at this width').toBeLessThan(fullHeight - 20);
	await pane.evaluate((el) => (el.scrollTop = 150));
	await expect(bar).toHaveAttribute('data-compact', '');
	await expect.poll(cellOffset).toBeCloseTo(oneRow, 0);
});
