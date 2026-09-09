import { test, expect, type Page, type Locator } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * The LIVE-then-COLD-REOPEN cycle for every frame shape, against a real kernel.
 *
 * That cycle is the only level these bugs are visible at, because the two
 * renderings come from DIFFERENT sources: live, an output carries the structured
 * `application/vnd.cellar.dataframe+json` the kernel formatter emitted; re-opened,
 * clean-on-save has stripped it and all that is left is the `text/html` repr, which
 * `dataframeHtml.ts` parses back. A shape can therefore render perfectly one way
 * and wrongly - or not at all - the other, which is exactly how the reported
 * defects were found, and no unit test on either half alone can see it.
 *
 * So the second reading is a genuine COLD reopen: the instance is killed and a
 * FRESH one booted on the same workspace, so nothing is served from an in-memory
 * document that still holds the un-stripped MIME.
 *
 * Boots the REAL launcher against a throwaway workspace (see ./harness); SKIPS when
 * the kernel runtime is absent, and the polars/Styler cases skip when those
 * packages could not be installed into the workspace venv.
 */

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';
/** Whether pandas + polars could be installed into the workspace venv. */
let hasFrames = false;

/** The reported polars shape: 17 columns, `uuid` first - the one that vanished. */
const POLARS_COLUMNS = [
	'uuid',
	'bidder_id',
	'bid_round',
	'floor',
	'win',
	'impressions',
	'revenue',
	'ctr',
	'segment',
	'device',
	'country',
	'hour',
	'model_v',
	'score',
	'market_floor',
	'delta',
	'ts'
];

const SRC_POLARS = [
	'import polars as pl, datetime as dt',
	'preds = pl.DataFrame({',
	'    "uuid": ["a1b2c3", "d4e5f6", "071819"],',
	'    "bidder_id": ["5006", "5006", "3788"],',
	'    "bid_round": [1, 2, 1],',
	'    "floor": [0.15, 0.22, 0.31],',
	'    "win": [True, False, True],',
	'    "impressions": [1200, 980, 1500],',
	'    "revenue": [18.4, 0.0, 27.15],',
	'    "ctr": [0.012, 0.0, 0.018],',
	'    "segment": ["video", "video", "display"],',
	'    "device": ["ctv", "mobile", "ctv"],',
	'    "country": ["US", "US", "CA"],',
	'    "hour": [3, 14, 22],',
	'    "model_v": ["v2", "v2", "v3"],',
	'    "score": [0.884, 0.211, 0.905],',
	'    "market_floor": [0.14, 0.25, 0.29],',
	'    "delta": [0.01, -0.03, 0.02],',
	'    "ts": [dt.datetime(2026, 1, 2, 3, 4, 5)] * 3,',
	'})',
	'preds.head(3)'
].join('\n');

const SRC_STYLER = [
	'import pandas as pd',
	't = pd.DataFrame({"rev": [1234.5, 98765.25], "share": [0.1234, 0.8766]}, index=["a", "b"])',
	'display(t.style.set_caption("Floors").format({"rev": "{:,.2f}", "share": "{:.1%}"}).hide(axis="index"))'
].join('\n');

const SRC_EMPTY = ['import pandas as pd', 'pd.DataFrame(columns=["a", "b", "c", "d"])'].join('\n');

const SRC_MULTI = [
	'import pandas as pd',
	'pd.DataFrame([[1, 2, 3, 4]], columns=pd.MultiIndex.from_tuples([("A", "x"), ("A", "y"), ("B", "x"), ("B", "y")]))'
].join('\n');

const SRC_PLAIN = ['import pandas as pd', 'pd.DataFrame({"a": [1, 2], "b": ["x", "y"]})'].join('\n');

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
	workspace = mkdtempSync(join(tmpdir(), 'cellar-e2e-dfhtml-'));

	const venv = join(workspace, '.venv');
	expect(spawnSync('uv', ['venv', venv], { stdio: 'inherit' }).status).toBe(0);
	const python = join(venv, 'bin', 'python');
	expect(spawnSync('uv', ['pip', 'install', '--python', python, '--quiet', 'ipykernel'], { stdio: 'inherit' }).status).toBe(0);
	// Best-effort, like the pandas install in mcp-ergonomics: a machine that cannot
	// fetch them skips those tests rather than failing the suite. `jinja2` is
	// explicit because pandas does not pull it in and `df.style` raises without it.
	hasFrames =
		spawnSync('uv', ['pip', 'install', '--python', python, '--quiet', 'pandas', 'polars', 'jinja2'], {
			stdio: 'inherit'
		}).status === 0;

	writeFileSync(
		join(workspace, 'notebook.ipynb'),
		JSON.stringify(
			{
				cells: [
					cell('c-polars-aaaaa', SRC_POLARS),
					cell('c-styler-aaaaa', SRC_STYLER),
					cell('c-empty-aaaaaa', SRC_EMPTY),
					cell('c-multi-aaaaaa', SRC_MULTI),
					cell('c-plain-aaaaaa', SRC_PLAIN)
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
	// Settle on whichever the shell paints BEFORE probing - see the note this helper
	// carries in every spec that uses it.
	await expect(openBtn.or(page.getByTestId('cell').first())).toBeVisible();
	if (await openBtn.isVisible().catch(() => false)) await openBtn.click();
	await expect(page.getByTestId('cell').first()).toBeVisible();
}

function cellById(page: Page, id: string): Locator {
	return page.locator(`[data-cell-id="${id}"]`);
}

/** The grid's column headers, in order. */
async function gridColumns(c: Locator): Promise<string[]> {
	return (await c.getByTestId('df-th').allInnerTexts()).map((t) => t.split('\n')[0].trim());
}

/** The grid's data cells, in row-major order. */
async function gridCells(c: Locator): Promise<string[]> {
	return (await c.getByTestId('df-cell').allInnerTexts()).map((t) => t.trim());
}

/** Run every cell and wait for each to have rendered a grid. */
async function runAll(page: Page): Promise<void> {
	await page.getByTestId('run-all').click();
	for (const id of ['c-polars-aaaaa', 'c-styler-aaaaa', 'c-empty-aaaaaa', 'c-multi-aaaaaa', 'c-plain-aaaaaa']) {
		await expect(cellById(page, id).getByTestId('dataframe-grid')).toBeVisible({ timeout: 180_000 });
	}
}

/**
 * Every assertion this spec makes about the rendered notebook, run twice against
 * the two DIFFERENT sources - once live, once after a cold reopen. Sharing one
 * body is the point: a divergence is a difference between these two calls, so
 * asserting the halves separately is how the divergences went unnoticed.
 */
async function assertEveryShape(page: Page, when: string): Promise<void> {
	await test.step(`polars keeps all 17 columns (${when})`, async () => {
		const c = cellById(page, 'c-polars-aaaaa');
		expect(await gridColumns(c)).toEqual(POLARS_COLUMNS);
		// The column the old parser deleted, and the values it promoted to the index.
		const cells = await gridCells(c);
		expect(cells.slice(0, 3)).toEqual(['a1b2c3', '5006', '1']);
		// polars quotes its string values in the repr; none of that reaches the grid.
		expect(cells.some((t) => t.includes('"'))).toBe(false);
		// A frame with no index gets no index column rather than a blank one.
		await expect(c.getByTestId('df-th-index')).toHaveCount(0);
		await expect(c.getByTestId('df-index-cell')).toHaveCount(0);
		// The declared dtypes, not ones guessed from the rendered text: `bidder_id`
		// looks numeric and is a string column.
		await expect(c.getByTestId('df-th').nth(1)).toContainText('str');
		await expect(c.getByTestId('df-th').nth(2)).toContainText('i64');
	});

	await test.step(`a Styler renders as the grid, formatted (${when})`, async () => {
		const c = cellById(page, 'c-styler-aaaaa');
		expect(await gridColumns(c)).toEqual(['rev', 'share']);
		// The FORMATTED values - `styler.data`, the only public handle the kernel
		// formatter would have, holds 1234.5 and 0.1234.
		expect(await gridCells(c)).toEqual(['1,234.50', '12.3%', '98,765.25', '87.7%']);
		await expect(c.getByTestId('df-caption')).toHaveText('Floors');
		// `.hide(axis="index")` is honored.
		await expect(c.getByTestId('df-th-index')).toHaveCount(0);
		// It is a grid, so it is NOT the sandboxed static-html iframe.
		await expect(c.getByTestId('output-html')).toHaveCount(0);
	});

	await test.step(`an empty frame keeps its grid and says so (${when})`, async () => {
		const c = cellById(page, 'c-empty-aaaaaa');
		expect(await gridColumns(c)).toEqual(['a', 'b', 'c', 'd']);
		await expect(c.getByTestId('df-empty')).toHaveText('This DataFrame has no rows.');
		await expect(c.getByTestId('output-html')).toHaveCount(0);
	});

	await test.step(`MultiIndex columns flatten the same way both times (${when})`, async () => {
		const c = cellById(page, 'c-multi-aaaaaa');
		expect(await gridColumns(c)).toEqual(['A / x', 'A / y', 'B / x', 'B / y']);
		expect(await gridCells(c)).toEqual(['1', '2', '3', '4']);
	});

	await test.step(`a plain pandas frame is unchanged (${when})`, async () => {
		const c = cellById(page, 'c-plain-aaaaaa');
		expect(await gridColumns(c)).toEqual(['a', 'b']);
		expect(await gridCells(c)).toEqual(['1', 'x', '2', 'y']);
		// Its index column is still there - `has_index` absent must read as true.
		await expect(c.getByTestId('df-th-index')).toHaveCount(1);
		expect(await c.getByTestId('df-index-cell').allInnerTexts()).toEqual(['0', '1']);
	});
}

test('every frame shape renders the same live and after a cold reopen', async ({ page }) => {
	test.skip(!hasFrames, 'pandas/polars could not be installed into the workspace venv');
	test.setTimeout(420_000);

	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	await runAll(page);

	// LIVE: each output still carries the structured MIME the kernel emitted...
	await assertEveryShape(page, 'live');

	// ...now kill the instance and boot a fresh one on the same workspace, so the
	// second reading comes from the SAVED `.ipynb` alone - clean-on-save has
	// stripped that MIME, leaving only the `text/html` repr the parser reads.
	killCellar(launcher!);
	launcher = null;
	const booted = await bootCellar(workspace);
	launcher = booted.proc;
	baseURL = booted.url;

	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	// Nothing is re-run: every grid below is parsed from the file on disk.
	await expect(cellById(page, 'c-polars-aaaaa').getByTestId('dataframe-grid')).toBeVisible({ timeout: 60_000 });
	await assertEveryShape(page, 'reopened');
});
