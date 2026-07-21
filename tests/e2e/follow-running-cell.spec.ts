import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * End-to-end proof of "follow the running cell" (commit 3463b9f), run as ONE
 * sequential scenario against a single live launcher (a shared kernel dislikes
 * overlapping runs from racing fresh contexts, so phases settle before the next):
 *
 *   A. Follow ON (default): a run in the VIEWED notebook scrolls its running cell
 *      into view — even when this tab did not start it (an out-of-band POST that
 *      stands in for another tab / an agent run in the same notebook). The
 *      viewport moves from the top down to the running cell.
 *   B. Follow OFF: the same run leaves the viewport where the user left it.
 *   C. Persistence: the OFF choice survives a full page reload (per-project
 *      UI-state store, not the .ipynb).
 *   D. No background hijack: with follow ON, a run in a DIFFERENT notebook the
 *      user is NOT looking at never moves the viewed notebook (`active` guard).
 *
 * Boots the REAL launcher (Node app + Jupyter sidecar + python3 kernel), so it
 * SKIPS when the runtime (uv + python3 + host-venv) is missing, like the smoke
 * spec. Screenshots are written for reviewer-visible evidence.
 */

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

const EVIDENCE = process.env.CELLAR_EVIDENCE_DIR || join(tmpdir(), 'cellar-follow-evidence');

/** An nbformat 4.5 notebook of `n` deliberately TALL code cells (so the notebook
 *  overflows the viewport and following is observable). Deterministic ids. */
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

/** scrollTop of the notebook's own scroll pane (the shell's overflow-y-auto). */
async function notebookScrollTop(page: Page): Promise<number> {
	return page.evaluate(() => {
		const cell = document.querySelector('[data-testid="cell"]');
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

async function scrollNotebookToTop(page: Page): Promise<void> {
	await page.evaluate(() => {
		const cell = document.querySelector('[data-testid="cell"]');
		let el: HTMLElement | null = cell as HTMLElement | null;
		while (el) {
			const s = getComputedStyle(el);
			if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight) {
				el.scrollTop = 0;
				return;
			}
			el = el.parentElement;
		}
	});
}

/** Fire a run of `cellId` in `nb` from the page's own fetch, with NO originId — so
 *  the viewing tab treats it as an external (other-tab / agent) run and reflects
 *  it live over SSE. `source` includes a short sleep so the cell stays "running"
 *  long enough to observe the viewport reaction. */
async function runCellOutOfBand(page: Page, nb: string, cellId: string, sleepS = 2): Promise<void> {
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
	workspace = mkdtempSync(join(tmpdir(), 'cellar-follow-'));
	writeFileSync(join(workspace, 'notebook.ipynb'), tallNotebook('viewed', 30));
	writeFileSync(join(workspace, 'background.ipynb'), tallNotebook('background', 12));
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

test('follow-the-running-cell: viewed-notebook follows, opt-out works + persists, background never hijacks', async ({
	page
}) => {
	test.setTimeout(180_000);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	// Fresh session → empty state offers to open the notebook; the existing 30-cell
	// notebook.ipynb on disk is opened untouched (30 cells proves it, not a fresh one).
	await page.getByTestId('empty-open-notebook').click();
	await expect.poll(async () => page.getByTestId('cell').count(), { timeout: 30_000 }).toBe(30);

	const runningBar = (id: string) => page.locator(`[data-cell-id="${id}"] [data-testid="running-bar"]`);
	const settle = async (id: string) =>
		expect(runningBar(id)).toBeHidden({ timeout: 30_000 });

	// ---- A. Follow ON (default): the viewed notebook follows its running cell ----
	await scrollNotebookToTop(page);
	expect(await notebookScrollTop(page)).toBeLessThan(20);

	await runCellOutOfBand(page, 'notebook.ipynb', 'viewed-cell-24');
	await expect(runningBar('viewed-cell-24')).toBeVisible({ timeout: 20_000 });
	await expect.poll(async () => notebookScrollTop(page), { timeout: 20_000 }).toBeGreaterThan(400);
	await page.screenshot({ path: join(EVIDENCE, '1-follow-on-scrolled.png') });
	const scrolledTop = await notebookScrollTop(page);
	await settle('viewed-cell-24');

	// ---- B. Follow OFF: the same run must NOT move the viewport ----
	await page.getByTestId('app-menu').click();
	const toggle = page.getByTestId('toggle-follow-running-cell');
	await expect(toggle).toHaveAttribute('aria-pressed', 'true'); // default ON
	await toggle.click();
	await expect(toggle).toHaveAttribute('aria-pressed', 'false');
	await page.keyboard.press('Escape');
	await page.mouse.click(400, 400); // dismiss the menu

	await scrollNotebookToTop(page);
	expect(await notebookScrollTop(page)).toBeLessThan(20);
	await runCellOutOfBand(page, 'notebook.ipynb', 'viewed-cell-24');
	await expect(runningBar('viewed-cell-24')).toBeVisible({ timeout: 20_000 });
	await page.waitForTimeout(1200); // give a broken scope time to (wrongly) scroll
	expect(await notebookScrollTop(page)).toBeLessThan(20);
	await page.screenshot({ path: join(EVIDENCE, '2-follow-off-stayed.png') });
	await settle('viewed-cell-24');

	// ---- C. Persistence: the OFF choice survives a reload ----
	await page.reload();
	await expect.poll(async () => page.getByTestId('cell').count(), { timeout: 30_000 }).toBe(30);
	await page.getByTestId('app-menu').click();
	await expect(page.getByTestId('toggle-follow-running-cell')).toHaveAttribute('aria-pressed', 'false');
	await page.screenshot({ path: join(EVIDENCE, '3-follow-off-persisted.png') });

	// Re-enable follow for the background test.
	await page.getByTestId('toggle-follow-running-cell').click();
	await expect(page.getByTestId('toggle-follow-running-cell')).toHaveAttribute('aria-pressed', 'true');
	await page.keyboard.press('Escape');
	await page.mouse.click(400, 400);

	// ---- D. No background hijack: a run in a notebook the user is NOT viewing ----
	await scrollNotebookToTop(page);
	expect(await notebookScrollTop(page)).toBeLessThan(20);
	await runCellOutOfBand(page, 'background.ipynb', 'background-cell-08', 3);
	await page.waitForTimeout(3000); // ample time for a broken scope to scroll
	expect(await notebookScrollTop(page)).toBeLessThan(20);
	await page.screenshot({ path: join(EVIDENCE, '4-background-no-hijack.png') });

	// Sanity: the ON scroll in phase A really was a large, deliberate move.
	expect(scrolledTop).toBeGreaterThan(400);
});
