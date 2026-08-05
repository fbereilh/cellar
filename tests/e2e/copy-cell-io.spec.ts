import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';
import { setScrollTop, isCellMounted } from './notebook-scroll';

/**
 * Per-cell "copy input" / "copy output" buttons.
 *
 * The text rules are unit-tested (`tests/unit/copy-cell.test.ts`). What only a
 * real browser proves is the wiring: that the buttons reach the clipboard API at
 * all, that the disabled rule is what the user actually sees, that the copy is
 * MODEL-based (so a cell windowing has never mounted still copies its outputs
 * once scrolled to), that a DENIED clipboard leaves no false confirmation, and
 * that a SQL cell copies its SQL rather than the Python it compiles to.
 *
 * `navigator.clipboard.writeText` is stubbed rather than read back: reading the
 * real clipboard needs a permission grant that varies by platform, and the stub
 * is also the only way to exercise the rejection path deterministically.
 *
 * Boots the REAL launcher, so it SKIPS when that runtime is missing.
 */

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

const NB = 'notebook.ipynb';
const ESC = String.fromCharCode(27);

const SRC_STDOUT = 'print("hello from cellar")';
const SRC_ERROR = 'raise ValueError("boom")';
const SRC_TABLE = 'styler()';
const SRC_DF = 'df';
const SRC_IMAGE = 'plot()';
const SRC_MULTI = 'multi()';
const SRC_EMPTY = 'x = 1';
const SRC_BLANK = 'print()';
const SRC_SCRIPT = 'chart.show()';
const SRC_SQL = 'SELECT 1 AS one';
const SRC_MD = '## A heading\n\nsome *prose*';
// Far below the initial window: proves the copy reads the model, not a node that
// was never rendered until we scrolled to it.
const SRC_FAR = 'print("far away")';

const stream = (text: string) => ({ output_type: 'stream', name: 'stdout', text });

function cell(id: string, source: string, outputs: unknown[], metadata: unknown = {}) {
	return { cell_type: 'code', id, metadata, execution_count: null, source: [source], outputs };
}

/** Filler cells so the interesting tail starts windowed OUT. */
function filler(): unknown[] {
	return Array.from({ length: 120 }, (_, i) =>
		cell(`filler-${String(i).padStart(4, '0')}`, `filler_${i} = ${i}\n# padding line\n# padding line`, [])
	);
}

function notebookJson(): string {
	return JSON.stringify({
		nbformat: 4,
		nbformat_minor: 5,
		metadata: { kernelspec: { name: 'python3', display_name: 'python3' } },
		cells: [
			cell('copy-stdout-aaaa', SRC_STDOUT, [stream('hello from cellar\n')]),
			cell('copy-error-aaaaa', SRC_ERROR, [
				{
					output_type: 'error',
					ename: 'ValueError',
					evalue: 'boom',
					traceback: [`${ESC}[0;31mValueError${ESC}[0m: boom`, '  File "<stdin>", line 1, in <module>']
				}
			]),
			// A pandas Styler: text/html only, no text/plain fallback.
			cell('copy-table-aaaaa', SRC_TABLE, [
				{
					output_type: 'display_data',
					metadata: {},
					data: {
						'text/html':
							'<style>#T_x td{color:red}</style><table id="T_x"><thead><tr><th>name</th><th>qty</th></tr></thead>' +
							'<tbody><tr><td>apple</td><td>3</td></tr><tr><td>pear</td><td>5</td></tr></tbody></table>'
					}
				}
			]),
			// A SAVED DataFrame: clean-on-save stripped the structured MIME, so all
			// that is left is pandas' own `_repr_html_` (which Cellar re-parses back
			// into the grid) plus its elided text/plain repr.
			cell('copy-df-aaaaaaaa', SRC_DF, [
				{
					output_type: 'execute_result',
					metadata: {},
					execution_count: 1,
					data: {
						'text/html':
							'<div><table border="1" class="dataframe"><thead>' +
							'<tr style="text-align: right;"><th></th><th>a</th><th>b</th></tr></thead><tbody>' +
							'<tr><th>0</th><td>1</td><td>x</td></tr>' +
							'<tr><th>1</th><td>2</td><td>y</td></tr>' +
							'</tbody></table></div>',
						'text/plain': '   a  b\n0  1  x\n1  2  y'
					}
				}
			]),
			// A run that printed nothing but a newline: enabled-looking under a
			// mime-presence rule, and the click would then copy nothing.
			cell('copy-blank-aaaaa', SRC_BLANK, [stream('\n')]),
			// An all-script rich bundle (Bokeh / Altair / plotly's HTML renderer):
			// html is present, but it strips to no text at all.
			cell('copy-script-aaaa', SRC_SCRIPT, [
				{
					output_type: 'display_data',
					metadata: {},
					data: { 'text/html': '<div id="chart-1"></div><script>(function () { window.__chartEmbedded = "chart-1"; })();</script>' }
				}
			]),
			// Image only - matplotlib ships a `<Figure …>` text/plain repr alongside,
			// which is a placeholder, not the output.
			cell('copy-image-aaaaa', SRC_IMAGE, [
				{
					output_type: 'display_data',
					metadata: {},
					data: {
						'image/png':
							'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
						'text/plain': '<Figure size 640x480 with 1 Axes>'
					}
				}
			]),
			cell('copy-multi-aaaaa', SRC_MULTI, [
				stream('first line\n'),
				{
					output_type: 'display_data',
					metadata: {},
					data: { 'image/png': 'iVBORw0KGgo=', 'text/plain': '<Figure size 640x480 with 1 Axes>' }
				},
				{ output_type: 'execute_result', metadata: {}, execution_count: 1, data: { 'text/plain': "'last value'" } }
			]),
			cell('copy-empty-aaaaa', SRC_EMPTY, []),
			cell('copy-sql-aaaaaa', SRC_SQL, [stream('one\n1\n')], { cellar: { language: 'sql' } }),
			{ cell_type: 'markdown', id: 'copy-md-aaaaaaaa', metadata: {}, source: [SRC_MD] },
			...filler(),
			cell('copy-far-aaaaaaa', SRC_FAR, [stream('far away\n')])
		]
	});
}

/** Install the clipboard stub. `mode` decides whether the write resolves. */
async function stubClipboard(page: Page, mode: 'ok' | 'deny' = 'ok'): Promise<void> {
	await page.addInitScript((m: string) => {
		const w = window as unknown as { __copied: string[]; __clipboardMode: string };
		w.__copied = [];
		w.__clipboardMode = m;
		Object.defineProperty(navigator, 'clipboard', {
			configurable: true,
			value: {
				writeText: (text: string) => {
					if (w.__clipboardMode === 'deny') return Promise.reject(new Error('NotAllowedError'));
					w.__copied.push(text);
					return Promise.resolve();
				}
			}
		});
	}, mode);
}

const copied = (page: Page) => page.evaluate(() => (window as unknown as { __copied: string[] }).__copied);
const lastCopied = async (page: Page) => (await copied(page)).at(-1) ?? null;
const clearCopied = (page: Page) => page.evaluate(() => ((window as unknown as { __copied: string[] }).__copied = []));
const setClipboardMode = (page: Page, m: 'ok' | 'deny') =>
	page.evaluate((v: string) => ((window as unknown as { __clipboardMode: string }).__clipboardMode = v), m);

const cellEl = (page: Page, id: string) => page.locator(`[data-cell-id="${id}"]`);

/**
 * Scroll a cell into the render window and wait for it to mount.
 *
 * Steps forward in increments smaller than the overscan so the target can never
 * be scrolled straight past, and stops the moment it mounts.
 */
async function reveal(page: Page, id: string): Promise<void> {
	for (let i = 0; i < 60 && !(await isCellMounted(page, id)); i++) {
		await setScrollTop(page, i * 1200);
		await page.waitForTimeout(100);
	}
	const el = cellEl(page, id);
	await expect(el).toBeVisible({ timeout: 20_000 });
	await el.scrollIntoViewIfNeeded();
}

async function openNotebook(page: Page): Promise<void> {
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	const emptyBtn = page.getByTestId('empty-open-notebook');
	const firstCell = page.getByTestId('cell').first();
	await expect(emptyBtn.or(firstCell).first()).toBeVisible({ timeout: 30_000 });
	if (await emptyBtn.isVisible()) await emptyBtn.click();
	await expect(firstCell).toBeVisible({ timeout: 30_000 });
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available - E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-copy-io-'));
	writeFileSync(join(workspace, NB), notebookJson());
	const booted = await bootCellar(workspace);
	launcher = booted.proc;
	baseURL = booted.url;
});

test.afterAll(() => {
	if (launcher) killCellar(launcher);
	if (workspace && existsSync(workspace)) rmSync(workspace, { recursive: true, force: true });
});

test.beforeEach(async ({ page }) => {
	await stubClipboard(page);
});

test('copy input puts the cell source on the clipboard and confirms', async ({ page }) => {
	await openNotebook(page);
	const target = cellEl(page, 'copy-stdout-aaaa');
	await reveal(page, 'copy-stdout-aaaa');

	const button = target.getByTestId('copy-input');
	await expect(button).toBeEnabled();
	await button.click();

	expect(await lastCopied(page)).toBe(SRC_STDOUT);
	// Transient confirmation, then gone.
	await expect(button).toHaveAttribute('data-copied', 'true');
	await expect(button).not.toHaveAttribute('data-copied', 'true', { timeout: 5_000 });
});

test('copy input copies a SQL cell as SQL, not the Python it compiles to', async ({ page }) => {
	await openNotebook(page);
	await reveal(page, 'copy-sql-aaaaaa');
	await cellEl(page, 'copy-sql-aaaaaa').getByTestId('copy-input').click();
	expect(await lastCopied(page)).toBe(SRC_SQL);
});

test('copy input copies the source as currently typed, not the last-loaded value', async ({ page }) => {
	await openNotebook(page);
	await reveal(page, 'copy-empty-aaaaa');
	const target = cellEl(page, 'copy-empty-aaaaa');
	// Clicking the cell is what summons its CodeMirror editor - a cell renders a
	// static stand-in until then. Then click the editor itself, so the typing is
	// in EDIT mode rather than firing the modal keyboard.
	await target.getByTestId('static-code').click();
	const editor = target.locator('.cm-content');
	await editor.waitFor({ state: 'visible', timeout: 30_000 });
	await editor.click();
	// Mod-a is CodeMirror's select-all and is not in cellar's shortcut registry,
	// so it reaches the editor: REPLACE rather than append, which is deterministic.
	await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
	await page.keyboard.type('x = 2');

	await target.getByTestId('copy-input').click();
	expect(await lastCopied(page)).toBe('x = 2');
});

test('copy output copies stream text', async ({ page }) => {
	await openNotebook(page);
	await reveal(page, 'copy-stdout-aaaa');
	const button = cellEl(page, 'copy-stdout-aaaa').getByTestId('copy-output');
	await expect(button).toBeEnabled();
	await button.click();
	expect(await lastCopied(page)).toBe('hello from cellar');
	await expect(button).toHaveAttribute('data-copied', 'true');
});

test('copy output copies an error traceback with the ANSI colors stripped', async ({ page }) => {
	await openNotebook(page);
	await reveal(page, 'copy-error-aaaaa');
	await cellEl(page, 'copy-error-aaaaa').getByTestId('copy-output').click();
	const text = await lastCopied(page);
	expect(text).toBe('ValueError: boom\n  File "<stdin>", line 1, in <module>');
	expect(text).not.toContain(ESC);
});

test('copy output copies an html table as readable text, never markup', async ({ page }) => {
	await openNotebook(page);
	await reveal(page, 'copy-table-aaaaa');
	await cellEl(page, 'copy-table-aaaaa').getByTestId('copy-output').click();
	const text = await lastCopied(page);
	expect(text).toBe('name\tqty\napple\t3\npear\t5');
	expect(text).not.toContain('<');
	expect(text).not.toContain('color:red');
});

test('copy output copies a SAVED DataFrame as the table the grid shows, not the elided repr', async ({ page }) => {
	// The structured MIME is gone (clean-on-save), so this is the pandas
	// `_repr_html_` the notebook carries on disk - the same repr renderOutput
	// re-parses into the interactive grid. Copy runs it through that ONE parser,
	// so what lands on the clipboard is the grid's table rather than the elided
	// text/plain repr shipped beside it.
	await openNotebook(page);
	await reveal(page, 'copy-df-aaaaaaaa');
	await cellEl(page, 'copy-df-aaaaaaaa').getByTestId('copy-output').click();
	expect(await lastCopied(page)).toBe('\ta\tb\n0\t1\tx\n1\t2\ty');
});

test('copy output concatenates several outputs and skips the image among them', async ({ page }) => {
	await openNotebook(page);
	await reveal(page, 'copy-multi-aaaaa');
	await cellEl(page, 'copy-multi-aaaaa').getByTestId('copy-output').click();
	expect(await lastCopied(page)).toBe("first line\n'last value'");
});

test('copy output is disabled for an image-only cell and for one with no output', async ({ page }) => {
	await openNotebook(page);
	await reveal(page, 'copy-image-aaaaa');
	await expect(cellEl(page, 'copy-image-aaaaa').getByTestId('copy-output')).toBeDisabled();
	// Its input button is unaffected - a cell always has source.
	await expect(cellEl(page, 'copy-image-aaaaa').getByTestId('copy-input')).toBeEnabled();

	await reveal(page, 'copy-empty-aaaaa');
	await expect(cellEl(page, 'copy-empty-aaaaa').getByTestId('copy-output')).toBeDisabled();

	// Nothing reached the clipboard from either.
	expect(await copied(page)).toEqual([]);
});

test('copy output is disabled when the text CONVERTS to nothing, not merely when a mime is absent', async ({ page }) => {
	// The two cases a mime-presence rule got wrong: a bare `print()` whose stream
	// text is only a newline, and an all-script rich bundle whose html strips to
	// no text. Both used to look enabled and copy nothing on click - the silent
	// no-op the disabled rule exists to prevent.
	await openNotebook(page);
	await reveal(page, 'copy-blank-aaaaa');
	await expect(cellEl(page, 'copy-blank-aaaaa').getByTestId('copy-output')).toBeDisabled();
	await reveal(page, 'copy-script-aaaa');
	await expect(cellEl(page, 'copy-script-aaaa').getByTestId('copy-output')).toBeDisabled();
	expect(await copied(page)).toEqual([]);
});

test('a disabled copy-output SAYS why, in the label a disabled control can still report', async ({ page }) => {
	// A disabled control receives no pointer events, so its `title` can never be
	// hovered: the reason has to ride the aria-label or nobody ever learns it.
	await openNotebook(page);
	await reveal(page, 'copy-empty-aaaaa');
	await expect(cellEl(page, 'copy-empty-aaaaa').getByTestId('copy-output')).toHaveAttribute(
		'aria-label',
		/no output to copy/i
	);
	await reveal(page, 'copy-stdout-aaaa');
	await expect(cellEl(page, 'copy-stdout-aaaa').getByTestId('copy-output')).toHaveAttribute(
		'aria-label',
		'Copy cell output'
	);
});

test("a disabled copy-output LOOKS disabled, at daisyUI's own ghost-button alpha", async ({ page }) => {
	// An explicit `text-base-content/60` on the button beats daisyUI's disabled
	// color, so without the `disabled:` variant the button reads as clickable and
	// only silently refuses the click. Measured against a sibling daisyUI button
	// that is disabled for its own reason, so the two can never drift apart.
	await openNotebook(page);
	await reveal(page, 'copy-empty-aaaaa');
	await reveal(page, 'copy-stdout-aaaa');
	await expect(cellEl(page, 'copy-empty-aaaaa')).toBeVisible();
	const alphas = await page.evaluate(() => {
		const at = (sel: string) => getComputedStyle(document.querySelector(sel) as Element).color;
		return {
			enabled: at('[data-cell-id="copy-stdout-aaaa"] [data-testid="copy-output"]'),
			disabled: at('[data-cell-id="copy-empty-aaaaa"] [data-testid="copy-output"]'),
			daisyDisabled: at('[data-cell-id="copy-stdout-aaaa"] [data-testid="move-up"]')
		};
	});
	const alpha = (c: string) => Number(/\/\s*([\d.]+)\s*\)/.exec(c)?.[1] ?? '1');
	expect(alpha(alphas.disabled)).toBeLessThan(alpha(alphas.enabled));
	expect(alpha(alphas.disabled)).toBeCloseTo(alpha(alphas.daisyDisabled), 2);
});

test('a markdown cell offers copy input (its raw markdown) and no copy output', async ({ page }) => {
	await openNotebook(page);
	await reveal(page, 'copy-md-aaaaaaaa');
	const md = cellEl(page, 'copy-md-aaaaaaaa');
	// A markdown cell has no outputs, so the button is omitted rather than
	// rendered disabled - there is no such thing as its output.
	await expect(md.getByTestId('copy-output')).toHaveCount(0);
	await md.getByTestId('copy-input').click();
	expect(await lastCopied(page)).toBe(SRC_MD);
});

test('a cell that started windowed out copies its outputs once scrolled to (model-based)', async ({ page }) => {
	await openNotebook(page);
	// It really is absent from the DOM at first - that is the point of the test.
	await expect(cellEl(page, 'copy-far-aaaaaaa')).toHaveCount(0);
	await expect(page.locator('[data-testid="cell-spacer"]').first()).toBeVisible({ timeout: 20_000 });

	await reveal(page, 'copy-far-aaaaaaa');
	const target = cellEl(page, 'copy-far-aaaaaaa');
	await target.getByTestId('copy-input').click();
	expect(await lastCopied(page)).toBe(SRC_FAR);
	await target.getByTestId('copy-output').click();
	expect(await lastCopied(page)).toBe('far away');
});

test('a denied clipboard is handled without an error and shows no confirmation', async ({ page }) => {
	const pageErrors: string[] = [];
	page.on('pageerror', (e) => pageErrors.push(String(e)));
	await openNotebook(page);
	await reveal(page, 'copy-stdout-aaaa');
	await setClipboardMode(page, 'deny');
	await clearCopied(page);

	const target = cellEl(page, 'copy-stdout-aaaa');
	await target.getByTestId('copy-input').click();
	await target.getByTestId('copy-output').click();
	await page.waitForTimeout(300);

	expect(await copied(page)).toEqual([]);
	await expect(target.getByTestId('copy-input')).not.toHaveAttribute('data-copied', 'true');
	await expect(target.getByTestId('copy-output')).not.toHaveAttribute('data-copied', 'true');
	expect(pageErrors).toEqual([]);
});

test('the copy buttons leave the existing cell controls alone', async ({ page }) => {
	await openNotebook(page);
	await reveal(page, 'copy-stdout-aaaa');
	const target = cellEl(page, 'copy-stdout-aaaa');
	for (const id of ['run', 'clear', 'delete', 'move-up', 'move-down', 'drag-handle', 'cell-actions']) {
		await expect(target.getByTestId(id)).toHaveCount(1);
	}
	// Clearing the output disables copy-output, and does not touch copy-input.
	await target.getByTestId('clear').click();
	await expect(target.getByTestId('copy-output')).toBeDisabled({ timeout: 10_000 });
	await expect(target.getByTestId('copy-input')).toBeEnabled();
});
