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
 *  - Export with a target runs the menu's export and says so on the notice line.
 *  - Export with no target writes nothing: it opens the language-and-export menu
 *    with the cursor in the target field.
 *  - Restart sends the existing kernel restart for THIS notebook.
 *  - Scrolled past, the same toolbar stays pinned at the top of the pane as icons,
 *    and a click there runs the same action. Scrolled back, it returns to full form.
 *
 * Every locator is scoped to one notebook's pane: each open notebook stays mounted.
 */

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

const NB = { target: 'target.ipynb', bare: 'bare.ipynb', long: 'long.ipynb' } as const;

function notebook(cellCount: number, target: string | null): string {
	const cells = Array.from({ length: cellCount }, (_, i) => ({
		cell_type: 'code',
		id: `c${i}`,
		metadata: i === 0 ? { cellar: { export: true } } : {},
		execution_count: null,
		outputs: [],
		source: [i === 0 ? 'def add(a, b):\n    return a + b' : `# cell ${i}\nx${i} = ${i}\nprint(x${i})`]
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
	// The menu stays closed: the click exported, it did not open settings.
	await expect(page.locator('[data-testid="notebook-settings-menu"]:popover-open')).toHaveCount(0);
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
