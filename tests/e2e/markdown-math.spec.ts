import { test, expect } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * TeX math in rendered markdown, end to end through the REAL launcher — which
 * means the PACKAGED build (`build/index.js`, never `--dev`), because the half of
 * this feature that a unit test cannot reach is asset delivery: KaTeX's
 * stylesheet and its fonts have to be bundled and served by Cellar itself.
 *
 * So the load-bearing assertions here are the ones vitest cannot make:
 *   - a KaTeX web font actually LOADED (not merely referenced), and
 *   - nothing was fetched off-origin to make that happen (no CDN), and
 *   - the notebook cell and the `.md` preview produce the SAME markup, which is
 *     what "one shared engine" means in practice rather than in the imports.
 */

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

const INLINE_TEX = 'e^{i\\pi}+1=0';
const DISPLAY_TEX = '\\int_0^\\infty e^{-x}\\,dx = 1';

// One markdown body, used verbatim by BOTH surfaces so the cell and the `.md`
// preview can be compared rather than merely each asserted to "have math".
const MATH_MD = [
	'# Math check',
	'',
	`Euler's identity $${INLINE_TEX}$ is inline.`,
	'',
	`$$${DISPLAY_TEX}$$`,
	'',
	'it cost $5 and $10 total',
	'',
	'broken: $\\frac{1}{$ and prose after it'
].join('\n');

function notebookJson(): string {
	return JSON.stringify({
		nbformat: 4,
		nbformat_minor: 5,
		metadata: { kernelspec: { name: 'python3', display_name: 'python3' } },
		cells: [
			{
				cell_type: 'markdown',
				id: 'md-math-aaaaaaaa',
				metadata: {},
				source: [MATH_MD]
			},
			{
				cell_type: 'code',
				id: 'code-plain-aaaaaa',
				metadata: {},
				execution_count: null,
				source: ['x = 1'],
				outputs: []
			}
		]
	});
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-e2e-math-'));
	writeFileSync(join(workspace, 'notebook.ipynb'), notebookJson());
	writeFileSync(join(workspace, 'notes.md'), MATH_MD + '\n');
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

/** Every request URL the page issued, so an off-origin fetch cannot hide. */
function recordRequests(page: import('@playwright/test').Page): string[] {
	const urls: string[] = [];
	page.on('request', (r) => urls.push(r.url()));
	return urls;
}

/**
 * Open the seeded notebook. A first-ever visit to a workspace has no saved tab
 * set, so the shell shows its empty state — the notebook has to be opened from
 * the file tree, exactly as a user would.
 */
async function openNotebook(page: import('@playwright/test').Page) {
	await page.locator('[data-testid="tree-file"][data-path="notebook.ipynb"]').click();
}

/**
 * A KaTeX font really loaded — the assertion that separates "the stylesheet
 * shipped" from "the fonts shipped". A web font is fetched lazily on first use,
 * so this runs after the math has painted.
 */
async function katexFontLoaded(page: import('@playwright/test').Page): Promise<boolean> {
	return page.evaluate(async () => {
		await document.fonts.ready;
		return Array.from(document.fonts).some(
			(f) => f.family.replace(/["']/g, '').startsWith('KaTeX_') && f.status === 'loaded'
		);
	});
}

test('a notebook markdown cell typesets $…$ and $$…$$ with self-hosted KaTeX', async ({ page }) => {
	const requests = recordRequests(page);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);

	const rendered = page.getByTestId('markdown-rendered').first();
	await expect(rendered).toBeVisible();

	// ---- Inline and display math are typeset -------------------------------
	await expect(rendered.locator('.katex').first()).toBeVisible();
	await expect(rendered.locator('.katex-display')).toHaveCount(1);
	// The MathML branch survived the sanitizer with its source annotation intact
	// (the piece DOMPurify's defaults strip — see markdown.ts).
	await expect(rendered.locator('annotation').first()).toHaveText(INLINE_TEX);
	// Prose around the math is untouched.
	await expect(rendered).toContainText("Euler's identity");
	await expect(rendered).toContainText('is inline.');

	// ---- Fonts are real, loaded, and came from Cellar ----------------------
	expect(await katexFontLoaded(page)).toBe(true);
	// The typeset glyphs are actually being drawn in a KaTeX face, not a fallback.
	const fontFamily = await rendered
		.locator('.katex .mord')
		.first()
		.evaluate((el) => getComputedStyle(el).fontFamily);
	expect(fontFamily).toContain('KaTeX');

	// No CDN, no external anything: every request stayed on Cellar's own origin
	// (fonts small enough to be inlined ride the CSS as data: URIs).
	const offOrigin = requests.filter((u) => !u.startsWith(baseURL) && !u.startsWith('data:'));
	expect(offOrigin).toEqual([]);

	// ---- Currency is prose, not math ---------------------------------------
	await expect(rendered).toContainText('it cost $5 and $10 total');

	// ---- An invalid formula is contained, not fatal ------------------------
	await expect(rendered.locator('.katex-error')).toHaveCount(1);
	// The cell as a whole still rendered: heading, math and the trailing prose.
	await expect(rendered.locator('h1')).toHaveText('Math check');
	await expect(rendered).toContainText('and prose after it');

	// ---- The SOURCE is untouched: raw edit still shows the delimiters -------
	await rendered.dblclick();
	const editor = page.locator('[data-testid="cell"]').first().locator('.cm-content');
	await expect(editor).toBeVisible();
	await expect(editor).toContainText(`$${INLINE_TEX}$`);
	await expect(editor).toContainText(`$$${DISPLAY_TEX}$$`);
});

test('a .md file preview renders the same math from the same engine', async ({ page }) => {
	const requests = recordRequests(page);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);

	// The notebook cell's markup, for comparison.
	const cell = page.getByTestId('markdown-rendered').first();
	await expect(cell.locator('.katex').first()).toBeVisible();
	const cellHtml = await cell.innerHTML();

	// A `.md` opens in Source view by design (you open one to edit it), so the
	// preview is one deliberate click away.
	await page.locator('[data-testid="tree-file"][data-path="notes.md"]').click();
	await page.getByTestId('file-view-preview').click();
	const preview = page.getByTestId('markdown-preview');
	await expect(preview).toBeVisible();

	await expect(preview.locator('.katex').first()).toBeVisible();
	await expect(preview.locator('.katex-display')).toHaveCount(1);
	await expect(preview.locator('annotation').first()).toHaveText(INLINE_TEX);
	await expect(preview.locator('.katex-error')).toHaveCount(1);
	await expect(preview).toContainText('it cost $5 and $10 total');

	// Same engine, same sanitizer: the math markup is byte-identical across the two
	// surfaces. Compared on the inline expression's own subtree, since the cell
	// splits its source at headings and the preview does not.
	const mathIn = (html: string) => (html.match(/<span class="katex">[\s\S]*?<\/span><\/span><\/span>/) || [''])[0];
	expect(mathIn(await preview.innerHTML())).toBe(mathIn(cellHtml));
	expect(mathIn(cellHtml).length).toBeGreaterThan(0);

	expect(await katexFontLoaded(page)).toBe(true);
	expect(requests.filter((u) => !u.startsWith(baseURL) && !u.startsWith('data:'))).toEqual([]);
});
