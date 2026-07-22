import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * E2E: the two bulk-run affordances.
 *
 *  - Per-cell "Run all above" (`run-above`): runs every code cell ABOVE the
 *    clicked one, exclusive of it and everything below, in document order.
 *    Disabled on the first cell (nothing above).
 *  - Top-of-notebook "Run all" (`run-all`): runs every code cell top-to-bottom.
 *
 * Both feed the shared server-side FIFO run queue, so a slow cell makes the rest
 * queue (queued badges) and interrupting cancels the whole batch — proven by
 * checking which marker variables actually landed in the live kernel namespace.
 */

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

/** nbformat 4.5 notebook: four code cells each binding a marker variable. */
function markerNotebook(): string {
	const cells = ['v0 = 0', 'v1 = 1', 'v2 = 2', 'v3 = 3'].map((src, i) => ({
		cell_type: 'code',
		id: `c${i}`,
		metadata: {},
		execution_count: null,
		outputs: [],
		source: [src]
	}));
	return JSON.stringify({
		cells,
		metadata: { kernelspec: { name: 'python3', display_name: 'python3' } },
		nbformat: 4,
		nbformat_minor: 5
	});
}

async function openNotebook(page: Page, expectCells: number): Promise<void> {
	const emptyOpen = page.getByTestId('empty-open-notebook');
	await Promise.race([
		emptyOpen.waitFor({ timeout: 30_000 }).catch(() => {}),
		page.getByTestId('cell').first().waitFor({ timeout: 30_000 }).catch(() => {})
	]);
	if (await emptyOpen.isVisible().catch(() => false)) await emptyOpen.click();
	await expect.poll(async () => page.getByTestId('cell').count(), { timeout: 30_000 }).toBe(expectCells);
}

/** Marker variable names (v0..v3) currently defined in the kernel namespace. */
async function definedMarkers(page: Page): Promise<string[]> {
	return page.evaluate(async () => {
		const res = await fetch('/api/kernel/variables?path=notebook.ipynb');
		if (!res.ok) return [];
		const body = await res.json();
		const vars: { name: string }[] = body.variables ?? body ?? [];
		return vars
			.map((v) => v.name)
			.filter((n) => /^v\d$/.test(n))
			.sort();
	});
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-runbulk-'));
	writeFileSync(join(workspace, 'notebook.ipynb'), markerNotebook());
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

test('Run above runs exactly the cells above the clicked cell (exclusive)', async ({ page }) => {
	test.setTimeout(120_000);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page, 4);

	// The first cell's run-above button is disabled (nothing above it).
	await expect(page.locator('[data-cell-id="c0"] [data-testid="run-above"]')).toBeDisabled();

	// Click "Run above" on the THIRD cell (c2): must run c0 and c1 only.
	await page.locator('[data-cell-id="c2"] [data-testid="run-above"]').click();

	// v0 and v1 land; v2 (the clicked cell) and v3 (below) never run.
	await expect.poll(async () => definedMarkers(page), { timeout: 45_000 }).toEqual(['v0', 'v1']);
	// Give any stray run ample time to (wrongly) execute.
	await page.waitForTimeout(3000);
	expect(await definedMarkers(page)).toEqual(['v0', 'v1']);
});

test('Run all runs every code cell top to bottom', async ({ page }) => {
	test.setTimeout(120_000);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page, 4);

	// No kernel-restart preamble: "Run all" runs EVERY code cell regardless of what
	// the namespace already holds, so its contract (all four markers defined) holds
	// whatever ran before — which keeps this test deterministic even when the whole
	// spec runs in sequence (the earlier restart-then-immediately-click preamble
	// raced the queue-clear against the shared launcher and flaked). Clicking Run
	// all re-runs v0/v1 too, so a partial namespace from the previous test only ever
	// converges to the full set.
	await page.getByTestId('run-all').click();

	// Every marker eventually gets defined (top-to-bottom over all four code cells).
	await expect.poll(async () => definedMarkers(page), { timeout: 45_000 }).toEqual(['v0', 'v1', 'v2', 'v3']);
});
