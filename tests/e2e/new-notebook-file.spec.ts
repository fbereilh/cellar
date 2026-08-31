/**
 * Creating a new `.ipynb` from the file explorer produces a notebook that OPENS.
 *
 * The reported bug, reproduced exactly by the first test below: "New file" ->
 * `analysis.ipynb` wrote a ZERO-BYTE file, and opening it rendered
 * `Could not open analysis.ipynb: Unexpected end of JSON input`. The empty-state
 * "New notebook" button went through a different writer and worked, which is why
 * the failure looked route-specific.
 *
 * This is the END-USER path, so it is the one that has to be pinned: the unit
 * suite covers the writer and the reader directly, but only a real browser
 * against the real launcher shows the two ends meeting - the explorer's click
 * really reaching the route, and the tab really rendering a notebook rather than
 * a load error.
 *
 * The second test covers the other half of the fix: a blank `.ipynb` that Cellar
 * did NOT write (a `touch`, a rename or a copy of an empty file, or one an older
 * Cellar left behind) opens as a blank notebook instead of dead-ending, with no
 * bytes written until the user actually edits it.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { bootCellar, killCellar, runtimeAvailable, openSidebarSection } from './harness';

const REASON = 'requires the kernel runtime (uv + python3 + ~/.cellar/host-venv)';

test.describe(runtimeAvailable() ? 'new .ipynb from the file explorer' : `new .ipynb (skipped: ${REASON})`, () => {
	test.skip(!runtimeAvailable(), REASON);

	let ws: string;
	let proc: ChildProcess;
	let url: string;

	test.beforeAll(async () => {
		ws = mkdtempSync(join(tmpdir(), 'cellar-new-ipynb-'));
		({ proc, url } = await bootCellar(ws));
	});
	test.afterAll(() => proc && killCellar(proc));

	/** Create a file through the explorer's "New file" control, exactly as a user does. */
	async function newFile(page: Page, name: string): Promise<void> {
		await openSidebarSection(page, 'files', 'files-body');
		await page.getByTestId('files-new-file').click();
		const field = page.getByTestId('tree-entry-field');
		await expect(field).toBeVisible();
		await field.fill(name);
		await field.press('Enter');
		await expect(page.getByTestId('tree-file').filter({ hasText: name })).toBeVisible();
	}

	/** Open a workspace file from the tree into a permanent tab (double-click). */
	async function openFromTree(page: Page, name: string): Promise<void> {
		await page.getByTestId('tree-file').filter({ hasText: name }).dblclick();
	}

	/**
	 * The VISIBLE notebook pane. Every opened notebook stays mounted (hidden) so its
	 * editor/run state survives a tab switch, so an unscoped `getByTestId('cell')`
	 * counts the cells of every tab this workspace has ever opened.
	 */
	function pane(page: Page) {
		return page.locator('[role=tabpanel]:not(.hidden)');
	}

	test('creates a notebook that opens and runs', async ({ page }) => {
		await page.goto(url);
		await newFile(page, 'analysis.ipynb');

		// On disk: a real notebook, not the zero bytes this bug was about.
		const abs = join(ws, 'analysis.ipynb');
		expect(statSync(abs).size).toBeGreaterThan(0);
		const raw = JSON.parse(readFileSync(abs, 'utf8'));
		expect(raw.nbformat).toBe(4);
		expect(raw.cells).toHaveLength(1);

		await openFromTree(page, 'analysis.ipynb');
		// The regression assertion: no load error, and a real editable cell.
		const cells = pane(page).getByTestId('cell');
		await expect(cells).toHaveCount(1);
		await expect(page.getByTestId('notebook-load-error')).toHaveCount(0);

		// And it is a working notebook, not merely a rendered one: run a cell.
		await cells.first().click();
		await page.keyboard.type('6 * 7');
		await page.keyboard.press('Shift+Enter');
		await expect(cells.first()).toContainText('42', { timeout: 60_000 });
	});

	test('a blank .ipynb Cellar did not write still opens', async ({ page }) => {
		// The repair half: `touch blank.ipynb` (or a rename/copy of an empty file).
		const abs = join(ws, 'blank.ipynb');
		writeFileSync(abs, '');

		// A fresh load fetches the tree, so the file is listed with no refresh click.
		await page.goto(url);
		await openSidebarSection(page, 'files', 'files-body');
		await openFromTree(page, 'blank.ipynb');

		await expect(pane(page).getByTestId('cell')).toHaveCount(1);
		await expect(page.getByTestId('notebook-load-error')).toHaveCount(0);
		// Opening writes nothing - Cellar still leaves an unedited file exactly as it was.
		expect(statSync(abs).size).toBe(0);
	});
});
