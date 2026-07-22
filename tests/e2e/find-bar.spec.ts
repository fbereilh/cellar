import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * E2E for the floating find-in-page bar (Search P3).
 *
 * Proves the find-in-page UX the phase promises, against the REAL app:
 *  - a non-Ctrl entry point (the `open-find` shortcut / sidebar button) opens the
 *    bar (Ctrl+F is deliberately NOT hijacked until P5);
 *  - a live `i / N` match count over the shared search engine;
 *  - Enter / Shift+Enter and F3 / Shift+F3 step through matches in DOCUMENT order,
 *    with wrap-around;
 *  - Escape closes and returns focus to the notebook;
 *  - opening seeds the query from the current text selection;
 *  - a match in a FOLDED section unfolds and scrolls to it;
 *  - WITH virtualization on, a match in a windowed-OUT (unmounted) cell still
 *    navigates - `jumpToCell` mounts it first, then scrolls;
 *  - the case (`Aa`) and whole-word (`\b`) toggles change the result set.
 *
 * Boots the real launcher against a throwaway workspace seeded with a controlled
 * notebook (so match counts + positions are exact); SKIPS when the kernel runtime
 * is absent (local-only, like the rest of the E2E suite). The search ENGINE has a
 * full vitest unit suite (`tests/unit/search.test.ts`); this covers the UI wiring
 * the engine can't.
 */

// A token that appears NOWHERE else in the notebook shell, so counts are exact.
const TOKEN = 'qqzzx';
const N = 200; // large enough that the bottom match is windowed out under virtualization

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

/** Deterministic UUID-shaped id from an index (no randomness → reproducible file). */
function id(i: number): string {
	const h = ((i * 2654435761) >>> 0).toString(16).padStart(8, '0');
	return `${h}-0000-4000-8000-${String(i).padStart(12, '0')}`;
}
function codeCell(i: number, source: string) {
	return { cell_type: 'code', id: id(i), metadata: { cellar: { visible: true } }, execution_count: null, outputs: [], source };
}
function mdCell(i: number, source: string) {
	return { cell_type: 'markdown', id: id(i), metadata: { cellar: { visible: true } }, source };
}

// Fixed indices of the interesting cells (see the layout below).
const IDX = {
	matchSource: 1, // `alpha = 1  # qqzzx`
	matchHeading: 2, // `## qqzzx heading`
	foldHeading: 9, // `## Hidden Group`   (fold target, no token)
	matchHidden: 10, // `secret = 'qqzzx in hidden'`   (inside the fold section)
	matchBottom: N - 3, // `omega = 'qqzzx at bottom'`  (windowing target, far down)
	matchUpper: N - 2, // `upper = 'QQZZX upper'`      (case toggle)
	matchWord: N - 1 // `word = 'qqzzxword'`         (whole-word toggle)
};

/** Build the seed notebook: 6 visible matches, one behind a foldable heading. */
function buildNotebook(): string {
	const cells: unknown[] = [];
	cells.push(mdCell(0, '# Find Bar Test'));
	cells.push(codeCell(IDX.matchSource, `alpha = 1  # ${TOKEN}`)); // match 1 (source)
	cells.push(mdCell(IDX.matchHeading, `## ${TOKEN} heading`)); // match 2 (rendered+source → 1 visible)
	for (let i = 3; i <= 8; i++) cells.push(codeCell(i, `f${i} = ${i}`));
	cells.push(mdCell(IDX.foldHeading, '## Hidden Group')); // fold target (no token)
	cells.push(codeCell(IDX.matchHidden, `secret = '${TOKEN} in hidden'`)); // match 3 (inside fold)
	for (let i = 11; i < IDX.matchBottom; i++) cells.push(codeCell(i, `g${i} = ${i}`));
	cells.push(codeCell(IDX.matchBottom, `omega = '${TOKEN} at bottom'`)); // match 4 (windowing)
	cells.push(codeCell(IDX.matchUpper, `upper = '${TOKEN.toUpperCase()} upper'`)); // match 5 (case)
	cells.push(codeCell(IDX.matchWord, `word = '${TOKEN}word'`)); // match 6 (whole word)
	return JSON.stringify({ cells, metadata: { kernelspec: { name: 'python3', display_name: 'python3' } }, nbformat: 4, nbformat_minor: 5 });
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-e2e-findbar-'));
	writeFileSync(join(workspace, 'notebook.ipynb'), buildNotebook());
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

const findBar = (page: Page) => page.getByTestId('find-bar');
const findInput = (page: Page) => page.getByTestId('find-input');
const findCount = (page: Page) => page.getByTestId('find-count');

async function open(page: Page, virtualize = false): Promise<void> {
	const q = `?ws=${encodeURIComponent(workspace)}${virtualize ? '&virtualize=1' : ''}`;
	await page.goto(`${baseURL}/${q}`);
	// A fresh tab-session starts in the empty state; open the seeded notebook.
	const openBtn = page.getByTestId('empty-open-notebook');
	if (await openBtn.isVisible().catch(() => false)) await openBtn.click();
	await expect(page.getByTestId('cell').first()).toBeVisible({ timeout: 30_000 });
}

/** Open the find bar via the app shortcut (Cmd/Ctrl+Shift+F). */
async function openFindBar(page: Page): Promise<void> {
	await page.getByTestId('notebook-root').click(); // ensure a notebook is focused
	await page.keyboard.press('ControlOrMeta+Shift+F');
	await expect(findBar(page)).toBeVisible();
}

test('opens from the sidebar Search button (non-Ctrl entry point)', async ({ page }) => {
	await open(page);
	// The button lives in the Search section body, which is collapsed by default.
	await page.getByTestId('section-search').click();
	await page.getByTestId('open-find-bar').click();
	await expect(findBar(page)).toBeVisible();
	await expect(findInput(page)).toBeFocused();
});

test('live count + Enter/Shift+Enter/F3 step through matches in document order, with wrap', async ({ page }) => {
	await open(page);
	await openFindBar(page);
	await findInput(page).fill(TOKEN);

	// 6 visible matches (the markdown heading's source+rendered pair dedupes to 1).
	await expect(findCount(page)).toHaveText('1/6');

	await page.keyboard.press('Enter'); // → next
	await expect(findCount(page)).toHaveText('2/6');
	await page.keyboard.press('Enter');
	await expect(findCount(page)).toHaveText('3/6');
	await page.keyboard.press('Shift+Enter'); // → prev
	await expect(findCount(page)).toHaveText('2/6');

	await page.keyboard.press('F3'); // → next
	await expect(findCount(page)).toHaveText('3/6');
	await page.keyboard.press('Shift+F3'); // → prev
	await expect(findCount(page)).toHaveText('2/6');

	// Wrap: from 1/6 backwards lands on the last.
	await page.keyboard.press('Shift+Enter');
	await expect(findCount(page)).toHaveText('1/6');
	await page.keyboard.press('Shift+Enter');
	await expect(findCount(page)).toHaveText('6/6');
	await page.keyboard.press('Enter');
	await expect(findCount(page)).toHaveText('1/6');
});

test('Escape closes the bar and returns focus to the notebook', async ({ page }) => {
	await open(page);
	await openFindBar(page);
	await findInput(page).fill(TOKEN);
	await expect(findCount(page)).toHaveText('1/6');

	await page.keyboard.press('Escape');
	await expect(findBar(page)).toBeHidden();
	// Focus returned to the notebook root (so command-mode keys work again).
	await expect(page.getByTestId('notebook-root')).toBeFocused();
});

test('opening seeds the query from the current text selection', async ({ page }) => {
	await open(page);
	// Select the rendered title text "Find Bar Test".
	await page.evaluate(() => {
		const el = document.querySelector('[data-testid="notebook-root"] h1');
		if (el) {
			const range = document.createRange();
			range.selectNodeContents(el);
			const sel = window.getSelection();
			sel?.removeAllRanges();
			sel?.addRange(range);
		}
	});
	await page.keyboard.press('ControlOrMeta+Shift+F');
	await expect(findBar(page)).toBeVisible();
	await expect(findInput(page)).toHaveValue(/Find Bar Test/);
});

test('a match inside a folded section unfolds and scrolls to it', async ({ page }) => {
	await open(page);

	// Fold the "Hidden Group" heading; its section swallows the cells below it,
	// so the hidden-token cell drops out of the layout.
	const hiddenCell = page.locator(`[data-cell-id="${id(IDX.matchHidden)}"]`);
	const foldToggle = page.locator(`[data-cell-id="${id(IDX.foldHeading)}"]`).getByTestId('fold-toggle').first();
	await foldToggle.scrollIntoViewIfNeeded();
	await foldToggle.click();
	await expect(hiddenCell).toBeHidden();

	await openFindBar(page);
	await findInput(page).fill(TOKEN);
	await expect(findCount(page)).toHaveText('1/6');
	// The hidden-token cell is match #3 in document order.
	await page.keyboard.press('Enter');
	await page.keyboard.press('Enter');
	await expect(findCount(page)).toHaveText('3/6');
	// Jumping revealed (unfolded) the section and scrolled the cell into view.
	await expect(hiddenCell).toBeVisible();
});

test('with virtualization on, a windowed-out match still navigates (mount then scroll)', async ({ page }) => {
	await open(page, /* virtualize */ true);

	// The bottom match is far off-screen, so under windowing it is a spacer, not a
	// mounted node.
	const bottom = page.locator(`[data-cell-id="${id(IDX.matchBottom)}"]`);
	await expect(bottom).toHaveCount(0);

	await openFindBar(page);
	await findInput(page).fill(TOKEN);
	await expect(findCount(page)).toHaveText('1/6');
	// Match #4 is the bottom cell; step to it.
	for (let i = 0; i < 3; i++) await page.keyboard.press('Enter');
	await expect(findCount(page)).toHaveText('4/6');

	// jumpToCell mounted the windowed-out cell and scrolled it into view.
	await expect(bottom).toHaveCount(1);
	await expect(bottom).toBeVisible();
});

test('case and whole-word toggles change the result set', async ({ page }) => {
	await open(page);
	await openFindBar(page);
	await findInput(page).fill(TOKEN);
	await expect(findCount(page)).toHaveText('1/6');

	// Case-sensitive drops the `QQZZX` (uppercase) cell → 5.
	await page.getByTestId('find-case').click();
	await expect(findCount(page)).toHaveText('1/5');
	await page.getByTestId('find-case').click(); // back to 6
	await expect(findCount(page)).toHaveText('1/6');

	// Whole-word drops the `qqzzxword` (trailing "word") cell → 5.
	await page.getByTestId('find-word').click();
	await expect(findCount(page)).toHaveText('1/5');
});
