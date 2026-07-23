import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess, spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar, REPO } from './harness';
import { setScrollTop, isCellMounted, cellIsOnScreen, mountedCellIds } from './notebook-scroll';

/**
 * Cell virtualization P4 — every jump / reveal / focus path reaches a WINDOWED-OUT
 * target (report `data/cellar-perf-cell-virtualization-a2/report.md` §6 P4, §4.3).
 *
 * Windowing (P2) replaces every off-screen cell with an inert spacer, so any
 * navigation that resolves its target with a `querySelector` lands on nothing. P4's
 * contract is that every such path first goes through ONE seam,
 * `LiveNotebook.ensureCellMounted` (reveal/unfold + pin + tick), so the target has a
 * real node before the scroll. This spec covers the paths P2/P3 did not:
 *
 *   A. OUTLINE row click       (shell `scrollToCell` → the notebook's `jumpToCell`)
 *   B. SIDEBAR SEARCH result   (same shell seam)
 *   C. KEYBOARD `j`/`k`        (`selectAndFocus` → `ensureCellMounted`), across the
 *                              overscan boundary — the selection must both mount AND
 *                              take DOM focus, or the whole modal keyboard goes dead
 *   D. FOLLOW-RUNNING          (`followCell`) onto a cell far outside the window
 *
 * Already covered elsewhere, deliberately not duplicated here:
 *   - the tab-spinner jump (`revealRunning`) → `virtualization-pinning.spec.ts`
 *   - the find-bar jump to a match (`jumpToCell`) → `find-bar.spec.ts`
 *   - `beforeprint` mounting every cell → `find-ctrlf.spec.ts`
 * There is no clickable error/traceback link in the app (tracebacks render as plain
 * text), so that listed path has nothing to make virtualization-safe.
 *
 * Boots the REAL launcher, so it SKIPS when that runtime is missing. Tests A-C need
 * no kernel; D runs one cell.
 */

const CELL_COUNT = 300;
const NB = 'notebook.ipynb';

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

const spacers = (page: Page) => page.locator('[data-testid="cell-spacer"]').count();

/** Every cell id of the notebook, in document order, read from the server model. */
async function allCellIds(page: Page): Promise<string[]> {
	return page.evaluate(async (nb) => {
		const res = await fetch(`/api/notebooks?path=${encodeURIComponent(nb)}`);
		const body = await res.json();
		return body.notebook.cells.map((c: { id: string }) => c.id) as string[];
	}, NB);
}

/** Open the notebook with windowing on (or off) and settle at the top. */
async function openNotebook(page: Page, { virtualize = true } = {}): Promise<void> {
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}${virtualize ? '&virtualize=1' : ''}`);
	const openButton = page.getByTestId('empty-open-notebook');
	if (await openButton.isVisible({ timeout: 10_000 }).catch(() => false)) await openButton.click();
	await expect(page.getByTestId('cell').first()).toBeVisible({ timeout: 30_000 });
	if (virtualize) {
		// Windowing is engaged once off-screen cells have collapsed into spacers.
		await expect.poll(() => spacers(page), { timeout: 30_000 }).toBeGreaterThan(0);
	} else {
		await expect(page.locator('[data-testid="cell-spacer"]')).toHaveCount(0);
	}
	await setScrollTop(page, 0);
	await page.waitForTimeout(300);
}

/** Open the sidebar's Search section (idempotent - its open state is persisted). */
async function openSearchSection(page: Page): Promise<void> {
	const input = page.getByTestId('search-input');
	if (await input.isVisible().catch(() => false)) return;
	await page.getByTestId('section-search').click();
	await expect(input).toBeVisible({ timeout: 30_000 });
}

/** The id of the cell that currently carries the selection ring. */
async function activeCellId(page: Page): Promise<string | null> {
	return page.evaluate(
		() => (document.querySelector('[data-testid="cell"][data-active="true"]') as HTMLElement | null)?.dataset.cellId ?? null
	);
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-virt-jump-'));
	const gen = spawnSync('node', [join(REPO, 'scripts', 'gen-large-notebook.js'), String(CELL_COUNT), join(workspace, NB)], {
		stdio: 'inherit'
	});
	if (gen.status !== 0) throw new Error('gen-large-notebook.js failed');
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

test('outline row jumps to a heading cell windowed out of the DOM', async ({ page }) => {
	test.setTimeout(120_000);
	await openNotebook(page);
	const ids = await allCellIds(page);

	// The generator emits `## Section N` every 6th cell, so outline row k addresses
	// cell 6k. Row 45 → cell 270: far below the window while we sit at the top.
	const row = 45;
	const target = ids[row * 6];
	expect(await isCellMounted(page, target)).toBe(false);

	const outline = page.getByTestId('outline-item');
	await expect(outline).toHaveCount(Math.ceil(CELL_COUNT / 6));
	await outline.nth(row).click();

	await expect.poll(() => isCellMounted(page, target), { timeout: 10_000 }).toBe(true);
	await expect.poll(() => cellIsOnScreen(page, target), { timeout: 10_000 }).toBe(true);
	// Still windowed: the jump mounted its target, it did not un-window the notebook.
	expect(await spacers(page)).toBeGreaterThan(0);

	// The transient mount pin is released once the scroll settles, so scrolling the
	// target away again lets it go back to being a spacer (pins must not accumulate).
	await setScrollTop(page, 0);
	await expect.poll(() => isCellMounted(page, target), { timeout: 10_000 }).toBe(false);
});

test('a sidebar search result jumps to a cell windowed out of the DOM', async ({ page }) => {
	test.setTimeout(120_000);
	await openNotebook(page);
	const ids = await allCellIds(page);
	const target = ids[247]; // `x_247 = 494` — the generator's only occurrence

	expect(await isCellMounted(page, target)).toBe(false);

	await openSearchSection(page);
	await page.getByTestId('search-input').fill('x_247');
	const results = page.getByTestId('search-result');
	await expect(results).toHaveCount(1, { timeout: 10_000 });
	await results.first().click();

	await expect.poll(() => isCellMounted(page, target), { timeout: 10_000 }).toBe(true);
	await expect.poll(() => cellIsOnScreen(page, target), { timeout: 10_000 }).toBe(true);
	expect(await spacers(page)).toBeGreaterThan(0);
});

test('keyboard j/k selects and focuses cells across the overscan boundary', async ({ page }) => {
	test.setTimeout(120_000);
	await openNotebook(page);
	const ids = await allCellIds(page);

	// Start on the LAST currently-mounted cell: from there `j` walks straight off the
	// window's bottom edge, the boundary case selection has to survive. This one
	// already passed before P4 - `activeId` is in P3's pinned set, so the selection
	// incidentally mounted itself - and the point of pinning it here is that it stays
	// true now that `selectAndFocus` states the requirement explicitly (mount BEFORE
	// focus) instead of relying on that coincidence.
	const mounted = await mountedCellIds(page);
	const start = mounted[mounted.length - 1];
	// Click the card's left accent gutter, NOT the editor: clicking into CodeMirror
	// would put us in edit mode, where `j` types a `j` instead of moving the selection.
	await page.locator(`[data-cell-id="${start}"]`).click({ position: { x: 3, y: 8 } });
	await expect.poll(() => activeCellId(page), { timeout: 5_000 }).toBe(start);

	const startIndex = ids.indexOf(start);
	const steps = 12; // comfortably past the mounted window's bottom edge
	for (let i = 0; i < steps; i++) {
		await page.keyboard.press('j');
		const expected = ids[startIndex + i + 1];
		await expect.poll(() => activeCellId(page), { timeout: 5_000 }).toBe(expected);
		// Selected ⇒ mounted (pinned as `activeId`) ⇒ visible, and holding DOM focus:
		// the dispatcher reads a keystroke's mode + target off the focused element, so
		// a selection the focus didn't follow would break every subsequent shortcut.
		expect(await isCellMounted(page, expected)).toBe(true);
		expect(await cellIsOnScreen(page, expected)).toBe(true);
	}
	const landed = ids[startIndex + steps];
	expect(
		await page.evaluate((id) => {
			const el = document.querySelector(`[data-cell-id="${CSS.escape(id)}"]`);
			return !!el && !!document.activeElement && el.contains(document.activeElement);
		}, landed)
	).toBe(true);
	// The walk did not un-window the notebook.
	expect(await spacers(page)).toBeGreaterThan(0);

	// And back up across the boundary the other way.
	for (let i = 0; i < 4; i++) await page.keyboard.press('k');
	const back = ids[startIndex + steps - 4];
	await expect.poll(() => activeCellId(page), { timeout: 5_000 }).toBe(back);
	expect(await cellIsOnScreen(page, back)).toBe(true);
});

test('follow-the-running-cell scrolls to a cell windowed out of the DOM', async ({ page }) => {
	test.setTimeout(180_000);
	await openNotebook(page);
	const ids = await allCellIds(page);
	const target = ids[249]; // `print(x_249)` — a code cell far below the window

	// Follow is a persisted viewer preference; make sure it is ON for this test.
	await page.getByTestId('app-menu').click();
	const toggle = page.getByTestId('toggle-follow-running-cell');
	if ((await toggle.getAttribute('aria-pressed')) === 'false') await toggle.click();
	await expect(toggle).toHaveAttribute('aria-pressed', 'true');
	await page.keyboard.press('Escape');
	await setScrollTop(page, 0);
	await page.waitForTimeout(300);
	expect(await isCellMounted(page, target)).toBe(false);

	// Run it out-of-band (no originId ⇒ the tab treats it as an agent/other-tab run
	// and reflects it over SSE), which is what drives the follow effect.
	await page.evaluate(
		({ nb, cellId }) => {
			fetch(`/api/cells/${cellId}/run`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ nb, source: 'import time\nprint("followed")\ntime.sleep(6)\n' })
			}).catch(() => {});
		},
		{ nb: NB, cellId: target }
	);

	await expect.poll(() => isCellMounted(page, target), { timeout: 90_000 }).toBe(true);
	await expect.poll(() => cellIsOnScreen(page, target), { timeout: 30_000 }).toBe(true);
});

test('with the flag OFF the same jumps still work (no windowing, no spacers)', async ({ page }) => {
	// Generous: with windowing off all 300 cells mount, which is precisely the cost
	// this feature exists to remove - the page is heavy here by design.
	test.setTimeout(300_000);
	await openNotebook(page, { virtualize: false });
	const ids = await allCellIds(page);

	// Every cell is mounted; the jump paths must behave exactly as they always did.
	const heading = ids[45 * 6];
	expect(await isCellMounted(page, heading)).toBe(true);
	await page.getByTestId('outline-item').nth(45).click();
	await expect.poll(() => cellIsOnScreen(page, heading), { timeout: 10_000 }).toBe(true);

	const searched = ids[247];
	await openSearchSection(page);
	await page.getByTestId('search-input').fill('x_247');
	const results = page.getByTestId('search-result');
	await expect(results).toHaveCount(1, { timeout: 10_000 });
	await results.first().click();
	await expect.poll(() => cellIsOnScreen(page, searched), { timeout: 10_000 }).toBe(true);

	await expect(page.locator('[data-testid="cell-spacer"]')).toHaveCount(0);
});
