import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * Drag-and-drop reordering of the open-file tab strip, in a real browser.
 *
 * The pure rules are unit-tested (`tests/unit/tab-reorder.test.ts`); this proves
 * the WIRING, which is the half only a browser can answer: that a real pointer
 * drag really reorders the strip, that the new order survives a reload, that a
 * drag never switches the active file, and - the regression this is most likely
 * to guard - that click-to-switch and close-tab still work, including for a
 * press that wobbles a pixel or two before it is released.
 *
 * Plain files are used as tabs on purpose - no kernel is involved, so every
 * assertion here is about the strip and nothing else. The one exception is the
 * `.html` fixture, whose sandboxed preview iframe is what makes "reordering the
 * strip leaves the hidden panes alone" observable at all.
 *
 * Boots the REAL launcher; SKIPS when the runtime (uv + python3 + host-venv) is
 * missing, like the other E2E specs.
 */

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

const FILES = ['alpha.txt', 'bravo.txt', 'charlie.txt', 'delta.txt'];
const HTML_FILE = 'report.html';
const tabId = (name: string) => 'file:' + name;

/** The tab ids in strip (DOM) order - the thing every assertion here is about. */
async function tabOrder(page: Page): Promise<string[]> {
	return page.$$eval('[data-testid="tab"]', (els) =>
		els.map((el) => (el as HTMLElement).dataset.tabId ?? '')
	);
}

/** Which tab is active, read from the strip rather than from any internal state. */
async function activeTab(page: Page): Promise<string | null> {
	return page
		.$eval('[data-testid="tab"][data-active="true"]', (el) => (el as HTMLElement).dataset.tabId ?? null)
		.catch(() => null);
}

/** Viewport centre of a tab. */
async function centreOf(page: Page, id: string): Promise<{ x: number; y: number }> {
	const box = await page.locator(`[data-testid="tab"][data-tab-id="${id}"]`).boundingBox();
	if (!box) throw new Error(`no box for tab ${id}`);
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * Press on `id` and drag to (x, y), in steps so the movement threshold is really
 * crossed and the pointermove handler runs more than once (a single teleporting
 * move would not exercise the same code path a hand does).
 */
async function dragTabTo(page: Page, id: string, x: number, y: number): Promise<void> {
	const from = await centreOf(page, id);
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move(from.x + (x - from.x) / 3, from.y + (y - from.y) / 3, {
		steps: 4
	});
	await page.mouse.move(x, y, { steps: 8 });
	await page.mouse.up();
}

/** Open every file in FILES as a pinned tab, left to right. */
async function openAllFiles(page: Page): Promise<void> {
	for (const name of FILES) {
		await page.locator(`[data-testid="tree-file"][data-path="${name}"]`).dblclick();
		await expect(page.locator(`[data-testid="tab"][data-tab-id="${tabId(name)}"]`)).toBeVisible();
	}
}

/**
 * Put the strip into a known state: exactly FILES, in FILES order, delta active.
 *
 * Every test calls this rather than inheriting the previous one's strip. Two
 * reasons: the tab session is PERSISTED per workspace, so a test really does
 * hand its state to the next one; and Playwright starts a fresh worker after a
 * failure, which re-runs `beforeAll` into a BRAND-NEW workspace - so a test that
 * leans on its predecessor fails for a reason that has nothing to do with it.
 */
async function resetStrip(page: Page): Promise<void> {
	await expect(page.getByTestId('tree-file').first()).toBeVisible({
		timeout: 30_000
	});
	// Close whatever is open, one at a time (the strip re-renders after each).
	for (let guard = 0; guard < 20; guard++) {
		const close = page.getByTestId('tab-close').first();
		if ((await close.count()) === 0) break;
		await close.click();
	}
	await expect(page.locator('[data-testid="tab"]')).toHaveCount(0);
	await openAllFiles(page);
	expect(await tabOrder(page)).toEqual(FILES.map(tabId));
	expect(await activeTab(page)).toBe(tabId('delta.txt'));
}

/** The tab ids of the strip, grouped into visual rows top-to-bottom. */
async function stripRows(page: Page): Promise<string[][]> {
	return page.$$eval('[data-testid="tab"]', (els) => {
		const rows: { top: number; ids: string[] }[] = [];
		for (const el of els) {
			const top = Math.round(el.getBoundingClientRect().top);
			const row = rows.find((r) => Math.abs(r.top - top) < 4);
			if (row) row.ids.push((el as HTMLElement).dataset.tabId ?? '');
			else rows.push({ top, ids: [(el as HTMLElement).dataset.tabId ?? ''] });
		}
		return rows.sort((a, b) => a.top - b.top).map((r) => r.ids);
	});
}

test.beforeAll(async () => {
	test.skip(
		!runtimeAvailable(),
		'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only'
	);
	workspace = mkdtempSync(join(tmpdir(), 'cellar-tab-reorder-'));
	for (const name of FILES) writeFileSync(join(workspace, name), `contents of ${name}\n`);
	writeFileSync(join(workspace, HTML_FILE), '<!doctype html><title>report</title><p>hello</p>\n');
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

test('a pointer drag reorders the strip, and the new order survives a reload', async ({ page }) => {
	test.setTimeout(120_000);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openAllFiles(page);
	expect(await tabOrder(page)).toEqual(FILES.map(tabId));

	// The user is looking at delta (the last one opened). Dragging must not change that.
	expect(await activeTab(page)).toBe(tabId('delta.txt'));

	// alpha → past charlie's midpoint, i.e. between charlie and delta.
	const charlie = await centreOf(page, tabId('charlie.txt'));
	const charlieBox = await page
		.locator(`[data-testid="tab"][data-tab-id="${tabId('charlie.txt')}"]`)
		.boundingBox();
	await dragTabTo(page, tabId('alpha.txt'), charlie.x + charlieBox!.width / 2 - 4, charlie.y);

	await expect
		.poll(() => tabOrder(page))
		.toEqual(['bravo.txt', 'charlie.txt', 'alpha.txt', 'delta.txt'].map(tabId));
	// Criterion 3: reordering never changes which file is active.
	expect(await activeTab(page)).toBe(tabId('delta.txt'));

	// Criterion 1: the order is durable. The tab session is persisted through the
	// same debounced `.cellar/` store as the rest of the strip's state, so give it
	// a beat before reloading.
	await page.waitForTimeout(600);
	await page.reload();
	await expect(page.locator('[data-testid="tab"]')).toHaveCount(FILES.length);
	await expect
		.poll(() => tabOrder(page))
		.toEqual(['bravo.txt', 'charlie.txt', 'alpha.txt', 'delta.txt'].map(tabId));
	expect(await activeTab(page)).toBe(tabId('delta.txt'));
});

test('a drag reaches the very first and the very last slot', async ({ page }) => {
	test.setTimeout(120_000);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await resetStrip(page);

	const strip = (await page.getByTestId('tabbar').boundingBox())!;
	const first = await centreOf(page, tabId('alpha.txt'));

	// Far past the left edge of the strip → slot 0.
	await dragTabTo(page, tabId('charlie.txt'), strip.x - 200, first.y);
	await expect
		.poll(() => tabOrder(page))
		.toEqual(['charlie.txt', 'alpha.txt', 'bravo.txt', 'delta.txt'].map(tabId));

	// Far past the right edge of the last tab → the final slot.
	const last = await centreOf(page, tabId('delta.txt'));
	await dragTabTo(page, tabId('charlie.txt'), last.x + 400, last.y);
	await expect
		.poll(() => tabOrder(page))
		.toEqual(['alpha.txt', 'bravo.txt', 'delta.txt', 'charlie.txt'].map(tabId));
});

test('the drop indicator names the slot the tab will land in, and Escape abandons the drag', async ({
	page
}) => {
	test.setTimeout(120_000);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await resetStrip(page);

	const before = await tabOrder(page);
	const indicator = page.getByTestId('tab-drop-indicator');
	await expect(indicator).toHaveCount(0); // nothing shown while idle

	const from = await centreOf(page, tabId('alpha.txt'));
	const charlie = await centreOf(page, tabId('charlie.txt'));
	const charlieBox = (await page
		.locator(`[data-testid="tab"][data-tab-id="${tabId('charlie.txt')}"]`)
		.boundingBox())!;
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move(charlie.x + charlieBox.width / 2 - 4, charlie.y, {
		steps: 10
	});

	// The indicator is up, and it names slot 3 — after charlie.
	await expect(indicator).toHaveCount(1);
	await expect(indicator).toHaveAttribute('data-drop-index', '3');
	// The dragged tab is lifted, follows the pointer, and is OPAQUE. That last one is
	// a real regression guard: `hover:bg-base-200/50` out-specifies a plain background
	// utility and a lifted tab is by definition under the pointer, so it once rendered
	// at 50% alpha with the tabs it floated over reading straight through it.
	const lifted = page.locator(`[data-testid="tab"][data-tab-id="${tabId('alpha.txt')}"]`);
	await expect(lifted).toHaveAttribute('data-dragging', 'true');
	const lift = await lifted.evaluate((el) => {
		const cs = getComputedStyle(el);
		// The alpha of a computed colour, whatever notation the engine chose
		// (`oklab(l a b / .5)`, `rgba(r, g, b, .5)`).
		const m = cs.backgroundColor.match(/[/,]\s*([\d.]+)\s*\)\s*$/);
		return { alpha: m ? Number(m[1]) : 1, opacity: Number(cs.opacity), moved: cs.transform };
	});
	expect(lift.moved).not.toBe('none'); // it really is translated under the pointer
	expect(lift.alpha).toBe(1);
	expect(lift.opacity).toBe(1);

	// The marker belongs to ONE row: its box matches the tab it is drawn against, so
	// on a wrapped strip it can never read as a bar across the whole header.
	const markerBox = (await indicator.boundingBox())!;
	const neighbourBox = (await page.locator('[data-testid="tab"]').nth(3).boundingBox())!;
	expect(Math.round(markerBox.y)).toBe(Math.round(neighbourBox.y));
	expect(Math.round(markerBox.height)).toBe(Math.round(neighbourBox.height));

	// Escape abandons: the indicator goes, the tab drops back into its slot,
	// nothing moves, and the release that follows must not select the tab either.
	const activeBefore = await activeTab(page);
	await page.keyboard.press('Escape');
	await expect(indicator).toHaveCount(0);
	await expect(page.locator('[data-testid="tab"][data-dragging="true"]')).toHaveCount(0);
	await page.mouse.up();
	await page.waitForTimeout(150);
	expect(await tabOrder(page)).toEqual(before);
	expect(await activeTab(page)).toBe(activeBefore);
});

test('dropping a tab back where it started changes nothing', async ({ page }) => {
	test.setTimeout(120_000);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await resetStrip(page);

	const before = await tabOrder(page);
	const activeBefore = await activeTab(page);
	const bravo = await centreOf(page, tabId('bravo.txt'));
	// Out and back: crosses the threshold (so a real drag runs) but is released
	// over its own slot.
	await page.mouse.move(bravo.x, bravo.y);
	await page.mouse.down();
	await page.mouse.move(bravo.x + 60, bravo.y, { steps: 6 });
	await page.mouse.move(bravo.x, bravo.y, { steps: 6 });
	await page.mouse.up();

	expect(await tabOrder(page)).toEqual(before);
	expect(await activeTab(page)).toBe(activeBefore);
});

test('click-to-switch and close-tab are unaffected, including a press that wobbles', async ({ page }) => {
	test.setTimeout(120_000);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await resetStrip(page);

	// A plain click still selects.
	await page.locator(`[data-testid="tab"][data-tab-id="${tabId('bravo.txt')}"]`).click();
	await expect.poll(() => activeTab(page)).toBe(tabId('bravo.txt'));

	// THE THRESHOLD REGRESSION GUARD: a press that drifts a couple of pixels
	// before release - an ordinary human click - must still select, and must not
	// reorder anything. Drop the threshold and this test fails, because the
	// wobble becomes a drag whose click is then swallowed.
	const before = await tabOrder(page);
	const charlie = await centreOf(page, tabId('charlie.txt'));
	await page.mouse.move(charlie.x, charlie.y);
	await page.mouse.down();
	await page.mouse.move(charlie.x + 2, charlie.y + 1);
	await page.mouse.up();
	await expect.poll(() => activeTab(page)).toBe(tabId('charlie.txt'));
	expect(await tabOrder(page)).toEqual(before);

	// Close still closes, and closes the tab it is drawn on.
	const deltaTab = page.locator(`[data-testid="tab"][data-tab-id="${tabId('delta.txt')}"]`);
	await deltaTab.getByTestId('tab-close').click();
	await expect(deltaTab).toHaveCount(0);
	await expect.poll(() => tabOrder(page)).toEqual(['alpha.txt', 'bravo.txt', 'charlie.txt'].map(tabId));
	// Closing the tab beside the active one leaves the active one alone.
	expect(await activeTab(page)).toBe(tabId('charlie.txt'));

	// A press on the close button never begins a tab drag - a control inside a
	// draggable surface stays a control. Press it, wander well past the threshold,
	// release: no drop indicator appears and the strip does not move. (Releasing
	// 120px away is not a click either, so the tab is not closed by this - which is
	// exactly the browser behaviour we want left intact.)
	const remaining = await tabOrder(page);
	const bravoClose = page
		.locator(`[data-testid="tab"][data-tab-id="${tabId('bravo.txt')}"]`)
		.getByTestId('tab-close');
	const closeBox = (await bravoClose.boundingBox())!;
	await page.mouse.move(closeBox.x + closeBox.width / 2, closeBox.y + closeBox.height / 2);
	await page.mouse.down();
	await page.mouse.move(closeBox.x + 120, closeBox.y, { steps: 6 });
	await expect(page.getByTestId('tab-drop-indicator')).toHaveCount(0);
	await expect(page.locator('[data-testid="tab"][data-dragging="true"]')).toHaveCount(0);
	await page.mouse.up();
	expect(await tabOrder(page)).toEqual(remaining);
});

test('reordering the strip leaves the hidden panes alone', async ({ page }) => {
	test.setTimeout(120_000);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await resetStrip(page);

	// An `.html` tab renders its preview in a SANDBOXED IFRAME, which is what makes
	// this observable: moving an iframe in the DOM RELOADS it. The panes are
	// rendered in OPEN order rather than strip order precisely so a drag cannot do
	// that - see `Tab.seq` in `+page.svelte`. Every rich `text/html` cell output is
	// the same shape, so a regression here would blank and re-fetch them across every
	// open notebook as a side effect of dragging a tab.
	await page.locator(`[data-testid="tree-file"][data-path="${HTML_FILE}"]`).dblclick();
	const preview = page.getByTestId('html-preview');
	await expect(preview).toBeVisible();

	// Count reloads from here on, then leave the pane mounted-but-hidden.
	await preview.evaluate((el) => {
		(window as unknown as { __loads: number }).__loads = 0;
		el.addEventListener('load', () => (window as unknown as { __loads: number }).__loads++);
	});
	await page.locator(`[data-testid="tab"][data-tab-id="${tabId('alpha.txt')}"]`).click();

	// Drag the HTML tab ITSELF, so it is that tab's own pane a strip-ordered render
	// would relocate - dragging some other tab past it moves only the other pane and
	// would leave this assertion true whatever the pane order is derived from.
	const before = await tabOrder(page);
	const htmlId = tabId(HTML_FILE);
	expect(before[before.length - 1]).toBe(htmlId);
	const first = await centreOf(page, before[0]);
	await dragTabTo(page, htmlId, first.x - 200, first.y);
	await expect.poll(() => tabOrder(page)).toEqual([htmlId, ...before.slice(0, -1)]);

	expect(await page.evaluate(() => (window as unknown as { __loads: number }).__loads)).toBe(0);
	await expect(page.getByTestId('html-preview')).toHaveCount(1);
});

test('the strip reorders from the keyboard, and a single-tab strip is inert', async ({ page }) => {
	test.setTimeout(120_000);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await resetStrip(page);

	const alpha = page.locator(`[data-testid="tab"][data-tab-id="${tabId('alpha.txt')}"]`);
	await alpha.focus();
	// Already first: the step is inert and says so, rather than wrapping around.
	await page.keyboard.press('ControlOrMeta+Shift+ArrowLeft');
	expect(await tabOrder(page)).toEqual(FILES.map(tabId));
	await expect(page.getByTestId('tab-move-announcement')).toHaveText(/already first/i);

	const activeBefore = await activeTab(page);
	await page.keyboard.press('ControlOrMeta+Shift+ArrowRight');
	await expect
		.poll(() => tabOrder(page))
		.toEqual(['bravo.txt', 'alpha.txt', 'charlie.txt', 'delta.txt'].map(tabId));
	// The keyboard move must not switch files either, and focus must follow the
	// tab so the next keystroke keeps steering the same one.
	expect(await activeTab(page)).toBe(activeBefore);
	await expect(page.getByTestId('tab-move-announcement')).toHaveText(/alpha\.txt moved to position 2 of 4/i);
	await expect(alpha).toBeFocused();

	await page.keyboard.press('ControlOrMeta+Shift+ArrowRight');
	await page.keyboard.press('ControlOrMeta+Shift+ArrowRight');
	await expect
		.poll(() => tabOrder(page))
		.toEqual(['bravo.txt', 'charlie.txt', 'delta.txt', 'alpha.txt'].map(tabId));

	// The reorder shortcuts are DECLARED in the registry, so Settings lists them and
	// they can be rebound like any other - that is where this app documents its keys.
	await page.getByTestId('app-menu').click();
	await page.getByTestId('open-settings').click();
	for (const id of ['move-tab-left', 'move-tab-right']) {
		const row = page.locator(`[data-testid="shortcut-row"][data-shortcut-id="${id}"]`);
		await expect(row).toHaveCount(1);
		await expect(row.getByTestId('shortcut-key').first()).toBeVisible();
	}
	await expect(page.getByTestId('shortcuts-conflict-warning')).toHaveCount(0);
	await page.getByTestId('settings-close').click();
	await expect(page.getByTestId('settings-modal')).toHaveCount(0);

	// Enter on a focused tab selects it (keyboard users are not left pointer-bound).
	await page.locator(`[data-testid="tab"][data-tab-id="${tabId('bravo.txt')}"]`).focus();
	await page.keyboard.press('Enter');
	await expect.poll(() => activeTab(page)).toBe(tabId('bravo.txt'));

	// A single-tab strip: dragging is a no-op rather than an error.
	for (const name of ['charlie.txt', 'delta.txt', 'alpha.txt']) {
		await page
			.locator(`[data-testid="tab"][data-tab-id="${tabId(name)}"]`)
			.getByTestId('tab-close')
			.click();
	}
	await expect(page.locator('[data-testid="tab"]')).toHaveCount(1);
	const only = await centreOf(page, tabId('bravo.txt'));
	await dragTabTo(page, tabId('bravo.txt'), only.x + 300, only.y);
	expect(await tabOrder(page)).toEqual([tabId('bravo.txt')]);
	expect(await activeTab(page)).toBe(tabId('bravo.txt'));
});

test('the strip is a real tablist: arrows move focus without switching files', async ({ page }) => {
	test.setTimeout(120_000);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await resetStrip(page);

	const at = (i: number) => page.locator('[data-testid="tab"]').nth(i);
	const focused = () => page.evaluate(() => (document.activeElement as HTMLElement)?.dataset?.tabId ?? null);
	const order = await tabOrder(page);
	const activeBefore = await activeTab(page);

	await at(0).focus();
	// Manual activation: browsing the strip must never switch the file under you.
	await page.keyboard.press('ArrowRight');
	expect(await focused()).toBe(order[1]);
	await page.keyboard.press('End');
	expect(await focused()).toBe(order[order.length - 1]);
	await page.keyboard.press('Home');
	expect(await focused()).toBe(order[0]);
	await page.keyboard.press('ArrowLeft'); // wraps, as the tablist pattern expects
	expect(await focused()).toBe(order[order.length - 1]);
	expect(await activeTab(page)).toBe(activeBefore);
	expect(await tabOrder(page)).toEqual(order);

	// Each tab names the pane it controls, and that pane names it back - the half of
	// the pattern that makes `role="tab"` mean something to assistive tech.
	const activeId = (await activeTab(page))!;
	const tab = page.locator(`[data-testid="tab"][data-tab-id="${activeId}"]`);
	const panelId = await tab.getAttribute('aria-controls');
	expect(panelId).toBeTruthy();
	// An attribute selector, not `#id`: the id carries `:` and `/`, and `CSS.escape`
	// is a browser global that does not exist in this Node test process.
	const panel = page.locator(`[id="${panelId}"]`);
	await expect(panel).toHaveAttribute('role', 'tabpanel');
	await expect(panel).toHaveAttribute('aria-labelledby', (await tab.getAttribute('id'))!);
	await expect(tab).toHaveAttribute('aria-selected', 'true');
});

test('a double-click still promotes a preview tab', async ({ page }) => {
	test.setTimeout(120_000);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await resetStrip(page);

	// Single-click a tree file → a transient preview tab. Double-clicking the TAB
	// promotes it, which is two press/release pairs with no movement between them -
	// so it is also a check that the drag gesture never eats an ordinary dblclick.
	await page.locator(`[data-testid="tree-file"][data-path="${HTML_FILE}"]`).click();
	const preview = page.locator(`[data-testid="tab"][data-tab-id="${tabId(HTML_FILE)}"]`);
	await expect(preview).toHaveAttribute('data-preview', 'true');
	await preview.dblclick();
	await expect(preview).not.toHaveAttribute('data-preview', 'true');
});

test('a wrapped, multi-row strip drops onto the row the pointer is on', async ({ page }) => {
	test.setTimeout(180_000);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await resetStrip(page);

	// Narrow the window until the strip spills onto a second row. This is the case
	// a plain left-to-right hit test gets wrong: x alone cannot tell the rows apart.
	await page.setViewportSize({ width: 560, height: 800 });
	await expect.poll(async () => (await stripRows(page)).length, { timeout: 10_000 }).toBeGreaterThan(1);

	const rows = await stripRows(page);
	const topRow = rows[0];
	test.skip(topRow.length < 2, 'the top row holds a single tab, so this drag proves nothing');

	const flat = rows.flat();
	const lastOnTop = topRow[topRow.length - 1];
	const topBox = (await page.locator(`[data-testid="tab"][data-tab-id="${lastOnTop}"]`).boundingBox())!;

	// Drag the FIRST tab to the far right of the TOP row. Row-aware, it lands at the
	// end of that row; a hit test that ignored rows would send it to the end of the
	// whole strip - which is what makes this assertion discriminating rather than
	// merely true.
	const moved = flat[0];
	await dragTabTo(page, moved, topBox.x + topBox.width + 40, topBox.y + topBox.height / 2);

	const expected = [...flat.slice(1, topRow.length), moved, ...flat.slice(topRow.length)];
	await expect.poll(() => tabOrder(page)).toEqual(expected);
	expect((await tabOrder(page)).at(-1)).not.toBe(moved); // it did NOT fall through to the end

	// And the other direction: from the top row down to the head of the bottom row.
	const nowRows = await stripRows(page);
	const bottomRow = nowRows[nowRows.length - 1];
	const headBox = (await page.locator(`[data-testid="tab"][data-tab-id="${bottomRow[0]}"]`).boundingBox())!;
	const fromTop = nowRows[0][0];
	await dragTabTo(page, fromTop, headBox.x + 2, headBox.y + headBox.height / 2);
	await expect
		.poll(async () => (await tabOrder(page)).indexOf(fromTop))
		.toBe((await tabOrder(page)).indexOf(bottomRow[0]) - 1);
});
