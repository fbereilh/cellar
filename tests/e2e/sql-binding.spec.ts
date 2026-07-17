import { test, expect, type Page, type Locator } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * E2E for the SQL cell's `-- >> name` result binding, driven through the real UI.
 *
 * The binding's whole point is a kernel-visible variable, so this exercises the
 * REAL kernel: a first Python cell installs a stand-in `spark` (a Databricks
 * cluster is not available to a test, and the binding is orthogonal to what
 * `spark.sql` does with the query) whose `.sql(q)` echoes the query it was handed
 * back as data — so the rendered grid also proves the `-- >>` line is STRIPPED
 * before the query reaches Spark.
 *
 * Covered end to end: the named variable exists in the kernel with the right
 * data, `_sql_df is sales_df` still holds (the documented "last SQL result"
 * alias), editing the SQL turns the consuming Python cell's chip amber `stale`
 * (the synthetic SQL `defines` reaching the staleness graph), and `-- >> spark`
 * fails visibly without destroying the live session.
 *
 * Boots the REAL launcher against a throwaway workspace (see ./harness); SKIPS
 * when the kernel runtime is absent (local-only, like smoke.spec).
 */

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

/** Where reviewer-visible screenshots land, when the runner asks for them. */
const EVIDENCE = process.env.CELLAR_EVIDENCE_DIR || '';

const SETUP_SRC = [
	'import pandas as pd',
	'',
	'',
	'class _DF:',
	'    """Stand-in for a lazy Spark DataFrame: echoes the query it was built from."""',
	'',
	'    def __init__(self, rows):',
	'        self.rows = rows',
	'',
	'    def limit(self, n):',
	'        return _DF(self.rows[:n])',
	'',
	'    def toPandas(self):',
	"        return pd.DataFrame(self.rows, columns=['id', 'query_spark_saw'])",
	'',
	'    def count(self):',
	'        return len(self.rows)',
	'',
	'',
	'class _Spark:',
	'    def sql(self, q):',
	'        return _DF([(1, q), (2, q)])',
	'',
	'',
	'spark = _Spark()',
	"print('stand-in spark ready')"
].join('\n');

const SQL_SRC = '-- >> sales_df\nselect * from sales';
const CONSUMER_SRC = [
	"print('sales_df.count() ->', sales_df.count())",
	"print('_sql_df is sales_df ->', _sql_df is sales_df)",
	"print('sales_df rows ->', sales_df.rows)"
].join('\n');
const RESERVED_SQL_SRC = '-- >> spark\nselect 1';
const SPARK_ALIVE_SRC = "print('spark is still ->', type(spark).__name__)";

/** A cell for the seeded notebook. `sql` tags it the way the type menu does. */
function cell(id: string, source: string, kind: 'python' | 'sql' = 'python') {
	return {
		id,
		cell_type: 'code',
		metadata: kind === 'sql' ? { cellar: { language: 'sql' } } : {},
		execution_count: null,
		outputs: [],
		source: source.split('\n').map((l, i, a) => (i === a.length - 1 ? l : l + '\n'))
	};
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-e2e-sql-'));

	// The project venv the kernel binds to. Seeded here so the stand-in `spark`
	// can build a real pandas frame (which is what makes the grid render).
	const venv = join(workspace, '.venv');
	expect(spawnSync('uv', ['venv', venv], { stdio: 'inherit' }).status).toBe(0);
	expect(
		spawnSync('uv', ['pip', 'install', '--python', join(venv, 'bin', 'python'), 'ipykernel', 'pandas'], {
			stdio: 'inherit'
		}).status
	).toBe(0);

	// Seed the notebook on disk rather than typing multi-line Python through
	// CodeMirror's auto-indent: opening an existing .ipynb is an ordinary user
	// path, and the behaviour under test is the run + the edit, not the typing.
	mkdirSync(workspace, { recursive: true });
	writeFileSync(
		join(workspace, 'notebook.ipynb'),
		JSON.stringify(
			{
				cells: [
					cell('c-setup', SETUP_SRC),
					cell('c-sql', SQL_SRC, 'sql'),
					cell('c-consumer', CONSUMER_SRC),
					cell('c-reserved', RESERVED_SQL_SRC, 'sql'),
					cell('c-alive', SPARK_ALIVE_SRC)
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

/** Open the seeded notebook from the empty state if no tab is restored yet. */
async function openNotebook(page: Page): Promise<void> {
	const openBtn = page.getByTestId('empty-open-notebook');
	if (await openBtn.isVisible().catch(() => false)) await openBtn.click();
	await expect(page.getByTestId('cell').first()).toBeVisible();
}

/** Run cell `cell` and wait for its run indicator to clear. */
async function runCell(page: Page, c: Locator): Promise<void> {
	await c.getByTestId('run').click();
	await expect(c.getByTestId('running-indicator')).toHaveCount(0, { timeout: 90_000 });
}

/** Build the lazy editor (click) and replace cell `c`'s source with `text`. */
async function typeInto(page: Page, c: Locator, text: string): Promise<void> {
	await c.getByTestId('editor-scroll').click();
	const editor = c.locator('.cm-content');
	await expect(editor).toBeVisible();
	await editor.click();
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.type(text);
}

async function shot(page: Page, name: string): Promise<void> {
	if (!EVIDENCE) return;
	mkdirSync(EVIDENCE, { recursive: true });
	await page.screenshot({ path: join(EVIDENCE, name), fullPage: true });
}

test('a `-- >> name` SQL cell binds its result in the kernel, keeps the _sql_df alias, and stales its consumer when edited', async ({
	page
}) => {
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);

	await openNotebook(page);
	const cells = page.getByTestId('cell');
	await expect(cells).toHaveCount(5);

	// 1. Install the stand-in spark in the real kernel.
	await runCell(page, cells.nth(0));
	await expect(cells.nth(0).getByTestId('output-scroll')).toContainText('stand-in spark ready', { timeout: 90_000 });

	// 2. The SQL cell renders as SQL and runs.
	await expect(cells.nth(1).getByTestId('sql-badge')).toBeVisible();
	await runCell(page, cells.nth(1));

	// The result grid renders — and the query Spark actually saw carries NO `-- >>`
	// line: the prefix was stripped, not sent.
	const grid = cells.nth(1).getByTestId('dataframe-grid');
	await expect(grid).toBeVisible({ timeout: 90_000 });
	await expect(grid.getByTestId('df-counts')).toContainText('2 rows × 2 cols');
	await expect(grid.getByTestId('df-cell').first()).toHaveText('1');
	await expect(grid).toContainText('select * from sales');
	await expect(grid).not.toContainText('>>');

	// 3. The named variable really exists in the kernel, holds the result, and
	//    `_sql_df` still points at the very same object (the documented alias).
	await runCell(page, cells.nth(2));
	const consumerOut = cells.nth(2).getByTestId('output-scroll');
	await expect(consumerOut).toContainText('sales_df.count() -> 2', { timeout: 90_000 });
	await expect(consumerOut).toContainText('_sql_df is sales_df -> True');
	await expect(consumerOut).toContainText("select * from sales");

	// A cell that just ran reads FRESH: no `stale`, and no `not run` (the signal
	// the absolute-path resolution fix restores — it read `not run` for every cell).
	await expect(cells.nth(1).getByTestId('not-run-badge')).toHaveCount(0, { timeout: 15_000 });
	await expect(cells.nth(2).getByTestId('not-run-badge')).toHaveCount(0, { timeout: 15_000 });

	await shot(page, 'sql-binding-bound.png');

	// 4. Editing the SQL stales the Python cell that consumes its result — the
	//    synthetic `defines` reaching the staleness graph, seen by an end user.
	await expect(cells.nth(2).getByTestId('stale-badge')).toHaveCount(0);
	await typeInto(page, cells.nth(1), '-- >> sales_df\nselect * from sales_v2');
	const staleChip = cells.nth(2).getByTestId('stale-badge');
	await expect(staleChip).toBeVisible({ timeout: 30_000 });
	await expect(staleChip).toHaveText(/stale/);
	await expect(staleChip).toHaveAttribute('title', /c-sql|edited/);

	await shot(page, 'sql-binding-stale.png');
});

test('`-- >> spark` fails visibly and leaves the live Spark session intact', async ({ page }) => {
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	const cells = page.getByTestId('cell');
	await expect(cells).toHaveCount(5);

	// Re-assert the stand-in spark, so this test does not lean on the other's run.
	await runCell(page, cells.nth(0));
	await runCell(page, cells.nth(3));
	const out = cells.nth(3).getByTestId('output-scroll');
	await expect(out).toContainText('RuntimeError', { timeout: 90_000 });
	await expect(out).toContainText('reserved');
	await expect(out).toContainText('the live Spark session');
	// It failed, so nothing was bound: no grid.
	await expect(cells.nth(3).getByTestId('dataframe-grid')).toHaveCount(0);

	// The session the reserved-name guard exists to protect is untouched.
	await runCell(page, cells.nth(4));
	await expect(cells.nth(4).getByTestId('output-scroll')).toContainText('spark is still -> _Spark', {
		timeout: 90_000
	});

	await shot(page, 'sql-binding-reserved.png');
});
