import { test, expect, type Page, type Locator } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * E2E for the P1 sidebar Search rewire (real match engine + per-cell cache).
 * Proves the END-USER experience: typing a query into the sidebar Search box
 * lists one row per matching cell in document order, shows a REAL total match
 * count ("N matches in M cells"), a per-cell count badge for cells with >1 hit,
 * and clicking a row scrolls that cell into view. Case-insensitive by default.
 *
 * Boots the REAL launcher against a throwaway workspace (see ./harness); SKIPS
 * when the kernel runtime is absent (local-only, like the other specs).
 */

const EVIDENCE_DIR =
	process.env.CELLAR_EVIDENCE_DIR ||
	'/var/folders/ds/m71hq5ln637g23x6xmrwqg080000gn/T/no-mistakes-evidence/01KY4HQ93BTZYXPS0ZS55RW3VZ';

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-e2e-search-'));
	const booted = await bootCellar(workspace);
	launcher = booted.proc;
	baseURL = booted.url;
	try {
		mkdirSync(EVIDENCE_DIR, { recursive: true });
	} catch {
		/* best effort */
	}
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

async function openNotebook(page: Page): Promise<void> {
	const openBtn = page.getByTestId('empty-open-notebook');
	if (await openBtn.isVisible().catch(() => false)) await openBtn.click();
	await expect(page.getByTestId('cell').first()).toBeVisible();
}

async function typeInto(page: Page, cell: Locator, text: string): Promise<void> {
	await cell.getByTestId('editor-scroll').click();
	const editor = cell.locator('.cm-content');
	await expect(editor).toBeVisible();
	await editor.click();
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.type(text);
	await expect(editor).toContainText(text.split('\n')[0]);
	// Blur to flush the debounced edit up to the notebook model the sidebar reads.
	await page.keyboard.press('Escape');
}

test('sidebar Search: real total count, per-cell rows in doc order, count badge, click-to-cell', async ({ page }) => {
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);

	const cells = page.getByTestId('cell');

	// Build three cells with a known distribution of the needle "pandas":
	//   cell 0: one occurrence (mixed case, to prove case-insensitivity)
	//   cell 1: no occurrence
	//   cell 2: two occurrences (to prove EVERY match is counted, not one-per-cell)
	await typeInto(page, cells.nth(0), 'import Pandas as pd');
	await page.getByTestId('add-cell').click();
	await expect(cells).toHaveCount(2);
	await typeInto(page, cells.nth(1), 'x = 1 + 2');
	await page.getByTestId('add-cell').click();
	await expect(cells).toHaveCount(3);
	await typeInto(page, cells.nth(2), 'df = pandas.DataFrame()\ndf2 = pandas.concat([df])');

	// Open the Search sidebar section (it may start collapsed).
	const searchHeader = page.getByTestId('section-search');
	await searchHeader.scrollIntoViewIfNeeded();
	const searchInput = page.getByTestId('search-input');
	if (!(await searchInput.isVisible().catch(() => false))) {
		await searchHeader.click();
	}
	await expect(searchInput).toBeVisible();

	// Type the query (lowercase) — should match the mixed-case "Pandas" too.
	await searchInput.click();
	await searchInput.fill('pandas');

	// Total match count: 3 hits (1 in cell 0 + 2 in cell 2) across 2 cells.
	const count = page.getByTestId('search-count');
	await expect(count).toHaveText('3 matches in 2 cells', { timeout: 5_000 });

	// One row per matching cell, in document order (cell 0 then cell 2).
	const results = page.getByTestId('search-result');
	await expect(results).toHaveCount(2);
	await expect(results.nth(0)).toContainText('import Pandas as pd');
	await expect(results.nth(1)).toContainText('df = pandas.DataFrame()');

	// The multi-match cell shows a per-cell count badge of 2; the single-match cell shows none.
	await expect(results.nth(1).getByTestId('search-result-count')).toHaveText('2');
	await expect(results.nth(0).getByTestId('search-result-count')).toHaveCount(0);

	// Evidence screenshot of the populated search panel.
	await page.screenshot({ path: join(EVIDENCE_DIR, 'sidebar-search-results.png'), fullPage: false });

	// Clicking the second result scrolls its cell into view (navigation preserved).
	await results.nth(1).click();
	await expect(cells.nth(2)).toBeInViewport({ timeout: 5_000 });

	// Singular grammar + narrowing: a query that hits exactly one cell once.
	await searchInput.fill('DataFrame');
	await expect(count).toHaveText('1 match in 1 cell', { timeout: 5_000 });
	await expect(page.getByTestId('search-result')).toHaveCount(1);

	// Clearing the query removes the count + results instantly.
	await searchInput.fill('');
	await expect(count).toHaveCount(0);
	await expect(page.getByTestId('search-result')).toHaveCount(0);
});
