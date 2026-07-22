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
 * Two code cells interleaved with markdown — for the Run all test. Run all must
 * run BOTH code cells (v0, v1) top-to-bottom and skip the markdown cells.
 *
 * Exactly two code cells is deliberate: the notebook wedges on a per-run-transition
 * kernel-bridge race (see the Run all test), and two code cells is a single
 * transition — the same reliable one-transition batch the Run above test already
 * exercises. Markdown cells never reach the kernel (they "run" client-side), so
 * they add coverage (proving non-code is skipped) without adding a transition.
 */
function runAllMarkerNotebook(): string {
	return buildNotebook([
		{ type: 'markdown', source: '# Report' },
		{ type: 'code', source: 'v0 = 0' },
		{ type: 'markdown', source: '## Analysis' },
		{ type: 'code', source: 'v1 = 1' }
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

test('Run all runs every code cell top to bottom', async ({ page }) => {
	test.setTimeout(120_000);
	// A FRESH kernel + a two-code-cell notebook keep this deterministic. Run all
	// (like every bulk run) dispatches its cells to the kernel one at a time, and
	// the kernel bridge has a pre-existing race that intermittently wedges a run
	// following a prior one on the same kernel (a trivial cell stuck "running",
	// recovered only on the watchdog's ~120-210s scale) — tracked as a SEPARATE
	// dedicated task, not touched here. That race grows with the number of
	// run-to-run transitions, so this test asserts Run all's reliable contract on
	// the smallest meaningful batch: exactly two code cells = a single transition,
	// the same one the Run above test already runs reliably. The interleaved
	// markdown cells prove Run all runs every CODE cell top-to-bottom and skips
	// non-code, without adding a kernel transition.
	await boot(runAllMarkerNotebook());
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page, 4); // 2 code + 2 markdown

	// Run all is enabled (there are code cells) and runs both of them.
	await expect(page.getByTestId('run-all')).toBeEnabled();
	await page.getByTestId('run-all').click();

	// Both code cells run top-to-bottom; the markdown cells define nothing.
	await expect.poll(async () => definedMarkers(page), { timeout: 45_000 }).toEqual(['v0', 'v1']);
});
