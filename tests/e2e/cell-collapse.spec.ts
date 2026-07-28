import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess, spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar, REPO } from './harness';
import { setScrollTop, isCellMounted } from './notebook-scroll';

/**
 * Full-cell collapse - hide a cell's INPUT and OUTPUT, leaving only its header -
 * exercised against DEFAULT-ON windowed rendering, because that is what shaped it.
 *
 * The rules are unit-tested (`tests/unit/cell-collapse.test.ts`). What only a real
 * browser can prove is what the feature actually promises:
 *
 *   A. one click hides the input AND the output, and the header that remains still
 *      names the cell (its id) and previews it;
 *   B. the toggle round-trips, and the collapse PERSISTS across a reload - in both
 *      directions, so expanding is as durable as collapsing;
 *   C. a collapsed cell that is windowed OUT and scrolled back is still collapsed
 *      and still compact: the state is a model record, not something a Cell instance
 *      remembers, and the window plans against the collapsed height;
 *   D. collapsing is VISUAL, not a disable - a collapsed cell still runs from its
 *      header (the output landing hidden, and there once expanded) and keyboard
 *      selection still lands on it without expanding it;
 *   E. deleting a collapsed cell drops its entry from the persisted record, so the
 *      per-notebook store cannot leak entries for cells that no longer exist;
 *   F. the three collapse-ish features stay independent: a full collapse leaves the
 *      editor-collapse choice and the heading fold exactly as they were.
 *
 * Boots the REAL launcher, so it SKIPS when that runtime is missing.
 */

const CELL_COUNT = 300;
const NB = 'notebook.ipynb';

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

/** The notebook's cells (id + type + source) in document order, from the server model. */
async function serverCells(page: Page): Promise<{ id: string; cell_type: string; source: string }[]> {
	return page.evaluate(async (nb) => {
		const res = await fetch(`/api/notebooks?path=${encodeURIComponent(nb)}`);
		const body = await res.json();
		return (body.notebook.cells as { id: string; cell_type: string; source: string }[]).map((c) => ({
			id: c.id,
			cell_type: c.cell_type,
			source: c.source
		}));
	}, NB);
}

/** This notebook's persisted collapsed-cell record, straight from the UI store. */
async function persistedCollapsed(page: Page): Promise<Record<string, unknown>> {
	return page.evaluate(async () => {
		const res = await fetch('/api/ui-state');
		const store = (await res.json()) as Record<string, Record<string, unknown> | undefined>;
		const key = Object.keys(store).find((k) => k.startsWith('cellar-cell-collapsed:'));
		return key ? ((store[key] ?? {}) as Record<string, unknown>) : {};
	});
}

/** Rewrite a cell's source server-side (the fixture is generic; some tests need a
 *  specific shape - a self-contained print, an editor tall enough to auto-collapse). */
async function setCellSource(page: Page, id: string, source: string): Promise<void> {
	await page.evaluate(
		async ({ nb, cellId, src }) => {
			await fetch(`/api/cells/${cellId}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ source: src, nb })
			});
		},
		{ nb: NB, cellId: id, src: source }
	);
}

const cell = (page: Page, id: string) => page.locator(`[data-cell-id="${id}"]`);
const collapseToggle = (page: Page, id: string) => cell(page, id).getByTestId('cell-collapse-toggle');
const spacers = (page: Page) => page.locator('[data-testid="cell-spacer"]').count();

/**
 * Drive a cell to a KNOWN collapse state rather than blind-toggling.
 *
 * The state is persisted, and every test in this file shares one workspace, so a
 * test that assumed "starts expanded" would depend on an earlier test's cleanup
 * having flushed to the server before its page closed - a race, not a contract.
 */
async function setCollapsed(page: Page, id: string, want: boolean): Promise<void> {
	const toggle = collapseToggle(page, id);
	await expect(toggle).toBeVisible();
	if (((await toggle.getAttribute('data-collapsed')) === 'true') !== want) await toggle.click();
	await expect(toggle).toHaveAttribute('aria-expanded', String(!want));
}

/** Open the notebook windowed (the shipping default) and settle at the top. */
async function openWindowed(page: Page): Promise<void> {
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}&virtualize=1`);
	const openButton = page.getByTestId('empty-open-notebook');
	if (await openButton.isVisible({ timeout: 10_000 }).catch(() => false)) await openButton.click();
	await expect(page.getByTestId('cell').first()).toBeVisible({ timeout: 30_000 });
	await expect.poll(() => spacers(page), { timeout: 30_000 }).toBeGreaterThan(0);
	await setScrollTop(page, 0);
	await page.waitForTimeout(300);
}

/** Height of a cell's card (px). */
async function cardHeight(page: Page, id: string): Promise<number> {
	const box = await cell(page, id).boundingBox();
	return box?.height ?? -1;
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-cell-collapse-'));
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

test('one click collapses a cell to a header that still names it, and expands it back', async ({ page }) => {
	test.setTimeout(120_000);
	await openWindowed(page);

	const cells = await serverCells(page);
	// A code cell carrying an OUTPUT, so the collapse has both halves to hide.
	const target = cells.filter((c) => c.cell_type === 'code' && c.source.startsWith('print('))[0];
	expect(target).toBeTruthy();

	const card = cell(page, target.id);
	await setCollapsed(page, target.id, false);
	await expect(card.getByTestId('editor-scroll')).toBeVisible();
	await expect(card.getByTestId('output')).toBeVisible();
	const expandedHeight = await cardHeight(page, target.id);

	// ---- A. input + output gone; the header names and previews the cell ----
	await collapseToggle(page, target.id).click();
	await expect(collapseToggle(page, target.id)).toHaveAttribute('data-collapsed', 'true');
	await expect(card.getByTestId('editor-scroll')).toBeHidden();
	await expect(card.getByTestId('output')).toBeHidden();
	await expect(card.getByTestId('static-code')).toBeHidden();
	// The cell id stays visible - it is how a collapsed cell is identified - and the
	// preview says which cell this is at a glance.
	await expect(card.getByTestId('cell-id-copy')).toBeVisible();
	await expect(card.getByTestId('cell-id-copy')).toContainText(target.id.slice(0, 4));
	await expect(card.getByTestId('collapsed-preview')).toHaveText(target.source.split('\n')[0].trim());

	// Compact: the card is now its header row and nothing else.
	const collapsedHeight = await cardHeight(page, target.id);
	expect(collapsedHeight).toBeLessThan(60);
	expect(collapsedHeight).toBeLessThan(expandedHeight / 2);

	// ---- B (first half). the toggle round-trips ----
	await collapseToggle(page, target.id).click();
	await expect(card.getByTestId('editor-scroll')).toBeVisible();
	await expect(card.getByTestId('output')).toBeVisible();
	await expect(card.getByTestId('collapsed-preview')).toHaveCount(0);
	expect(Math.abs((await cardHeight(page, target.id)) - expandedHeight)).toBeLessThan(4);

	// Clicking the collapsed HEADER (not the chevron) expands too - the disclosure
	// convention, and the affordance reached for before the chevron is found.
	await collapseToggle(page, target.id).click();
	await expect(card.getByTestId('editor-scroll')).toBeHidden();
	const box = (await card.boundingBox())!;
	await card.click({ position: { x: Math.round(box.width / 2), y: Math.round(box.height / 2) } });
	await expect(card.getByTestId('editor-scroll')).toBeVisible();
});

test('the collapse persists across a reload - and so does expanding again', async ({ page }) => {
	test.setTimeout(120_000);
	await openWindowed(page);

	const cells = await serverCells(page);
	const target = cells[1];

	await setCollapsed(page, target.id, true);
	await expect(cell(page, target.id).getByTestId('editor-scroll')).toBeHidden();
	// The UI-store write is debounced, so give it a moment to reach the server.
	await expect.poll(() => persistedCollapsed(page).then((r) => r[target.id]), { timeout: 10_000 }).toBe(true);

	await openWindowed(page);
	await expect(collapseToggle(page, target.id)).toHaveAttribute('data-collapsed', 'true');
	await expect(cell(page, target.id).getByTestId('editor-scroll')).toBeHidden();

	// ---- B (second half). expanding is just as durable ----
	await collapseToggle(page, target.id).click();
	await expect(cell(page, target.id).getByTestId('editor-scroll')).toBeVisible();
	await expect.poll(() => persistedCollapsed(page).then((r) => target.id in r), { timeout: 10_000 }).toBe(false);

	await openWindowed(page);
	await expect(collapseToggle(page, target.id)).not.toHaveAttribute('data-collapsed', 'true');
	await expect(cell(page, target.id).getByTestId('editor-scroll')).toBeVisible();
});

test('a collapsed cell windowed out and scrolled back is still collapsed and still compact', async ({ page }) => {
	test.setTimeout(120_000);
	await openWindowed(page);

	const cells = await serverCells(page);
	const target = cells[2];

	await setCollapsed(page, target.id, true);
	await expect(cell(page, target.id).getByTestId('editor-scroll')).toBeHidden();
	const collapsedHeight = await cardHeight(page, target.id);

	// Move the selection (and DOM focus) off it first: the PRIMARY and the focused
	// cell are both PINNED mounted wherever they are, so a cell that is still either
	// would never leave the window and this would prove nothing.
	const other = cell(page, cells[0].id);
	const otherBox = (await other.boundingBox())!;
	await other.click({ position: { x: Math.round(otherBox.width / 2), y: 14 } });
	await expect(other).toHaveAttribute('data-active', 'true');

	// ---- C. leave the window entirely, then come back ----
	await setScrollTop(page, 20_000);
	await page.waitForTimeout(400);
	await expect.poll(() => isCellMounted(page, target.id), { timeout: 10_000 }).toBe(false);

	await setScrollTop(page, 0);
	await page.waitForTimeout(400);
	await expect.poll(() => isCellMounted(page, target.id), { timeout: 10_000 }).toBe(true);
	await expect(collapseToggle(page, target.id)).toHaveAttribute('data-collapsed', 'true');
	await expect(cell(page, target.id).getByTestId('editor-scroll')).toBeHidden();
	// Re-mounted at its collapsed size, so the window's height model still matches
	// what is actually on screen.
	expect(Math.abs((await cardHeight(page, target.id)) - collapsedHeight)).toBeLessThan(2);

});

test('a collapsed cell still runs, and keyboard selection lands on it without expanding it', async ({ page }) => {
	test.setTimeout(180_000);
	await openWindowed(page);

	const cells = await serverCells(page);
	// A code cell near the top, so it and its neighbour are inside the window at
	// rest (this spec runs at the shipped windowing default, and a spacer has no
	// toolbar to click). Sharing a cell with an earlier test is safe: every test here
	// drives the collapse to a KNOWN state rather than assuming one.
	const target = cells.filter((c) => c.cell_type === 'code' && c.source.startsWith('print('))[0];
	const above = cells[cells.indexOf(target) - 1];

	// Give the cell something self-contained to print, so the run's own output is
	// distinguishable from the fixture's.
	await setCellSource(page, target.id, 'print("collapsed-run-ok")');
	await openWindowed(page);

	await setCollapsed(page, target.id, true);
	const card = cell(page, target.id);
	await expect(card.getByTestId('editor-scroll')).toBeHidden();

	// ---- D. run it from the collapsed header ----
	await card.getByTestId('run').click();
	// The header stays informative while the run happens: the run-status badge lands
	// on it even though nothing of the body is showing.
	await expect(card.getByTestId('run-meta')).toBeVisible({ timeout: 90_000 });
	// The output arrived, and stayed hidden while the cell is collapsed.
	await expect(card.getByTestId('output')).toBeHidden();

	await setCollapsed(page, target.id, false);
	await expect(card.getByTestId('output')).toBeVisible();
	await expect(card.getByTestId('output')).toContainText('collapsed-run-ok');

	// ---- D (second half). j/k lands on a collapsed cell, leaving it collapsed ----
	await setCollapsed(page, target.id, true);
	await expect(card.getByTestId('editor-scroll')).toBeHidden();
	const aboveBox = (await cell(page, above.id).boundingBox())!;
	await cell(page, above.id).click({ position: { x: Math.round(aboveBox.width / 2), y: 14 } });
	await expect(cell(page, above.id)).toHaveAttribute('data-active', 'true');
	await page.keyboard.press('j');
	await expect(card).toHaveAttribute('data-active', 'true');
	await expect(card.getByTestId('editor-scroll')).toBeHidden(); // selection is not edit-intent
	// Moving on off it leaves it collapsed too.
	await page.keyboard.press('k');
	await expect(cell(page, above.id)).toHaveAttribute('data-active', 'true');
	await expect(card.getByTestId('editor-scroll')).toBeHidden();
});

test('deleting a collapsed cell drops its entry from the persisted record', async ({ page }) => {
	test.setTimeout(120_000);
	await openWindowed(page);

	const before = await serverCells(page);
	const target = before[4];

	await setCollapsed(page, target.id, true);
	await expect.poll(() => persistedCollapsed(page).then((r) => r[target.id]), { timeout: 10_000 }).toBe(true);

	// ---- E. delete it; the record must not keep an entry for a cell that is gone ----
	await cell(page, target.id).getByTestId('delete').click();
	await expect.poll(async () => (await serverCells(page)).some((c) => c.id === target.id), { timeout: 10_000 }).toBe(false);
	await expect.poll(() => persistedCollapsed(page).then((r) => target.id in r), { timeout: 10_000 }).toBe(false);
});

test('a full collapse leaves the editor-collapse choice and the heading fold untouched', async ({ page }) => {
	test.setTimeout(120_000);
	await openWindowed(page);

	const cells = await serverCells(page);
	// An editor tall enough to pass the auto-collapse cap, so the editor-collapse
	// toggle is actually offered (the fixture's cells sit just under it).
	const tall = cells.filter((c) => c.cell_type === 'code' && c.source.startsWith('def process_'))[1];
	await setCellSource(page, tall.id, Array.from({ length: 60 }, (_, k) => `step_${k} = ${k}`).join('\n'));
	await openWindowed(page);
	const card = cell(page, tall.id);

	// ---- F. the editor-collapse choice survives a full collapse round-trip ----
	// A tall editor AUTO-collapses, so one click records the explicit opposite
	// choice: "keep this editor at full height". A full collapse must not disturb it
	// (nor let the auto rule quietly reassert itself when the editor re-appears).
	await expect(card.getByTestId('editor-scroll')).toHaveAttribute('data-collapsed', 'true');
	await card.getByTestId('editor-collapse-toggle').click();
	await expect(card.getByTestId('editor-scroll')).not.toHaveAttribute('data-collapsed', 'true');

	await setCollapsed(page, tall.id, true);
	await expect(card.getByTestId('editor-scroll')).toBeHidden();
	await setCollapsed(page, tall.id, false);
	await expect(card.getByTestId('editor-scroll')).toBeVisible();
	await expect(card.getByTestId('editor-scroll')).not.toHaveAttribute('data-collapsed', 'true');

	// A folded heading still hides its section, and a collapsed cell inside it is
	// hidden by the fold rather than fighting it.
	const heading = page.getByTestId('fold-toggle').first();
	await heading.click();
	await expect(page.getByTestId('fold-hidden-count').first()).toBeVisible();
	await heading.click();
	await expect(page.getByTestId('fold-hidden-count')).toHaveCount(0);
});
