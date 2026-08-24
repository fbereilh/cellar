import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * E2E: interrupt must END the run even when the kernel will not surrender.
 *
 * The captain's report was "the interrupt cell tool is not working, specially on
 * spark cells ... the cell hangs as running". Driven through the REAL user path -
 * a real launcher, a real browser, a real kernel - against the shape that produces
 * it: a cell whose work does not surrender to SIGINT.
 *
 * That shape is induced here in PURE PYTHON rather than against Databricks, and
 * deliberately so. The mechanism was measured, not assumed: against this runtime a
 * blocking gRPC call and a real pyspark Spark Connect query BOTH raise
 * KeyboardInterrupt out of the blocking call (~2s), so "Spark blocks signals" is
 * NOT the cause. What actually matters is only that the kernel does not send its
 * `execute_reply` - once that is true the run never settles, whatever produced it -
 * and a cell that swallows the KeyboardInterrupt reproduces exactly that, with no
 * cluster, no credential, and no network.
 *
 * The proven path is asserted alongside it in the same notebook, because the fix is
 * worthless if it breaks the ordinary case: a plain `time.sleep` must still be
 * ended BY THE KERNEL, keeping its own KeyboardInterrupt traceback.
 */

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

/** A cell that swallows the KeyboardInterrupt, and an ordinary sleeper beside it. */
function notebook(): string {
	const cell = (id: string, source: string[]) => ({
		cell_type: 'code',
		id,
		metadata: {},
		execution_count: null,
		outputs: [],
		source
	});
	return JSON.stringify({
		cells: [
			// Receives the signal, runs python's handler, and keeps going anyway - the
			// shape of a client library that catches broadly inside a retry loop.
			cell('deaf', [
				'import time\n',
				'while True:\n',
				'    try:\n',
				'        time.sleep(0.2)\n',
				'    except KeyboardInterrupt:\n',
				'        pass\n'
			]),
			cell('sleeper', ['import time\n', 'time.sleep(60)\n', 'sleeper_ran = True'])
		],
		metadata: { kernelspec: { name: 'python3', display_name: 'python3' } },
		nbformat: 4,
		nbformat_minor: 5
	});
}

async function openNotebook(page: Page): Promise<void> {
	const emptyOpen = page.getByTestId('empty-open-notebook');
	// Settle before probing: the shell paints either the empty state or an already
	// open notebook, and probing before either arrives makes the click a no-op.
	await expect(emptyOpen.or(page.getByTestId('cell').first())).toBeVisible({ timeout: 30_000 });
	if (await emptyOpen.isVisible().catch(() => false)) await emptyOpen.click();
	await expect.poll(async () => page.getByTestId('cell').count(), { timeout: 30_000 }).toBe(2);
}

/** Run one cell via its own Run button and wait until it is really executing. */
async function startCell(page: Page, id: string): Promise<void> {
	await page.locator(`[data-cell-id="${id}"] [data-testid="run"]`).click();
	await expect(page.locator(`[data-cell-id="${id}"] [data-testid="running-bar"]`)).toBeVisible({
		timeout: 30_000
	});
	// Let the kernel genuinely enter the cell before signalling it.
	await page.waitForTimeout(3000);
}

/** The cell's rendered output text. */
async function outputText(page: Page, id: string): Promise<string> {
	return (await page.locator(`[data-cell-id="${id}"]`).innerText()) ?? '';
}

test.beforeAll(async () => {
	test.skip(
		!runtimeAvailable(),
		'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only'
	);
	workspace = mkdtempSync(join(tmpdir(), 'cellar-interrupt-deaf-'));
	writeFileSync(join(workspace, 'notebook.ipynb'), notebook());
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

test('an ordinary cell is still ended BY THE KERNEL, keeping its KeyboardInterrupt', async ({
	page
}) => {
	test.setTimeout(150_000);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);

	await startCell(page, 'sleeper');
	await page.locator('[data-cell-id="sleeper"] [data-testid="cell-interrupt"]').click();

	// It surrenders in milliseconds, so this must clear well inside the grace window -
	// the fix must not have turned every interrupt into a 5s wait.
	await expect(page.locator('[data-cell-id="sleeper"] [data-testid="running-bar"]')).toBeHidden({
		timeout: 10_000
	});

	// The kernel's OWN KeyboardInterrupt is what the cell shows: nothing was
	// force-settled, so Cellar synthesized no message of its own.
	const text = await outputText(page, 'sleeper');
	expect(text).toMatch(/KeyboardInterrupt/);
	expect(text).not.toMatch(/did not respond to the interrupt/i);

	// And it really was interrupted rather than run to completion.
	const completed = await page.evaluate(async () => {
		const res = await fetch('/api/kernel/variables?path=notebook.ipynb');
		const body = await res.json();
		return (body.variables ?? []).some((v: { name: string }) => v.name === 'sleeper_ran');
	});
	expect(completed, 'the sleeper ran to completion instead of being interrupted').toBe(false);
});

// LAST on purpose: a force-settled run leaves the runaway loop executing in the
// kernel - which is exactly what its message warns about - so anything after it
// would queue behind that loop inside jupyter and never start.
test('the in-cell stop button ends a run the kernel will not surrender', async ({ page }) => {
	test.setTimeout(150_000);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	await startCell(page, 'deaf');

	// The real user action: the running cell's own stop button.
	await page.locator('[data-cell-id="deaf"] [data-testid="cell-interrupt"]').click();

	// THE REGRESSION: before the fix this stayed visible forever - the run never
	// settled, so the cell read "running" for the rest of the session and no further
	// cell of this notebook could run. The wait is comfortably past the 5s grace.
	await expect(page.locator('[data-cell-id="deaf"] [data-testid="running-bar"]')).toBeHidden({
		timeout: 30_000
	});
	expect(await page.getByTestId('running-indicator').count()).toBe(0);
	expect(await page.getByTestId('queued-indicator').count()).toBe(0);

	// HONESTY: the interrupt never observed a stop, so the cell must not claim one.
	// It says Cellar stopped waiting, that the kernel may still be running the code,
	// and names the one action that is guaranteed to end it.
	const text = await outputText(page, 'deaf');
	expect(text).toMatch(/did not respond to the interrupt/i);
	expect(text).toMatch(/may still be executing/i);
	expect(text).toMatch(/restart/i);
});
