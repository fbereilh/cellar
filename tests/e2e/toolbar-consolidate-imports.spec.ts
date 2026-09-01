import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';
import { tabPanelDomId } from '../../src/lib/tabIds';

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
 *  - it acts on ITS OWN notebook, not on whichever tab is focused — proven by the
 *    notebook each POST NAMES, since a click on the active tab's own button is
 *    consistent with either binding and so discriminates nothing;
 *  - it cannot be fired twice: while a sweep is in flight the button is disabled
 *    and shows a spinner (the request is held open so that state is observable
 *    rather than raced) — and that busy state is per NOTEBOOK, so a second
 *    notebook stays clickable and sweeps concurrently;
 *  - a sweep that FAILS says so on the shell's transient notice line and leaves
 *    the button clickable again, rather than dying silently;
 *  - the toolbar keeps every button reachable at a narrow window — one row at
 *    ordinary widths, wrapping rather than overflowing below that, and never a
 *    horizontal page scrollbar.
 *
 * ONE launcher for the file, and every test ESTABLISHES ITS OWN TAB SET rather
 * than inheriting one. The tab session is SERVER-owned (`cellar-tabs:<workspace>`
 * in the `.cellar/` UI store), so a fresh browser context still restores it and
 * this file's single workspace would otherwise carry every notebook an earlier
 * test opened into the next — leaving several notebook panes mounted at once
 * (only the active one is visible), which both trips Playwright strict mode on an
 * unscoped `getByTestId('notebook-toolbar')` and makes a `document.querySelector`
 * measurement read a `display:none` pane's all-zero geometry. `beforeEach` clears
 * the session and every locator here is scoped to a pane.
 */

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

const NB = {
	sweep: 'sweep.ipynb',
	busy: 'busy.ipynb',
	failed: 'failed.ipynb',
	layout: 'layout.ipynb',
	other: 'other.ipynb',
	peerA: 'peer-a.ipynb',
	peerB: 'peer-b.ipynb'
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

/**
 * The consolidate button belonging to `file`'s OWN pane — visible or not.
 *
 * Addressed through the pane's DOM id rather than by visibility, because that is
 * what makes "acts on its own notebook" testable at all: the background pane is
 * `display:none`, so its button is only reachable by name, and every notebook the
 * tab session restores carries one of these too.
 */
function paneFor(page: Page, file: string) {
	return page.locator(`[id="${tabPanelDomId('file:' + file)}"]`);
}

function consolidateButtonFor(page: Page, file: string) {
	return paneFor(page, file).getByTestId('consolidate-imports');
}

/**
 * The toolbar of the pane the user is LOOKING AT.
 *
 * Every open notebook stays mounted (the inactive panes are `display:none`), so
 * an unscoped `getByTestId('notebook-toolbar')` names several elements and reads
 * the wrong one's geometry. Filtering by visibility is what makes "the toolbar"
 * a single, on-screen element whatever else happens to be open.
 */
function activeToolbar(page: Page) {
	return page.getByTestId('notebook-toolbar').filter({ visible: true });
}

/**
 * Forget the persisted tab session, so a test starts from an empty tab set.
 *
 * The key is read back from the store rather than rebuilt here: it is
 * `cellar-tabs:<workspace>` and the workspace the server reports need not be the
 * `mkdtemp` string this file holds (macOS resolves `/var` through `/private`).
 */
async function clearTabSession(page: Page): Promise<void> {
	const state = await (await page.request.get(`${baseURL}/api/ui-state`)).json();
	const cleared: Record<string, null> = {};
	for (const key of Object.keys(state ?? {})) if (key.startsWith('cellar-tabs:')) cleared[key] = null;
	if (Object.keys(cleared).length) await page.request.put(`${baseURL}/api/ui-state`, { data: cleared });
}

/** Records the notebook each POST to the sweep route names, in order. */
async function recordSweepTargets(page: Page, gate?: Promise<void>): Promise<string[]> {
	const posted: string[] = [];
	await page.route('**/api/notebooks/imports', async (route) => {
		posted.push(JSON.parse(route.request().postData() ?? '{}').path);
		if (gate) await gate;
		await route.continue();
	});
	return posted;
}

/** Opens `files` as permanent tabs (double-click promotes out of the preview slot). */
async function openBoth(page: Page, files: readonly string[]): Promise<void> {
	await page.goto(baseURL);
	for (const file of files) {
		await page.getByTestId('tree-file').filter({ hasText: file }).first().dblclick();
		await expect(activeToolbar(page)).toHaveCount(1, { timeout: 30_000 });
		await expect(consolidateButtonFor(page, file)).toBeVisible({ timeout: 30_000 });
	}
}

async function openNotebook(page: Page, file: string): Promise<void> {
	await page.goto(baseURL);
	await page.getByTestId('tree-file').filter({ hasText: file }).first().click();
	await expect(activeToolbar(page)).toHaveCount(1, { timeout: 30_000 });
	await expect(consolidateButtonFor(page, file)).toBeVisible({ timeout: 30_000 });
	await expect
		.poll(async () => paneFor(page, file).getByTestId('cell').count(), { timeout: 30_000 })
		.toBeGreaterThan(0);
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

// Every test establishes the tab set it needs, rather than inheriting whatever
// the one before it left in the server-owned session (see the file header).
test.beforeEach(async ({ page }) => {
	await clearTabSession(page);
});

test('the toolbar button sweeps this notebook`s imports into the pinned cell', async ({ page }) => {
	await openNotebook(page, NB.sweep);
	expect(importsCellSource(NB.sweep), 'seeded with no imports cell').toBeNull();

	const button = consolidateButtonFor(page, NB.sweep);
	await expect(button).toBeVisible();
	// It sits inside the toolbar, beside Clear all outputs — not somewhere else.
	await expect(activeToolbar(page).getByTestId('consolidate-imports')).toBeVisible();
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

	const button = consolidateButtonFor(page, NB.busy);
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

test('a failed sweep says so and leaves the button clickable', async ({ page }) => {
	await openNotebook(page, NB.failed);

	// The route rethrows every refusal as a 400 carrying its own message; the
	// button must not swallow that and re-enable as if the sweep had worked.
	await page.route('**/api/notebooks/imports', async (route) =>
		route.fulfill({
			status: 400,
			contentType: 'application/json',
			body: JSON.stringify({ message: 'no imports cell could be created' })
		})
	);

	const button = consolidateButtonFor(page, NB.failed);
	await button.click();

	await expect(page.getByTestId('app-notice')).toContainText('no imports cell could be created', {
		timeout: 30_000
	});
	// The per-path busy entry is released on the failure path too, so the notebook
	// is clickable again rather than stranded disabled.
	await expect(button).toBeEnabled({ timeout: 30_000 });

	// Nothing reached the server, so the notebook is untouched — and the notice
	// deliberately claims nothing about that either way.
	expect(importsCellSource(NB.failed)).toBeNull();

	// A retry is really sent: the refusal did not latch the notebook shut.
	let retries = 0;
	await page.route('**/api/notebooks/imports', async (route) => {
		retries++;
		await route.continue();
	});
	await button.click();
	await expect.poll(() => retries, { timeout: 30_000 }).toBe(1);
});

test('each notebook`s button names ITS OWN notebook, not the focused tab', async ({ page }) => {
	// TWO notebooks open at once (double-click promotes out of the shared preview
	// slot, so both panes stay mounted) — which is what makes this a real test of
	// the per-notebook binding rather than of "the one notebook that exists".
	// `layout.ipynb` is opened last, so it is the ACTIVE tab.
	await openBoth(page, [NB.other, NB.layout]);
	const posted = await recordSweepTargets(page);

	// The active tab's button names the active notebook — true either way, so this
	// half discriminates nothing on its own; it is the control for the one below.
	await consolidateButtonFor(page, NB.layout).click();
	await expect.poll(() => posted, { timeout: 30_000 }).toEqual([NB.layout]);
	await expect.poll(() => importsCellSource(NB.layout), { timeout: 30_000 }).toContain('import');
	expect(importsCellSource(NB.other), 'the notebook the user was NOT looking at was swept too').toBeNull();

	// THE DISCRIMINATING HALF: the BACKGROUND notebook's own button names ITS
	// notebook. Bound to the shell's `activeNotebookPath` instead, this second
	// request would name `layout.ipynb` again and `other.ipynb` would never change.
	// Its pane is `display:none`, so the click is dispatched rather than pointed.
	await consolidateButtonFor(page, NB.other).dispatchEvent('click');
	await expect.poll(() => posted, { timeout: 30_000 }).toEqual([NB.layout, NB.other]);
	await expect.poll(() => importsCellSource(NB.other), { timeout: 30_000 }).toContain('import');
});

test('the busy state is per notebook, so one sweep never disables another', async ({ page }) => {
	// `peer-b.ipynb` is opened last, so it is the ACTIVE tab.
	await openBoth(page, [NB.peerA, NB.peerB]);

	// Hold every sweep open so the busy state is observable rather than raced.
	let release: (() => void) | null = null;
	const held = new Promise<void>((r) => (release = r));
	const posted = await recordSweepTargets(page, held);

	const active = consolidateButtonFor(page, NB.peerB);
	const background = consolidateButtonFor(page, NB.peerA);

	await active.click();
	await expect(active).toBeDisabled();

	// A second click on the SAME notebook still sends nothing.
	await active.click({ force: true }).catch(() => {});
	expect(posted, 'a second request was sent for a notebook already sweeping').toEqual([NB.peerB]);

	// ...while the OTHER notebook is untouched: a shell-wide flag would disable it
	// here for a sweep that is not its own.
	expect(
		await background.isDisabled(),
		'a sweep disabled a notebook it was not for'
	).toBe(false);
	await background.dispatchEvent('click');
	await expect.poll(() => posted, { timeout: 30_000 }).toEqual([NB.peerB, NB.peerA]);

	release!();
	await expect(active).toBeEnabled({ timeout: 30_000 });
	for (const file of [NB.peerA, NB.peerB]) {
		await expect.poll(() => importsCellSource(file), { timeout: 30_000 }).toContain('import');
	}
});

test('the toolbar stays reachable as the window narrows', async ({ page }) => {
	await openNotebook(page, NB.sweep);
	// Read the toolbar the user can SEE. `document.querySelector` picks the first in
	// DOM order, which is pane (= open) order, so with more than one notebook open
	// it lands on a `display:none` pane whose every rect is all-zero — reporting one
	// row and no overflow at every width whatever the real layout does.
	const measure = () =>
		activeToolbar(page).evaluate((bar: HTMLElement) => {
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
