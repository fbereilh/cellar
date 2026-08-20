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
/** A second token, used only by the math case so it never disturbs TOKEN's counts. */
const MATH_TOKEN = 'wwyyv';

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
	mathMatch: 100, // prose + inline math, all three holding wwyyv (rendered markdown)
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
	cells.push(
		mdCell(IDX.mathMatch, `Prose ${MATH_TOKEN} before $${MATH_TOKEN}^2$ and ${MATH_TOKEN} after.`)
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

// Windowing is on by default since P5, so both modes are pinned EXPLICITLY here:
// `virtualize=0` keeps the un-windowed coverage these cases were written against,
// `virtualize=1` the windowed one. Neither rides the shell's default.
async function open(page: Page, virtualize = false): Promise<void> {
	const q = `?ws=${encodeURIComponent(workspace)}&virtualize=${virtualize ? '1' : '0'}`;
	await page.goto(`${baseURL}/${q}`);
	const openBtn = page.getByTestId('empty-open-notebook');
	// Settle on whichever the shell paints - the empty state, or a notebook that is
	// already open - BEFORE probing. Probed earlier, a slow first paint reports the
	// button invisible, the click becomes a no-op, and the wait below then times out
	// on a notebook nothing ever opened (a real flake under `workers: 2`).
	await expect(openBtn.or(page.getByTestId('cell').first())).toBeVisible();
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

/**
 * A compact signature of the ACTIVE emphasis: one entry per active range, saying
 * whether it sits inside typeset math and what text node holds it. `inMath:true`
 * would mean the emphasis landed on one of KaTeX's invisible copies of the
 * expression (the clipped MathML branch or its `<annotation>` TeX) - the regression.
 */
async function activeSignature(page: Page): Promise<string> {
	return page.evaluate(() => {
		const hi = (CSS as unknown as { highlights?: Map<string, Iterable<Range>> }).highlights?.get(
			'cellar-search-active'
		);
		if (!hi) return '';
		const parts: string[] = [];
		for (const r of hi) {
			const n = r.startContainer;
			const el = n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement;
			parts.push(`${el?.closest('.katex, .katex-error') ? 'math' : 'prose'}:${n.textContent ?? ''}`);
		}
		return parts.join(' | ');
	});
}

test('math counts once: no ordinal lands on an invisible KaTeX copy', async ({ page }) => {
	// KaTeX writes each expression's text three times (clipped MathML, its
	// `<annotation>` TeX, the visible glyphs) while the engine counts it once from the
	// source, so a naive DOM walk emphasized an invisible node and painted more
	// highlights than the bar reported. Three model matches here - before the math,
	// INSIDE it, after it - and only the two prose ones are paintable.
	await open(page);
	await openFindBar(page);
	await findInput(page).fill(MATH_TOKEN);
	await expect(findCount(page)).toHaveText('1/3');

	const painted = async () =>
		(await highlightCount(page, 'cellar-search')) + (await highlightCount(page, 'cellar-search-active'));
	await expect.poll(painted).toBe(2);

	// Match 1: the occurrence BEFORE the math, on the visible prose.
	await expect.poll(() => activeSignature(page)).toBe('prose:Prose wwyyv before ');

	// Match 2 is inside the math: counted (it is in the source) but nothing is
	// emphasized, because the rendered glyphs are not the source text. Crucially the
	// base highlights stay put rather than shifting onto the math.
	await page.keyboard.press('Enter');
	await expect(findCount(page)).toHaveText('2/3');
	await expect.poll(() => activeSignature(page)).toBe('');
	await expect.poll(painted).toBe(2);

	// Match 3: the occurrence AFTER the math - the one the regression skipped past.
	await page.keyboard.press('Enter');
	await expect(findCount(page)).toHaveText('3/3');
	await expect.poll(() => activeSignature(page)).toBe('prose: and wwyyv after.');
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

test('a full collapse clears a markdown cell\'s highlights, and expanding repaints them', async ({ page }) => {
	await open(page);
	await openFindBar(page);
	await findInput(page).fill(TOKEN);

	const md = page.locator(`[data-cell-id="${id(IDX.mdMatch)}"]`);
	const toggle = md.getByTestId('cell-collapse-toggle');
	const painted = async () =>
		(await highlightCount(page, 'cellar-search')) + (await highlightCount(page, 'cellar-search-active'));
	await expect.poll(painted).toBeGreaterThan(0);
	const before = await painted();

	// A full collapse DROPS the rendered-markdown block via `{#if}`, so this cell's
	// ranges must be cleared rather than left pointing at detached nodes.
	await toggle.click();
	await expect(md.getByTestId('markdown-rendered')).toHaveCount(0);
	await expect.poll(painted).toBe(before - 1);

	// The regression this pins: expanding re-creates that block, but no other
	// highlight input changed - so without `cellCollapsed` as a tracked dep the cell
	// stayed unpainted while the find bar went on counting its match.
	await toggle.click();
	await expect(md.getByTestId('markdown-rendered')).toBeVisible();
	await expect.poll(painted).toBe(before);
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

/**
 * The `data-testid` of the element each active-emphasis range sits inside - so a
 * test can assert WHICH surface the emphasis landed on, not merely that one exists.
 */
function activeHighlightHosts(page: Page): Promise<string[]> {
	return page.evaluate(() => {
		const hi = (CSS as unknown as { highlights?: Map<string, Iterable<Range>> }).highlights?.get(
			'cellar-search-active'
		);
		const out: string[] = [];
		if (!hi) return out;
		for (const r of hi) {
			const n = r.startContainer;
			const el = n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement;
			out.push(el?.closest('[data-testid]')?.getAttribute('data-testid') ?? '');
		}
		return out;
	});
}

test('a cell-id query highlights the toolbar id chip - and keeps doing so when collapsed', async ({
	page
}) => {
	// A cell is findable by its id handle, and the surface that shows it - the
	// toolbar `cell #xxxxxxxx` chip - is the ONE that survives a full collapse. So
	// unlike a source/output match (counted but unpaintable on a collapsed cell), an
	// id match on a collapsed cell is fully visible: the good case.
	await open(page);
	// A filler cell, deliberately holding no TOKEN, so collapsing it cannot disturb
	// any other case in this file even if this one fails before restoring it.
	const targetId = id(10);
	const card = page.locator(`[data-cell-id="${targetId}"]`);
	await card.scrollIntoViewIfNeeded();

	await openFindBar(page);
	await findInput(page).fill(targetId.slice(0, 8));
	await expect(findCount(page)).toHaveText('1/1');

	// Exactly one emphasis, and it is inside that cell's id chip.
	await expect.poll(() => activeEmphasisCount(page)).toBe(1);
	await expect.poll(() => activeHighlightHosts(page)).toEqual(['cell-id-copy']);
	await expect(card.getByTestId('cell-id-copy')).toBeVisible();

	try {
		// Collapse the cell: input and output go, the toolbar (and the chip) stay.
		await card.getByTestId('cell-collapse-toggle').click();
		await expect(card.getByTestId('collapsed-preview')).toBeVisible();
		await expect(card.getByTestId('cell-id-copy')).toBeVisible();
		await expect.poll(() => activeHighlightHosts(page)).toEqual(['cell-id-copy']);
	} finally {
		// Collapse state is PERSISTED per project, so put it back for the rest of
		// this file (which shares one workspace).
		await card.getByTestId('cell-collapse-toggle').click();
	}
	await expect(card.getByTestId('collapsed-preview')).toHaveCount(0);
});
