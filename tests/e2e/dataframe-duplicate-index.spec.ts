import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar, REPO } from './harness';

/**
 * A DataFrame output whose pandas index is NOT unique must render, and must not
 * take the notebook down with it.
 *
 * The grid keys its row `{#each}` by the row's POSITION (`DataFrameGrid.svelte`).
 * Keying it by the pandas index LABEL - which pandas never guarantees to be unique
 * (`set_index` on a repeated column, groupby/concat/explode, a flattened MultiIndex)
 * - throws Svelte's `each_key_duplicate` DURING RENDER, and because nothing wraps a
 * cell in an error boundary that uncaught error kills the whole notebook's render
 * tree rather than just this grid. The observed damage, from the reported bug:
 *
 *   - windowing ON  : the render loop dies the moment the offending cell scrolls
 *                     into the window, so everything below it stays permanently
 *                     blank - a deterministic gap in the same place every time,
 *                     surviving a restart - and arrow-key navigation and the
 *                     jump-to-running-cell spinner stop working with it;
 *   - windowing OFF : it throws at LOAD, so NOTHING renders - "Render all cells"
 *                     showed an empty notebook.
 *
 * THE LOAD-BEARING ASSERTION IS THE CONSOLE ONE. A duplicate key can be thrown while
 * the visible cells still look right (the blast radius varies by where in the flush
 * it lands), so "the cells are there" alone would pass against the bug on some runs.
 * `each_key_duplicate` reaching the console is the unambiguous signal, and it is what
 * catches any future keyed-`{#each}` regression here too.
 *
 * The fixture is a real pandas `_repr_html_` for `bids.set_index("bidder")` where one
 * bidder appears three times - the exact shape from the reported notebook - wrapped in
 * a plain cell either side so a broken render is visible as missing NEIGHBOURS, not
 * just a missing grid. Only 3 cells: this is deliberately NOT a virtualization test.
 * The bug reproduces at any size, which is why it also broke "Render all cells"; the
 * two modes here pin both halves.
 *
 * Needs the real runtime (uv + python3 + host-venv) like the rest of the E2E suite;
 * skips gracefully without it. The parser precondition + a source guard on the key
 * are unit-tested in `tests/unit/dataframe-grid.test.ts`.
 */

const FIXTURE = 'duplicate-index-dataframe.ipynb';
const CELL_COUNT = 3;
/** The grid must show every row of the duplicate index, not a deduplicated subset. */
const GRID_ROWS = 6;

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

const cells = (page: Page) => page.locator('[data-testid="cell"]:visible').count();
const gridRows = (page: Page) => page.locator('[data-testid="df-index-cell"]:visible').count();

/**
 * Collect page errors + console errors for the whole test. `pageerror` is what an
 * uncaught render throw actually surfaces as; the console listener is belt-and-braces
 * for anything logged rather than thrown.
 */
function watchErrors(page: Page): string[] {
	const errors: string[] = [];
	page.on('pageerror', (err) => errors.push(String(err?.message ?? err)));
	page.on('console', (msg) => {
		if (msg.type() === 'error') errors.push(msg.text());
	});
	return errors;
}

/** Open the fixture from the file tree and wait for ITS cells to show. */
async function openFixture(page: Page): Promise<void> {
	await page.locator(`[data-testid="tree-file"][data-path="${FIXTURE}"]`).click();
	await expect.poll(() => cells(page), { timeout: 30_000 }).toBeGreaterThan(0);
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available - E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-df-dupidx-e2e-'));
	copyFileSync(join(REPO, 'tests', 'e2e', 'fixtures', FIXTURE), join(workspace, FIXTURE));
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

test('windowed (default): a duplicate-index DataFrame renders with no render error', async ({ page }) => {
	test.setTimeout(120_000);
	const errors = watchErrors(page);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openFixture(page);

	// Every cell mounts - the neighbours either side prove the render tree survived.
	await expect.poll(() => cells(page), { timeout: 30_000 }).toBe(CELL_COUNT);
	// The grid shows every row, including the three that share one index label.
	await expect.poll(() => gridRows(page), { timeout: 30_000 }).toBe(GRID_ROWS);
	await expect(page.locator('[data-testid="df-index-cell"]').first()).toHaveText('3376');

	// The assertion that actually catches the bug.
	expect(errors, `unexpected page/console errors:\n${errors.join('\n')}`).toEqual([]);
});

test('render all cells (?virtualize=0): the notebook still loads', async ({ page }) => {
	test.setTimeout(120_000);
	const errors = watchErrors(page);
	// With windowing off every cell mounts at load, so the offending cell throws
	// before anything paints: this is the mode where the bug emptied the notebook.
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}&virtualize=0`);
	await openFixture(page);

	await expect.poll(() => cells(page), { timeout: 30_000 }).toBe(CELL_COUNT);
	await expect.poll(() => page.locator('[data-testid="cell-spacer"]:visible').count()).toBe(0);
	await expect.poll(() => gridRows(page), { timeout: 30_000 }).toBe(GRID_ROWS);

	expect(errors, `unexpected page/console errors:\n${errors.join('\n')}`).toEqual([]);
});
