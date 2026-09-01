import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * E2E: "Consolidate imports" as a toolbar button.
 *
 * Pure SURFACING — the sweep itself is `src/lib/server/imports-cell.ts` and is
 * covered by the unit suite — so what is proven here is the wiring, the gating and
 * the layout, not what consolidating does:
 *
 *  - the button renders in the toolbar beside "Clear all outputs", and clicking it
 *    really sweeps this notebook's imports into the pinned imports cell, asserted
 *    against the `.ipynb` ON DISK;
 *  - it acts on ITS OWN notebook, not on whichever tab is focused;
 *  - it cannot be fired twice: while a sweep is in flight the button is disabled
 *    and shows a spinner (the request is held open so that state is observable
 *    rather than raced);
 *  - the toolbar keeps every button reachable at a narrow window — one row at
 *    ordinary widths, wrapping rather than overflowing below that, and never a
 *    horizontal page scrollbar.
 *
 * ONE launcher for the file, one notebook per test — the sibling specs' shape.
 */

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

const NB = {
	sweep: 'sweep.ipynb',
	busy: 'busy.ipynb',
	layout: 'layout.ipynb',
	other: 'other.ipynb'
} as const;

/** A notebook whose imports are scattered below ordinary code. */
function scatteredImports(): string {
	const cells = [
		{ cell_type: 'markdown', id: 'c0', metadata: {}, source: ['# Report'] },
		{ cell_type: 'code', id: 'c1', metadata: {}, execution_count: null, outputs: [], source: ['import os\nhere = os.getcwd()'] },
		{ cell_type: 'code', id: 'c2', metadata: {}, execution_count: null, outputs: [], source: ['import json\nblob = json.dumps({})'] }
	];
	return JSON.stringify({
		cells,
		metadata: { kernelspec: { name: 'python3', display_name: 'python3' } },
		nbformat: 4,
		nbformat_minor: 5
	});
}

type DiskCell = { id: string; cell_type: string; source: string[]; metadata?: { cellar?: { role?: string } } };

function cellsOnDisk(file: string): DiskCell[] {
	return JSON.parse(readFileSync(join(workspace, file), 'utf8')).cells;
}

/** The source of the cell designated the imports cell, or null if there is none. */
function importsCellSource(file: string): string | null {
	const cell = cellsOnDisk(file).find((c) => c.metadata?.cellar?.role === 'imports');
	return cell ? cell.source.join('') : null;
}

async function openNotebook(page: Page, file: string): Promise<void> {
	await page.goto(baseURL);
	await page.getByTestId('tree-file').filter({ hasText: file }).first().click();
	await expect(page.getByTestId('notebook-toolbar')).toBeVisible({ timeout: 30_000 });
	await expect.poll(async () => page.getByTestId('cell').count(), { timeout: 30_000 }).toBeGreaterThan(0);
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-consolidate-'));
	for (const file of Object.values(NB)) writeFileSync(join(workspace, file), scatteredImports());
	const boot = await bootCellar(workspace);
	launcher = boot.proc;
	baseURL = boot.url;
});

test.afterAll(async () => {
	if (launcher) killCellar(launcher);
});

test('the toolbar button sweeps this notebook`s imports into the pinned cell', async ({ page }) => {
	await openNotebook(page, NB.sweep);
	expect(importsCellSource(NB.sweep), 'seeded with no imports cell').toBeNull();

	const button = page.getByTestId('consolidate-imports');
	await expect(button).toBeVisible();
	// It sits inside the toolbar, beside Clear all outputs — not somewhere else.
	await expect(page.getByTestId('notebook-toolbar').getByTestId('consolidate-imports')).toBeVisible();
	await button.click();

	await expect
		.poll(() => importsCellSource(NB.sweep), { timeout: 30_000 })
		.toMatch(/import json[\s\S]*import os|import os[\s\S]*import json/);

	// The imports really MOVED: neither body cell still declares one at module level.
	const bodies = cellsOnDisk(NB.sweep)
		.filter((c) => c.metadata?.cellar?.role !== 'imports')
		.map((c) => c.source.join(''));
	for (const body of bodies) expect(body).not.toMatch(/^import (os|json)$/m);
});

test('a sweep in flight disables the button, so it cannot be fired twice', async ({ page }) => {
	await openNotebook(page, NB.busy);

	// Hold the request open so the busy state is observable rather than raced.
	let release: (() => void) | null = null;
	const held = new Promise<void>((r) => (release = r));
	let calls = 0;
	await page.route('**/api/notebooks/imports', async (route) => {
		calls++;
		await held;
		await route.continue();
	});

	const button = page.getByTestId('consolidate-imports');
	await button.click();
	await expect(button).toBeDisabled();
	await expect(button.locator('.loading-spinner')).toBeVisible();

	// A second click while it is disabled reaches nothing.
	await button.click({ force: true }).catch(() => {});
	expect(calls, 'a second request was sent while one was in flight').toBe(1);

	release!();
	await expect(button).toBeEnabled({ timeout: 30_000 });
	await expect
		.poll(() => importsCellSource(NB.busy), { timeout: 30_000 })
		.toContain('import');
});

test('each notebook`s button acts on ITS OWN notebook', async ({ page }) => {
	// TWO notebooks open at once (double-click promotes out of the shared preview
	// slot, so both panes stay mounted) — which is what makes this a real test of
	// the per-notebook binding rather than of "the one notebook that exists".
	await page.goto(baseURL);
	for (const file of [NB.other, NB.layout]) {
		await page.getByTestId('tree-file').filter({ hasText: file }).first().dblclick();
		await expect(page.getByTestId('notebook-toolbar').filter({ visible: true })).toHaveCount(1, {
			timeout: 30_000
		});
	}
	// Both notebooks are mounted, so there are two toolbars — only the active tab's
	// is visible, and that is the one a user can click.
	const buttons = page.getByTestId('consolidate-imports');
	await expect.poll(async () => buttons.count(), { timeout: 30_000 }).toBeGreaterThan(1);

	const visible = buttons.filter({ visible: true });
	await expect(visible).toHaveCount(1);
	await visible.click();

	// `layout.ipynb` was opened last, so it is the active tab and the one that changes.
	await expect.poll(() => importsCellSource(NB.layout), { timeout: 30_000 }).toContain('import');
	expect(importsCellSource(NB.other), 'the notebook the user was NOT looking at was swept too').toBeNull();
});

test('the toolbar stays reachable as the window narrows', async ({ page }) => {
	await openNotebook(page, NB.sweep);
	const measure = () =>
		page.evaluate(() => {
			const bar = document.querySelector('[data-testid="notebook-toolbar"]') as HTMLElement;
			const btns = [...bar.querySelectorAll('button')] as HTMLElement[];
			return {
				rows: new Set(btns.map((b) => Math.round(b.getBoundingClientRect().top))).size,
				count: btns.length,
				overflows: bar.scrollWidth > bar.clientWidth + 1,
				pageScrolls: document.documentElement.scrollWidth > document.documentElement.clientWidth
			};
		});

	// One row at an ordinary window width, every button on it.
	await page.setViewportSize({ width: 1280, height: 800 });
	const wide = await measure();
	expect(wide.count).toBe(4);
	expect(wide.rows, 'the bar wraps at an ordinary width').toBe(1);
	expect(wide.overflows).toBe(false);
	expect(wide.pageScrolls).toBe(false);

	// Narrow: it may wrap onto a second row, but it must never clip a button out of
	// reach nor push the page into a horizontal scrollbar.
	for (const width of [900, 768, 640]) {
		await page.setViewportSize({ width, height: 800 });
		const m = await measure();
		expect(m.count, `a button vanished at ${width}px`).toBe(4);
		expect(m.overflows, `the toolbar overflows at ${width}px`).toBe(false);
		expect(m.pageScrolls, `the page scrolls horizontally at ${width}px`).toBe(false);
	}
});
