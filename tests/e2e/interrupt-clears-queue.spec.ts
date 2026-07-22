import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * E2E: interrupting a Run all must cancel the WHOLE run — the running cell AND
 * every cell that has not run yet.
 *
 * Run all on a notebook whose first cell is a long sleeper. Run all dispatches
 * SEQUENTIALLY (`LiveNotebook.runCodeIds` — one `/run` stream open at a time, the
 * same reliable path Run above/below use), so while the sleeper runs the marker
 * cells behind it have not been submitted yet. Interrupt the running sleeper (its
 * in-cell stop button) and assert that NONE of the later cells execute — their
 * marker variables never get defined — the sleeper itself stopped early (was
 * interrupted, not run to completion), and every running/queued badge clears.
 *
 * Interrupt cancels a bulk run through two paths, BOTH exercised here:
 *   - the client bumps `interruptGeneration` (`cancelQueuedRuns`), which stops the
 *     sequential Run-all loop from advancing to the next cell after the abort; and
 *   - the server interrupts the kernel, ending the running cell.
 * (The old fire-and-forget Run all opened every cell's stream at once and relied on
 * saturating the browser's HTTP/1.1 pool; that dispatch model — and the wedge it
 * caused on a reused kernel — was replaced by the sequential path, so this spec no
 * longer asserts a pile of queued badges: with one stream at a time there are none.)
 */

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

/** nbformat 4.5 notebook: a long sleeper first, then N fast marker cells. */
function queueNotebook(): string {
	const cells: unknown[] = [
		{
			cell_type: 'code',
			id: 'sleeper',
			metadata: {},
			execution_count: null,
			outputs: [],
			source: ['import time\n', 'time.sleep(20)\n', 'sleeper_ran = True']
		}
	];
	for (let i = 0; i < 10; i++) {
		cells.push({
			cell_type: 'code',
			id: `marker-${String(i).padStart(2, '0')}`,
			metadata: {},
			execution_count: null,
			outputs: [],
			source: [`marker_${i} = ${i}`]
		});
	}
	return JSON.stringify({
		cells,
		metadata: { kernelspec: { name: 'python3', display_name: 'python3' } },
		nbformat: 4,
		nbformat_minor: 5
	});
}

/** Open the canonical notebook (11 cells), whether the empty state is shown or the
 *  notebook tab auto-restored (it does once the notebook has been mutated on disk). */
async function openNotebook(page: Page): Promise<void> {
	const emptyOpen = page.getByTestId('empty-open-notebook');
	await Promise.race([
		emptyOpen.waitFor({ timeout: 30_000 }).catch(() => {}),
		page.getByTestId('cell').first().waitFor({ timeout: 30_000 }).catch(() => {})
	]);
	if (await emptyOpen.isVisible().catch(() => false)) await emptyOpen.click();
	await expect.poll(async () => page.getByTestId('cell').count(), { timeout: 30_000 }).toBe(11);
}

/** Trigger "Run all cells" from the command palette (the real user path). */
async function runAllViaPalette(page: Page): Promise<void> {
	await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
	await expect(page.getByTestId('command-palette')).toBeVisible({ timeout: 5000 });
	await page.getByTestId('command-palette-input').fill('Run all cells');
	await page.getByTestId('command-palette-input').press('Enter');
}

/** Read the live kernel namespace; return the marker names currently defined. */
async function definedMarkers(page: Page): Promise<string[]> {
	return page.evaluate(async () => {
		const res = await fetch('/api/kernel/variables?path=notebook.ipynb');
		if (!res.ok) return [];
		const body = await res.json();
		const vars: { name: string }[] = body.variables ?? body ?? [];
		return vars.map((v) => v.name).filter((n) => n.startsWith('marker_'));
	});
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-interrupt-'));
	writeFileSync(join(workspace, 'notebook.ipynb'), queueNotebook());
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

test('interrupt cancels the running cell AND the rest of the Run all batch', async ({ page }) => {
	test.setTimeout(120_000);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);

	// Run All via the command palette — the real user path.
	await runAllViaPalette(page);

	// The sleeper runs first; no later cell has been submitted yet (sequential
	// dispatch awaits the running cell), so nothing downstream should be defined.
	await expect(page.locator('[data-cell-id="sleeper"] [data-testid="running-bar"]')).toBeVisible({ timeout: 20_000 });

	// Let the kernel boot and the sleep genuinely begin.
	await page.waitForTimeout(4000);

	// Interrupt via the in-cell stop button — the real user action.
	await page.locator('[data-cell-id="sleeper"] [data-testid="cell-interrupt"]').click();

	// The sleeper must stop well before its 20s sleep would end.
	await expect(page.locator('[data-cell-id="sleeper"] [data-testid="running-bar"]')).toBeHidden({ timeout: 15_000 });

	// Give any leaked run ample time to (wrongly) execute.
	await page.waitForTimeout(6000);

	// EXPECTED: the Run-all loop stopped at the interrupt, so no marker cell ran.
	const markers = await definedMarkers(page);
	expect(markers, `the rest of the batch leaked and executed: ${markers.join(', ')}`).toEqual([]);

	// EXPECTED: the sleeper was interrupted (its sleep did NOT complete).
	const sleeperCompleted = await page.evaluate(async () => {
		const res = await fetch('/api/kernel/variables?path=notebook.ipynb');
		const body = await res.json();
		return (body.variables ?? []).some((v: { name: string }) => v.name === 'sleeper_ran');
	});
	expect(sleeperCompleted, 'the sleeper ran to completion instead of being interrupted').toBe(false);

	// EXPECTED: every running/queued badge cleared back to idle.
	expect(await page.getByTestId('queued-indicator').count()).toBe(0);
	expect(await page.getByTestId('running-indicator').count()).toBe(0);
});

test('a normal Run All (no interrupt) still runs every cell in order', async ({ page }) => {
	test.setTimeout(120_000);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);

	// Run All with NO interrupt: the sleeper runs first, then every marker runs in
	// order behind it (the sequential loop advances cell by cell). All must run.
	// The sleeper's own 20s sleep sets the pace, so poll generously.
	await runAllViaPalette(page);
	await expect(page.locator('[data-cell-id="sleeper"] [data-testid="running-bar"]')).toBeVisible({ timeout: 20_000 });

	// Every marker eventually gets defined, in order; nothing was cancelled.
	await expect
		.poll(async () => (await definedMarkers(page)).length, { timeout: 60_000 })
		.toBe(10);
	await expect.poll(async () => page.getByTestId('queued-indicator').count(), { timeout: 15_000 }).toBe(0);
	expect(await page.getByTestId('running-indicator').count()).toBe(0);
});
