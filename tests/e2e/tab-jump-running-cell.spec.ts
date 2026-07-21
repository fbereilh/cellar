import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * End-to-end proof of "click a notebook tab's run spinner to jump to its running
 * cell". Two notebooks are open as tabs; notebook A runs a cell out-of-band while
 * the user is VIEWING notebook B. Clicking A's tab spinner must:
 *   A. activate notebook A (switch the viewed tab), and
 *   B. scroll A's running cell into view.
 * It must do so EVEN with the "follow the running cell" preference turned OFF (the
 * jump is an explicit user action, independent of that automatic-scroll setting).
 * Finally, a click on the tab's non-spinner area still just selects the tab.
 *
 * Boots the REAL launcher; SKIPS when the runtime (uv + python3 + host-venv) is
 * missing, like the other E2E specs. Screenshots are written as evidence.
 */

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

const EVIDENCE = process.env.CELLAR_EVIDENCE_DIR || join(tmpdir(), 'cellar-tab-jump-evidence');

/** An nbformat 4.5 notebook of `n` deliberately TALL code cells (so the notebook
 *  overflows the viewport and a scroll is observable). Deterministic ids. */
function tallNotebook(prefix: string, n: number): string {
	const cells = [];
	for (let i = 0; i < n; i++) {
		const id = `${prefix}-cell-${String(i).padStart(2, '0')}`;
		const source: string[] = [`# ${prefix} cell ${i}\n`];
		for (let k = 0; k < 10; k++) source.push(`# padding line ${k} to give this cell some height\n`);
		source.push(`marker_${prefix}_${i} = ${i}`);
		cells.push({ cell_type: 'code', id, metadata: {}, execution_count: null, outputs: [], source });
	}
	return JSON.stringify({
		cells,
		metadata: { kernelspec: { name: 'python3', display_name: 'python3' } },
		nbformat: 4,
		nbformat_minor: 5
	});
}

/** scrollTop of the VISIBLE notebook's own scroll pane. Two notebooks stay mounted
 *  (the hidden one is display:none, so its cells have no offsetParent) — pick a
 *  cell that is actually rendered, then walk up to its scroll ancestor. */
async function visibleNotebookScrollTop(page: Page): Promise<number> {
	return page.evaluate(() => {
		const cell = [...document.querySelectorAll('[data-testid="cell"]')].find(
			(c) => (c as HTMLElement).offsetParent !== null
		);
		let el: HTMLElement | null = cell as HTMLElement | null;
		while (el) {
			const s = getComputedStyle(el);
			if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight)
				return el.scrollTop;
			el = el.parentElement;
		}
		return -1;
	});
}

/** Fire a run of `cellId` in `nb` from the page's own fetch, with NO originId — so
 *  the viewing tab treats it as an external run and reflects it live over SSE. */
async function runCellOutOfBand(page: Page, nb: string, cellId: string, sleepS = 4): Promise<void> {
	await page.evaluate(
		async ({ nb, cellId, sleepS }) => {
			fetch(`/api/cells/${cellId}/run`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ nb, source: `import time\ntime.sleep(${sleepS})\nprint("ran ${cellId}")` })
			}).catch(() => {});
		},
		{ nb, cellId, sleepS }
	);
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only');
	mkdirSync(EVIDENCE, { recursive: true });
	workspace = mkdtempSync(join(tmpdir(), 'cellar-tab-jump-'));
	// A = the canonical notebook (30 tall cells, run far down). B = a second notebook
	// the user views while A runs in the background.
	writeFileSync(join(workspace, 'notebook.ipynb'), tallNotebook('viewed', 30));
	writeFileSync(join(workspace, 'other.ipynb'), tallNotebook('other', 12));
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

test('tab run spinner: click jumps to (and switches to) the running notebook, follow-independent; normal tab click still selects', async ({
	page
}) => {
	test.setTimeout(180_000);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);

	// Open notebook A (the canonical notebook.ipynb) from the empty state.
	await page.getByTestId('empty-open-notebook').click();
	await expect.poll(async () => page.getByTestId('cell').count(), { timeout: 30_000 }).toBe(30);

	const tabA = page.locator('[data-testid="tab"][data-tab-id="notebook"]');
	const jumpBtnA = tabA.getByTestId('tab-jump-running');
	const runningBarA = (id: string) => page.locator(`[data-cell-id="${id}"] [data-testid="running-bar"]`);

	// Warm A's kernel with a quick run so the (cold, first-run) host-venv boot doesn't
	// eat the short window in which the later background run is observable.
	await runCellOutOfBand(page, 'notebook.ipynb', 'viewed-cell-00', 1);
	await expect(runningBarA('viewed-cell-00')).toBeVisible({ timeout: 60_000 });
	await expect(runningBarA('viewed-cell-00')).toBeHidden({ timeout: 30_000 });

	// Open notebook B (other.ipynb) from the file tree and view it (double-click pins it).
	const treeB = page.getByTestId('tree-file').filter({ hasText: 'other.ipynb' });
	await treeB.dblclick();
	const tabB = page.locator('[data-testid="tab"][data-tab-id="file:other.ipynb"]');
	await expect(tabB).toHaveAttribute('data-active', 'true'); // now viewing B

	// ---- Phase 1: follow ON (default). Run a cell deep in A while viewing B. ----
	await runCellOutOfBand(page, 'notebook.ipynb', 'viewed-cell-24', 6);
	// The spinner appears on A's tab (background run reflected over SSE).
	await expect(jumpBtnA).toBeVisible({ timeout: 20_000 });
	await expect(page.getByTestId('tab-running')).toBeVisible();
	await page.screenshot({ path: join(EVIDENCE, '1-spinner-on-background-tab.png') });

	// Click A's spinner: switch to A and scroll its running cell into view.
	await jumpBtnA.click();
	await expect(tabA).toHaveAttribute('data-active', 'true'); // switched to A
	await expect(runningBarA('viewed-cell-24')).toBeVisible();
	await expect.poll(async () => visibleNotebookScrollTop(page), { timeout: 10_000 }).toBeGreaterThan(400);
	await page.screenshot({ path: join(EVIDENCE, '2-jumped-to-running-cell.png') });
	await expect(runningBarA('viewed-cell-24')).toBeHidden({ timeout: 30_000 }); // settle

	// ---- Phase 2: follow OFF. The jump must STILL work (it's an explicit action). ----
	await page.getByTestId('app-menu').click();
	const follow = page.getByTestId('toggle-follow-running-cell');
	await follow.click();
	await expect(follow).toHaveAttribute('aria-pressed', 'false');
	await page.keyboard.press('Escape');
	await page.mouse.click(400, 400);

	// View B again, run A deep, jump — with follow OFF, only the explicit jump scrolls.
	await tabB.locator('button', { hasText: 'other.ipynb' }).click();
	await expect(tabB).toHaveAttribute('data-active', 'true');
	await runCellOutOfBand(page, 'notebook.ipynb', 'viewed-cell-27', 6);
	await expect(jumpBtnA).toBeVisible({ timeout: 20_000 });
	await jumpBtnA.click();
	await expect(tabA).toHaveAttribute('data-active', 'true');
	await expect.poll(async () => visibleNotebookScrollTop(page), { timeout: 10_000 }).toBeGreaterThan(400);
	await page.screenshot({ path: join(EVIDENCE, '3-jump-works-with-follow-off.png') });
	await expect(runningBarA('viewed-cell-27')).toBeHidden({ timeout: 30_000 }); // settle

	// ---- Phase 3: a normal (non-spinner) tab click still just selects the tab. ----
	await tabB.locator('button', { hasText: 'other.ipynb' }).click();
	await expect(tabB).toHaveAttribute('data-active', 'true');
	await expect(tabA).toHaveAttribute('data-active', 'false');
});
