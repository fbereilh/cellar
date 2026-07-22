import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * E2E for Search P5 (find-in-page final): Ctrl/Cmd+F INTERCEPT, the regex toggle,
 * and print-safety under virtualization. Against the REAL app:
 *  - Ctrl/Cmd+F opens cellar's find-bar and `preventDefault`s the browser's own
 *    find (asserted via the keydown's `defaultPrevented`);
 *  - Ctrl+F seeds the query from the current text selection;
 *  - Ctrl+F while ALREADY open re-focuses + re-seeds (does not close);
 *  - Escape closes;
 *  - the regex toggle: a regex query matches (metachars active), a literal query
 *    matches (metachars inert) with it off, and an invalid regex fails safe (no
 *    crash, a visible invalid state, zero matches);
 *  - with virtualization ON, a `beforeprint` mounts every cell (so print/PDF
 *    captures the whole notebook), and `afterprint` restores windowing.
 *
 * SKIPS when the kernel runtime is absent (local-only, like the rest of the suite).
 */

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

function id(i: number): string {
	const h = ((i * 2654435761) >>> 0).toString(16).padStart(8, '0');
	return `${h}-0000-4000-8000-${String(i).padStart(12, '0')}`;
}
function codeCell(i: number, source: string) {
	return { cell_type: 'code', id: id(i), metadata: { cellar: { visible: true } }, execution_count: null, outputs: [], source };
}

// Far enough down that the last cell is windowed out under virtualization.
const N = 200;
const IDX = { regexA: 1, regexB: 2, literalDot: 3, litAxb: 4, bottom: N - 1 };

/**
 * Seed notebook:
 *  - `df1`/`df2`  → regex `df\d` finds 2, literal `df\d` finds 0.
 *  - `a.b`/`axb`  → literal `a.b` finds 1, regex `a.b` finds 2.
 *  - a `zzmark` far at the bottom (print/virtualization target).
 */
function buildNotebook(): string {
	const cells: unknown[] = [];
	cells.push(codeCell(0, '# find ctrl-f p5'));
	cells.push(codeCell(IDX.regexA, 'df1 = 1'));
	cells.push(codeCell(IDX.regexB, 'df2 = 2'));
	cells.push(codeCell(IDX.literalDot, "s = 'a.b literal'"));
	cells.push(codeCell(IDX.litAxb, "t = 'axb regex'"));
	for (let i = 5; i < IDX.bottom; i++) cells.push(codeCell(i, `g${i} = ${i}`));
	cells.push(codeCell(IDX.bottom, "footer = 'zzmark at bottom'"));
	return JSON.stringify({ cells, metadata: { kernelspec: { name: 'python3', display_name: 'python3' } }, nbformat: 4, nbformat_minor: 5 });
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-e2e-ctrlf-'));
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
	const openBtn = page.getByTestId('empty-open-notebook');
	if (await openBtn.isVisible().catch(() => false)) await openBtn.click();
	await expect(page.getByTestId('cell').first()).toBeVisible({ timeout: 30_000 });
	await page.getByTestId('notebook-root').click(); // focus a notebook
}

/** Press Ctrl/Cmd+F and report whether the browser's native find was suppressed. */
async function pressCtrlF(page: Page): Promise<boolean> {
	await page.evaluate(() => {
		(window as unknown as { __cf?: boolean }).__cf = false;
		// A SECOND capture-phase listener on window. The app's interceptor registers
		// first (onMount) and calls preventDefault + stopPropagation; stopPropagation
		// (unlike stopImmediatePropagation) does NOT skip later listeners on the same
		// target/phase, so this fires afterwards and observes `defaultPrevented`.
		window.addEventListener(
			'keydown',
			(e) => {
				if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f')
					(window as unknown as { __cf?: boolean }).__cf = e.defaultPrevented;
			},
			true
		);
	});
	await page.keyboard.press('ControlOrMeta+f');
	await page.waitForTimeout(30);
	return page.evaluate(() => (window as unknown as { __cf?: boolean }).__cf === true);
}

test('Ctrl/Cmd+F opens the cellar find-bar and prevents the browser native find', async ({ page }) => {
	await open(page);
	const prevented = await pressCtrlF(page);
	await expect(findBar(page)).toBeVisible();
	await expect(findInput(page)).toBeFocused();
	expect(prevented).toBe(true);
});

test('Ctrl+F seeds the query from the current text selection', async ({ page }) => {
	await open(page);
	await page.evaluate(() => {
		const el = document.querySelector('[data-testid="notebook-root"] .cm-content, [data-testid="notebook-root"] .cm-static-content');
		if (el) {
			const range = document.createRange();
			range.selectNodeContents(el);
			const sel = window.getSelection();
			sel?.removeAllRanges();
			sel?.addRange(range);
		}
	});
	await page.keyboard.press('ControlOrMeta+f');
	await expect(findBar(page)).toBeVisible();
	await expect(findInput(page)).not.toHaveValue('');
});

test('Ctrl+F while the bar is already open re-focuses/re-seeds, does not close', async ({ page }) => {
	await open(page);
	await page.keyboard.press('ControlOrMeta+f');
	await expect(findBar(page)).toBeVisible();
	await findInput(page).fill('df1');
	await expect(findCount(page)).toHaveText('1/1');

	// Move focus off the input, then press Ctrl+F again: the bar stays open and
	// focus returns to the input (a repeat native-find press). Wait for the click's
	// async focus-follows-selection to settle (the input loses focus) before the
	// repeat press - otherwise, in a large notebook where the click lands on a cell,
	// that pending cell-focus races the reseed refocus (a test-only timing artifact,
	// not something a real user hits between a click and a keystroke).
	await page.getByTestId('notebook-root').click();
	await expect(findInput(page)).not.toBeFocused();
	await page.keyboard.press('ControlOrMeta+f');
	await expect(findBar(page)).toBeVisible(); // NOT closed
	await expect(findInput(page)).toBeFocused();

	await page.keyboard.press('Escape');
	await expect(findBar(page)).toBeHidden();
});

test('the regex toggle: metachars active on, literal off, invalid fails safe', async ({ page }) => {
	await open(page);
	await page.keyboard.press('ControlOrMeta+f');
	await expect(findBar(page)).toBeVisible();

	// Literal (regex OFF): `a.b` matches only the literal "a.b", not "axb".
	await findInput(page).fill('a.b');
	await expect(findCount(page)).toHaveText('1/1');

	// Regex ON: `.` is any char → matches both "a.b" and "axb".
	await page.getByTestId('find-regex').click();
	await expect(findCount(page)).toHaveText('1/2');

	// A real regex: `df\d` → df1 and df2.
	await findInput(page).fill('df\\d');
	await expect(findCount(page)).toHaveText('1/2');

	// Invalid regex: no crash, a visible invalid state, zero matches.
	await findInput(page).fill('(');
	await expect(page.getByTestId('find-invalid')).toBeVisible();
	await expect(findBar(page)).toBeVisible(); // still alive

	// Fixing the pattern recovers.
	await findInput(page).fill('df\\d');
	await expect(page.getByTestId('find-invalid')).toBeHidden();
	await expect(findCount(page)).toHaveText('1/2');

	// Toggling regex OFF makes `df\d` a literal string → 0 matches (safe, no crash).
	await page.getByTestId('find-regex').click();
	await expect(findCount(page)).toHaveText('0/0');
});

test('with virtualization on, beforeprint mounts every cell and afterprint restores windowing', async ({ page }) => {
	await open(page, /* virtualize */ true);
	const bottom = page.locator(`[data-cell-id="${id(IDX.bottom)}"]`);
	// Far off-screen → a spacer, not a mounted node.
	await expect(bottom).toHaveCount(0);

	await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
	await expect(bottom).toHaveCount(1); // every cell mounted for print

	await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
	await expect(bottom).toHaveCount(0); // windowing restored
});
