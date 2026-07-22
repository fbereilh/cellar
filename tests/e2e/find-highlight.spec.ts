import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * E2E for in-place match highlighting (Search P4).
 *
 * Proves the visual layer against the REAL app: every match highlighted WHERE it
 * appears across the three surfaces (code - built editor AND the static stand-in,
 * rendered markdown, output), the active match visually distinct + scrolled into
 * view, stepping moves the emphasis, closing clears everything, and (virtualization
 * on) a windowed-out match highlights once navigated-to. Highlighting is view-only:
 * it never mutates the model.
 *
 * Highlights are painted with the CSS Custom Highlight API (rendered surfaces) and
 * CodeMirror `.cm-searchMatch` decorations (built editors), so the assertions read
 * `CSS.highlights` range counts + `.cm-searchMatch` nodes rather than pixels.
 *
 * SKIPS when the kernel runtime is absent (local-only, like the rest of E2E). The
 * pure mapping (`findOccurrences` / `buildCellHighlights`) has a vitest suite
 * (`tests/unit/search-highlight.test.ts`); this covers the DOM/editor wiring.
 */

const TOKEN = 'qqzzx';

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

function id(i: number): string {
	const h = ((i * 2654435761) >>> 0).toString(16).padStart(8, '0');
	return `${h}-0000-4000-8000-${String(i).padStart(12, '0')}`;
}
function codeCell(i: number, source: string, outputs: unknown[] = []) {
	return { cell_type: 'code', id: id(i), metadata: { cellar: { visible: true } }, execution_count: null, outputs, source };
}
function mdCell(i: number, source: string) {
	return { cell_type: 'markdown', id: id(i), metadata: { cellar: { visible: true } }, source };
}

const IDX = {
	heading: 0, // `# Highlight Test`
	mdMatch: 1, // `Some qqzzx prose.`      (rendered-markdown surface)
	srcMatch: 2, // `alpha = 'qqzzx'`        (static-code / editor surface)
	outMatch: 3, // stream output holds qqzzx (output surface)
	bottom: 60 // `omega = 'qqzzx'`        (windowing target, far down)
};

/** Seed notebook: one match per surface, plus a far-down match for virtualization. */
function buildNotebook(): string {
	const cells: unknown[] = [];
	cells.push(mdCell(IDX.heading, '# Highlight Test'));
	cells.push(mdCell(IDX.mdMatch, `Some **${TOKEN}** prose.`));
	cells.push(codeCell(IDX.srcMatch, `alpha = '${TOKEN}'`));
	cells.push(
		codeCell(IDX.outMatch, `print("value")`, [
			{ output_type: 'stream', name: 'stdout', text: `computed ${TOKEN} result\n` }
		])
	);
	for (let i = 4; i < IDX.bottom; i++) cells.push(codeCell(i, `g${i} = ${i}`));
	cells.push(codeCell(IDX.bottom, `omega = '${TOKEN}'`));
	return JSON.stringify({ cells, metadata: { kernelspec: { name: 'python3', display_name: 'python3' } }, nbformat: 4, nbformat_minor: 5 });
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-e2e-findhl-'));
	writeFileSync(join(workspace, 'notebook.ipynb'), buildNotebook());
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

const findInput = (page: Page) => page.getByTestId('find-input');
const findCount = (page: Page) => page.getByTestId('find-count');

async function open(page: Page, virtualize = false): Promise<void> {
	const q = `?ws=${encodeURIComponent(workspace)}${virtualize ? '&virtualize=1' : ''}`;
	await page.goto(`${baseURL}/${q}`);
	const openBtn = page.getByTestId('empty-open-notebook');
	if (await openBtn.isVisible().catch(() => false)) await openBtn.click();
	await expect(page.getByTestId('cell').first()).toBeVisible({ timeout: 30_000 });
}

/**
 * Open the find bar via the shell shortcut (window-level, so it fires without
 * clicking anything). Deliberately NOT by clicking a cell, so no code cell's lazy
 * editor is summoned and its source surface stays the `StaticCode` stand-in (the
 * CSS Custom Highlight path we want to exercise). A separate test builds an editor
 * explicitly to cover the CodeMirror path.
 */
async function openFindBar(page: Page): Promise<void> {
	await page.keyboard.press('ControlOrMeta+Shift+F');
	await expect(page.getByTestId('find-bar')).toBeVisible();
}

/** Total ranges in a named CSS Custom Highlight (0 when absent). */
function highlightCount(page: Page, name: string): Promise<number> {
	return page.evaluate((n) => {
		const hi = (CSS as unknown as { highlights?: Map<string, { size: number }> }).highlights?.get(n);
		return hi ? hi.size : 0;
	}, name);
}

/**
 * The active-emphasis count across BOTH mechanisms: a rendered surface (static
 * code / markdown / output) marks the active match with the `cellar-search-active`
 * CSS highlight, while a BUILT editor marks it with a `.cm-searchMatch-selected`
 * decoration. Exactly one active emphasis should exist at any time, on whichever
 * surface the active match lives.
 */
async function activeEmphasisCount(page: Page): Promise<number> {
	const css = await highlightCount(page, 'cellar-search-active');
	const cm = await page.locator('.cm-searchMatch-selected').count();
	return css + cm;
}

test('CSS Custom Highlight API is available (the primary paint path)', async ({ page }) => {
	await open(page);
	const ok = await page.evaluate(
		() => typeof CSS !== 'undefined' && !!(CSS as unknown as { highlights?: unknown }).highlights && typeof Highlight !== 'undefined'
	);
	expect(ok).toBe(true);
});

test('all matches highlighted across rendered markdown + static code + output; active is distinct', async ({ page }) => {
	await open(page);
	await openFindBar(page);
	await findInput(page).fill(TOKEN);
	await expect(findCount(page)).toHaveText(/^\d+\/\d+$/); // count populated

	// The rendered-markdown, static-code and output surfaces are all painted via the
	// CSS Custom Highlight API, so the base highlight holds several ranges and there
	// is exactly one active emphasis.
	await expect.poll(() => highlightCount(page, 'cellar-search')).toBeGreaterThan(0);
	await expect.poll(() => activeEmphasisCount(page)).toBe(1);

	// The active match landed in the first cell that has one (the markdown prose):
	// its RENDERED surface contains the token, proving highlight targets the right
	// surface (not the raw source).
	const md = page.locator(`[data-cell-id="${id(IDX.mdMatch)}"] [data-testid="markdown-rendered"]`);
	await expect(md).toContainText(TOKEN);

	// The code cell's source is highlighted on its StaticCode stand-in (no editor
	// built via the sidebar-open path), i.e. the CSS-highlight code path.
	const staticCode = page.locator(`[data-cell-id="${id(IDX.srcMatch)}"] [data-testid="static-code"]`);
	await expect(staticCode).toBeVisible();
	await expect(page.locator(`[data-cell-id="${id(IDX.srcMatch)}"] .cm-editor`)).toHaveCount(0);
});

test('built editor shows CodeMirror .cm-searchMatch decorations', async ({ page }) => {
	await open(page);
	// Summon the code cell's real editor by clicking its static stand-in.
	const codeCard = page.locator(`[data-cell-id="${id(IDX.srcMatch)}"]`);
	await codeCard.getByTestId('static-code').click();
	await expect(codeCard.locator('.cm-editor')).toBeVisible();

	await openFindBar(page);
	await findInput(page).fill(TOKEN);
	// The built editor decorates its one match with `.cm-searchMatch` (the class the
	// theme styles), proving the CodeMirror highlight path (not the CSS one).
	await expect(codeCard.locator('.cm-searchMatch')).toHaveCount(1);
});

test('stepping next/prev moves the active emphasis (count follows, active stays single)', async ({ page }) => {
	await open(page);
	await openFindBar(page);
	await findInput(page).fill(TOKEN);
	await expect(findCount(page)).toHaveText(/^1\//);
	await expect.poll(() => activeEmphasisCount(page)).toBe(1);

	await page.keyboard.press('Enter'); // → match 2 (static-code source)
	await expect(findCount(page)).toHaveText(/^2\//);
	// Exactly one active emphasis at all times, and the active cell is in view.
	await expect.poll(() => activeEmphasisCount(page)).toBe(1);
	await expect(page.locator(`[data-cell-id="${id(IDX.srcMatch)}"]`)).toBeInViewport();

	await page.keyboard.press('Enter'); // → match 3 (output)
	await expect(findCount(page)).toHaveText(/^3\//);
	await expect.poll(() => activeEmphasisCount(page)).toBe(1);
	await expect(page.locator(`[data-cell-id="${id(IDX.outMatch)}"]`)).toBeInViewport();

	await page.keyboard.press('Shift+Enter'); // → back to match 2
	await expect(findCount(page)).toHaveText(/^2\//);
	await expect.poll(() => activeEmphasisCount(page)).toBe(1);
});

test('closing the bar clears every highlight', async ({ page }) => {
	await open(page);
	await openFindBar(page);
	await findInput(page).fill(TOKEN);
	await expect.poll(() => highlightCount(page, 'cellar-search')).toBeGreaterThan(0);

	await page.keyboard.press('Escape');
	await expect(page.getByTestId('find-bar')).toBeHidden();
	await expect.poll(() => highlightCount(page, 'cellar-search')).toBe(0);
	await expect.poll(() => highlightCount(page, 'cellar-search-active')).toBe(0);
});

test('view-only: highlighting is a pure overlay (no <mark> mutation, source unchanged)', async ({ page }) => {
	await open(page);
	const read = (cid: string) =>
		page.evaluate(
			(c) => document.querySelector(`[data-cell-id="${c}"] [data-testid="static-code"]`)?.textContent ?? '',
			cid
		);
	const before = await read(id(IDX.srcMatch));
	expect(before).toContain(TOKEN); // sanity: the static stand-in holds the source

	await openFindBar(page);
	await findInput(page).fill(TOKEN);
	await expect.poll(() => highlightCount(page, 'cellar-search')).toBeGreaterThan(0);

	// The Custom Highlight API path inserts NO DOM (`<mark>`) - it is a pure Range
	// overlay - and the source text is byte-identical.
	expect(await page.locator('mark.cellar-search-mark').count()).toBe(0);
	expect(await read(id(IDX.srcMatch))).toBe(before);
});

test('with virtualization on, a windowed-out match highlights once navigated-to', async ({ page }) => {
	await open(page, /* virtualize */ true);
	const bottom = page.locator(`[data-cell-id="${id(IDX.bottom)}"]`);
	await expect(bottom).toHaveCount(0); // windowed out

	await openFindBar(page);
	await findInput(page).fill(TOKEN);
	// Wait for the count to settle, then read the total.
	await expect(findCount(page)).toHaveText(/^\d+\/\d+$/);
	const count = (await findCount(page).textContent()) ?? '';
	const total = Number(count.split('/')[1]);
	expect(total).toBeGreaterThan(1);

	await page.keyboard.press('Shift+Enter'); // wrap to the last match (the bottom cell)
	await expect(findCount(page)).toHaveText(new RegExp(`^${total}/${total}$`));

	// jumpToCell mounted the windowed-out cell; it now highlights in place.
	await expect(bottom).toHaveCount(1);
	await expect(bottom).toBeVisible();
	await expect.poll(() => activeEmphasisCount(page)).toBe(1);
});
