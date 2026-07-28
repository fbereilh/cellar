import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess, spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar, REPO } from './harness';
import { setScrollTop } from './notebook-scroll';

/**
 * Cell virtualization P5 - windowing is ON BY DEFAULT, with a reliable opt-out.
 *
 * Everything else in the virtualization suite pins a mode with `?virtualize=1|0`.
 * This spec is the one that must NOT: it opens the app the way a user does (no URL
 * param at all) and pins what the default now is, plus the two ways to leave it:
 *
 *   1. LARGE notebook, no param → windowed (spacers exist, mounted ≪ N). The payoff.
 *   2. `?virtualize=0` → every cell mounted, zero spacers. The deterministic
 *      support/debug override, and it beats the persisted preference.
 *   3. SMALL notebook, no param → TRANSPARENT: exactly the same cells mounted as
 *      with windowing off, and no spacer artifacts. `planWindow` emits no spacers
 *      when everything fits the viewport + overscan, so the flip costs a small
 *      notebook nothing - this is the blocker-class property of default-on.
 *   4. Print safety survives the flip: `beforeprint` mounts every cell (so a PDF
 *      captures the whole notebook) and `afterprint` restores the window.
 *   5. The in-app opt-out (navbar View menu) persists across a reload - it lives in
 *      the per-project UI-state store, not localStorage - and `?virtualize=1` still
 *      overrides it, with the toggle locked while a param owns the session.
 *   6. The Settings pane's "Windowed rendering" row is a SECOND surface for that one
 *      preference, not a copy: flipped in either place the other agrees in-session,
 *      it persists across a reload, and a `?virtualize=` session shows the Settings
 *      control locked with the reason (the param named) like the menu item.
 *
 * Both notebooks live in ONE workspace (one launcher), so every assertion is scoped
 * to the VISIBLE pane: an inactive notebook tab stays mounted behind `display:none`
 * and would otherwise pollute the counts.
 *
 * Needs the real runtime (uv + python3 + host-venv) like the rest of the E2E suite;
 * skips gracefully without it. The pure precedence rule is unit-tested in
 * `tests/unit/virtualize-pref.test.ts`.
 */

const LARGE_COUNT = 300;
const SMALL_COUNT = 8;
const SMALL_NB = 'small.ipynb';

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

/** Cells/spacers in the VISIBLE notebook pane (other open notebooks are display:none). */
const cells = (page: Page) => page.locator('[data-testid="cell"]:visible').count();
const spacers = (page: Page) => page.locator('[data-testid="cell-spacer"]:visible').count();
/** Ids of the mounted cells of the visible pane, in document order. */
async function mountedIds(page: Page): Promise<string[]> {
	return page.evaluate(() =>
		Array.from(document.querySelectorAll('[data-testid="cell"]'))
			.filter((el) => !!(el as HTMLElement).offsetParent)
			.map((el) => (el as HTMLElement).getAttribute('data-cell-id') ?? '')
	);
}

/** A minimal, valid nbformat 4.5 notebook of N short code cells. */
function smallNotebook(n: number): string {
	return JSON.stringify(
		{
			cells: Array.from({ length: n }, (_, i) => ({
				cell_type: 'code',
				id: `small000-0000-4000-8000-${String(i).padStart(12, '0')}`,
				metadata: {},
				execution_count: null,
				outputs: [],
				source: [`x${i} = ${i}\n`]
			})),
			metadata: { kernelspec: { display_name: 'python3', language: 'python', name: 'python3' } },
			nbformat: 4,
			nbformat_minor: 5
		},
		null,
		1
	);
}

/** Open a workspace notebook from the file tree and wait for ITS cells to show. */
async function openFromTree(page: Page, path: string): Promise<void> {
	await page.locator(`[data-testid="tree-file"][data-path="${path}"]`).click();
	// Scoped to the visible pane: another notebook tab may be mounted-but-hidden.
	await expect.poll(() => cells(page), { timeout: 30_000 }).toBeGreaterThan(0);
}

/** Open the app's View menu (the navbar app-menu dropdown holds the toggles). */
async function openAppMenu(page: Page): Promise<void> {
	await page.getByTestId('app-menu').click();
	await expect(page.getByTestId('toggle-virtualize-cells')).toBeVisible();
}

/** Close it again: the daisyUI dropdown is `:focus-within`-driven, so blur it. */
async function closeAppMenu(page: Page): Promise<void> {
	await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

/** Open the Settings modal (the SECOND surface for the same windowing preference). */
async function openSettings(page: Page): Promise<void> {
	await openAppMenu(page);
	await page.getByTestId('open-settings').click();
	await expect(page.getByTestId('settings-modal')).toBeVisible();
}

async function closeSettings(page: Page): Promise<void> {
	await page.getByTestId('settings-close').click();
	await expect(page.getByTestId('settings-modal')).toHaveCount(0);
	await closeAppMenu(page);
}

/**
 * Put the (shared, per-workspace) preference into the windowed state via the
 * pre-existing navbar control, so a test that starts from "windowing on" says so
 * instead of inheriting whatever an earlier test left in `.cellar/`.
 */
async function ensureWindowed(page: Page): Promise<void> {
	await openAppMenu(page);
	const toggle = page.getByTestId('toggle-virtualize-cells');
	if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
	await closeAppMenu(page);
	await expect.poll(() => spacers(page), { timeout: 60_000 }).toBeGreaterThan(0);
}

/**
 * Let the debounced UI-state PUT land before the page goes away - `setUi` coalesces
 * writes over ~300ms, so a test that ends the instant after a toggle can otherwise
 * leave the server store holding the PREVIOUS value.
 */
async function settlePref(page: Page): Promise<void> {
	await page.waitForTimeout(600);
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available - E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-virt-default-e2e-'));
	const gen = spawnSync(
		'node',
		[join(REPO, 'scripts', 'gen-large-notebook.js'), String(LARGE_COUNT), join(workspace, 'notebook.ipynb')],
		{ stdio: 'inherit' }
	);
	if (gen.status !== 0) throw new Error('gen-large-notebook.js failed');
	writeFileSync(join(workspace, SMALL_NB), smallNotebook(SMALL_COUNT));
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

test('with NO url param a large notebook is windowed (P5 default-on)', async ({ page }) => {
	test.setTimeout(120_000);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	const openBtn = page.getByTestId('empty-open-notebook');
	if (await openBtn.isVisible({ timeout: 10_000 }).catch(() => false)) await openBtn.click();
	await expect.poll(() => cells(page), { timeout: 30_000 }).toBeGreaterThan(0);

	// Windowing engaged with nothing in the URL: off-screen cells are spacers.
	await expect.poll(() => spacers(page), { timeout: 30_000 }).toBeGreaterThan(0);
	await setScrollTop(page, 0);
	await page.waitForTimeout(200);
	const mounted = await cells(page);
	expect(mounted).toBeLessThan(LARGE_COUNT / 3);

	// The View menu reflects it, and offers the opt-out (nothing is forcing it).
	await openAppMenu(page);
	const toggle = page.getByTestId('toggle-virtualize-cells');
	await expect(toggle).toHaveAttribute('aria-pressed', 'true');
	await expect(toggle).toBeEnabled();
	await closeAppMenu(page);
});

test('?virtualize=0 forces windowing off: every cell mounted, no spacers', async ({ page }) => {
	// With windowing off all 300 cells mount - heavy by design, that is the cost
	// this feature removes.
	test.setTimeout(300_000);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}&virtualize=0`);
	await expect.poll(() => cells(page), { timeout: 60_000 }).toBe(LARGE_COUNT);
	expect(await spacers(page)).toBe(0);

	// A param owns the session, so the toggle shows the state but cannot be used.
	await openAppMenu(page);
	const toggle = page.getByTestId('toggle-virtualize-cells');
	await expect(toggle).toHaveAttribute('aria-pressed', 'false');
	await expect(toggle).toBeDisabled();
	await closeAppMenu(page);
});

test('a SMALL notebook renders identically with the default on (no spacers, same cells)', async ({
	page
}) => {
	test.setTimeout(180_000);

	// ---- Baseline: windowing explicitly OFF -------------------------------
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}&virtualize=0`);
	await openFromTree(page, SMALL_NB);
	await expect.poll(() => cells(page), { timeout: 30_000 }).toBe(SMALL_COUNT);
	const eagerIds = await mountedIds(page);
	expect(eagerIds).toHaveLength(SMALL_COUNT);

	// ---- The P5 default: no param at all -----------------------------------
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await expect.poll(() => cells(page), { timeout: 30_000 }).toBe(SMALL_COUNT);
	// Give the window a chance to settle (metrics read + measured heights land):
	// if it were going to collapse anything into a spacer, it would by now.
	await page.waitForTimeout(600);
	expect(await spacers(page)).toBe(0);
	// Byte-for-byte the same cells, in the same order, as the un-windowed render.
	expect(await mountedIds(page)).toEqual(eagerIds);
});

test('print safety holds with the default on: beforeprint mounts every cell', async ({ page }) => {
	test.setTimeout(300_000);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openFromTree(page, 'notebook.ipynb');
	await expect.poll(() => spacers(page), { timeout: 30_000 }).toBeGreaterThan(0);

	// A print/PDF must capture the WHOLE notebook, not just the mounted window.
	await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
	await expect.poll(() => cells(page), { timeout: 60_000 }).toBe(LARGE_COUNT);
	expect(await spacers(page)).toBe(0);

	// …and windowing comes back afterwards.
	await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
	await expect.poll(() => spacers(page), { timeout: 30_000 }).toBeGreaterThan(0);
});

test('the View-menu opt-out survives a reload, and ?virtualize=1 still overrides it', async ({
	page
}) => {
	test.setTimeout(300_000);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openFromTree(page, 'notebook.ipynb');
	await expect.poll(() => spacers(page), { timeout: 30_000 }).toBeGreaterThan(0);

	// Turn windowing off from the navbar View menu.
	await openAppMenu(page);
	await page.getByTestId('toggle-virtualize-cells').click();
	await expect.poll(() => cells(page), { timeout: 60_000 }).toBe(LARGE_COUNT);
	expect(await spacers(page)).toBe(0);

	// It persists: reload with NO param and the opt-out still holds (the preference
	// lives in the per-project store, so it survives the dynamic port too).
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await expect.poll(() => cells(page), { timeout: 60_000 }).toBe(LARGE_COUNT);
	expect(await spacers(page)).toBe(0);
	await openAppMenu(page);
	await expect(page.getByTestId('toggle-virtualize-cells')).toHaveAttribute('aria-pressed', 'false');
	await closeAppMenu(page);

	// The URL param always wins - `?virtualize=1` re-windows despite the stored opt-out.
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}&virtualize=1`);
	await expect.poll(() => spacers(page), { timeout: 30_000 }).toBeGreaterThan(0);
	await openAppMenu(page);
	const toggle = page.getByTestId('toggle-virtualize-cells');
	await expect(toggle).toHaveAttribute('aria-pressed', 'true');
	await expect(toggle).toBeDisabled(); // a param owns the session
	await closeAppMenu(page);

	// Restore the default so the workspace is left as a user would find it.
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await expect.poll(() => cells(page), { timeout: 60_000 }).toBe(LARGE_COUNT);
	await openAppMenu(page);
	await page.getByTestId('toggle-virtualize-cells').click();
	await expect.poll(() => spacers(page), { timeout: 30_000 }).toBeGreaterThan(0);
});

test('the Settings opt-out drives the SAME preference as the View menu (one source of truth)', async ({
	page
}) => {
	test.setTimeout(300_000);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openFromTree(page, 'notebook.ipynb');
	await ensureWindowed(page);

	// Settings reflects the live state, and offers the opt-out (nothing forces it).
	await openSettings(page);
	const settingsToggle = page.getByTestId('settings-virtualize-cells');
	await expect(settingsToggle).toBeChecked();
	await expect(settingsToggle).toBeEnabled();
	await expect(page.getByTestId('virtualize-forced-note')).toHaveCount(0);

	// Turning it off here un-windows the notebook, exactly like the View-menu toggle.
	await settingsToggle.click();
	await expect(settingsToggle).not.toBeChecked();
	await closeSettings(page);
	await expect.poll(() => cells(page), { timeout: 60_000 }).toBe(LARGE_COUNT);
	expect(await spacers(page)).toBe(0);

	// …and the NAVBAR toggle already agrees: one state, two surfaces, no second copy.
	await openAppMenu(page);
	await expect(page.getByTestId('toggle-virtualize-cells')).toHaveAttribute('aria-pressed', 'false');
	await closeAppMenu(page);

	// It persists across a reload - the same single `VIRTUALIZE_PREF_KEY` preference
	// the View menu writes, in the per-project store (not localStorage).
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await expect.poll(() => cells(page), { timeout: 60_000 }).toBe(LARGE_COUNT);
	expect(await spacers(page)).toBe(0);
	await openSettings(page);
	await expect(page.getByTestId('settings-virtualize-cells')).not.toBeChecked();
	await closeSettings(page);

	// The other direction: flip it in the View menu, Settings reflects it.
	await openAppMenu(page);
	await page.getByTestId('toggle-virtualize-cells').click();
	await expect.poll(() => spacers(page), { timeout: 30_000 }).toBeGreaterThan(0);
	await closeAppMenu(page);
	await openSettings(page);
	await expect(page.getByTestId('settings-virtualize-cells')).toBeChecked();
	await closeSettings(page);
	await settlePref(page);
});

test('a ?virtualize= session shows the Settings control locked, with the reason', async ({
	page
}) => {
	test.setTimeout(300_000);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}&virtualize=0`);
	await openFromTree(page, 'notebook.ipynb');
	await expect.poll(() => cells(page), { timeout: 60_000 }).toBe(LARGE_COUNT);
	expect(await spacers(page)).toBe(0);

	await openSettings(page);
	const settingsToggle = page.getByTestId('settings-virtualize-cells');
	await expect(settingsToggle).not.toBeChecked(); // shows the forced state…
	await expect(settingsToggle).toBeDisabled(); // …but never pretends to change it
	await expect(page.getByTestId('virtualize-forced-note')).toBeVisible();
	await closeSettings(page);

	// The forced ON side reads the same way.
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}&virtualize=1`);
	await openFromTree(page, 'notebook.ipynb');
	await expect.poll(() => spacers(page), { timeout: 30_000 }).toBeGreaterThan(0);
	await openSettings(page);
	await expect(page.getByTestId('settings-virtualize-cells')).toBeChecked();
	await expect(page.getByTestId('settings-virtualize-cells')).toBeDisabled();
	await expect(page.getByTestId('virtualize-forced-note')).toBeVisible();
	await closeSettings(page);
});
