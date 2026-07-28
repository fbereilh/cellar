import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess, spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar, REPO } from './harness';
import { setScrollTop, isCellMounted, mountedCellIds, paneMetric } from './notebook-scroll';

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
 *      to, so focus follows the selection and the next keystroke still has a target;
 *   G. a right-click on a member keeps the selection WITHOUT cancelling the press,
 *      and Cmd/Ctrl+A leaves the head at a real end so Shift+K shrinks by one;
 *   H. Cmd/Ctrl+A leaves a LIVE primary (its head mounts and takes focus, so the
 *      primary-addressed shortcuts still reach it) while changing nothing else - it
 *      scrolls nowhere and unfolds nothing, so it can neither move the reader nor
 *      write persisted fold state - and a paste selects the whole pasted block, not
 *      just its last cell - the set-consistency cut/copy and undo already have;
 *   I. a Shift+click on a READING surface (rendered markdown, the output block)
 *      stays the browser's text-selection gesture rather than a cell-range one.
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

	// A right-click on a MEMBER keeps the selection: a non-primary press is a
	// context-menu gesture, not a selection one, and collapsing to the clicked cell
	// before the menu even opens would destroy the set the menu is about to act on.
	const menuTarget = page.locator(`[data-cell-id="${c}"]`);
	const menuBox = await menuTarget.boundingBox();
	await menuTarget.click({ button: 'right', position: { x: Math.round(menuBox!.width / 2), y: 14 } });
	await expect(page.getByTestId('selection-count')).toHaveText('3 selected');

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

test('a right-click on a member keeps the selection without cancelling the press', async ({ page }) => {
	test.setTimeout(120_000);
	await openWindowed(page);
	const mounted = await mountedCellIds(page);
	await clickCell(page, mounted[1]);
	await page.keyboard.press('Shift+j');
	await expect(page.getByTestId('selection-count')).toHaveText('2 selected');

	// A right-click is a context-menu gesture, not a selection gesture, so the set
	// survives it - and the selection is preserved by NOT collapsing, never by
	// `preventDefault`ing the press: cancelling `pointerdown` would also stop the
	// press reaching the cell at all (an editor right-clicked for Cut/Copy/Paste
	// would never take the caret). So focus still lands, and promotes this member.
	const card = page.locator(`[data-cell-id="${mounted[2]}"]`);
	const box = await card.boundingBox();
	await card.click({ button: 'right', position: { x: Math.round(box!.width / 2), y: 14 } });
	await expect(page.getByTestId('selection-count')).toHaveText('2 selected');
	await expect(card).toHaveAttribute('data-active', 'true');
	expect(await page.evaluate((id) => document.activeElement?.closest('[data-cell-id]')?.getAttribute('data-cell-id') === id, mounted[2])).toBe(true);

	await page.keyboard.press('Escape');
});

test('a Shift+click in rendered markdown extends the TEXT selection, never the cell range', async ({ page }) => {
	test.setTimeout(120_000);
	// Eagerly rendered: this is about a press landing on a specific painted surface,
	// so every cell needs a stable node and a stable box.
	await openNotebook(page, '0');
	const cells = await serverCells(page);
	const md = cells.find((c, i) => i > 2 && c.cell_type === 'markdown' && c.source.includes('prose'));
	expect(md).toBeDefined();

	// Fold state is persisted per notebook and this file shares one workspace, so an
	// earlier test's collapsed section would otherwise decide how far Shift+J steps.
	await clickCell(page, cells[0].id);
	await page.keyboard.press('Shift+ArrowRight');
	await page.waitForTimeout(300);
	await page.keyboard.press('Shift+j');
	await expect(page.getByTestId('selection-count')).toHaveText('2 selected');

	// Rendered markdown and the output block are for READING, and Shift+click there
	// is how you grab part of a traceback or a printed table. The cell gesture
	// `preventDefault`s, which suppresses the compatibility mouse events - so with no
	// exemption the browser never extends the text selection at all.
	const prose = page.locator(`[data-cell-id="${md!.id}"] [data-testid="markdown-rendered"] p`).first();
	await expect(prose).toBeVisible();
	const box = await prose.boundingBox();
	await prose.click({ position: { x: 4, y: 6 } });
	await prose.click({ position: { x: Math.round(Math.min(220, box!.width - 8)), y: 6 }, modifiers: ['Shift'] });

	expect(await page.evaluate(() => (window.getSelection()?.toString() ?? '').trim().length)).toBeGreaterThan(0);
	// And the press is NOT a range gesture: it never re-ranges the selection from the
	// anchor. The plain click that preceded it collapsed to this cell, as it always
	// has.
	await expect(page.getByTestId('selection-count')).toHaveCount(0);

	// But it must not COLLAPSE one either, which is the other half of exempting it:
	// the press belongs to the native text gesture, so it is not a cell-selection
	// gesture at all, and Shift+dragging across part of a traceback used to discard a
	// five-cell selection on its way past. With a multi-cell selection standing and
	// this cell in it, the same press leaves the set alone.
	await page.keyboard.press('Shift+j');
	await expect(page.getByTestId('selection-count')).toHaveText('2 selected');
	await prose.click({ position: { x: Math.round(Math.min(220, box!.width - 8)), y: 6 }, modifiers: ['Shift'] });
	await page.waitForTimeout(200);
	await expect(page.getByTestId('selection-count')).toHaveText('2 selected');

	await page.keyboard.press('Escape');
});

test('Cmd/Ctrl+A leaves the head at the last cell, so Shift+K shrinks by one', async ({ page }) => {
	test.setTimeout(120_000);
	await openWindowed(page);
	const order = await serverOrder(page);
	const last = order[order.length - 1];

	await clickCell(page, (await mountedCellIds(page))[1]);
	// Expand everything first: fold state is PERSISTED per notebook (server-side, so
	// a fresh browser context does not clear it) and this file shares one workspace,
	// so an earlier test's collapsed section would otherwise decide the arithmetic
	// below - a fold-hidden head steps past its whole hidden run, not by one. Nothing
	// unfolds it for us any more: select-all deliberately does not (see "Cmd/Ctrl+A
	// does not unfold anything").
	await page.keyboard.press('Shift+ArrowRight');
	await page.waitForTimeout(300);

	await page.keyboard.press(`${MOD}+a`);
	await expect(page.getByTestId('selection-count')).toHaveText(`${order.length} selected`);
	// The head really moved to the far end. Mounting it proves nothing on its own
	// (the PRIMARY is pinned into the window anyway), so the proof is behavioural:
	// `extendSelection` rebuilds the range as anchor→head, so a head left
	// mid-document would drop everything past it. One step back from a real end drops
	// exactly one, and stepping forward again restores exactly one.
	await expect.poll(() => isCellMounted(page, last), { timeout: 20_000 }).toBe(true);
	await expect(page.locator(`[data-cell-id="${last}"]`)).toHaveAttribute('data-active', 'true');
	await page.keyboard.press('Shift+k');
	await expect(page.getByTestId('selection-count')).toHaveText(`${order.length - 1} selected`);
	await page.keyboard.press('Shift+j');
	await expect(page.getByTestId('selection-count')).toHaveText(`${order.length} selected`);
	await page.keyboard.press('Escape');
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

test('an insert that fails mid-restore is resumed, not replayed, by the next `z`', async ({ page }) => {
	test.setTimeout(120_000);
	await openNotebook(page, '0');
	const before = await serverCells(page);
	const sourcesBefore = before.map((c) => c.source);

	const start = (await visibleCellIds(page))[1];
	await clickCell(page, start);
	await page.keyboard.press('Shift+j');
	await page.keyboard.press('Shift+j');
	await expect(page.getByTestId('selection-count')).toHaveText('3 selected');
	await page.keyboard.press('d');
	await page.keyboard.press('d');
	await expect.poll(async () => (await serverOrder(page)).length, { timeout: 20_000 }).toBe(before.length - 3);

	// Fail the SECOND insert of the restore. The group survives (that is the whole
	// point of dropping it only once every cell is back), so the records that
	// already landed must be gone from it - otherwise the next `z` replays them and
	// the notebook grows duplicates of cells the user asked to see once.
	let posts = 0;
	await page.route('**/api/cells', async (route) => {
		if (route.request().method() !== 'POST') return route.fallback();
		posts += 1;
		return posts === 2 ? route.abort('failed') : route.continue();
	});
	await page.keyboard.press('z');
	await expect.poll(async () => (await serverOrder(page)).length, { timeout: 20_000 }).toBe(before.length - 2);
	await page.waitForTimeout(800); // nothing further lands: the restore stopped there
	expect(await serverOrder(page)).toHaveLength(before.length - 2);
	await page.unroute('**/api/cells');

	// The retry picks up the two that never landed and stops.
	await page.keyboard.press('z');
	await expect.poll(async () => (await serverOrder(page)).length, { timeout: 30_000 }).toBe(before.length);
	await page.waitForTimeout(1500);
	const after = await serverCells(page);
	expect(after.map((c) => c.source)).toEqual(sourcesBefore); // each cell back exactly once, in place
	expect(new Set(after.map((c) => c.id)).size).toBe(after.length);
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

test('undo restores a deleted cell EXACTLY - language, role, export and hide_input', async ({ page }) => {
	test.setTimeout(120_000);
	await openNotebook(page, '0');

	// Undo is the one path where a user expects exact restoration, and the undo
	// record used to carry the CLIPBOARD's shape (type + source + output_scrolled),
	// so everything in the `cellar` namespace was silently dropped: ten deleted SQL
	// cells came back as ten plain Python cells, and an imports cell / an
	// export-marked cell lost its designation. Bulk delete is what turned that from
	// a one-cell annoyance into a ten-cell one.
	// Fold state is persisted per notebook and this file shares one workspace, so an
	// earlier test's collapsed section would otherwise decide what is clickable.
	await clickCell(page, (await visibleCellIds(page))[0]);
	await page.keyboard.press('Shift+ArrowRight');
	await page.waitForTimeout(300);

	// Two ADJACENT code cells, both on screen: the imports role and the export flag
	// are Python-code-only (a markdown cell cannot hold either), and the selection is
	// built by clicking one and Shift+J-ing onto the next.
	const order = await serverOrder(page);
	const cells = await serverCells(page);
	const visible = new Set(await visibleCellIds(page));
	const at = order.findIndex(
		(id, i) =>
			i > 0 &&
			cells[i]?.cell_type === 'code' &&
			cells[i + 1]?.cell_type === 'code' &&
			visible.has(id) &&
			visible.has(order[i + 1])
	);
	expect(at).toBeGreaterThan(0);
	const [sqlId, markedId] = [order[at], order[at + 1]];

	await page.evaluate(
		async ({ nb, sqlId, markedId }) => {
			await fetch('/api/cells/bulk', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ op: 'type', ids: [sqlId], cellType: 'sql', nb })
			});
			await fetch(`/api/cells/${markedId}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ role: 'imports', export: true, hideInput: true, nb })
			});
		},
		{ nb: NB, sqlId, markedId }
	);

	// Reload so the browser model carries the metadata the snapshot has to capture.
	await openNotebook(page, '0');
	const meta = () =>
		page.evaluate(async (nb) => {
			const res = await fetch(`/api/notebooks?path=${encodeURIComponent(nb)}`);
			const body = await res.json();
			return (body.notebook.cells as { id: string; cell_type: string; metadata?: { cellar?: Record<string, unknown> } }[]).map(
				(c) => ({ id: c.id, cell_type: c.cell_type, cellar: c.metadata?.cellar ?? {} })
			);
		}, NB);
	const before = await meta();
	expect(before.find((c) => c.id === sqlId)?.cellar.language).toBe('sql');
	expect(before.find((c) => c.id === markedId)?.cellar).toMatchObject({ role: 'imports', export: true, hide_input: true });

	await clickCell(page, sqlId);
	await page.keyboard.press('Shift+j');
	await expect(page.getByTestId('selection-count')).toHaveText('2 selected');
	await page.keyboard.press('d');
	await page.keyboard.press('d');
	await expect.poll(async () => (await serverOrder(page)).length, { timeout: 20_000 }).toBe(order.length - 2);

	await page.keyboard.press('z');
	await expect.poll(async () => (await serverOrder(page)).length, { timeout: 20_000 }).toBe(order.length);

	// Both cells are back in place, and back as what they WERE. The ids are fresh
	// (a restore re-adds rather than resurrecting), so identity is by position.
	const after = await meta();
	expect(after[at].cellar.language).toBe('sql');
	expect(after[at + 1].cellar).toMatchObject({ role: 'imports', export: true, hide_input: true });
	// …and the runtime-only records are NOT forged back: `lastRun` is the sole
	// evidence a cell ran against the LIVE kernel namespace, so it may only ever
	// originate from an in-process run, never from a client-supplied snapshot.
	expect(after[at].cellar.lastRun).toBeUndefined();
	expect(after[at + 1].cellar.lastRun).toBeUndefined();
});

test('a delete covering every cell is refused - and SAYS why instead of doing nothing', async ({ page }) => {
	test.setTimeout(120_000);
	await openWindowed(page);
	const before = await serverOrder(page);

	// The rule (a notebook always keeps one cell) is deliberate and enforced
	// server-side. What is under test is that the user is TOLD: a keystroke refusal
	// sends no request that could fail and disables no button, so a silent return is
	// indistinguishable from a dead keyboard.
	// A VISIBLE cell, not merely a mounted one: fold state is per-project, so a
	// section an earlier test in this file collapsed is still collapsed here and a
	// hidden cell has no box to click.
	await clickCell(page, (await visibleCellIds(page))[1]);
	await page.keyboard.press(`${MOD}+a`);
	await expect(page.getByTestId('selection-count')).toHaveText(`${before.length} selected`);

	await page.keyboard.press('d');
	await page.keyboard.press('d');
	await expect(page.getByTestId('app-notice')).toContainText('at least one cell');
	const firstSeq = await page.getByTestId('app-notice').getAttribute('data-seq');
	await page.waitForTimeout(1000);
	expect(await serverOrder(page)).toEqual(before); // and nothing was removed

	// The cut path refuses on exactly the same condition and must not go silent
	// either (a cut that cannot delete would otherwise be half a cut) - and the
	// toast is still up carrying the SAME sentence, so what proves the user was
	// told a second time is the nonce moving, not the text being present.
	await clickCell(page, (await visibleCellIds(page))[1]);
	await page.keyboard.press(`${MOD}+a`);
	await page.keyboard.press('x');
	await expect(page.getByTestId('app-notice')).toContainText('at least one cell');
	await expect(page.getByTestId('app-notice')).not.toHaveAttribute('data-seq', firstSeq!);
	await page.waitForTimeout(1000);
	expect(await serverOrder(page)).toEqual(before);

	// It takes itself down; a refusal the user will retry must not need dismissing.
	await expect(page.getByTestId('app-notice')).toHaveCount(0, { timeout: 15_000 });
	await page.keyboard.press('Escape');
});

test('a refusal the client did NOT predict says why too, and only when the server said so', async ({ page }) => {
	test.setTimeout(120_000);
	await openNotebook(page, '0');
	const before = await serverOrder(page);

	// The client's own guard compares against ITS cell list, which is stale for as
	// long as an agent's `cell:deleted` events are in flight - so the server can
	// legitimately refuse a delete the browser already rendered as gone. The recovery
	// is a refetch, and a refetch ALONE is the same silent refusal the keystroke path
	// was fixed for: the cells simply reappear, with nothing to explain them (the
	// events that would are echo-suppressed, carrying this tab's own `originId`).
	await page.route('**/api/cells/bulk', (route) =>
		route.fulfill({ status: 400, json: { ok: false, reason: 'would-empty-notebook' } })
	);
	const start = (await visibleCellIds(page))[1];
	await clickCell(page, start);
	await page.keyboard.press('Shift+j');
	await expect(page.getByTestId('selection-count')).toHaveText('2 selected');
	await page.keyboard.press('d');
	await page.keyboard.press('d');
	await expect(page.getByTestId('app-notice')).toContainText('at least one cell');
	await expect.poll(async () => (await serverOrder(page)).length, { timeout: 20_000 }).toBe(before.length);

	// …but the reason is READ, never assumed from the failure: a refetch caused by a
	// dropped connection or any other error must not claim a rule the server never
	// invoked. It takes itself down first, so what is asserted is a fresh absence.
	await expect(page.getByTestId('app-notice')).toHaveCount(0, { timeout: 15_000 });
	await page.unroute('**/api/cells/bulk');
	await page.route('**/api/cells/bulk', (route) => route.fulfill({ status: 500, json: { ok: false, reason: 'boom' } }));
	await clickCell(page, start);
	await page.keyboard.press('Shift+j');
	await expect(page.getByTestId('selection-count')).toHaveText('2 selected');
	await page.keyboard.press('d');
	await page.keyboard.press('d');
	await page.waitForTimeout(2000);
	await expect(page.getByTestId('app-notice')).toHaveCount(0);
	expect(await serverOrder(page)).toEqual(before);
	await page.unroute('**/api/cells/bulk');

	// The SINGLE-cell delete route carries the same invariant and the same refusal
	// shape, so it must speak too - `dd` on one cell is the commonest way to meet it.
	await page.route('**/api/cells/*', (route) =>
		route.request().method() === 'DELETE'
			? route.fulfill({ status: 400, json: { ok: false, reason: 'would-empty-notebook' } })
			: route.fallback()
	);
	await clickCell(page, start);
	await expect(page.getByTestId('selection-count')).toHaveCount(0);
	await page.keyboard.press('d');
	await page.keyboard.press('d');
	await expect(page.getByTestId('app-notice')).toContainText('at least one cell');
	await expect.poll(async () => (await serverOrder(page)).length, { timeout: 20_000 }).toBe(before.length);
	await page.unroute('**/api/cells/*');
	await page.keyboard.press('Escape');
});

test('command-mode Escape with nothing to collapse is left for the rest of the app', async ({ page }) => {
	test.setTimeout(120_000);
	await openWindowed(page);

	// The notebook's key dispatcher is a window CAPTURE listener that stops the
	// keystroke dead once an action matches, so `clear-selection` binding Escape
	// would swallow it app-wide - including for the sidebar, which dismisses its
	// context menu from a plain BUBBLE-phase window listener. An action that did
	// nothing must therefore decline the keystroke.
	await page.evaluate(() => {
		(window as unknown as { __esc: number }).__esc = 0;
		window.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') (window as unknown as { __esc: number }).__esc++;
		});
	});
	const escapesSeen = () => page.evaluate(() => (window as unknown as { __esc: number }).__esc);

	const ids = await visibleCellIds(page);
	await clickCell(page, ids[1]);
	await expect(page.locator(`[data-cell-id="${ids[1]}"]`)).toHaveAttribute('data-active', 'true');
	await expect(page.getByTestId('selection-count')).toHaveCount(0); // nothing to collapse

	await page.keyboard.press('Escape');
	expect(await escapesSeen()).toBe(1);

	// …and a real multi-selection still CONSUMES Escape (it has something to do).
	await clickCell(page, ids[1]);
	await page.keyboard.press('Shift+j');
	await expect(page.getByTestId('selection-count')).toHaveText('2 selected');
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('selection-count')).toHaveCount(0);
	expect(await escapesSeen()).toBe(1);

	// The user-visible repro: a cell selected in command mode, the sidebar's file
	// context menu open, Escape must close it.
	await clickCell(page, ids[1]);
	await page.getByTestId('files-body').click({ button: 'right', position: { x: 4, y: 4 } });
	await expect(page.getByTestId('tree-context-menu')).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('tree-context-menu')).toHaveCount(0);
});

test('Cmd/Ctrl+A selects everything WITHOUT taking the reader to the end', async ({ page }) => {
	test.setTimeout(120_000);
	await openWindowed(page);
	const order = await serverOrder(page);

	// Select-all is not a navigation. The head moves to the LAST cell (that is what
	// makes a following Shift+J/K extend from a coherent range) and focus follows it,
	// because `activeId` is ALSO the primary every single-cell action addresses -
	// but the viewport does not travel with it. The mount runs in the seam's
	// mount-only mode and the focus is `preventScroll`, so the reader stays put.
	await setScrollTop(page, 6_000);
	await page.waitForTimeout(400);
	await clickCell(page, (await visibleCellIds(page))[1]);
	const before = await paneMetric(page, 'scrollTop');

	await page.keyboard.press(`${MOD}+a`);
	await expect(page.getByTestId('selection-count')).toHaveText(`${order.length} selected`);

	// Not "close enough": select-all runs no scroll at all, so the pane cannot move.
	await page.waitForTimeout(600);
	expect(await paneMetric(page, 'scrollTop')).toBe(before);

	// …and the primary is LIVE, not a windowed-out id: it mounted, it holds focus,
	// and Enter really reaches it. Without the mount, `apiOf(activeId)` resolved to
	// nothing and every primary-addressed shortcut (Enter, Ctrl+Enter, command-mode,
	// split-cell) silently no-opped right after Cmd/Ctrl+A on a long notebook.
	const last = order[order.length - 1];
	await expect.poll(() => isCellMounted(page, last), { timeout: 20_000 }).toBe(true);
	await expect
		.poll(
			() =>
				page.evaluate(
					() => document.activeElement?.closest('[data-cell-id]')?.getAttribute('data-cell-id') ?? null
				),
			{ timeout: 10_000 }
		)
		.toBe(last);
	await page.keyboard.press('Enter');
	await expect(page.locator(`[data-cell-id="${last}"]`).getByTestId('cell-mode')).toHaveAttribute('data-mode', 'edit');
	await page.keyboard.press('Escape');
});

test('Cmd/Ctrl+A does not unfold anything, not even the section hiding the last cell', async ({ page }) => {
	test.setTimeout(120_000);
	// Rendered eagerly so "hidden by a fold" and "windowed out" stay distinguishable.
	await openNotebook(page, '0');
	const cells = await serverCells(page);
	const headings = cells.flatMap((c, i) => (c.cell_type === 'markdown' && c.source.startsWith('## ') ? [i] : []));
	const tail = headings[headings.length - 1];
	expect(tail).toBeLessThan(cells.length - 1);

	// Start from a known fold state: it is persisted per notebook (server-side, so a
	// fresh browser context does not clear it) and this file shares one workspace, so
	// an earlier test's collapsed section would otherwise make the click below an
	// UNfold. Nothing clears it for us - which is the whole point of this test.
	const lastCell = page.locator(`[data-cell-id="${cells[cells.length - 1].id}"]`);
	await clickCell(page, cells[0].id);
	await page.keyboard.press('Shift+ArrowRight');
	await expect(lastCell).toBeVisible();

	await page.locator(`[data-cell-id="${cells[tail].id}"] [data-testid="fold-toggle"]`).first().click();
	await expect(lastCell).not.toBeVisible();

	// Select-all puts the head ON that hidden last cell. Reaching it through the
	// mount seam used to REVEAL it - unfolding the section and persisting the change
	// via `saveFolds()` - so Cmd/Ctrl+A silently expanded whichever section happened
	// to hide the last cell, and the expansion survived a reload.
	await clickCell(page, cells[0].id);
	await page.keyboard.press(`${MOD}+a`);
	await expect(page.getByTestId('selection-count')).toHaveText(`${cells.length} selected`);
	await page.waitForTimeout(600);
	await expect(lastCell).not.toBeVisible();

	// A Cmd/Ctrl+click DESELECT is not a navigation either, and it reaches the same
	// mount-without-unfold seam: it leaves the primary on that fold-hidden last cell
	// (only toggling out the PRIMARY moves it), so it must not expand the section
	// hiding it. It used to, and `saveFolds()` persisted the expansion - a mere
	// deselect permanently opening a section the user collapsed.
	await clickCell(page, cells[1].id, [MOD]);
	await expect(page.getByTestId('selection-count')).toHaveText(`${cells.length - 1} selected`);
	await page.waitForTimeout(400);
	await expect(lastCell).not.toBeVisible();

	// Plain `k` walks from that fold-hidden head by DOCUMENT position too - the same
	// rule Shift+K uses, now shared rather than written twice. A bare `findIndex` miss
	// read as "restart at the first entry", so the very next keystroke after Cmd/Ctrl+A
	// flung the selection to the TOP of the notebook instead of stepping one cell.
	await page.keyboard.press('k');
	await expect(page.getByTestId('selection-count')).toHaveCount(0);
	await expect(page.locator(`[data-cell-id="${cells[tail].id}"]`)).toHaveAttribute('data-active', 'true');
	await expect(page.locator(`[data-cell-id="${cells[0].id}"]`)).not.toHaveAttribute('data-active', 'true');

	await clickCell(page, cells[0].id);
	await page.keyboard.press(`${MOD}+a`);
	await expect(page.getByTestId('selection-count')).toHaveText(`${cells.length} selected`);

	// A fold-hidden head still walks: Shift+K steps to the nearest VISIBLE cell above
	// it by document position, contracting the selection rather than collapsing it.
	await page.keyboard.press('Shift+k');
	await expect(page.getByTestId('selection-count')).toHaveText(`${tail + 1} selected`);

	// Fold state is persisted, so a reload is what proves nothing was written.
	await openNotebook(page, '0');
	await expect(page.locator(`[data-cell-id="${cells[cells.length - 1].id}"]`)).not.toBeVisible();
});

test('pasting a multi-cell clipboard selects the whole pasted block', async ({ page }) => {
	test.setTimeout(120_000);
	await openNotebook(page, '0');
	const before = await serverOrder(page);

	// Cut/copy act on the whole selection and undo restores the whole group, so a
	// paste that left one cell of three selected would be an asymmetry this feature
	// invented.
	const start = (await visibleCellIds(page))[1];
	await clickCell(page, start);
	await page.keyboard.press('Shift+j');
	await page.keyboard.press('Shift+j');
	await expect(page.getByTestId('selection-count')).toHaveText('3 selected');
	await page.keyboard.press('c');

	await page.keyboard.press('v');
	await expect.poll(async () => (await serverOrder(page)).length, { timeout: 20_000 }).toBe(before.length + 3);
	await expect(page.getByTestId('selection-count')).toHaveText('3 selected');

	// And they are exactly the PASTED ids, identified against the SERVER document:
	// the three new cells, with the last of them primary.
	const after = await serverOrder(page);
	const pasted = after.filter((id) => !before.includes(id));
	expect(pasted).toHaveLength(3);
	const selected = await page
		.locator('[data-testid="cell"][data-selected="true"]')
		.evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.cellId ?? ''));
	expect(selected.sort()).toEqual([...pasted].sort());
	await expect(page.locator(`[data-cell-id="${pasted[2]}"]`)).toHaveAttribute('data-active', 'true');

	// A one-cell clipboard is the degenerate case and still lands on a single cell.
	await clickCell(page, start);
	await page.keyboard.press('c');
	await page.keyboard.press('v');
	await expect.poll(async () => (await serverOrder(page)).length, { timeout: 20_000 }).toBe(before.length + 4);
	await expect(page.getByTestId('selection-count')).toHaveCount(0);
});
