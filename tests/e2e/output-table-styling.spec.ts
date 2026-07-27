import { test, expect, type Page, type Locator, type FrameLocator } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * E2E for the comfortable default styling of HTML tables in cell output
 * (`htmlOutputStyle.ts`, injected by `HtmlOutput.svelte`'s `buildSrcdoc`).
 *
 * This has to run in a real browser: the whole feature IS a cascade - cellar's
 * element-level defaults must apply to a bare table AND lose to a Styler's own
 * id-scoped rules - and the layout facts (a wide table scrolling itself instead
 * of the document) only exist once something lays the table out.
 *
 * It deliberately uses `IPython.display.HTML` with hand-written markup rather
 * than pandas: the markup below IS the shape pandas emits (a Styler's
 * `<style>#T_x td{…}</style><table id="T_x">` with `col_heading`/`row_heading`
 * cells; `_repr_html_`'s `<table border="1" class="dataframe">`), so the cascade
 * under test is identical while the workspace venv needs only `ipykernel`.
 *
 * Boots the REAL launcher against a throwaway workspace (see ./harness); SKIPS
 * when the kernel runtime is absent (local-only, like smoke.spec).
 */

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

const EVIDENCE = process.env.CELLAR_EVIDENCE_DIR || '';

/** Python that emits `html` as a rich `text/html` output. */
function displayHtml(html: string): string {
	return ['from IPython.display import HTML, display', `display(HTML(${JSON.stringify(html)}))`].join('\n');
}

/**
 * An unstyled table with an index column and pandas' `border="1"` presentational
 * attribute. Deliberately WITHOUT `class="dataframe"`: that class is the narrow
 * signal `dataframeHtml.ts` uses to route a pandas `_repr_html_` to the native
 * `DataFrameGrid` instead (asserted below), so this is the arbitrary-HTML /
 * unstyled-Styler shape that reaches the iframe.
 */
const BARE_TABLE = `<table border="1">
<thead><tr><th></th><th>alpha</th><th>beta</th></tr></thead>
<tbody>
<tr><th>0</th><td>1.5</td><td>-2.25</td></tr>
<tr><th>1</th><td>3.5</td><td>-4.75</td></tr>
</tbody></table>`;

/** The pandas `_repr_html_` shape - must keep routing to the native grid. */
const DATAFRAME_REPR = `<table border="1" class="dataframe">
<thead><tr style="text-align: right;"><th></th><th>alpha</th></tr></thead>
<tbody><tr><th>0</th><td>1.5</td></tr></tbody></table>`;

/** Many numeric columns - wide enough that it cannot fit the output width. */
const WIDE_TABLE = `<table id="T_wide"><caption>Wide numeric table</caption>
<thead><tr><th class="blank"></th>${Array.from({ length: 18 }, (_, i) => `<th class="col_heading">metric_${i}</th>`).join('')}</tr></thead>
<tbody><tr><th class="row_heading">0</th>${Array.from({ length: 18 }, (_, i) => `<td class="data">${(i * 1111.25).toFixed(6)}</td>`).join('')}</tr></tbody></table>`;

/**
 * A Styler that states its own padding/alignment - exactly what `set_table_styles`
 * emits. Cellar's defaults must lose to every one of these.
 */
const STYLED_TABLE = `<style type="text/css">
#T_user td { padding: 2px 4px; text-align: center; color: rgb(185, 28, 28); }
#T_user caption { font-size: 20px; }
</style>
<table id="T_user"><caption>User styled</caption>
<thead><tr><th class="blank"></th><th class="col_heading">alpha</th></tr></thead>
<tbody><tr><th class="row_heading">0</th><td class="data">1.5</td></tr></tbody></table>`;

/** A `<table>` used for two-column LAYOUT - prose in block-level cells. */
const LAYOUT_TABLE = `<table><tr>
<td><p>Some prose that is long enough that it has to wrap inside a layout table used for a two-column arrangement of text.</p></td>
<td><p>A second column of equally long prose that also has to wrap rather than run off the side of the output.</p></td>
</tr></table>`;

/** A div-based rich output (sklearn's estimator repr shape) - no table at all. */
const NO_TABLE = `<div id="est" style="border:1px dotted #999;padding:8px"><div><b>Pipeline</b></div><div style="margin-left:1em">StandardScaler()</div></div>`;

function cell(id: string, source: string) {
	return {
		id,
		cell_type: 'code',
		metadata: {},
		execution_count: null,
		outputs: [],
		source: source.split('\n').map((l, i, a) => (i === a.length - 1 ? l : l + '\n'))
	};
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available - E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-e2e-tablecss-'));

	const venv = join(workspace, '.venv');
	expect(spawnSync('uv', ['venv', venv], { stdio: 'inherit' }).status).toBe(0);
	expect(
		spawnSync('uv', ['pip', 'install', '--python', join(venv, 'bin', 'python'), 'ipykernel'], { stdio: 'inherit' })
			.status
	).toBe(0);

	mkdirSync(workspace, { recursive: true });
	writeFileSync(
		join(workspace, 'notebook.ipynb'),
		JSON.stringify(
			{
				cells: [
					cell('c-bare', displayHtml(BARE_TABLE)),
					cell('c-wide', displayHtml(WIDE_TABLE)),
					cell('c-styled', displayHtml(STYLED_TABLE)),
					cell('c-layout', displayHtml(LAYOUT_TABLE)),
					cell('c-notable', displayHtml(NO_TABLE)),
					cell('c-grid', displayHtml(DATAFRAME_REPR))
				],
				metadata: { kernelspec: { name: 'python3', display_name: 'python3', language: 'python' } },
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

async function openNotebook(page: Page): Promise<void> {
	const openBtn = page.getByTestId('empty-open-notebook');
	if (await openBtn.isVisible().catch(() => false)) await openBtn.click();
	await expect(page.getByTestId('cell').first()).toBeVisible();
}

/** Run `c` and wait for its rich-HTML iframe to exist, returning a handle to it. */
async function runForIframe(c: Locator): Promise<FrameLocator> {
	await c.getByTestId('run').click();
	const frame = c.getByTestId('output-html');
	await expect(frame).toBeVisible({ timeout: 90_000 });
	// The srcdoc document has to have parsed before its computed styles mean
	// anything; the injected content is the signal that it has.
	const inner = c.frameLocator('[data-testid="output-html"]');
	await expect(inner.locator('body > *').first()).toBeAttached({ timeout: 30_000 });
	return inner;
}

/** Computed style of the first `selector` inside the output iframe. */
function styleOf(frame: FrameLocator, selector: string, props: string[]) {
	return frame.locator(selector).first().evaluate((el, ps: string[]) => {
		const cs = getComputedStyle(el);
		return Object.fromEntries(ps.map((p) => [p, cs.getPropertyValue(p)]));
	}, props);
}

test('a bare output table gets comfortable, scannable defaults', async ({ page }) => {
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	const cells = page.getByTestId('cell');
	await expect(cells).toHaveCount(6);

	const frame = await runForIframe(cells.nth(0));

	// Generous horizontal padding is the whole point - the user's hand-rolled
	// helper existed because the browser default is 1px.
	const td = await styleOf(frame, 'td', ['padding-top', 'padding-right', 'text-align', 'white-space']);
	expect(td['padding-top']).toBe('7px');
	expect(td['padding-right']).toBe('20px');
	expect(td['text-align']).toBe('right'); // the pandas numeric convention
	expect(td['white-space']).toBe('nowrap');

	// The index column reads as a label, not as data.
	expect((await styleOf(frame, 'tbody th', ['text-align']))['text-align']).toBe('left');
	// Column headings sit over their (right-aligned) data.
	expect((await styleOf(frame, 'thead th', ['text-align']))['text-align']).toBe('right');

	// `border="1"`'s presentational grid is replaced by a header rule + hairlines,
	// not left to draw an outset box around every cell.
	const borders = await styleOf(frame, 'tbody td', ['border-top-width', 'border-left-width', 'border-bottom-width']);
	expect(borders['border-top-width']).toBe('0px');
	expect(borders['border-left-width']).toBe('0px');
	expect(borders['border-bottom-width']).toBe('1px');

	if (EVIDENCE) await cells.nth(0).screenshot({ path: join(EVIDENCE, 'output-table-bare.png') });
});

test('a wide table scrolls itself - the output document never scrolls sideways', async ({ page }) => {
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	const cells = page.getByTestId('cell');

	const frame = await runForIframe(cells.nth(1));

	const metrics = await frame.locator('table').first().evaluate((t) => {
		const de = t.ownerDocument.documentElement;
		return {
			tableOverflows: t.scrollWidth > t.clientWidth,
			docScrollsSideways: de.scrollWidth > de.clientWidth,
			bodyScrollsSideways: t.ownerDocument.body.scrollWidth > t.ownerDocument.body.clientWidth
		};
	});
	// The table is genuinely wider than the output, and absorbs that itself.
	expect(metrics.tableOverflows).toBe(true);
	expect(metrics.docScrollsSideways).toBe(false);
	expect(metrics.bodyScrollsSideways).toBe(false);

	// And it really scrolls, rather than merely clipping.
	const scrolled = await frame.locator('table').first().evaluate((t) => {
		t.scrollLeft = 400;
		return t.scrollLeft;
	});
	expect(scrolled).toBeGreaterThan(0);

	// `set_caption` reads as a title above the table.
	const cap = await styleOf(frame, 'caption', ['font-weight', 'text-align']);
	expect(cap['font-weight']).toBe('600');
	expect(cap['text-align']).toBe('left');

	// The page itself must never gain a horizontal scrollbar because of it.
	const pageScrolls = await page.evaluate(
		() => document.documentElement.scrollWidth > document.documentElement.clientWidth
	);
	expect(pageScrolls).toBe(false);

	if (EVIDENCE) await cells.nth(1).screenshot({ path: join(EVIDENCE, 'output-table-wide.png') });
});

test("an explicit Styler's own rules still beat cellar's defaults", async ({ page }) => {
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	const cells = page.getByTestId('cell');

	const frame = await runForIframe(cells.nth(2));

	// Every property the user stated is theirs - this is the `overwrite=False`
	// contract of the helper this feature replaces.
	const td = await styleOf(frame, 'td', ['padding-top', 'padding-right', 'text-align', 'color']);
	expect(td['padding-top']).toBe('2px');
	expect(td['padding-right']).toBe('4px');
	expect(td['text-align']).toBe('center');
	expect(td['color']).toBe('rgb(185, 28, 28)');
	expect((await styleOf(frame, 'caption', ['font-size']))['font-size']).toBe('20px');

	// …while a property they did NOT state still gets cellar's default.
	expect((await styleOf(frame, 'caption', ['font-weight']))['font-weight']).toBe('600');
	expect((await styleOf(frame, 'tbody th', ['text-align']))['text-align']).toBe('left');
});

test('a layout table and a non-table output are not harmed', async ({ page }) => {
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	const cells = page.getByTestId('cell');

	// A cell holding block-level prose is a container, not a datum: it keeps
	// normal wrapping and start alignment, so a two-column layout still reads.
	const layout = await runForIframe(cells.nth(3));
	const cellStyle = await styleOf(layout, 'td', ['white-space', 'text-align']);
	expect(cellStyle['white-space']).toBe('normal');
	expect(cellStyle['text-align']).toBe('left');
	const wraps = await layout.locator('td').first().evaluate((td) => {
		const line = parseFloat(getComputedStyle(td).lineHeight) || 20;
		return td.getBoundingClientRect().height > line * 1.5;
	});
	expect(wraps).toBe(true);

	// A div-based rich output has nothing for the table rules to touch: it keeps
	// the browser's own inline layout, untouched by any of them.
	const notable = await runForIframe(cells.nth(4));
	await expect(notable.locator('#est')).toContainText('StandardScaler()');
	const est = await styleOf(notable, '#est', ['white-space', 'text-align', 'padding-top']);
	expect(est['white-space']).toBe('normal');
	expect(est['text-align']).toBe('start');
	expect(est['padding-top']).toBe('8px'); // its own inline style, untouched
});

test("a pandas `_repr_html_` still routes to the native grid, not the styled iframe", async ({ page }) => {
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	const c = page.getByTestId('cell').nth(5);

	// `dataframeHtml.ts` recognizes `class="dataframe"` and hands it to
	// DataFrameGrid - this styling change must not have diverted that path.
	await c.getByTestId('run').click();
	await expect(c.getByTestId('dataframe-grid')).toBeVisible({ timeout: 90_000 });
	await expect(c.getByTestId('output-html')).toHaveCount(0);
});
