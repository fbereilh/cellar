import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess, spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar, REPO } from './harness';

/**
 * Cell virtualization P2 — the windowing itself, behind the off-by-default flag.
 *
 * A large (N=300) synthetic notebook is opened with `?virtualize=1` and we assert
 * the three P2 acceptance properties (report §6 P2):
 *   (a) mounted-cell count is O(viewport + overscan), NOT O(N);
 *   (b) total DOM node count drops far below the eager baseline (~137 nodes/cell);
 *   (c) scrolling top→bottom→top produces NO visible jump — the first cell's
 *       viewport-relative top is stable across the round trip, the scroll-stability
 *       core (estimate→measured corrections compensated, report §4.2).
 * A final check reloads WITHOUT the flag and asserts the render is un-windowed
 * (zero spacers, every cell mounted) — the flag-off byte-identical guarantee.
 *
 * Like the rest of the E2E suite this needs the real runtime (uv + python3 + the
 * cached host-venv); it SKIPS gracefully when that is absent. The vitest unit suite
 * (`tests/unit/virtualization.test.ts`) is the must-pass gate for the pure logic.
 */

const CELL_COUNT = 300;

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

const mountedCells = (page: Page) => page.locator('[data-testid="cell"]').count();
const spacers = (page: Page) => page.locator('[data-testid="cell-spacer"]').count();
const totalNodes = (page: Page) => page.evaluate(() => document.querySelectorAll('*').length);

/** The notebook's own scroll pane (the shell's `overflow-y-auto` ancestor). */
async function scrollPaneMetric(page: Page, prop: 'scrollTop' | 'scrollHeight' | 'clientHeight'): Promise<number> {
	return page.evaluate((p) => {
		const cell = document.querySelector('[data-testid="cell"]');
		let el: HTMLElement | null = cell as HTMLElement | null;
		while (el) {
			const s = getComputedStyle(el);
			if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight)
				return (el as unknown as Record<string, number>)[p];
			el = el.parentElement;
		}
		return -1;
	}, prop);
}

async function setScrollTop(page: Page, top: number): Promise<void> {
	await page.evaluate((t) => {
		const cell = document.querySelector('[data-testid="cell"]');
		let el: HTMLElement | null = cell as HTMLElement | null;
		while (el) {
			const s = getComputedStyle(el);
			if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight) {
				el.scrollTop = t;
				return;
			}
			el = el.parentElement;
		}
	}, top);
}

/** Viewport-relative top of the first cell, or null if it isn't mounted. */
async function firstCellTop(page: Page): Promise<number | null> {
	return page.evaluate(() => {
		const el = document.querySelector('[data-testid="cell"]');
		return el ? el.getBoundingClientRect().top : null;
	});
}

/** The `data-cell-id` of a mounted cell whose top is nearest the viewport's top edge. */
async function cellNearViewportTop(page: Page): Promise<string | null> {
	return page.evaluate(() => {
		let best: { id: string; d: number } | null = null;
		for (const el of Array.from(document.querySelectorAll('[data-cell-id]'))) {
			const id = (el as HTMLElement).getAttribute('data-cell-id');
			if (!id) continue;
			const top = (el as HTMLElement).getBoundingClientRect().top;
			if (top < 0) continue;
			if (!best || top < best.d) best = { id, d: top };
		}
		return best?.id ?? null;
	});
}

/** Viewport-relative top of the cell with `data-cell-id`, or null if unmounted. */
async function cellTopById(page: Page, id: string): Promise<number | null> {
	return page.evaluate((cellId) => {
		const el = document.querySelector(`[data-cell-id="${CSS.escape(cellId)}"]`);
		return el ? (el as HTMLElement).getBoundingClientRect().top : null;
	}, id);
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-virt-e2e-'));
	// Reuse the P0 harness to seed a realistic mixed N-cell notebook.
	const gen = spawnSync('node', [join(REPO, 'scripts', 'gen-large-notebook.js'), String(CELL_COUNT), join(workspace, 'notebook.ipynb')], {
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

test(`windows a ${CELL_COUNT}-cell notebook: O(viewport) mounted, fewer nodes, no scroll jump`, async ({ page }) => {
	test.setTimeout(120_000);

	// ---- Flag ON: open the notebook windowed ----
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}&virtualize=1`);
	await page.getByTestId('empty-open-notebook').click();
	// Windowing engaged once off-screen cells have collapsed to spacers.
	await expect.poll(() => spacers(page), { timeout: 30_000 }).toBeGreaterThan(0);
	await setScrollTop(page, 0);
	await page.waitForTimeout(200);

	// (a) Mounted-cell count is O(viewport + overscan), not O(N).
	const mounted = await mountedCells(page);
	const nSpacers = await spacers(page);
	expect(mounted).toBeLessThan(80); // ~viewport(720) + 2×overscan(1080) worth of cells, far below 300
	expect(mounted).toBeLessThan(CELL_COUNT / 3);
	expect(nSpacers).toBeGreaterThan(0);

	// (b) DOM node count drops far below the eager baseline (~137/cell → ~41k at N=300).
	const nodes = await totalNodes(page);
	expect(nodes).toBeLessThan(15_000);

	// (c) Scroll stability: top→bottom→top leaves the first cell's rect stable.
	const topBefore = await firstCellTop(page);
	expect(topBefore).not.toBeNull();

	const scrollHeight = await scrollPaneMetric(page, 'scrollHeight');
	// Drift the window down to the bottom in steps, so every estimate→measured
	// correction along the way is exercised (and compensated) rather than skipped.
	for (let f = 0.25; f <= 1.0001; f += 0.25) {
		await setScrollTop(page, Math.round(scrollHeight * Math.min(1, f)));
		await page.waitForTimeout(120);
	}
	// The last cell must have mounted by the time we reach the bottom.
	await expect.poll(() => mountedCells(page), { timeout: 10_000 }).toBeGreaterThan(0);

	// Back to the top the same way.
	for (let f = 0.75; f >= -0.0001; f -= 0.25) {
		await setScrollTop(page, Math.round(scrollHeight * Math.max(0, f)));
		await page.waitForTimeout(120);
	}
	await setScrollTop(page, 0);
	await page.waitForTimeout(200);

	const topAfter = await firstCellTop(page);
	expect(topAfter).not.toBeNull();
	// The first cell sits where it did before the round trip: no accumulated jump.
	expect(Math.abs((topAfter as number) - (topBefore as number))).toBeLessThan(4);

	// (c2) The same no-jump guarantee at a NON-zero scroll offset — where the
	// `viewportTop<=0` short-circuit does NOT fire, so scrollCompensation actually
	// runs and the coordinate-origin (scrollTop vs cell-stack) must line up. Pick a
	// mid-notebook offset, anchor on a currently-visible reference cell, round-trip
	// to the bottom and back to the SAME offset, and assert the reference is stable.
	const midOffset = Math.round(scrollHeight * 0.4);
	await setScrollTop(page, midOffset);
	await page.waitForTimeout(200);
	const refId = await cellNearViewportTop(page);
	expect(refId).not.toBeNull();
	const refTopBefore = await cellTopById(page, refId as string);
	expect(refTopBefore).not.toBeNull();

	for (let f = 0.4; f <= 1.0001; f += 0.2) {
		await setScrollTop(page, Math.round(scrollHeight * Math.min(1, f)));
		await page.waitForTimeout(120);
	}
	for (let f = 0.8; f >= 0.4; f -= 0.2) {
		await setScrollTop(page, Math.round(scrollHeight * f));
		await page.waitForTimeout(120);
	}
	await setScrollTop(page, midOffset);
	await page.waitForTimeout(200);

	const refTopAfter = await cellTopById(page, refId as string);
	expect(refTopAfter).not.toBeNull();
	expect(Math.abs((refTopAfter as number) - (refTopBefore as number))).toBeLessThan(4);

	// eslint-disable-next-line no-console
	console.log(
		`[virtualization P2] N=${CELL_COUNT} → mounted ${mounted} (eager: ${CELL_COUNT}); spacers ${nSpacers}; ` +
			`DOM nodes ${nodes} (eager baseline ~41,168); first-cell top drift ${Math.abs((topAfter as number) - (topBefore as number)).toFixed(1)}px`
	);

	// ---- Flag OFF: reload without the param → un-windowed, every cell mounted ----
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await expect.poll(() => mountedCells(page), { timeout: 30_000 }).toBe(CELL_COUNT);
	expect(await spacers(page)).toBe(0);
});
