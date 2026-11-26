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
 *  - Scrolled past, the same toolbar stays pinned at the top of the pane with its
 *    labelled buttons, edge to edge with the cells, and a click there acts.
 *  - Scrolling back and forth across the pin point never moves a cell or the
 *    scroll position, and the bar settles in the right state.
 *  - A toolbar wrapped onto two rows keeps its size when pinned, and the pane's
 *    scroll padding clears it.
 *  - The find bar sits in a band below the toolbar, pinned or not, covering no
 *    toolbar button and no cell, and a match lands below it.
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
	await expect(bar).toHaveAttribute('data-pinned', '');
	for (let i = 0; i < 120; i++) await page.keyboard.press('ArrowUp');
	await expect(bar).toHaveAttribute('data-pinned', '');
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

/** Left and right edges of an element, in viewport px. */
function edges(el: Element): [number, number] {
	const r = el.getBoundingClientRect();
	return [Math.round(r.left), Math.round(r.right)];
}

test('scrolled past, the toolbar stays on screen with its labels and still acts', async ({ page }) => {
	rmSync(join(workspace, 'mod_long.py'), { force: true });
	await openNotebook(page, NB.long);
	const pane = paneFor(page, NB.long);
	const bar = pane.getByTestId('notebook-toolbar');
	const cell = pane.getByTestId('cell').first();
	await expect(bar).not.toHaveAttribute('data-pinned');
	// Edge to edge with the cells, pinned or not.
	expect(await bar.evaluate(edges)).toEqual(await cell.evaluate(edges));

	await pane.evaluate((el) => (el.scrollTop = el.scrollHeight));
	await expect(bar).toHaveAttribute('data-pinned', '');
	const [paneTop, barTop] = await Promise.all([
		pane.evaluate((el) => el.getBoundingClientRect().top),
		bar.evaluate((el) => el.getBoundingClientRect().top)
	]);
	expect(Math.abs(barTop - paneTop)).toBeLessThanOrEqual(1);
	expect(await bar.evaluate(edges)).toEqual(await pane.getByTestId('cell').last().evaluate(edges));
	// The pinned bar keeps every label.
	await expect(pane.getByTestId('run-all')).toContainText('Run all');
	await expect(pane.getByTestId('toolbar-export')).toContainText('Export');
	await expect(pane.getByTestId('toolbar-export')).toHaveAttribute('aria-label', 'Export to mod_long.py');

	await pane.getByTestId('toolbar-export').click();
	await expect(page.getByTestId('app-notice')).toContainText('Exported 1 cell', { timeout: 30_000 });
	expect(existsSync(join(workspace, 'mod_long.py'))).toBe(true);

	await pane.evaluate((el) => (el.scrollTop = 0));
	await expect(bar).not.toHaveAttribute('data-pinned');
});

test('scrolling back and forth across the pin point moves no cell and no scroll', async ({ page }) => {
	await openNotebook(page, NB.long);
	const pane = paneFor(page, NB.long);
	const bar = pane.getByTestId('notebook-toolbar');
	await expect(bar).not.toHaveAttribute('data-pinned');
	// The bar's own offset in the pane: it pins once the pane scrolls past it.
	const pinAt = await pane.evaluate(
		(el) => el.querySelector('[data-testid="notebook-toolbar"]')!.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop
	);
	const cellOffset = () =>
		pane.evaluate(
			(el) => el.querySelector('[data-testid="cell"]')!.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop
		);
	const before = await cellOffset();
	const barHeight = await bar.evaluate((el) => el.getBoundingClientRect().height);
	for (const delta of [-2, 2, -1, 3, -3, 1, 6, -6, 2]) {
		const target = Math.max(0, Math.round(pinAt + delta));
		await pane.evaluate((el, top) => (el.scrollTop = top), target);
		if (target > pinAt) await expect(bar).toHaveAttribute('data-pinned', '');
		else await expect(bar).not.toHaveAttribute('data-pinned');
		// Settled: the state holds, the pane stayed where it was put, no cell moved.
		await page.waitForTimeout(150);
		expect(await pane.evaluate((el) => el.scrollTop), `scroll jumped at ${target}`).toBe(target);
		expect(await cellOffset()).toBeCloseTo(before, 0);
		expect(await bar.evaluate((el) => el.getBoundingClientRect().height)).toBeCloseTo(barHeight, 0);
	}
});

test('a wrapped toolbar keeps its size when pinned and the pane clears it', async ({ page }) => {
	await page.setViewportSize({ width: 640, height: 720 });
	await openNotebook(page, NB.long);
	const pane = paneFor(page, NB.long);
	const bar = pane.getByTestId('notebook-toolbar');
	const barHeight = () => bar.evaluate((el) => el.getBoundingClientRect().height);
	const cellOffset = () =>
		pane.evaluate(
			(el) => el.querySelector('[data-testid="cell"]')!.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop
		);
	await expect(bar).not.toHaveAttribute('data-pinned');
	const fullHeight = await barHeight();
	expect(fullHeight, 'the toolbar did not wrap at this width').toBeGreaterThan(60);
	const before = await cellOffset();

	await pane.evaluate((el) => (el.scrollTop = 150));
	await expect(bar).toHaveAttribute('data-pinned', '');
	expect(await barHeight()).toBeCloseTo(fullHeight, 0);
	expect(await cellOffset()).toBeCloseTo(before, 0);
	// Scrolled-to cells land below the whole two-row bar.
	const padding = await pane.evaluate((el) => parseFloat(getComputedStyle(el).scrollPaddingTop));
	expect(padding).toBeGreaterThanOrEqual(fullHeight);
});

test('the find bar sits below the toolbar and covers no button or cell', async ({ page }) => {
	await openNotebook(page, NB.long);
	const pane = paneFor(page, NB.long);
	const bar = pane.getByTestId('notebook-toolbar');
	await pane.getByTestId('cell').first().click();
	await page.keyboard.press('ControlOrMeta+f');
	const find = page.getByTestId('find-bar');
	await expect(find).toBeVisible();
	await page.keyboard.type('print');
	await expect(find).toContainText('/');

	const rect = (el: Element) => {
		const r = el.getBoundingClientRect();
		return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
	};
	const check = async (state: string) => {
		const f = await find.evaluate(rect);
		const b = await bar.evaluate(rect);
		// Inside the toolbar's band, below every button.
		expect(f.top, `${state}: the find bar starts above the toolbar's bottom band`).toBeGreaterThanOrEqual(b.top);
		expect(f.bottom, `${state}: the find bar hangs below the toolbar`).toBeLessThanOrEqual(b.bottom);
		expect(f.right).toBeLessThanOrEqual(b.right + 1);
		for (const button of await bar.locator('button').all()) {
			if (!(await button.isVisible())) continue;
			const r = await button.evaluate(rect);
			expect(r.bottom <= f.top || r.top >= f.bottom || r.right <= f.left || r.left >= f.right, `${state}: covers a button`).toBe(true);
		}
		// No cell reaches up under the find bar unless the pinned bar already hides it.
		const firstCell = await pane.evaluate((el) => {
			const cells = [...el.querySelectorAll('[data-testid="cell"]')].map((c) => c.getBoundingClientRect());
			return cells.find((c) => c.bottom > el.getBoundingClientRect().top)?.top ?? Infinity;
		});
		if (state === 'unpinned') expect(firstCell).toBeGreaterThanOrEqual(f.bottom);
	};
	await expect(bar).not.toHaveAttribute('data-pinned');
	await check('unpinned');

	// Jump far down: the bar pins, and the active match lands below the find bar.
	for (let i = 0; i < 30; i++) await page.keyboard.press('Enter');
	await expect(bar).toHaveAttribute('data-pinned', '');
	await check('pinned');
	const findBottom = await find.evaluate((el) => el.getBoundingClientRect().bottom);
	// The active match is a CSS highlight range on a static cell, or a CodeMirror mark in a built editor.
	const activeTop = () =>
		page.evaluate(() => {
			const range = [...((CSS as any).highlights?.get('cellar-search-active') ?? [])][0] as Range | undefined;
			const el = document.querySelector('.cm-searchMatch-selected');
			return (range ?? el)?.getBoundingClientRect().top ?? -1;
		});
	await expect.poll(activeTop).toBeGreaterThanOrEqual(findBottom);
});
