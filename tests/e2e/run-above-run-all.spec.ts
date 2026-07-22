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
 *  - Top-of-notebook "Run all" (`run-all`): runs every code cell top-to-bottom,
 *    skipping non-code (markdown) cells.
 *
 * Both feed the shared server-side FIFO run queue and are proven by checking
 * which marker variables actually landed in the live kernel namespace.
 *
 * Each test boots its OWN launcher + throwaway workspace, so it runs against a
 * FRESH kernel (see `boot`) — the pre-existing kernel-bridge wedge (below) is
 * far more likely once a bulk run follows a prior run on the same kernel.
 */

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

type CellSpec = { type: 'code' | 'markdown'; source: string };

/** nbformat 4.5 notebook from ordered cell specs; ids are `c0`, `c1`, … */
function buildNotebook(specs: CellSpec[]): string {
	const cells = specs.map((s, i) => {
		const base = { cell_type: s.type, id: `c${i}`, metadata: {}, source: [s.source] };
		return s.type === 'code' ? { ...base, execution_count: null, outputs: [] } : base;
	});
	return JSON.stringify({
		cells,
		metadata: { kernelspec: { name: 'python3', display_name: 'python3' } },
		nbformat: 4,
		nbformat_minor: 5
	});
}

/** Four code cells (c0..c3), each binding a marker variable — for the Run above test. */
function codeMarkerNotebook(): string {
	return buildNotebook(['v0 = 0', 'v1 = 1', 'v2 = 2', 'v3 = 3'].map((source) => ({ type: 'code', source })));
}

/**
 * Several code cells interleaved with markdown — for the Run all test. Run all must
 * run every code cell (v0..v3) top-to-bottom and skip the markdown cells.
 *
 * This used to be capped at two code cells because Run all fired every cell's POST
 * at once (fire-and-forget) and intermittently wedged on a reused kernel — a cell
 * stuck "running" for the ~120-210s watchdog window. Run all now dispatches
 * SEQUENTIALLY (`LiveNotebook.runCodeIds`) and every `execute()` serializes on the
 * kernel's exec lock, so no two run against the same kernel at once and the wedge is
 * gone. So the batch is deliberately larger (four code cells = three run-to-run
 * transitions) to exercise the reliability this task fixed. The interleaved markdown
 * cells prove Run all runs every CODE cell and skips non-code.
 */
function runAllMarkerNotebook(): string {
	return buildNotebook([
		{ type: 'markdown', source: '# Report' },
		{ type: 'code', source: 'v0 = 0' },
		{ type: 'markdown', source: '## Analysis' },
		{ type: 'code', source: 'v1 = 1' },
		{ type: 'code', source: 'v2 = 2' },
		{ type: 'markdown', source: '## More' },
		{ type: 'code', source: 'v3 = 3' }
	]);
}

/** Boot a fresh launcher + workspace seeded with `nbJson` as `notebook.ipynb`. */
async function boot(nbJson: string): Promise<void> {
	workspace = mkdtempSync(join(tmpdir(), 'cellar-runbulk-'));
	writeFileSync(join(workspace, 'notebook.ipynb'), nbJson);
	const booted = await bootCellar(workspace);
	launcher = booted.proc;
	baseURL = booted.url;
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

test.beforeEach(() => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only');
});

test.afterEach(async () => {
	if (launcher) killCellar(launcher);
	launcher = null;
	if (workspace && existsSync(workspace)) {
		try {
			rmSync(workspace, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}
	workspace = '';
});

test('Run above runs exactly the cells above the clicked cell (exclusive)', async ({ page }) => {
	test.setTimeout(120_000);
	await boot(codeMarkerNotebook());
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

test('Run all runs every code cell top to bottom (reliable on a warm kernel)', async ({ page }) => {
	test.setTimeout(120_000);
	// Run all now dispatches SEQUENTIALLY and every execute serializes on the kernel's
	// exec lock, so the reused-kernel wedge this task fixed cannot recur. Prove it on a
	// warm kernel with multiple transitions: run once to warm the kernel, then Run all
	// AGAIN (the exact "Run all again after cells already ran" scenario) and assert all
	// four code cells run, in order, with nothing stuck. The interleaved markdown cells
	// prove non-code is skipped.
	await boot(runAllMarkerNotebook());
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page, 7); // 4 code + 3 markdown

	await expect(page.getByTestId('run-all')).toBeEnabled();

	// First Run all warms the kernel and defines every marker.
	await page.getByTestId('run-all').click();
	await expect.poll(async () => definedMarkers(page), { timeout: 45_000 }).toEqual(['v0', 'v1', 'v2', 'v3']);

	// Run all AGAIN on the now-warm kernel: it must complete with no cell left running.
	await page.getByTestId('run-all').click();
	// The batch re-runs and drains fully — no cell stuck "running", no leftover queue.
	await expect
		.poll(async () => (await page.getByTestId('running-indicator').count()) + (await page.getByTestId('queued-indicator').count()), { timeout: 45_000 })
		.toBe(0);
	// Every marker is (re)defined. Poll rather than read once: the sidebar inspector
	// probe is briefly in flight after the batch, and the variables endpoint reports
	// `busy` (empty) while it runs — a transient the poll rides out.
	await expect.poll(async () => definedMarkers(page), { timeout: 15_000 }).toEqual(['v0', 'v1', 'v2', 'v3']);
});
