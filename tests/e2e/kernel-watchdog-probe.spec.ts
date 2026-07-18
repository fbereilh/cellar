import { test, expect, type Locator, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * END-TO-END regression for the captain's Spark bug: a SILENT long-running cell
 * must not be killed by the idle watchdog.
 *
 * The old watchdog aborted any run whose kernel went quiet for the idle window,
 * which cannot distinguish a slow cluster job from a dead kernel - both are silent.
 * `time.sleep()` is the cheap local stand-in for `spark.sql(...).toPandas()`: one
 * blocking call that emits NOTHING until it returns. The window here is driven to
 * 700ms via CELLAR_KERNEL_IDLE_TIMEOUT_MS, so an 8-second sleep outlives ~11 of them;
 * under the old behavior it died on the first. Now each expiry only triggers an
 * out-of-band liveness probe, the real kernel probes busy, and the run rides on.
 *
 * Needs the full runtime (uv + python3 + host-venv), so it SKIPS when absent, like
 * the other E2E specs - the vitest suite is the must-pass gate.
 */

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available - E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-e2e-watchdog-'));
	// A tiny idle window, inherited by the launcher (and thus the app) from this env.
	// The sleep below must outlive MANY of these.
	process.env.CELLAR_KERNEL_IDLE_TIMEOUT_MS = '700';
	const booted = await bootCellar(workspace);
	launcher = booted.proc;
	baseURL = booted.url;
});

test.afterAll(async () => {
	if (launcher) killCellar(launcher);
	launcher = null;
	delete process.env.CELLAR_KERNEL_IDLE_TIMEOUT_MS;
	if (workspace && existsSync(workspace)) {
		try {
			rmSync(workspace, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}
});

/** Type `source` into a cell's editor (building the lazy CodeMirror editor first). */
async function typeInto(cell: Locator, page: Page, source: string) {
	await cell.getByTestId('editor-scroll').click();
	const editor = cell.locator('.cm-content');
	await editor.click();
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.type(source);
	await expect(editor).toContainText(source.split('\n')[0].slice(0, 12));
}

test('a silent time.sleep() cell outliving many idle windows completes and returns its result', async ({ page }) => {
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await page.getByTestId('empty-open-notebook').click();

	const firstCell = page.getByTestId('cell').first();
	await expect(firstCell).toBeVisible();

	// A cell that is BUSY but SILENT for ~8s - ~11 idle windows at 700ms. It prints
	// nothing until it returns, exactly like a Spark query.
	await typeInto(firstCell, page, 'import time; time.sleep(8); print("SLEPT-OK")');
	await firstCell.getByTestId('run').click();

	// The old watchdog aborted here with "Kernel went unresponsive (no activity for
	// Ns)". The run must instead survive and print its result.
	await expect(firstCell.getByTestId('output-scroll')).toContainText('SLEPT-OK', { timeout: 60_000 });
	await expect(firstCell.getByTestId('output-scroll')).not.toContainText('unresponsive');
	await expect(firstCell.getByTestId('output-scroll')).not.toContainText('CellarError');

	// The queue slot was released: the notebook still runs. A second cell that runs to
	// completion proves the kernel was never left holding the slot.
	await page.keyboard.press('Escape');
	await page.getByTestId('add-cell').click();
	const second = page.getByTestId('cell').nth(1);
	await typeInto(second, page, '6*7');
	await second.getByTestId('run').click();
	await expect(second.getByTestId('output-scroll')).toContainText('42', { timeout: 60_000 });
});
