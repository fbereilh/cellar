import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, rmSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar, REPO } from './harness';
import { paneMetric, setScrollTop } from './notebook-scroll';

/**
 * One malformed kernel output must cost ONE cell, not the whole notebook.
 *
 * Cellar renders arbitrary output from a user's kernel, so a renderer that throws is
 * a recurring failure class rather than a one-off - the duplicate-pandas-index bug
 * (`tests/e2e/dataframe-duplicate-index.spec.ts`, since fixed) was one instance.
 * Svelte flushes the whole document in one pass and nothing in `src/` used to mount a
 * boundary, so an uncaught render throw took the ENTIRE notebook's render tree with
 * it. Measured on this branch's parent, with the fixture below:
 *
 *   ?virtualize=0  → pageerror `a(...).map is not a function`, ZERO cells rendered;
 *   windowed       → the render loop dies as the bad cell enters the window, so
 *                    everything below it stays permanently blank.
 *
 * `Notebook.svelte` now wraps each cell row in a `<svelte:boundary>`, so the bad cell
 * degrades to an inline placeholder. Diagnosis + design:
 * `data/cellar-virt-55cell-bugs-w7/report.md` §7b.
 *
 * THE TRIGGER is a genuinely malformed structured DataFrame payload whose `data` is
 * an object rather than the array of rows the kernel formatter emits, so
 * `DataFrameGrid`'s `rawData.map(...)` throws WHILE RENDERING. That mime is stripped
 * on SAVE but passed through on LOAD, so a fixture can carry it and no kernel is
 * needed to produce it; it is the same render-time-throw class as the duplicate key,
 * reached through a payload rather than a key.
 *
 * THE HARD PART IS THE HEIGHT, not the boundary. Windowing plans the document's flow
 * from a cache of measured card heights, so a placeholder that collapsed to the
 * height of its own message would trade a fatal bug for the height-cache mismatch
 * class the windowing work exists to remove. `windowed: the flow does not move…`
 * below is the assertion that actually proves the fix is safe under windowing: the
 * cells BELOW the failure must not move as it fails, nor as it scrolls out of the
 * window into a spacer and back.
 *
 * Needs the real runtime (uv + python3 + host-venv) like the rest of the E2E suite;
 * skips gracefully without it. The pure rules + source guards on the wiring are in
 * `tests/unit/cell-render-boundary.test.ts`.
 */

const FIXTURE = 'broken-output.ipynb';
/** The middle cell of the fixture - the one whose output throws. */
const BAD_ID = 'brkout00-0000-4000-8000-000000000001';
/** The two healthy cells either side of it. */
const HEALTHY_CELLS = 2;

/** A tall notebook with the same malformed output planted mid-document. */
const BIG = 'big-broken.ipynb';
const BIG_CELLS = 60;
const BIG_BAD_INDEX = 30;
/**
 * The same notebook again, but with the failing cell already FULLY COLLAPSED (the
 * collapse record is server-owned `.cellar/` state, so the fixture seeds it directly).
 * This is the case where the two halves of the height rule come apart: a collapsed
 * cell reserves only its header row (`COLLAPSED_CELL_PX`, 34px) while the placeholder's
 * message needs ~110px, so RESERVING alone would leave the cache 76px short of what
 * the DOM renders - and the placeholder MEASURING ITSELF back into that cache is what
 * closes it. A separate notebook because `BIG`'s own test needs that cell expanded.
 */
const COLLAPSED = 'collapsed-broken.ipynb';

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

const cells = (page: Page) => page.locator('[data-testid="cell"]:visible').count();
// Scoped to the VISIBLE pane: every open notebook tab stays mounted (hidden), and the
// tab set is server-owned state restored on load, so an unscoped locator would also
// match the OTHER fixture's placeholder.
const placeholder = (page: Page) => page.locator('[data-testid="cell-render-error"]:visible');

/**
 * Page errors + console errors for the whole test.
 *
 * The boundary REPORTS the failure it absorbs (`console.error`), deliberately: a
 * boundary that made a broken renderer survivable AND silent would also make it
 * undetectable, retiring the console assertion that is how several specs here catch a
 * render regression. So the expectation is not "no errors" but "exactly the
 * boundary's own report, and nothing thrown".
 */
function watchErrors(page: Page): { page: string[]; console: string[] } {
	const seen = { page: [] as string[], console: [] as string[] };
	page.on('pageerror', (err) => seen.page.push(String(err?.message ?? err)));
	page.on('console', (msg) => {
		if (msg.type() === 'error') seen.console.push(msg.text());
	});
	return seen;
}

async function openFixture(page: Page, name: string): Promise<void> {
	await page.locator(`[data-testid="tree-file"][data-path="${name}"]`).click();
	await expect.poll(() => cells(page), { timeout: 30_000 }).toBeGreaterThan(0);
}

/**
 * Sweep the scroll pane downwards until the failed cell's placeholder AND the cell
 * below it are both in the window, and return the offset that happened at (-1 if it
 * never did). Both are required because the reference measurements need a live node
 * for each: the placeholder can enter the window at the far edge of the overscan with
 * its neighbour still collapsed into the spacer behind it.
 */
async function scrollUntilFailureInWindow(page: Page, below: string): Promise<number> {
	const step = Math.max(200, Math.round((await paneMetric(page, 'clientHeight')) * 0.7));
	const end = await paneMetric(page, 'scrollHeight');
	for (let top = step; top < end + step; top += step) {
		await setScrollTop(page, top);
		await page.waitForTimeout(150);
		if ((await placeholder(page).count()) > 0 && (await offsetTop(page, below)) > 0) {
			return await paneMetric(page, 'scrollTop');
		}
	}
	return -1;
}

/** Document offset (px from the top of the notebook flow) of a cell, or -1. */
async function offsetTop(page: Page, id: string): Promise<number> {
	return page.evaluate((cellId) => {
		const el = document.querySelector(`[data-cell-id="${CSS.escape(cellId)}"]`) as HTMLElement | null;
		if (!el) return -1;
		let top = 0;
		for (let n: HTMLElement | null = el; n; n = n.offsetParent as HTMLElement | null) top += n.offsetTop;
		return top;
	}, id);
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available - E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-render-boundary-e2e-'));
	copyFileSync(join(REPO, 'tests', 'e2e', 'fixtures', FIXTURE), join(workspace, FIXTURE));

	// The windowing case needs a notebook tall enough to window, so reuse the
	// virtualization harness's generator and transplant the fixture's malformed
	// output onto one mid-document cell. Generated rather than committed: the fixture
	// that matters is the 3-cell one, and a 60-cell copy of it is noise in the repo.
	const gen = spawnSync('node', [join(REPO, 'scripts', 'gen-large-notebook.js'), String(BIG_CELLS), join(workspace, BIG)], {
		stdio: 'inherit'
	});
	if (gen.status !== 0) throw new Error('gen-large-notebook.js failed');
	const small = JSON.parse(readFileSync(join(workspace, FIXTURE), 'utf8'));
	const big = JSON.parse(readFileSync(join(workspace, BIG), 'utf8'));
	const bad = small.cells.find((c: { id: string }) => c.id === BAD_ID);
	big.cells[BIG_BAD_INDEX] = { ...bad, id: big.cells[BIG_BAD_INDEX].id };
	writeFileSync(join(workspace, BIG), JSON.stringify(big, null, 1) + '\n');
	writeFileSync(join(workspace, COLLAPSED), JSON.stringify(big, null, 1) + '\n');

	// Seed the collapse record for the failing cell of the COLLAPSED copy. `.cellar/`
	// is the same per-project UI store `LiveNotebook` restores from on load, keyed by
	// the notebook's absolute path (`$lib/cellCollapse`'s `collapsedKeyFor`).
	mkdirSync(join(workspace, '.cellar'), { recursive: true });
	writeFileSync(
		join(workspace, '.cellar', 'ui-state.json'),
		JSON.stringify({
			[`cellar-cell-collapsed:${join(workspace, COLLAPSED)}`]: { [big.cells[BIG_BAD_INDEX].id]: true }
		})
	);

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

test('render all cells (?virtualize=0): the failure costs one cell, not the notebook', async ({ page }) => {
	test.setTimeout(120_000);
	const errors = watchErrors(page);
	// With windowing off every cell mounts at load, so the bad cell throws before
	// anything paints: this is the mode where the bug rendered NOTHING at all.
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}&virtualize=0`);
	await openFixture(page, FIXTURE);

	// The neighbours either side render as real cells...
	await expect.poll(() => cells(page), { timeout: 30_000 }).toBe(HEALTHY_CELLS);
	// ...and the bad one as exactly one placeholder, in its own place in the document.
	await expect(placeholder(page)).toHaveCount(1);
	await expect(placeholder(page)).toBeVisible();
	await expect(placeholder(page)).toHaveAttribute('data-cell-id', BAD_ID);

	// It says plainly what happened, and names the cause without a stack.
	await expect(placeholder(page)).toContainText('could not render this cell');
	const detail = page.locator('[data-testid="cell-render-error-detail"]:visible');
	await expect(detail).toContainText('is not a function');
	expect(await detail.innerText()).not.toContain('.svelte');

	// Nothing was thrown out of the render; the ONE error is the boundary's own report.
	expect(errors.page, `unexpected page errors:\n${errors.page.join('\n')}`).toEqual([]);
	expect(errors.console.filter((e) => !e.includes('failed to render'))).toEqual([]);
	expect(errors.console.filter((e) => e.includes(`cell ${BAD_ID} failed to render`))).not.toEqual([]);
});

test('windowed (default): the notebook stays usable around the failed cell', async ({ page }) => {
	test.setTimeout(180_000);
	const errors = watchErrors(page);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openFixture(page, FIXTURE);
	await expect(placeholder(page)).toBeVisible();

	// The notebook is not merely painted, it still WORKS: a cell below the failure
	// runs against the real kernel and shows its output.
	const after = page.locator(`[data-cell-id="brkout00-0000-4000-8000-000000000002"]`);
	await after.getByTestId('editor-scroll').click(); // build the lazy editor
	const editor = after.locator('.cm-content');
	await expect(editor).toBeVisible();
	await editor.click();
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.type('print(6 * 7)');
	await page.keyboard.press('Shift+Enter');
	await expect(after.getByTestId('output')).toContainText('42', { timeout: 60_000 });

	expect(errors.page, `unexpected page errors:\n${errors.page.join('\n')}`).toEqual([]);
});

test('windowed: the flow does not move as a cell fails, or as it scrolls in and out', async ({ page }) => {
	test.setTimeout(180_000);
	const errors = watchErrors(page);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openFixture(page, BIG);
	// Windowing engaged: off-screen cells have collapsed to spacers.
	await expect.poll(() => page.locator('[data-testid="cell-spacer"]').count(), { timeout: 30_000 }).toBeGreaterThan(0);

	// The cell immediately BELOW the failure: the one whose position proves nothing
	// moved. Adjacent, so it is mounted whenever the failed cell is.
	const below = JSON.parse(readFileSync(join(workspace, BIG), 'utf8')).cells[BIG_BAD_INDEX + 1].id as string;

	// The bad cell starts windowed OUT, so it has no node to scroll to: sweep the pane
	// until its placeholder enters the window. The sweep also measures every cell it
	// passes, so the reference heights taken below are measured ones, not estimates.
	const scrollTop = await scrollUntilFailureInWindow(page, below);
	expect(scrollTop, 'never scrolled the failing cell into the window').toBeGreaterThan(0);
	await expect(placeholder(page)).toBeVisible();

	// The reserved height is PLAUSIBLE, not a collapsed strip. This cell's estimate is
	// ~220px (card chrome + 2 source lines + one output block) while the placeholder's
	// own message needs ~100px, so a floor between the two distinguishes "reserved the
	// cell's extent" from "collapsed to the height of its message". The RIGOROUS proof
	// is the scrollHeight/offsetTop invariance below; this is the sanity floor.
	const failedHeight = await placeholder(page).evaluate((el) => (el as HTMLElement).offsetHeight);
	expect(failedHeight).toBeGreaterThanOrEqual(150);

	// Freeze a reference: where the cell BELOW the failure sits in the document, and how
	// tall the document is, with the failed cell mounted as a placeholder.
	const belowBefore = await offsetTop(page, below);
	const heightBefore = await paneMetric(page, 'scrollHeight');
	expect(belowBefore).toBeGreaterThan(0);

	// Scroll far away, so the failed cell leaves the window and becomes a SPACER...
	await setScrollTop(page, 0);
	await page.waitForTimeout(400);
	await expect(placeholder(page)).toHaveCount(0);
	// ...and the document's total extent is unchanged: the spacer reproduces what the
	// placeholder occupied, i.e. the height cache and the DOM agree about the failed
	// cell. (A few px of slack, because this compares two different windows and every
	// mount can still replace some other cell's estimate with its measured height.)
	expect(Math.abs((await paneMetric(page, 'scrollHeight')) - heightBefore)).toBeLessThanOrEqual(4);

	// ...and back. The failure re-renders, and NOTHING below it has moved - the direct
	// form of the claim, and the one that would fail loudest if the placeholder
	// collapsed to the height of its own message.
	await setScrollTop(page, scrollTop);
	await page.waitForTimeout(400);
	await expect(placeholder(page)).toBeVisible();
	await expect.poll(() => offsetTop(page, below), { timeout: 10_000 }).toBeGreaterThan(0);
	expect(Math.abs((await paneMetric(page, 'scrollTop')) - scrollTop)).toBeLessThanOrEqual(2);
	expect(Math.abs((await offsetTop(page, below)) - belowBefore)).toBeLessThanOrEqual(2);
	expect(Math.abs((await paneMetric(page, 'scrollHeight')) - heightBefore)).toBeLessThanOrEqual(4);

	// Cells above AND below the failure are still mounted and rendering.
	expect(await cells(page)).toBeGreaterThan(1);
	expect(errors.page, `unexpected page errors:\n${errors.page.join('\n')}`).toEqual([]);
});

test('windowed: a COLLAPSED cell that fails still leaves the flow coherent', async ({ page }) => {
	test.setTimeout(180_000);
	const errors = watchErrors(page);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openFixture(page, COLLAPSED);
	await expect.poll(() => page.locator('[data-testid="cell-spacer"]').count(), { timeout: 30_000 }).toBeGreaterThan(0);

	const below = JSON.parse(readFileSync(join(workspace, COLLAPSED), 'utf8')).cells[BIG_BAD_INDEX + 1].id as string;
	const scrollTop = await scrollUntilFailureInWindow(page, below);
	expect(scrollTop, 'never scrolled the failing cell into the window').toBeGreaterThan(0);

	// The reservation is DELIBERATELY too small here (34px for a collapsed cell), so
	// the placeholder renders taller than the plan had allowed for...
	const failedHeight = await placeholder(page).evaluate((el) => (el as HTMLElement).offsetHeight);
	expect(failedHeight).toBeGreaterThan(60);

	// ...and the height cache must catch up. The SENSITIVE comparison is the document's
	// total extent placeholder-vs-spacer: if the placeholder did not measure itself back
	// into the cache, the spacer standing in for it would be the 34px that was reserved
	// against a ~110px placeholder, and the document would shrink by the difference
	// every time it scrolled out of the window. (The `offsetTop` round trip below is
	// blind to that on its own - the placeholder is mounted at both ends of it.)
	const belowBefore = await offsetTop(page, below);
	const heightBefore = await paneMetric(page, 'scrollHeight');
	expect(belowBefore).toBeGreaterThan(0);
	await setScrollTop(page, 0);
	await page.waitForTimeout(400);
	await expect(placeholder(page)).toHaveCount(0);
	expect(Math.abs((await paneMetric(page, 'scrollHeight')) - heightBefore)).toBeLessThanOrEqual(4);
	await setScrollTop(page, scrollTop);
	await page.waitForTimeout(400);
	await expect(placeholder(page)).toBeVisible();
	await expect.poll(() => offsetTop(page, below), { timeout: 10_000 }).toBeGreaterThan(0);
	expect(Math.abs((await offsetTop(page, below)) - belowBefore)).toBeLessThanOrEqual(2);

	expect(errors.page, `unexpected page errors:\n${errors.page.join('\n')}`).toEqual([]);
});
