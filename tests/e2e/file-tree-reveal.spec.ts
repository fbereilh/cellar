/**
 * Clicking a tab REVEALS its file in the Files sidebar (VS Code's
 * `explorer.autoReveal`): every ancestor folder opens, the row is selected and
 * scrolled into view - and the person's "Reveal the active file in the file
 * tree" setting turns it off, in which case a tab click changes nothing in the
 * tree.
 *
 * The rules (ancestor chain, the expansion set) are pinned in
 * `tests/unit/tree-expansion.test.ts`; this pins the WIRING, which is where the
 * feature can die silently: a tab click that never reaches the sidebar, a
 * reveal that selects but opens no folder, or a setting the sidebar never reads.
 *
 * Every test starts from a RELOAD, because folder expansion is not persisted:
 * a reload is the one way to get a tree whose every folder is collapsed, which
 * is the case the task is about - a nested file none of whose ancestors is open.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { bootCellar, killCellar, runtimeAvailable, openSidebarSection, removeWorkspace } from './harness';

const REASON = 'requires the kernel runtime (uv + python3 + ~/.cellar/host-venv)';
const DEEP = 'zz/y/x/deep.md';
const ROOT_FILE = 'root.md';
const KEY = 'cellar-tree-auto-reveal';

test.describe(runtimeAvailable() ? 'file tree: reveal the active tab' : `file tree reveal (skipped: ${REASON})`, () => {
	test.skip(!runtimeAvailable(), REASON);

	let ws: string;
	let proc: ChildProcess;
	let url: string;

	test.beforeAll(async () => {
		ws = mkdtempSync(join(tmpdir(), 'cellar-tree-reveal-'));
		// Sixty folders ahead of `zz` push the revealed row well below the fold, so
		// "scrolled into view" is a real assertion rather than a row that was
		// already on screen.
		for (let i = 0; i < 60; i++) mkdirSync(join(ws, `d${String(i).padStart(2, '0')}`));
		mkdirSync(join(ws, 'zz/y/x'), { recursive: true });
		writeFileSync(join(ws, DEEP), '# deep\n');
		writeFileSync(join(ws, ROOT_FILE), '# root\n');
		mkdirSync(join(ws, 'ren/inner'), { recursive: true });
		writeFileSync(join(ws, 'ren/inner/f.md'), '# f\n');
		({ proc, url } = await bootCellar(ws));
	});
	test.afterAll(() => {
		if (proc) killCellar(proc);
		removeWorkspace(ws);
	});

	const fileRow = (page: Page, path: string) => page.locator(`[data-testid=tree-file][data-path="${path}"]`);
	const dirRow = (page: Page, path: string) => page.locator(`[data-testid=tree-dir][data-path="${path}"]`);
	const tab = (page: Page, path: string) => page.locator(`[data-testid=tab][data-tab-id="file:${path}"]`);

	async function setReveal(page: Page, on: boolean): Promise<void> {
		// The server store, not the UI: this is setup, and the test that pins the
		// Settings toggle drives the toggle itself.
		const res = await page.request.put(`${url}/api/user-settings`, { data: { [KEY]: on ? null : false } });
		expect(res.ok()).toBe(true);
	}

	/** The sidebar's scroll container - the element a reveal has to move. */
	async function scrollTreeToTop(page: Page): Promise<void> {
		await page.getByTestId('files-body').evaluate((el) => {
			let n: HTMLElement | null = el;
			while (n && !(n.scrollHeight > n.clientHeight && getComputedStyle(n).overflowY !== 'visible')) n = n.parentElement;
			if (n) n.scrollTop = 0;
		});
	}

	/**
	 * Two pinned tabs - the nested file and a root-level one - then a RELOAD with
	 * the root-level tab active, so the test begins with every folder collapsed
	 * and the nested file's tab in the strip but not active.
	 */
	async function setup(page: Page, revealOn: boolean): Promise<void> {
		await page.goto(url);
		await openSidebarSection(page, 'files', 'files-body');
		for (const d of ['zz', 'zz/y', 'zz/y/x']) {
			const row = dirRow(page, d);
			if ((await row.getAttribute('aria-expanded')) !== 'true') await row.click();
		}
		await fileRow(page, DEEP).dblclick();
		await expect(tab(page, DEEP)).toBeVisible();
		await fileRow(page, ROOT_FILE).dblclick();
		await expect(tab(page, ROOT_FILE)).toHaveAttribute('aria-selected', 'true');
		// The tab session is a debounced `.cellar/` write: wait until the SERVER
		// holds it with root.md active, or the reload restores an older strip.
		await expect
			.poll(async () => {
				const state = await (await page.request.get(`${url}/api/ui-state`)).json();
				const saved = Object.entries(state).find(([k]) => k.startsWith('cellar-tabs:'))?.[1] as
					| { activeTabId?: string; tabs?: { path: string }[] }
					| undefined;
				return [saved?.activeTabId ?? null, (saved?.tabs ?? []).map((t) => t.path).sort().join(',')];
			})
			.toEqual([`file:${ROOT_FILE}`, [DEEP, ROOT_FILE].sort().join(',')]);

		await page.reload();
		await openSidebarSection(page, 'files', 'files-body');
		await expect(tab(page, ROOT_FILE)).toHaveAttribute('aria-selected', 'true');
		await expect(dirRow(page, 'zz')).toHaveAttribute('aria-expanded', 'false');
		await expect(fileRow(page, DEEP)).toHaveCount(0);
		// The restored active tab is revealed too (it is the active tab changing);
		// let that scroll land before resetting it, or it lands afterwards.
		if (revealOn) await expect(fileRow(page, ROOT_FILE)).toHaveAttribute('data-selected', 'true');
		await page.waitForTimeout(100);
		await scrollTreeToTop(page);
		await expect(dirRow(page, 'zz')).not.toBeInViewport();
	}

	test('clicking a tab opens every collapsed ancestor, selects the file and scrolls it into view', async ({ page }) => {
		await setReveal(page, true);
		await setup(page, true);

		await tab(page, DEEP).click();

		for (const d of ['zz', 'zz/y', 'zz/y/x']) await expect(dirRow(page, d)).toHaveAttribute('aria-expanded', 'true');
		await expect(fileRow(page, DEEP)).toHaveAttribute('data-selected', 'true');
		await expect(fileRow(page, DEEP)).toBeInViewport();
		// The tab keeps focus: revealing is not a reason to take the keyboard away.
		await expect(page.locator('[data-testid=files-body] :focus')).toHaveCount(0);
	});

	test('clicking the ALREADY-active tab reveals again after the folders were collapsed', async ({ page }) => {
		await setReveal(page, true);
		await setup(page, true);
		await tab(page, DEEP).click();
		await expect(fileRow(page, DEEP)).toBeVisible();

		// Collapse the outermost folder by hand - a deliberate browse.
		await dirRow(page, 'zz').click();
		await expect(fileRow(page, DEEP)).toHaveCount(0);

		// Another tree action that does not change the tab must not undo it.
		await dirRow(page, 'd00').click();
		await expect(dirRow(page, 'zz')).toHaveAttribute('aria-expanded', 'false');

		await tab(page, DEEP).click();
		await expect(fileRow(page, DEEP)).toBeVisible();
		await expect(fileRow(page, DEEP)).toHaveAttribute('data-selected', 'true');
	});

	test('with the setting off, clicking a tab changes nothing in the tree', async ({ page }) => {
		await setReveal(page, false);
		await setup(page, false);
		const scroller = page.getByTestId('files-body');
		const before = await scroller.evaluate((el) => document.querySelectorAll('[data-selected]').length);

		await tab(page, DEEP).click();
		await expect(tab(page, DEEP)).toHaveAttribute('aria-selected', 'true');

		// Give a reveal every chance to land before asserting it did not.
		await page.waitForTimeout(300);
		await expect(dirRow(page, 'zz')).toHaveAttribute('aria-expanded', 'false');
		await expect(fileRow(page, DEEP)).toHaveCount(0);
		await expect(dirRow(page, 'zz')).not.toBeInViewport();
		expect(await scroller.evaluate(() => document.querySelectorAll('[data-selected]').length)).toBe(before);
	});

	test('the Settings toggle defaults on, persists off, and switching back on stores nothing', async ({ page }) => {
		await setReveal(page, true);
		await page.goto(url);
		await page.getByTestId('app-menu').click();
		await page.getByTestId('open-settings').click();
		const toggle = page.getByTestId('settings-tree-auto-reveal');
		await expect(toggle).toBeChecked();

		await toggle.click();
		await expect(toggle).not.toBeChecked();
		await expect
			.poll(async () => (await (await page.request.get(`${url}/api/user-settings`)).json())[KEY])
			.toBe(false);

		// A reload reads it back.
		await page.reload();
		await page.getByTestId('app-menu').click();
		await page.getByTestId('open-settings').click();
		await expect(page.getByTestId('settings-tree-auto-reveal')).not.toBeChecked();

		await page.getByTestId('settings-tree-auto-reveal').click();
		await expect
			.poll(async () => KEY in (await (await page.request.get(`${url}/api/user-settings`)).json()))
			.toBe(false);
	});

	// ---- Expansion now lives in the sidebar: the tree's own gestures still work ----

	test('New File on a COLLAPSED folder force-opens it, and it stays open once the file exists', async ({ page }) => {
		await page.goto(url);
		await openSidebarSection(page, 'files', 'files-body');
		const folder = dirRow(page, 'd05');
		await expect(folder).toHaveAttribute('aria-expanded', 'false');

		await folder.click({ button: 'right' });
		await page.getByTestId('ctx-new-file').click();
		await expect(folder).toHaveAttribute('aria-expanded', 'true');
		await page.getByTestId('tree-entry-field').fill('made.md');
		await page.getByTestId('tree-entry-field').press('Enter');

		await expect(fileRow(page, 'd05/made.md')).toBeVisible();
		await expect(folder).toHaveAttribute('aria-expanded', 'true');
		// And a plain click still collapses it.
		await folder.click();
		await expect(fileRow(page, 'd05/made.md')).toHaveCount(0);
	});

	test('renaming an OPEN folder keeps it and its open subfolder open under the new name', async ({ page }) => {
		await page.goto(url);
		await openSidebarSection(page, 'files', 'files-body');
		await dirRow(page, 'ren').click();
		await dirRow(page, 'ren/inner').click();
		await expect(fileRow(page, 'ren/inner/f.md')).toBeVisible();

		await dirRow(page, 'ren').click({ button: 'right' });
		await page.getByTestId('ctx-rename').click();
		await page.getByTestId('tree-entry-field').fill('renamed');
		await page.getByTestId('tree-entry-field').press('Enter');

		await expect(dirRow(page, 'renamed')).toHaveAttribute('aria-expanded', 'true');
		await expect(dirRow(page, 'renamed/inner')).toHaveAttribute('aria-expanded', 'true');
		await expect(fileRow(page, 'renamed/inner/f.md')).toBeVisible();
	});
});
