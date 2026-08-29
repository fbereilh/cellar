import { test, expect, type Page, type Locator } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * nbdev/Quarto `#|` directive comments, COLOURED, in the real browser.
 *
 * `#| default_exp training` changes what Cellar does (`server/export-py.ts` reads
 * it as the export target), so it must not read as a dead comment. The rule and the
 * two code paths are unit-tested (`tests/unit/directive-comment.test.ts`); what
 * only a browser can answer is the part the rule cannot state:
 *
 *   - the CASCADE actually lands the colour. CodeMirror's mark decoration WRAPS
 *     the comment token span, so an ancestor rule alone loses to the child's own
 *     `color` whatever its specificity - a computed-style assertion is the only
 *     thing that catches that.
 *   - the STATIC render (an unfocused cell, no editor) and the LIVE editor agree
 *     pixel-for-pixel, which is the contract `staticHighlight.ts` exists to keep.
 *   - it is legible and non-colliding in BOTH themes.
 *
 * Cells are addressed by `data-cell-id`, since the shipped default windows cells
 * out of the DOM.
 */

const NB = 'directives.ipynb';
const CELL = 'directive0';
// The last three lines are what makes the collision check below mean something:
// they put a KEYWORD and a FUNCTION name on screen, and `tok-keyword`/`tok-meta`
// are the palette's nearest neighbours to the directive's magenta.
const SOURCE = [
	'#| default_exp training\n',
	'#| some-future-directive\n',
	'# an ordinary comment\n',
	'x = 1  #| not a directive, it trails code\n',
	's = """\n',
	'#| not a directive, it is string content\n',
	'"""\n',
	'import os\n',
	'def scale(n):\n',
	'    return os.sep * n\n'
];

/** CIE76 ΔE below which two token colours read as the same colour. */
const MIN_TOKEN_DISTANCE = 20;

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

const cell = (page: Page) => page.locator(`[data-testid="cell"][data-cell-id="${CELL}"]`);

/** The computed colour of the first element whose text starts with `prefix`. */
async function colourOf(scope: Locator, prefix: string): Promise<string> {
	return scope.evaluate((root: HTMLElement, p: string) => {
		// The deepest element carrying the text is the one actually painted: the
		// editor nests the token span INSIDE the directive mark.
		const hit = [...root.querySelectorAll('span')]
			.filter((n) => (n.textContent ?? '').startsWith(p) && n.children.length === 0)
			.pop();
		if (!hit) throw new Error(`no leaf span starting with ${JSON.stringify(p)}`);
		return getComputedStyle(hit).color;
	}, prefix);
}

/** The linear-light RGB channels of an `rgb(...)` string. */
function channels(s: string): [number, number, number] {
	const [r, g, b] = s.match(/\d+(\.\d+)?/g)!.slice(0, 3).map(Number);
	const c = (v: number) => {
		const n = v / 255;
		return n <= 0.03928 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
	};
	return [c(r), c(g), c(b)];
}

/** WCAG relative-luminance contrast between two `rgb(...)` strings. */
function contrast(a: string, b: string): number {
	const lum = (s: string) => {
		const [r, g, b] = channels(s);
		return 0.2126 * r + 0.7152 * g + 0.0722 * b;
	};
	const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
	return (x + 0.05) / (y + 0.05);
}

/**
 * CIE76 ΔE between two `rgb(...)` strings - a PERCEPTUAL distance, which is the
 * right question for "do these two read as the same colour". Luminance contrast is
 * not: a cyan operator and a pink directive can share a luminance while being
 * maximally distinct in hue, so a contrast floor would reject colours nobody could
 * confuse. ~2.3 is the just-noticeable difference; the palette's nearest pair here
 * measures ~28.
 */
function distance(a: string, b: string): number {
	const lab = (s: string) => {
		const [r, g, b] = channels(s);
		const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
		const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
		const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
		const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
		return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
	};
	const [p, q] = [lab(a), lab(b)];
	return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

async function setTheme(page: Page, id: 'dim' | 'cellar-light') {
	await page.getByTestId('app-menu').click();
	await page.getByTestId('open-settings').click();
	await expect(page.getByTestId('settings-modal')).toBeVisible();
	await page.getByTestId(`theme-${id}`).click();
	await page.getByTestId('settings-close').click();
	await expect(page.getByTestId('settings-modal')).toBeHidden();
	await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(id);
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available - E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-directive-e2e-'));
	writeFileSync(
		join(workspace, NB),
		JSON.stringify(
			{
				cells: [
					{ cell_type: 'code', id: CELL, metadata: {}, source: SOURCE, outputs: [], execution_count: null }
				],
				metadata: {},
				nbformat: 4,
				nbformat_minor: 5
			},
			null,
			1
		)
	);
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

async function open(page: Page) {
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await page.locator(`[data-testid="tree-file"][data-path="${NB}"]`).click();
	await expect(cell(page)).toBeVisible({ timeout: 30_000 });
}

for (const theme of ['dim', 'cellar-light'] as const) {
	test(`${theme}: a directive is coloured apart from an ordinary comment, before and after the editor is built`, async ({
		page
	}) => {
		test.setTimeout(120_000);
		await open(page);
		await setTheme(page, theme);

		// --- the STATIC render (no editor has been built yet) --------------------
		const staticCode = cell(page).getByTestId('static-code');
		await expect(staticCode).toBeVisible();

		const directive = await colourOf(staticCode, '#| default_exp');
		const unknownDirective = await colourOf(staticCode, '#| some-future-directive');
		const comment = await colourOf(staticCode, '# an ordinary comment');
		const trailing = await colourOf(staticCode, '#| not a directive, it trails');

		// The headline: a directive does NOT read as an ordinary comment.
		expect(directive).not.toBe(comment);
		// The recorded decision - every `#|` line, not only the ones Cellar acts on.
		expect(unknownDirective).toBe(directive);
		// A trailing `#|` is an ordinary comment; a directive owns its line.
		expect(trailing).toBe(comment);

		// Legible on the editor surface. `.cm-static` is where `--cellar-cm-bg` is
		// painted (its `[data-testid=static-code]` parent has none), and the live
		// editor paints the same var on `.cm-editor` - so this is the real ground
		// the directive sits on, in whichever theme is active.
		const bg = await cell(page)
			.locator('.cm-static')
			.evaluate((n: HTMLElement) => getComputedStyle(n).backgroundColor);
		expect(contrast(directive, bg)).toBeGreaterThanOrEqual(4.5);
		// And it clears the ordinary comment by enough to read as a different colour
		// rather than a shade of the same one.
		expect(contrast(directive, comment)).toBeGreaterThan(1.2);

		// It must not COLLIDE with any other token colour this render puts on screen -
		// the fixture carries a comment, a name, an operator, a number, a string, a
		// keyword and a function name, so the palette's nearest neighbours are among them.
		const others = await staticCode.evaluate((root: HTMLElement) => {
			const seen = new Set<string>();
			for (const n of root.querySelectorAll('span'))
				if (n.children.length === 0) seen.add(getComputedStyle(n as HTMLElement).color);
			return [...seen];
		});
		expect(others).toContain(directive);
		expect(others.length).toBeGreaterThan(1); // the render really did highlight
		for (const other of others) {
			if (other === directive) continue;
			expect(
				distance(directive, other),
				`directive ${directive} vs ${other}`
			).toBeGreaterThan(MIN_TOKEN_DISTANCE);
		}

		// --- the LIVE editor, summoned by clicking in -----------------------------
		await cell(page).getByTestId('static-code').click();
		const content = cell(page).locator('.cm-content');
		await expect(content).toBeVisible({ timeout: 15_000 });

		// The pixel-for-pixel contract: identical colours either side of the lazy
		// editor being built. This is what the CSS descendant selector buys - without
		// it the editor's nested token span keeps painting comment grey.
		expect(await colourOf(content, '#| default_exp')).toBe(directive);
		expect(await colourOf(content, '# an ordinary comment')).toBe(comment);
		expect(await colourOf(content, '#| not a directive, it trails')).toBe(comment);
	});
}
