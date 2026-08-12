import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * E2E: the two toolbar buttons added beside "Run all" — Interrupt and Clear all
 * outputs. Both are pure SURFACING of actions that already existed (the palette's
 * `kernel-interrupt` / `clear-all-outputs`), so what is proven here is the wiring
 * and the gating, not the underlying kernel/output logic:
 *
 *  - all three buttons render in the toolbar;
 *  - Interrupt is disabled while nothing runs, arms while a run is in flight, and
 *    clicking it really stops the batch (the sleeper ends far short of its sleep
 *    and no later cell runs) — the same effect as the palette command;
 *  - Clear all outputs is disabled when there is nothing to clear, clears EVERY
 *    cell including ones virtualization has windowed out (it reads the document
 *    model, not the mounted DOM), and the cleared state is on DISK — asserted
 *    against the `.ipynb` itself, not just the in-memory doc, plus a reload.
 */

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

type CellSpec = { type: 'code' | 'markdown'; source: string; output?: string };

/** nbformat 4.5 notebook from ordered cell specs; ids are `c0`, `c1`, … */
function buildNotebook(specs: CellSpec[]): string {
	const cells = specs.map((s, i) => {
		const base = { cell_type: s.type, id: `c${i}`, metadata: {}, source: [s.source] };
		if (s.type !== 'code') return base;
		const outputs = s.output ? [{ output_type: 'stream', name: 'stdout', text: [`${s.output}\n`] }] : [];
		return { ...base, execution_count: null, outputs };
	});
	return JSON.stringify({
		cells,
		metadata: { kernelspec: { name: 'python3', display_name: 'python3' } },
		nbformat: 4,
		nbformat_minor: 5
	});
}

/** A long sleeper first, then fast marker cells — for the Interrupt test. */
function sleeperNotebook(): string {
	const specs: CellSpec[] = [{ type: 'code', source: 'import time\ntime.sleep(20)\nsleeper_ran = True' }];
	for (let i = 0; i < 5; i++) specs.push({ type: 'code', source: `marker_${i} = ${i}` });
	return buildNotebook(specs);
}

/**
 * Many cells, EVERY code cell carrying a saved output. Long enough that windowing
 * (on by default) leaves most of them unmounted, which is the point: clear-all must
 * reach a cell that has no DOM at all.
 */
function manyOutputsNotebook(count: number): string {
	const specs: CellSpec[] = [];
	for (let i = 0; i < count; i++) {
		specs.push({ type: 'markdown', source: `## Section ${i}` });
		specs.push({ type: 'code', source: `print(${i})`, output: `${i}` });
	}
	return buildNotebook(specs);
}

/** Boot a fresh launcher + workspace seeded with `nbJson` as `notebook.ipynb`. */
async function boot(nbJson: string): Promise<void> {
	workspace = mkdtempSync(join(tmpdir(), 'cellar-toolbar-'));
	writeFileSync(join(workspace, 'notebook.ipynb'), nbJson);
	const booted = await bootCellar(workspace);
	launcher = booted.proc;
	baseURL = booted.url;
}

async function openNotebook(page: Page): Promise<void> {
	const emptyOpen = page.getByTestId('empty-open-notebook');
	await Promise.race([
		emptyOpen.waitFor({ timeout: 30_000 }).catch(() => {}),
		page.getByTestId('cell').first().waitFor({ timeout: 30_000 }).catch(() => {})
	]);
	if (await emptyOpen.isVisible().catch(() => false)) await emptyOpen.click();
	await expect(page.getByTestId('notebook-toolbar')).toBeVisible({ timeout: 30_000 });
	await expect.poll(async () => page.getByTestId('cell').count(), { timeout: 30_000 }).toBeGreaterThan(0);
}

/** Marker variable names currently defined in the live kernel namespace. */
async function definedMarkers(page: Page): Promise<string[]> {
	return page.evaluate(async () => {
		const res = await fetch('/api/kernel/variables?path=notebook.ipynb');
		if (!res.ok) return [];
		const body = await res.json();
		const vars: { name: string }[] = body.variables ?? body ?? [];
		return vars.map((v) => v.name).filter((n) => n.startsWith('marker_')).sort();
	});
}

/** How many code cells still hold outputs, read from the `.ipynb` ON DISK. */
function cellsWithOutputsOnDisk(): number {
	const nb = JSON.parse(readFileSync(join(workspace, 'notebook.ipynb'), 'utf8'));
	return nb.cells.filter((c: { outputs?: unknown[] }) => (c.outputs?.length ?? 0) > 0).length;
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

test('the toolbar renders Run all, Interrupt and Clear all outputs, each gated on state', async ({ page }) => {
	test.setTimeout(120_000);
	// One code cell WITHOUT output, so clear-all has nothing to do at load.
	await boot(buildNotebook([{ type: 'markdown', source: '# Report' }, { type: 'code', source: "print('hi')" }]));
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);

	const toolbar = page.getByTestId('notebook-toolbar');
	const runAll = toolbar.getByTestId('run-all');
	const interrupt = toolbar.getByTestId('interrupt-all');
	const clearAll = toolbar.getByTestId('clear-all-outputs');

	// All three are in the toolbar, and each is a real labelled control.
	await expect(runAll).toBeVisible();
	await expect(interrupt).toBeVisible();
	await expect(clearAll).toBeVisible();
	await expect(interrupt).toHaveAttribute('aria-label', /interrupt/i);
	await expect(clearAll).toHaveAttribute('aria-label', /clear all outputs/i);

	// Nothing running, nothing to clear.
	await expect(runAll).toBeEnabled();
	await expect(interrupt).toBeDisabled();
	await expect(clearAll).toBeDisabled();

	// Running a cell that prints gives the notebook an output — clear-all arms.
	await page.locator('[data-cell-id="c1"] [data-testid="run"]').click();
	await expect(clearAll).toBeEnabled({ timeout: 60_000 });
});

test('Interrupt is disabled until a run is in flight, then stops the whole batch', async ({ page }) => {
	test.setTimeout(180_000);
	await boot(sleeperNotebook());
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);

	const interrupt = page.getByTestId('notebook-toolbar').getByTestId('interrupt-all');
	await expect(interrupt).toBeDisabled();

	// Run all: the sleeper runs first, so the markers behind it are not submitted yet.
	await page.getByTestId('notebook-toolbar').getByTestId('run-all').click();
	await expect(page.locator('[data-cell-id="c0"] [data-testid="running-bar"]')).toBeVisible({ timeout: 60_000 });
	await expect(interrupt).toBeEnabled();

	// Let the kernel boot and the sleep genuinely begin.
	await page.waitForTimeout(4000);
	await interrupt.click();

	// The sleeper stops well short of its 20s sleep, and the batch does not continue.
	await expect(page.locator('[data-cell-id="c0"] [data-testid="running-bar"]')).toBeHidden({ timeout: 20_000 });
	await page.waitForTimeout(6000);
	expect(await definedMarkers(page)).toEqual([]);

	// With nothing left running the button disarms again.
	await expect(interrupt).toBeDisabled();
});

test('Clear all outputs clears every cell — windowed-out ones included — and persists', async ({ page }) => {
	test.setTimeout(180_000);
	const CODE_CELLS = 60;
	await boot(manyOutputsNotebook(CODE_CELLS));
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);

	// Windowing is on by default: most cells have no DOM at all, so this really is
	// the "clear must read the model, not the mounted cells" case.
	const mounted = await page.getByTestId('cell').count();
	expect(mounted).toBeLessThan(CODE_CELLS * 2);
	expect(cellsWithOutputsOnDisk()).toBe(CODE_CELLS);

	const clearAll = page.getByTestId('notebook-toolbar').getByTestId('clear-all-outputs');
	await expect(clearAll).toBeEnabled();
	await clearAll.click();

	// Every cell's outputs are gone on DISK — including the ones never mounted.
	await expect.poll(() => cellsWithOutputsOnDisk(), { timeout: 90_000 }).toBe(0);
	await expect(clearAll).toBeDisabled();

	// And the cleared state survives a reload.
	await page.reload();
	await openNotebook(page);
	await expect(page.getByTestId('notebook-toolbar').getByTestId('clear-all-outputs')).toBeDisabled();
	expect(cellsWithOutputsOnDisk()).toBe(0);
});
