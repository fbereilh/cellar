import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess, spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar, REPO } from './harness';
import { setScrollTop, isCellMounted, mountedCellIds } from './notebook-scroll';

/**
 * Multi-cell selection, exercised against DEFAULT-ON windowed rendering.
 *
 * The rules themselves are unit-tested (`tests/unit/cell-selection.test.ts`) and
 * the batch document writes too (`tests/unit/bulk-cell-ops.test.ts`). What only a
 * real browser can prove is the interaction this feature had to be SHAPED around:
 * windowing means most of a large notebook has no DOM at all, so
 *
 *   A. a Shift range whose endpoints straddle the window still selects every cell
 *      between them - including the hundreds with no node - and a bulk delete then
 *      removes exactly those, no more and no fewer;
 *   B. a selected cell that was windowed OUT renders selected the moment it
 *      scrolls back in (the highlight is derived from the model set, not
 *      remembered by a cell instance);
 *   C. Cmd/Ctrl+click builds a genuinely non-contiguous selection and the bulk
 *      retype hits exactly its members;
 *   D. Shift+J extends, a bulk move carries the block and keeps it selected, and a
 *      plain click / Escape collapses back to one cell;
 *   E. Cmd/Ctrl+A selects the FULL document - fold-hidden cells included - so a
 *      collapsed section can never be left behind by the selection that moves it;
 *   F. toggling the primary OUT of a selection MOUNTS the survivor it hands primacy
 *      to, so focus follows the selection and the next keystroke still has a target.
 *
 * Every assertion about WHICH cells an op touched reads the SERVER document, not
 * the DOM: the DOM can only ever show the window, and "it looked right on screen"
 * is exactly the failure mode this spec exists to rule out.
 *
 * Boots the REAL launcher, so it SKIPS when that runtime is missing.
 */

const CELL_COUNT = 300;
const NB = 'notebook.ipynb';
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

/** The notebook's cell ids in document order, straight from the server model. */
async function serverOrder(page: Page): Promise<string[]> {
	return page.evaluate(async (nb) => {
		const res = await fetch(`/api/notebooks?path=${encodeURIComponent(nb)}`);
		const body = await res.json();
		return (body.notebook.cells as { id: string }[]).map((c) => c.id);
	}, NB);
}

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

/** The notebook's cell types in document order, from the server model. */
async function serverTypes(page: Page): Promise<string[]> {
	return page.evaluate(async (nb) => {
		const res = await fetch(`/api/notebooks?path=${encodeURIComponent(nb)}`);
		const body = await res.json();
		return (body.notebook.cells as { cell_type: string }[]).map((c) => c.cell_type);
	}, NB);
}

/**
 * Click a mounted cell to select it. Lands on the empty middle of the cell's
 * toolbar strip: clicking the editor would open it (and collapse the selection),
 * and the toolbar's own controls sit at the two ends.
 */
async function clickCell(page: Page, id: string, modifiers: ('Shift' | 'Meta' | 'Control')[] = []) {
	const card = page.locator(`[data-cell-id="${id}"]`);
	const box = await card.boundingBox();
	if (!box) throw new Error(`cell ${id} is not mounted`);
	await card.click({ position: { x: Math.round(box.width / 2), y: 14 }, modifiers });
}

const selectedInDom = (page: Page) => page.locator('[data-testid="cell"][data-selected="true"]').count();
const visibleCellIds = (page: Page) =>
	page.locator('[data-testid="cell"]:visible').evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.cellId ?? ''));
const spacers = (page: Page) => page.locator('[data-testid="cell-spacer"]').count();

/** Open the notebook and wait for its cells, at the given windowing mode. */
async function openNotebook(page: Page, virtualize: '0' | '1'): Promise<void> {
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}&virtualize=${virtualize}`);
	const openButton = page.getByTestId('empty-open-notebook');
	if (await openButton.isVisible({ timeout: 10_000 }).catch(() => false)) await openButton.click();
	await expect(page.getByTestId('cell').first()).toBeVisible({ timeout: 30_000 });
}

/** Open the notebook windowed and settle at the top. */
async function openWindowed(page: Page): Promise<void> {
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}&virtualize=1`);
	const openButton = page.getByTestId('empty-open-notebook');
	if (await openButton.isVisible({ timeout: 10_000 }).catch(() => false)) await openButton.click();
	await expect(page.getByTestId('cell').first()).toBeVisible({ timeout: 30_000 });
	await expect.poll(() => spacers(page), { timeout: 30_000 }).toBeGreaterThan(0);
	await setScrollTop(page, 0);
	await page.waitForTimeout(300);
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-multi-select-'));
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

test('a Shift range across the window boundary selects, shows and deletes exactly the right cells', async ({ page }) => {
	test.setTimeout(120_000);
	await openWindowed(page);

	const order = await serverOrder(page);
	expect(order).toHaveLength(CELL_COUNT);

	// The anchor: a cell mounted at the top of the notebook.
	const anchor = order[2];
	await clickCell(page, anchor);
	await expect(page.locator(`[data-cell-id="${anchor}"]`)).toHaveAttribute('data-active', 'true');
	await expect(page.getByTestId('selection-count')).toHaveCount(0); // a lone cell is not a "selection"

	// Scroll far away and pick a cell that IS mounted down here as the other end of
	// the range. (The anchor is still mounted at this point - it is the PRIMARY, and
	// the primary is pinned. It stops being the primary the instant the Shift+click
	// moves the head, and unmounts below.)
	await setScrollTop(page, 14_000);
	await page.waitForTimeout(400);
	const mountedBelow = await mountedCellIds(page);
	const target = mountedBelow[Math.floor(mountedBelow.length / 2)];
	const from = order.indexOf(anchor);
	const to = order.indexOf(target);
	expect(to).toBeGreaterThan(from + 20); // a range with many unmounted members

	await clickCell(page, target, ['Shift']);

	// ---- A. the selection spans cells that have no DOM node at all ----
	const expected = to - from + 1;
	await expect(page.getByTestId('selection-count')).toHaveText(`${expected} selected`);
	// The proof it is a MODEL selection: far more cells are selected than are
	// mounted, and the anchor itself - now an ordinary member, no longer the pinned
	// primary - has no DOM node at all. Selected cells are deliberately NOT pinned:
	// pinning them would mount the whole range and undo windowing.
	expect(await selectedInDom(page)).toBeLessThan(expected);
	await expect.poll(() => isCellMounted(page, anchor), { timeout: 5_000 }).toBe(false);

	// ---- B. a windowed-out member renders selected once it scrolls in ----
	await setScrollTop(page, 0);
	await page.waitForTimeout(400);
	await expect(page.locator(`[data-cell-id="${anchor}"]`)).toHaveAttribute('data-selected', 'true');
	const midway = order[from + Math.floor((to - from) / 2)];
	await setScrollTop(page, 7_000);
	await page.waitForTimeout(400);
	if (await isCellMounted(page, midway)) {
		await expect(page.locator(`[data-cell-id="${midway}"]`)).toHaveAttribute('data-selected', 'true');
	}
	// …and a cell OUTSIDE the range that is mounted right beside them is not.
	const outside = order[to + 5];
	await setScrollTop(page, 14_000);
	await page.waitForTimeout(400);
	if (await isCellMounted(page, outside)) {
		await expect(page.locator(`[data-cell-id="${outside}"]`)).not.toHaveAttribute('data-selected', 'true');
	}

	// ---- A (continued). one action deletes exactly the range ----
	await page.keyboard.press('d');
	await page.keyboard.press('d');
	await expect.poll(async () => (await serverOrder(page)).length, { timeout: 20_000 }).toBe(CELL_COUNT - expected);
	const after = await serverOrder(page);
	expect(after).toEqual([...order.slice(0, from), ...order.slice(to + 1)]);
	// The selection collapsed onto the cell that slid into the range's place.
	await expect(page.getByTestId('selection-count')).toHaveCount(0);
});

test('Cmd/Ctrl+click builds a non-contiguous selection, and bulk retype converts exactly its members', async ({ page }) => {
	test.setTimeout(120_000);
	await openWindowed(page);
	const order = await serverOrder(page);
	const typesBefore = await serverTypes(page);

	// Three scattered cells among the ones mounted at the top.
	const mounted = await mountedCellIds(page);
	expect(mounted.length).toBeGreaterThanOrEqual(4);
	const [a, , c, d] = mounted;
	await clickCell(page, a);
	await clickCell(page, c, [MOD]);
	await clickCell(page, d, [MOD]);

	await expect(page.getByTestId('selection-count')).toHaveText('3 selected');
	// Genuinely non-contiguous: the cell between two members is NOT selected.
	const between = mounted[1];
	await expect(page.locator(`[data-cell-id="${between}"]`)).not.toHaveAttribute('data-selected', 'true');

	// Toggling a member back out shrinks the selection rather than replacing it.
	await clickCell(page, d, [MOD]);
	await expect(page.getByTestId('selection-count')).toHaveText('2 selected');
	await clickCell(page, d, [MOD]);

	// `m` → markdown, for the whole selection, in one action.
	await page.keyboard.press('m');
	const picked = new Set([a, c, d]);
	await expect
		.poll(async () => (await serverTypes(page)).filter((t) => t === 'markdown').length, { timeout: 20_000 })
		.toBe(typesBefore.filter((t) => t === 'markdown').length + order.filter((id) => picked.has(id) && typesBefore[order.indexOf(id)] === 'code').length);
	const typesAfter = await serverTypes(page);
	order.forEach((id, i) => {
		if (picked.has(id)) expect(typesAfter[i]).toBe('markdown');
		else expect(typesAfter[i]).toBe(typesBefore[i]); // nothing else moved
	});
});

test('Shift+J extends, a bulk move carries the block, and a plain click / Escape collapses', async ({ page }) => {
	test.setTimeout(120_000);
	await openWindowed(page);
	const order = await serverOrder(page);
	const mounted = await mountedCellIds(page);
	const start = mounted[1];
	const from = order.indexOf(start);

	await clickCell(page, start);
	await page.keyboard.press('Shift+j');
	await page.keyboard.press('Shift+j');
	await expect(page.getByTestId('selection-count')).toHaveText('3 selected');
	const block = order.slice(from, from + 3);

	// Shrinking back is the same rule in reverse (the range re-derives from the anchor).
	await page.keyboard.press('Shift+k');
	await expect(page.getByTestId('selection-count')).toHaveText('2 selected');
	await page.keyboard.press('Shift+j');

	// Move the block down one: it slides as a unit and stays selected.
	await page.keyboard.press(`${MOD}+Shift+ArrowDown`);
	await expect
		.poll(async () => (await serverOrder(page)).indexOf(block[0]), { timeout: 20_000 })
		.toBe(from + 1);
	const moved = await serverOrder(page);
	expect(moved.slice(from + 1, from + 4)).toEqual(block); // contiguous, same order
	expect(moved[from]).toBe(order[from + 3]); // the cell it stepped over
	expect(moved).toHaveLength(order.length);
	await expect(page.getByTestId('selection-count')).toHaveText('3 selected');

	// Escape collapses to the primary…
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('selection-count')).toHaveCount(0);
	expect(await selectedInDom(page)).toBe(1);

	// …and so does a plain click on another cell.
	await clickCell(page, block[0]);
	await page.keyboard.press('Shift+j');
	await expect(page.getByTestId('selection-count')).toHaveText('2 selected');
	await clickCell(page, mounted[0]);
	await expect(page.getByTestId('selection-count')).toHaveCount(0);
	await expect(page.locator(`[data-cell-id="${mounted[0]}"]`)).toHaveAttribute('data-active', 'true');
});

test('Cmd/Ctrl+A selects fold-hidden cells too, so a collapsed section is never left behind', async ({ page }) => {
	test.setTimeout(120_000);
	// Rendered eagerly: the point here is fold SCOPE, not windowing (windowing drops a
	// fold-hidden cell from the DOM entirely, which would make "hidden" and "windowed
	// out" indistinguishable), and every heading's fold chevron has to be clickable.
	await openNotebook(page, '0');

	const cells = await serverCells(page);
	const headings = cells.flatMap((c, i) => (c.cell_type === 'markdown' && c.source.startsWith('## ') ? [i] : []));
	expect(headings.length).toBeGreaterThan(2);

	// The LAST section is what makes this test able to fail: folding it hides the
	// notebook's final cell, so a selection that skipped hidden cells would NOT touch
	// the bottom edge and the move below would be allowed to run.
	const tail = headings[headings.length - 1];
	expect(tail).toBeLessThan(cells.length - 1);
	// …plus an earlier one, so a visible-only selection would be non-contiguous - the
	// exact shape in which `moveSelectionPlan` swaps a heading past the first cell of
	// its own collapsed section.
	const early = headings.find((i) => i < tail && !headings.includes(i + 1) && i + 1 < cells.length);
	expect(early).toBeDefined();

	for (const at of [early!, tail]) {
		await page.locator(`[data-cell-id="${cells[at].id}"] [data-testid="fold-toggle"]`).first().click();
		await expect(page.locator(`[data-cell-id="${cells[at + 1].id}"]`)).not.toBeVisible();
	}
	// The final cell really is hidden, so "select all" now has something to miss.
	await expect(page.locator(`[data-cell-id="${cells[cells.length - 1].id}"]`)).not.toBeVisible();

	await clickCell(page, cells[early!].id);
	await page.keyboard.press(`${MOD}+a`);
	// Every cell of the DOCUMENT, not every cell on screen - the same set a Shift
	// range would produce across the same collapsed sections.
	await expect(page.getByTestId('selection-count')).toHaveText(`${cells.length} selected`);

	// And the consequence: the selection covers the whole notebook, so the move is
	// refused outright rather than sliding each visible heading down into the section
	// it titles. Asserted against the SERVER document.
	await page.keyboard.press(`${MOD}+Shift+ArrowDown`);
	await page.waitForTimeout(1500);
	expect(await serverOrder(page)).toEqual(cells.map((c) => c.id));
	await expect(page.getByTestId('selection-count')).toHaveText(`${cells.length} selected`);
});

test('toggling the primary OUT mounts the survivor, so the keyboard still acts on it', async ({ page }) => {
	test.setTimeout(120_000);
	await openWindowed(page);
	const order = await serverOrder(page);

	// The survivor-to-be, selected at the top of the notebook.
	const survivor = (await mountedCellIds(page))[1];
	await clickCell(page, survivor);

	// Scroll far away and add a cell down here. The survivor stops being the primary
	// at that moment, so it loses its pin and windowing drops its DOM node.
	await setScrollTop(page, 14_000);
	await page.waitForTimeout(400);
	const mountedBelow = await mountedCellIds(page);
	const primary = mountedBelow[Math.floor(mountedBelow.length / 2)];
	await clickCell(page, primary, [MOD]);
	await expect(page.getByTestId('selection-count')).toHaveText('2 selected');
	await expect.poll(() => isCellMounted(page, survivor), { timeout: 5_000 }).toBe(false);

	// Toggling the primary back OUT hands primacy to that windowed-out survivor. It
	// must be MOUNTED before focus lands on it: the dispatcher reads a keystroke's
	// mode and target off the focused element, so a primary with no node would leave
	// the next key acting on nothing.
	await clickCell(page, primary, [MOD]);
	await expect(page.getByTestId('selection-count')).toHaveCount(0);
	await expect.poll(() => isCellMounted(page, survivor), { timeout: 10_000 }).toBe(true);
	await expect(page.locator(`[data-cell-id="${survivor}"]`)).toHaveAttribute('data-active', 'true');
	// Focus is the assertion with teeth: becoming the primary pins the survivor, so
	// it would mount either way - but focus can only land on it if the mount ran
	// FIRST, since an unmounted cell has registered no API to focus through.
	await expect
		.poll(
			() =>
				page.evaluate(
					(id) => document.activeElement?.closest('[data-testid="cell"]')?.getAttribute('data-cell-id') ?? null,
					survivor
				),
			{ timeout: 10_000 }
		)
		.toBe(survivor);

	// And the consequence: a command-mode key acts on the survivor, asserted against
	// the SERVER document.
	await page.keyboard.press('d');
	await page.keyboard.press('d');
	await expect.poll(async () => (await serverOrder(page)).length, { timeout: 20_000 }).toBe(order.length - 1);
	expect(await serverOrder(page)).toEqual(order.filter((id) => id !== survivor));
});

test('a second `z` during a restore does not replay the same undo group', async ({ page }) => {
	test.setTimeout(120_000);
	await openNotebook(page, '0');
	const before = await serverOrder(page);

	const start = (await visibleCellIds(page))[1];
	await clickCell(page, start);
	await page.keyboard.press('Shift+j');
	await page.keyboard.press('Shift+j');
	await expect(page.getByTestId('selection-count')).toHaveText('3 selected');
	await page.keyboard.press('d');
	await page.keyboard.press('d');
	await expect.poll(async () => (await serverOrder(page)).length, { timeout: 20_000 }).toBe(before.length - 3);

	// A restore is one insert per cell, and the group leaves the stack only once the
	// last one lands - so it is still readable for the whole window. Slowing the
	// inserts widens that window to something a test can aim at; a second `z` (or
	// plain key auto-repeat) landing inside it must not restore the group twice.
	await page.route('**/api/cells', async (route) => {
		if (route.request().method() !== 'POST') return route.fallback();
		await new Promise((r) => setTimeout(r, 800));
		return route.continue();
	});
	await page.keyboard.press('z');
	await page.waitForTimeout(300);
	await page.keyboard.press('z');
	await expect.poll(async () => (await serverOrder(page)).length, { timeout: 30_000 }).toBe(before.length);
	await page.unroute('**/api/cells');

	// Restored ONCE: the three cells are back, with no duplicates persisted.
	await page.waitForTimeout(1500);
	const after = await serverOrder(page);
	expect(after).toHaveLength(before.length);
	expect(new Set(after).size).toBe(after.length);
});

test('a REFUSED bulk delete leaves no undo group, so `z` cannot duplicate cells', async ({ page }) => {
	test.setTimeout(120_000);
	await openNotebook(page, '0');
	const before = await serverOrder(page);

	// A batch the server declines is not an HTTP failure: `{ok:true}` with an empty
	// `removed` is exactly what a refused delete looks like on the wire, and it is
	// the shape the client must not record an undo group for - the refusal refetches
	// the cells back, so a phantom group would make `z` re-insert copies of cells
	// that are still there.
	await page.route('**/api/cells/bulk', (route) => route.fulfill({ json: { ok: true, removed: [] } }));

	// Started from a VISIBLE cell: fold state is per-project, so a section an
	// earlier test in this file collapsed is still collapsed here, and a hidden
	// cell has no box to click.
	const start = (await visibleCellIds(page))[1];
	await clickCell(page, start);
	await page.keyboard.press('Shift+j');
	await page.keyboard.press('Shift+j');
	await expect(page.getByTestId('selection-count')).toHaveText('3 selected');
	await page.keyboard.press('d');
	await page.keyboard.press('d');

	// The refusal's refetch puts the cells back on screen…
	await expect(page.locator(`[data-cell-id="${start}"]`)).toBeVisible({ timeout: 20_000 });
	expect(await serverOrder(page)).toEqual(before);

	// …and `z` has nothing to undo, so the document is untouched rather than grown
	// by three duplicates of cells that were never deleted.
	await page.keyboard.press('z');
	await page.waitForTimeout(1500);
	expect(await serverOrder(page)).toEqual(before);
});
