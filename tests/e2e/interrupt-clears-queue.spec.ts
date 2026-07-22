import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * E2E: interrupting a running cell must cancel the WHOLE pending queue.
 *
 * Run All on a notebook whose first cell is a long sleeper, so that cell runs
 * while the rest queue. Interrupt the running cell (the in-cell stop button) and
 * assert that NONE of the queued cells executed - their marker variables never get
 * defined in the kernel, every queued/running badge clears, and the sleeper itself
 * stopped early (was interrupted, not run to completion).
 *
 * This reproduces a real, subtle bug: each queued run holds an open streaming
 * response, and enough of them saturate the browser's HTTP/1.1 connection pool, so
 * the interrupt request could not even reach the server until the running cell
 * finished on its own - by which point the queue had already drained.
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
	// 10 markers → comfortably exceeds the browser's ~6-connection HTTP/1.1 pool.
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

test('interrupt cancels the running cell AND every queued cell', async ({ page }) => {
	test.setTimeout(120_000);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);

	// Run All via the command palette — the real user path (fires each cell's own
	// run request, so the client's AbortControllers are in play).
	await runAllViaPalette(page);

	// The sleeper is running and several markers show the queued badge.
	await expect(page.locator('[data-cell-id="sleeper"] [data-testid="running-bar"]')).toBeVisible({ timeout: 20_000 });
	await expect.poll(async () => page.getByTestId('queued-indicator').count(), { timeout: 15_000 }).toBeGreaterThan(2);

	// Let the kernel boot and the sleep genuinely begin.
	await page.waitForTimeout(4000);

	// Interrupt via the in-cell stop button — the real user action.
	await page.locator('[data-cell-id="sleeper"] [data-testid="cell-interrupt"]').click();

	// The sleeper must stop well before its 20s sleep would end.
	await expect(page.locator('[data-cell-id="sleeper"] [data-testid="running-bar"]')).toBeHidden({ timeout: 15_000 });

	// Give any leaked queued runs ample time to (wrongly) execute.
	await page.waitForTimeout(6000);

	// EXPECTED: no marker cell ever ran, so no marker variable exists.
	const markers = await definedMarkers(page);
	expect(markers, `queued cells leaked and executed: ${markers.join(', ')}`).toEqual([]);

	// EXPECTED: the sleeper was interrupted (its sleep did NOT complete).
	const sleeperCompleted = await page.evaluate(async () => {
		const res = await fetch('/api/kernel/variables?path=notebook.ipynb');
		const body = await res.json();
		return (body.variables ?? []).some((v: { name: string }) => v.name === 'sleeper_ran');
	});
	expect(sleeperCompleted, 'the sleeper ran to completion instead of being interrupted').toBe(false);

	// EXPECTED: every queued/running badge cleared back to idle.
	expect(await page.getByTestId('queued-indicator').count()).toBe(0);
	expect(await page.getByTestId('running-indicator').count()).toBe(0);
});

test('a normal Run All (no interrupt) still runs every cell in order', async ({ page }) => {
	test.setTimeout(120_000);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);

	// Run All with NO interrupt: the sleeper runs, the markers queue behind it, and
	// every one must eventually run (the queue drains normally, in order). The
	// sleeper's own 20s sleep sets the pace, so poll generously.
	await runAllViaPalette(page);
	await expect(page.locator('[data-cell-id="sleeper"] [data-testid="running-bar"]')).toBeVisible({ timeout: 20_000 });
	await expect.poll(async () => page.getByTestId('queued-indicator').count(), { timeout: 15_000 }).toBeGreaterThan(2);

	// Every marker eventually gets defined; nothing was cancelled.
	await expect
		.poll(async () => (await definedMarkers(page)).length, { timeout: 45_000 })
		.toBe(10);
	expect(await page.getByTestId('queued-indicator').count()).toBe(0);
});
