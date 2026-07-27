import { test, expect, type Page, type Locator, type FrameLocator } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';
import { horizontallyOverflowingBoxes, isCellMounted, paneMetric, setScrollTop } from './notebook-scroll';

/**
 * E2E for the comfortable default styling of HTML tables in cell output
 * (`htmlOutputStyle.ts`, injected by `HtmlOutput.svelte`'s `buildSrcdoc`).
 *
 * This has to run in a real browser: the whole feature IS a cascade - cellar's
 * element-level defaults must apply to a bare table AND lose to a Styler's own
 * id-scoped rules (including one stated on the TABLE, which reaches the cells
 * only by inheritance) - and the layout facts (which tables wrap, which overflow)
 * only exist once something lays the table out.
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
 * A long text column, as bare text in the `<td>` - deliberately NOT wrapped in a
 * `<p>`, so it does not take the `:has()` escape and is governed by the ordinary
 * cell rules. It must wrap like pandas/Jupyter rather than scroll away.
 *
 * The row count is deliberate, not filler: this fixture also carries the height
 * reporter's liveness guard below, whose failure value is the 120px
 * pre-measurement default. Eight rows of wrapped prose render several hundred
 * pixels tall at any plausible viewport, so that assertion is decided by a wide
 * margin rather than by how one cell happens to wrap at 1280px.
 */
const TEXT_TABLE = `<table id="T_text">
<thead><tr><th></th><th>note</th><th>n</th></tr></thead>
<tbody>${Array.from(
	{ length: 8 },
	(_, r) =>
		`<tr><th>${r}</th><td>${'a fairly long sentence of prose that should wrap into view rather than force the output document sideways. '.repeat(
			3
		)}</td><td>${(r + 1.5).toFixed(1)}</td></tr>`
).join('')}</tbody></table>`;

/**
 * A Styler that aligns the WHOLE table - `set_table_styles([{'selector': '', …}])`
 * emits its rule on the table element, and `text-align` reaches the cells only by
 * inheritance. Cellar's default therefore has to be declared on `table` too, or a
 * cell-level default would silently outrank this.
 */
const TABLE_LEVEL_STYLED = `<style type="text/css">
#T_tablelevel { text-align: left; }
</style>
<table id="T_tablelevel"><caption>Table-level align</caption>
<thead><tr><th class="blank"></th><th class="col_heading">alpha</th></tr></thead>
<tbody><tr><th class="row_heading">0</th><td class="data">1.5</td></tr></tbody></table>`;

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
					cell('c-grid', displayHtml(DATAFRAME_REPR)),
					cell('c-text', displayHtml(TEXT_TABLE)),
					cell('c-tablelevel', displayHtml(TABLE_LEVEL_STYLED))
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

/** How far each sweep step advances the pane while hunting for a spacer cell. */
const SCAN_STEP_PX = 500;

/**
 * Address a cell by its stable id, scrolling until virtualization has mounted it.
 *
 * Deliberately NOT `getByTestId('cell').nth(i)`: every test here persists its
 * cell's output, so by the last one the notebook is tall enough that the bottom
 * cells start as spacers - which have no `run` button AND do not count towards
 * that locator, so an index silently addresses the wrong cell. This spec runs at
 * the shipped windowing default (see the virtualization entry in AGENTS.md); its
 * subject is the CSS cascade, so it mounts what it needs rather than opting out.
 *
 * The sweep runs inside `expect.poll` for one load-bearing reason: `Notebook.svelte`
 * re-plans its window off rAF-COALESCED pane metrics, so the mount that a scroll
 * causes lands a frame or more after the scroll itself. Consecutive `page.evaluate`
 * round trips complete well inside one frame, so a tight loop sweeps the entire
 * scroll range before a single re-plan runs, clamps at the bottom, and then waits
 * out its timeout at a fixed offset - a target in the MIDDLE of the notebook would
 * never mount. The poll interval is what gives the re-plan room (the same reason
 * `virtualization-remote-edit-run.spec.ts` polls around its scroll); do not
 * "optimize" it back into a bare loop. The offset wraps rather than clamping, so
 * the sweep keeps covering the whole notebook for a target anywhere in it.
 */
async function cellById(page: Page, id: string): Promise<Locator> {
	const cell = page.locator(`[data-cell-id="${id}"]`);
	let step = 0;
	await expect
		.poll(
			async () => {
				if (await isCellMounted(page, id)) return true;
				const max = Math.max(
					0,
					(await paneMetric(page, 'scrollHeight')) - (await paneMetric(page, 'clientHeight'))
				);
				await setScrollTop(page, max > 0 ? (step++ * SCAN_STEP_PX) % (max + SCAN_STEP_PX) : 0);
				return false;
			},
			{ timeout: 30_000 }
		)
		.toBe(true);
	await expect(cell).toBeAttached();
	await cell.scrollIntoViewIfNeeded();
	return cell;
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
	const bare = await cellById(page, 'c-bare');

	const frame = await runForIframe(bare);

	// Generous horizontal padding is the whole point - the user's hand-rolled
	// helper existed because the browser default is 1px.
	const td = await styleOf(frame, 'td', ['padding-top', 'padding-right', 'text-align', 'white-space']);
	expect(td['padding-top']).toBe('7px');
	expect(td['padding-right']).toBe('20px');
	// The pandas numeric convention, reaching the cell by inheritance from the
	// `table` rule (see the table-level Styler case below for why that matters).
	expect(td['text-align']).toBe('right');
	// Cells wrap like pandas/Jupyter - nothing declares white-space.
	expect(td['white-space']).toBe('normal');

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

	if (EVIDENCE) await bare.screenshot({ path: join(EVIDENCE, 'output-table-bare.png') });
});

test('a wide table stays a real table and overflows into the output document', async ({ page }) => {
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	const wide = await cellById(page, 'c-wide');

	const frame = await runForIframe(wide);

	const metrics = await frame.locator('table').first().evaluate((t) => {
		const de = t.ownerDocument.documentElement;
		return {
			display: getComputedStyle(t).display,
			tableScrollsItself: t.scrollWidth > t.clientWidth,
			docScrollsSideways: de.scrollWidth > de.clientWidth
		};
	});
	// It stays a real table, so a user's `width` / `table-layout` still work…
	expect(metrics.display).toBe('table');
	// …and the columns are unwrappable numbers, so the overflow lands on the
	// output iframe's own document rather than on a scroll box inside the table.
	expect(metrics.tableScrollsItself).toBe(false);
	expect(metrics.docScrollsSideways).toBe(true);

	// And that document really scrolls, rather than merely clipping.
	const scrolled = await frame.locator('table').first().evaluate((t) => {
		const de = t.ownerDocument.documentElement;
		de.scrollLeft = 400;
		return de.scrollLeft;
	});
	expect(scrolled).toBeGreaterThan(0);

	// `set_caption` reads as a title above the table - and stays a caption. A
	// `display:block` here would get it wrapped in an anonymous cell, i.e. a row.
	const cap = await styleOf(frame, 'caption', ['font-weight', 'text-align', 'display']);
	expect(cap['font-weight']).toBe('600');
	expect(cap['text-align']).toBe('left');
	expect(cap['display']).toBe('table-caption');
	const above = await frame.locator('table').first().evaluate((el) => {
		const t = el as HTMLTableElement;
		const c = t.querySelector('caption') as HTMLElement;
		return { capTop: c.getBoundingClientRect().top, headTop: t.tHead!.getBoundingClientRect().top };
	});
	expect(above.capTop).toBeLessThan(above.headTop);

	// …and it must not push its own container wider - the real guarantee that
	// dropping `table{max-width:100%}` rests on. The output iframe is a fixed-width
	// box that scrolls its own document, so nothing here may spill sideways into
	// the app around it.
	//
	// Deliberately NOT measured on `document.documentElement`: the shell root and
	// `<main>` are both `overflow-hidden`, so a descendant's horizontal overflow is
	// clipped long before it reaches the root, and an assertion there is
	// structurally incapable of failing - it reads as coverage while asserting
	// nothing. The walk is inclusive of the cell card, which is the innermost
	// `overflow-hidden` boundary and so the layer that can actually answer (verified
	// live: an oversized child makes it report 5000>904), and carries on through the
	// notebook's `overflow-y-auto` pane - the layer that would grow a real sideways
	// scrollbar - up to the root. Do not narrow it back to any one of them.
	expect(await horizontallyOverflowingBoxes(page, '[data-cell-id="c-wide"]')).toEqual([]);

	if (EVIDENCE) await wide.screenshot({ path: join(EVIDENCE, 'output-table-wide.png') });
});

test("an explicit Styler's own rules still beat cellar's defaults", async ({ page }) => {
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	const frame = await runForIframe(await cellById(page, 'c-styled'));

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
	// A cell holding block-level prose is a container, not a datum: it takes back
	// start alignment rather than inheriting the table's right-align, so a
	// two-column layout still reads as prose.
	const layout = await runForIframe(await cellById(page, 'c-layout'));
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
	const notable = await runForIframe(await cellById(page, 'c-notable'));
	await expect(notable.locator('#est')).toContainText('StandardScaler()');
	const est = await styleOf(notable, '#est', ['white-space', 'text-align', 'padding-top']);
	expect(est['white-space']).toBe('normal');
	expect(est['text-align']).toBe('start');
	expect(est['padding-top']).toBe('8px'); // its own inline style, untouched
});

test('a long text column wraps into view instead of scrolling away', async ({ page }) => {
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	const text = await cellById(page, 'c-text');

	const frame = await runForIframe(text);

	// The height reporter is a function serialized into the srcdoc, so if it ever
	// gains a reference outside its own parameters the ReferenceError is thrown
	// inside `send()`, swallowed by its `catch(e){}`, no height is ever posted, and
	// EVERY rich text/html output silently renders at the 120px pre-measurement
	// default with both suites still green. Measured on the outer iframe from the
	// parent page - that is what the postMessage round trip actually produces. The
	// fixture's eight rows of wrapped prose run to several hundred pixels at any
	// plausible viewport, so this clears 120 by a wide margin instead of hinging on
	// how one cell wraps; 120 stays the comparison because it is the exact value a
	// dead reporter leaves behind.
	await expect
		.poll(
			() => text.getByTestId('output-html').evaluate((el) => el.getBoundingClientRect().height),
			{ timeout: 15_000 }
		)
		.toBeGreaterThan(120);

	// Bare text in the `<td>`, so it does NOT take the `:has()` escape - this is
	// the ordinary cell rule, and it must leave pandas/Jupyter wrapping alone.
	const td = frame.locator('tbody td').first();
	expect((await styleOf(frame, 'tbody td', ['white-space']))['white-space']).toBe('normal');
	const layout = await td.evaluate((el) => {
		const line = parseFloat(getComputedStyle(el).lineHeight) || 20;
		return {
			wraps: el.getBoundingClientRect().height > line * 1.5,
			docScrollsSideways:
				el.ownerDocument.documentElement.scrollWidth > el.ownerDocument.documentElement.clientWidth
		};
	});
	expect(layout.wraps).toBe(true);
	// Wrapping is what keeps a text-heavy table out of a horizontal scroll.
	expect(layout.docScrollsSideways).toBe(false);

	if (EVIDENCE) await text.screenshot({ path: join(EVIDENCE, 'output-table-text.png') });
});

test("a Styler's TABLE-level alignment beats cellar's default", async ({ page }) => {
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	const frame = await runForIframe(await cellById(page, 'c-tablelevel'));

	// `set_table_styles([{'selector': '', 'props': 'text-align:left'}])` states its
	// rule on the TABLE, and `text-align` reaches a cell only by inheritance. A
	// cellar default declared on `th,td` would apply directly and silently outrank
	// it; declared on `table`, the id-scoped user rule wins on the same element.
	expect((await styleOf(frame, 'tbody td', ['text-align']))['text-align']).toBe('left');
	expect((await styleOf(frame, 'thead th', ['text-align']))['text-align']).toBe('left');

	// …while padding, which they did not state, still gets cellar's default.
	expect((await styleOf(frame, 'tbody td', ['padding-right']))['padding-right']).toBe('20px');
});

test("a pandas `_repr_html_` still routes to the native grid, not the styled iframe", async ({ page }) => {
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	const c = await cellById(page, 'c-grid');

	// `dataframeHtml.ts` recognizes `class="dataframe"` and hands it to
	// DataFrameGrid - this styling change must not have diverted that path.
	await c.getByTestId('run').click();
	await expect(c.getByTestId('dataframe-grid')).toBeVisible({ timeout: 90_000 });
	await expect(c.getByTestId('output-html')).toHaveCount(0);
});
