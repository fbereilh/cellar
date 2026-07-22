import { test, expect, type Page, type Locator } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * E2E for the "keep the expand toggle clear of the scrollbar gutter" fix
 * (ce60cda). A contracted code cell's INPUT (editor-collapse toggle) and OUTPUT
 * (scroll-output toggle) are absolutely positioned in the top-right of a scroll
 * box. They used to be pinned at `right: 0.25rem` (`right-1`), so a classic /
 * always-on vertical scrollbar (~15px) painted directly under the toggle,
 * overlapping the "expand" affordance.
 *
 * The fix insets each toggle by `max(1rem, calc(0.25rem + Wpx))`, where `W` is the
 * scroll box's measured vertical-scrollbar width (`offsetWidth - clientWidth`),
 * re-measured reactively. This spec drives the REAL app + kernel and proves, with
 * on-screen measurements + screenshots:
 *
 *   1. classic/always-on scrollbar (forced 15px): the toggle's right edge clears
 *      the scrollbar gutter with a small gap — and the OLD `right:4px` positioning,
 *      applied to the same live toggle, visibly overlaps it (bug reproduced);
 *   2. overlay scrollbar (0 layout width): the toggle is inset by the ~16px floor;
 *   3. both the input and the output toggles behave identically;
 *   4. expand/collapse still toggles state.
 */

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

const EVIDENCE =
	process.env.CELLAR_EVIDENCE_DIR ||
	'/var/folders/ds/m71hq5ln637g23x6xmrwqg080000gn/T/no-mistakes-evidence/01KY4J6341WTWSG0NPFSBW536Q';

// Cell 0: tall OUTPUT (200 lines) → auto-contracts into the output scroll box, so
// its output-scroll-toggle shows. Cell 1: tall SOURCE (60 lines) → the editor
// auto-collapses into its scroll box, so its editor-collapse-toggle shows.
const TALL_OUTPUT_SRC = 'for i in range(200):\n    print(f"output line {i}")';
const TALL_INPUT_SRC = Array.from({ length: 60 }, (_, i) => `value_${i} = ${i}`).join('\n');

function notebookJson(): string {
	return JSON.stringify({
		nbformat: 4,
		nbformat_minor: 5,
		metadata: { kernelspec: { name: 'python3', display_name: 'python3' } },
		cells: [
			{
				cell_type: 'code',
				id: 'cell-out-aaaaaaaa',
				metadata: {},
				execution_count: null,
				source: [TALL_OUTPUT_SRC],
				outputs: []
			},
			{
				cell_type: 'code',
				id: 'cell-in-aaaaaaaaa',
				metadata: {},
				execution_count: null,
				source: [TALL_INPUT_SRC],
				outputs: []
			}
		]
	});
}

test.beforeAll(async () => {
	test.skip(
		!runtimeAvailable(),
		'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only'
	);
	workspace = mkdtempSync(join(tmpdir(), 'cellar-expand-e2e-'));
	writeFileSync(join(workspace, 'notebook.ipynb'), notebookJson());
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

async function ensureNotebookOpen(page: Page): Promise<void> {
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	const emptyBtn = page.getByTestId('empty-open-notebook');
	const firstCell = page.getByTestId('cell').first();
	await expect(emptyBtn.or(firstCell).first()).toBeVisible();
	if (await emptyBtn.isVisible()) await emptyBtn.click();
	await expect(firstCell).toBeVisible();
}

/**
 * Force a classic, always-visible 15px vertical scrollbar on every scroll box.
 * `scrollbar-gutter: stable` reserves real layout width (`offsetWidth -
 * clientWidth` = 15) even where the platform default is an overlay scrollbar
 * (macOS/headless Chromium), which is what lets this reproduce the classic
 * always-on case cross-platform; the `::-webkit-scrollbar` styling paints a
 * visible thumb in that reserved gutter for the screenshots.
 */
async function forceClassicScrollbars(page: Page): Promise<void> {
	await page.addStyleTag({
		content: `
			[data-testid="output-scroll"], [data-testid="editor-scroll"] {
				scrollbar-gutter: stable !important;
			}
			[data-testid="output-scroll"]::-webkit-scrollbar,
			[data-testid="editor-scroll"]::-webkit-scrollbar {
				width: 15px !important;
			}
			[data-testid="output-scroll"]::-webkit-scrollbar-thumb,
			[data-testid="editor-scroll"]::-webkit-scrollbar-thumb {
				background: #d33682 !important;
				border-radius: 0;
			}
			[data-testid="output-scroll"]::-webkit-scrollbar-track,
			[data-testid="editor-scroll"]::-webkit-scrollbar-track {
				background: #ffe08a !important;
			}
		`
	});
}

/**
 * Undo the forced classic gutter → back to an overlay scrollbar (0 layout width),
 * the platform default on macOS/headless Chromium. A later `!important` rule of
 * equal specificity wins, so this resets `scrollbar-gutter` to `auto`.
 */
async function forceOverlayScrollbars(page: Page): Promise<void> {
	await page.addStyleTag({
		content: `
			[data-testid="output-scroll"], [data-testid="editor-scroll"] {
				scrollbar-gutter: auto !important;
			}
			[data-testid="output-scroll"]::-webkit-scrollbar,
			[data-testid="editor-scroll"]::-webkit-scrollbar {
				width: 0px !important;
			}
		`
	});
}

/**
 * Draw a labeled translucent strip over the scroll box's reserved scrollbar
 * gutter. Headless Chromium reserves the gutter width but paints no visible thumb
 * at rest, so this annotation makes the gutter (and thus the overlap / clearance)
 * visible in the screenshots. Returns a cleanup that removes the marker.
 */
async function annotateGutter(page: Page, scrollBox: Locator, label: string): Promise<() => Promise<void>> {
	const id = await scrollBox.evaluate((el: HTMLElement, text) => {
		const r = el.getBoundingClientRect();
		const w = el.offsetWidth - el.clientWidth;
		const mark = document.createElement('div');
		mark.id = 'gutter-marker-' + Math.random().toString(36).slice(2);
		mark.style.cssText = [
			'position:fixed',
			`left:${r.right - w}px`,
			`top:${r.top}px`,
			`width:${w}px`,
			`height:${r.height}px`,
			'background:rgba(211,54,130,0.55)',
			'outline:1px solid #d33682',
			'z-index:9999',
			'pointer-events:none'
		].join(';');
		const tag = document.createElement('div');
		tag.textContent = text;
		tag.style.cssText = [
			`position:fixed`,
			`left:${r.right - w - 150}px`,
			`top:${r.top - 16}px`,
			'font:11px sans-serif',
			'color:#d33682',
			'background:rgba(255,255,255,0.9)',
			'padding:1px 4px',
			'border-radius:3px',
			'z-index:9999',
			'pointer-events:none'
		].join(';');
		tag.id = mark.id + '-tag';
		document.body.appendChild(mark);
		document.body.appendChild(tag);
		return mark.id;
	}, label);
	return async () => {
		await page.evaluate((markId) => {
			document.getElementById(markId)?.remove();
			document.getElementById(markId + '-tag')?.remove();
		}, id);
	};
}

/**
 * Geometry of a toggle vs. its scroll box: the box's measured scrollbar width, the
 * gutter's inner left edge, and how far the toggle's right edge sits from that
 * gutter (positive = a clear gap; negative = overlap).
 */
async function toggleVsGutter(
	scrollBox: Locator,
	toggle: Locator
): Promise<{ scrollbarW: number; gapToGutter: number; toggleRightEdge: number; gutterLeft: number }> {
	const box = await scrollBox.evaluate((el: HTMLElement) => {
		const r = el.getBoundingClientRect();
		return { right: r.right, scrollbarW: el.offsetWidth - el.clientWidth };
	});
	const toggleRight = await toggle.evaluate((el) => el.getBoundingClientRect().right);
	const gutterLeft = box.right - box.scrollbarW;
	return {
		scrollbarW: box.scrollbarW,
		gutterLeft,
		toggleRightEdge: toggleRight,
		gapToGutter: gutterLeft - toggleRight
	};
}

test('input + output expand toggles clear the scrollbar gutter in every scrollbar state', async ({
	page
}) => {
	await page.setViewportSize({ width: 1100, height: 900 });
	await ensureNotebookOpen(page);

	const outCell = page.getByTestId('cell').nth(0);
	const inCell = page.getByTestId('cell').nth(1);

	// Run cell 0 so it emits 200 lines → its output auto-contracts and the
	// output-scroll-toggle appears with the box scrolled.
	await outCell.getByTestId('run').click();
	const outScroll = outCell.getByTestId('output-scroll');
	await expect(outScroll).toContainText('output line 199', { timeout: 60_000 });
	await expect(outScroll).toHaveAttribute('data-scrolled', 'true');
	const outToggle = outCell.getByTestId('output-scroll-toggle');
	await expect(outToggle).toBeVisible();

	// The tall-source cell auto-collapses its editor → editor-collapse-toggle shows.
	const inToggle = inCell.getByTestId('editor-collapse-toggle');
	await expect(inToggle).toBeVisible();
	const inScroll = inCell.getByTestId('editor-scroll');
	await expect(inScroll).toHaveAttribute('data-collapsed', 'true');

	// ---- Scenario 1: classic always-on 15px scrollbar --------------------------
	await forceClassicScrollbars(page);
	// The reactive re-measure (ResizeObserver on the box) needs a beat to inset.
	await expect
		.poll(async () => (await toggleVsGutter(outScroll, outToggle)).scrollbarW, { timeout: 5000 })
		.toBeGreaterThan(10);

	const outClassic = await toggleVsGutter(outScroll, outToggle);
	const inClassic = await toggleVsGutter(inScroll, inToggle);

	// The classic scrollbar really took layout width...
	expect(outClassic.scrollbarW).toBeGreaterThan(10);
	expect(inClassic.scrollbarW).toBeGreaterThan(10);
	// ...and the toggle's right edge sits LEFT of the gutter with a small gap
	// (~4px = the 0.25rem term past the measured width), i.e. it no longer overlaps.
	expect(outClassic.gapToGutter).toBeGreaterThan(1);
	expect(inClassic.gapToGutter).toBeGreaterThan(1);
	// The gap is small + consistent (not a huge inset): a few px, not tens.
	expect(outClassic.gapToGutter).toBeLessThan(10);

	// Screenshot the FIXED layout: the "expand" toggle sits clear (left) of the
	// pink-marked scrollbar gutter.
	let cleanupOut = await annotateGutter(page, outScroll, 'scrollbar gutter (15px) →');
	let cleanupIn = await annotateGutter(page, inScroll, 'scrollbar gutter (15px) →');
	await outCell.screenshot({ path: join(EVIDENCE, 'output-classic-scrollbar-fixed.png') });
	await inCell.screenshot({ path: join(EVIDENCE, 'input-classic-scrollbar-fixed.png') });
	await cleanupOut();
	await cleanupIn();

	// ---- Reproduce the OLD bug on the SAME live toggle: pin it back to right:4px.
	// This is the pre-fix positioning; its right edge now paints OVER the scrollbar.
	await outToggle.evaluate((el) => {
		el.setAttribute('style', 'right: 0.25rem;');
	});
	const outOld = await toggleVsGutter(outScroll, outToggle);
	expect(outOld.gapToGutter).toBeLessThan(0); // negative = overlaps the gutter
	// The overlap is on the order of the scrollbar width minus the 4px pin (~11px).
	expect(outOld.gapToGutter).toBeLessThan(-8);
	cleanupOut = await annotateGutter(page, outScroll, 'scrollbar gutter (15px) →');
	await outCell.screenshot({ path: join(EVIDENCE, 'output-classic-scrollbar-OLD-overlap.png') });
	await cleanupOut();
	// Restore the fix (remove the override so the style:right binding wins again).
	await outToggle.evaluate((el) => {
		el.removeAttribute('style');
	});

	// ---- Scenario 2: overlay scrollbar (0 layout width) ------------------------
	await forceOverlayScrollbars(page);
	await expect
		.poll(async () => (await toggleVsGutter(outScroll, outToggle)).scrollbarW, { timeout: 5000 })
		.toBe(0);

	const outOverlay = await toggleVsGutter(outScroll, outToggle);
	const inOverlay = await toggleVsGutter(inScroll, inToggle);
	// No layout scrollbar → the 1rem (~16px) floor keeps the toggle off the edge an
	// overlay scrollbar would paint over on hover. The gap-to-(zero-width)-gutter
	// equals the toggle's inset, ~16px.
	expect(outOverlay.scrollbarW).toBe(0);
	expect(outOverlay.gapToGutter).toBeGreaterThanOrEqual(14);
	expect(inOverlay.gapToGutter).toBeGreaterThanOrEqual(14);
	await outCell.screenshot({ path: join(EVIDENCE, 'output-overlay-scrollbar-fixed.png') });

	// ---- Behavior unchanged: the toggle still flips state. ----------------------
	await expect(outScroll).toHaveAttribute('data-scrolled', 'true');
	await outToggle.click(); // expand
	await expect(outScroll).not.toHaveAttribute('data-scrolled', 'true');
	await outToggle.click(); // contract again
	await expect(outScroll).toHaveAttribute('data-scrolled', 'true');

	await expect(inScroll).toHaveAttribute('data-collapsed', 'true');
	await inToggle.click(); // expand editor
	await expect(inScroll).not.toHaveAttribute('data-collapsed', 'true');
	await inToggle.click(); // collapse again
	await expect(inScroll).toHaveAttribute('data-collapsed', 'true');
});
