import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * E2E for the interim cell virtualization (Tier 3 perf): a code cell renders its
 * source WITHOUT building a CodeMirror `EditorView`; the heavy editor is created
 * only on first edit-intent. This proves, in the REAL app against a REAL kernel,
 * the promises that matter:
 *
 *   (a) every cell shows its code on open,
 *   (b) ZERO live editors exist until the user interacts (a per-cell-eager design
 *       would have one per cell — the count NOT tracking the cell count is the
 *       decisive signal),
 *   (c) clicking a cell builds exactly one editor, carrying that cell's source,
 *   (d) editing then running works,
 *   (e) running an UN-focused cell works and does NOT require/build its editor,
 *   (f) a keyboard enter-edit on a never-focused cell builds its editor first.
 *
 * Boots the real launcher (see ./harness); skips when the kernel runtime is
 * absent, like the smoke spec. A 6-cell notebook is written to disk up front so
 * the cells exist WITHOUT any of them having been focused (typing would build an
 * editor), which is what lets (a)/(b) be observed on a clean open.
 */

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

const MARKERS = ['A = 111', 'B = 222', 'C = 333', 'print(4444)', 'D = 555', 'E = 666'];

function notebookJson(): string {
	return JSON.stringify({
		nbformat: 4,
		nbformat_minor: 5,
		metadata: { kernelspec: { name: 'python3', display_name: 'python3' } },
		cells: MARKERS.map((src, i) => ({
			cell_type: 'code',
			id: `cell-${i}-aaaaaaaa`,
			metadata: {},
			execution_count: null,
			source: [src],
			outputs: []
		}))
	});
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-lazy-e2e-'));
	// Seed a multi-cell notebook so the cells exist unfocused on first open.
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

/** Count of live CodeMirror editors on the page (each cell builds at most one). */
function editorCount(page: Page): Promise<number> {
	return page.locator('.cm-editor').count();
}

/**
 * Open the notebook, robust to test order. On a fresh server the empty state
 * offers to open it; once a prior test has opened it the server seeds the tab, so
 * it is already open and there is no empty-state button. Either way, wait for the
 * cells to be present.
 */
async function ensureNotebookOpen(page: Page): Promise<void> {
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	const emptyBtn = page.getByTestId('empty-open-notebook');
	const firstCell = page.getByTestId('cell').first();
	await expect(emptyBtn.or(firstCell).first()).toBeVisible();
	if (await emptyBtn.isVisible()) await emptyBtn.click();
	await expect(firstCell).toBeVisible();
}

test('cells render their source with zero editors until first interaction', async ({ page }) => {
	await ensureNotebookOpen(page);

	const cells = page.getByTestId('cell');
	await expect(cells).toHaveCount(6);

	// (a) Every cell shows its exact source via the read-only static render.
	for (let i = 0; i < 6; i++) {
		await expect(cells.nth(i).getByTestId('static-code')).toBeVisible();
		await expect(cells.nth(i)).toContainText(MARKERS[i]);
	}

	// (b) ZERO live editors on open — the whole point. A per-cell-eager build would
	// have made 6. Give the app a beat to settle so this isn't a race on an early read.
	await expect.poll(() => editorCount(page)).toBe(0);

	// (c) Click a NEVER-focused cell (index 2) → exactly one editor, its source loaded.
	const c2 = cells.nth(2);
	await c2.getByTestId('editor-scroll').click();
	await expect(c2.locator('.cm-editor')).toBeVisible();
	await expect(c2.getByTestId('static-code')).toHaveCount(0); // static handed off to the editor
	await expect(editorCount(page)).resolves.toBe(1);
	await expect(c2.locator('.cm-content')).toContainText('C = 333');

	// (d) Edit it, run, and see the kernel result.
	await c2.locator('.cm-content').click();
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.type('print(90909)');
	await c2.getByTestId('run').click();
	await expect(c2.getByTestId('output-scroll')).toContainText('90909', { timeout: 60_000 });

	// (e) Run an UN-focused cell (index 3, `print(4444)`) with NO editor built: the
	// run reads the doc source, not an EditorView. Its output lands and its editor
	// stays unbuilt (still showing the static render) — a run must not require one.
	const c3 = cells.nth(3);
	await expect(c3.getByTestId('static-code')).toBeVisible();
	await c3.getByTestId('run').click();
	await expect(c3.getByTestId('output-scroll')).toContainText('4444', { timeout: 60_000 });
	await expect(c3.getByTestId('static-code')).toBeVisible(); // still no editor built by running
	await expect(editorCount(page)).resolves.toBe(1); // only cell 2's editor exists

	// (f) Command-mode keyboard navigation must NOT build editors; entering edit
	// mode on the reached cell builds its editor before focusing it (the
	// reveal-and-mount rule — never target a non-existent editor). We don't hardcode
	// which cell is reached: only that walking selection builds nothing, and that
	// the cell landed on was showing its static render until Enter summoned an editor.
	await page.keyboard.press('Escape'); // → command mode (focus on the active cell's card)
	await expect(editorCount(page)).resolves.toBe(1); // Escape tears nothing down (lazy-create only)
	await page.keyboard.press('k'); // walk the selection up through cells...
	await page.keyboard.press('k');
	await expect(editorCount(page)).resolves.toBe(1); // ...building nothing along the way
	const active = page.locator('[data-testid="cell"][data-active="true"]');
	await expect(active).toHaveCount(1);
	await expect(active.getByTestId('static-code')).toBeVisible(); // reached a never-focused cell
	await page.keyboard.press('Enter'); // edit-mode → build + focus the reached editor
	await expect(active.locator('.cm-editor')).toBeVisible();
	await expect(active.getByTestId('static-code')).toHaveCount(0);
	await expect(editorCount(page)).resolves.toBe(2);
});

/**
 * The x-position of a cell's first code character must be IDENTICAL before and
 * after its editor is summoned. Regression guard for the fold-gutter reflow: the
 * static render reserves the fold gutter's column (`.cm-static-foldgutter`, width
 * `--cellar-cm-fold-width`) that `basicSetup`'s `foldGutter` mounts on first
 * click, so the code never jumps right by that gutter's width. `basicSetup`
 * reserves the fold column even for cells with no foldable region, so these
 * single-line cells still exercise the reflow the fix removes.
 */
async function firstCharLeft(page: Page, cellIndex: number, selector: string): Promise<number> {
	const line = page.getByTestId('cell').nth(cellIndex).locator(selector).first();
	await expect(line).toBeVisible();
	return line.evaluate((el) => {
		// A Range around the first character measures the glyph's left edge, which
		// is exactly what a user perceives as the code's x-position.
		const node = el.firstChild ?? el;
		const range = document.createRange();
		range.setStart(node, 0);
		range.setEnd(node, node.textContent && node.textContent.length ? 1 : 0);
		return range.getBoundingClientRect().left;
	});
}

test('summoning a cell editor does not shift the code horizontally (fold-gutter reserved)', async ({ page }) => {
	await ensureNotebookOpen(page);
	const cells = page.getByTestId('cell');
	await expect(cells).toHaveCount(6);

	// Cell 5 ('E = 666') is never mutated by the other specs — use it so this test
	// is order-independent. It shows its static render with no editor built.
	const c5 = cells.nth(5);
	await expect(c5.getByTestId('static-code')).toBeVisible();

	// BEFORE: the static render's first character.
	const before = await firstCharLeft(page, 5, '.cm-static-line');

	// Summon the editor (first-click) — this is where the fold gutter would appear.
	await c5.getByTestId('editor-scroll').click();
	await expect(c5.locator('.cm-editor')).toBeVisible();
	await expect(c5.getByTestId('static-code')).toHaveCount(0);

	// AFTER: the live editor's first character. Must land on the same pixel.
	const after = await firstCharLeft(page, 5, '.cm-line');

	// Without the reserved fold column the shift is the whole gutter width (~10px);
	// the reserved column pins it to zero. Sub-pixel tolerance for rounding only.
	expect(Math.abs(after - before)).toBeLessThan(0.5);
});

test('an agent edit to an UNfocused cell updates its static render (doc is source of truth)', async ({ page }) => {
	await ensureNotebookOpen(page);
	const cells = page.getByTestId('cell');
	await expect(cells).toHaveCount(6);

	// Cell 4 is untouched: it shows its source via the static render, no editor.
	const c4 = cells.nth(4);
	await expect(c4.getByTestId('static-code')).toBeVisible();
	await expect(c4).toContainText('D = 555');

	// Drive the EXACT server path an MCP `edit_cell` uses: a source change that
	// emits the `cell:edited` event. A foreign `originId` (not this tab's) means the
	// event is applied as a remote edit, not suppressed as our own echo — precisely
	// what an agent's edit looks like to an open browser.
	const res = await page.request.patch(`${baseURL}/api/cells/cell-4-aaaaaaaa`, {
		data: { source: 'AGENT_EDIT = 7', nb: 'notebook.ipynb', originId: 'agent-sim' }
	});
	expect(res.ok()).toBe(true);

	// The still-UNfocused cell reflects the edit in its static render — no editor built.
	await expect(c4).toContainText('AGENT_EDIT = 7');
	await expect(c4.getByTestId('static-code')).toBeVisible();
	await expect(c4.locator('.cm-editor')).toHaveCount(0);

	// Focusing it now builds an editor seeded from the EDITED source, not the stale
	// original — the doc stays the single source of truth across the lazy build.
	await c4.getByTestId('editor-scroll').click();
	await expect(c4.locator('.cm-content')).toContainText('AGENT_EDIT = 7');
	await expect(c4.locator('.cm-content')).not.toContainText('D = 555');
});
