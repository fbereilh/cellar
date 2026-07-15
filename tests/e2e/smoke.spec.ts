import { test, expect } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * ONE end-to-end smoke test guarding cellar's core promise: create a notebook,
 * run a trivial code cell, see the real kernel output in the page, and confirm
 * the saved `.ipynb` is valid on disk.
 *
 * It boots the REAL `cellar` launcher (Node app + Jupyter sidecar + a python3
 * kernel) against a throwaway workspace, so it needs the full runtime (uv +
 * python3 + the cached host-venv). That runtime is not reliably available in CI,
 * so this spec is a LOCAL, best-effort check and SKIPS itself when the runtime
 * is missing — the vitest unit suite is the must-pass gate. There are no
 * arbitrary sleeps: the launcher's stdout announces readiness and every wait is
 * on an observable condition. The launcher lifecycle lives in ./harness.
 */

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-e2e-'));
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

test('create a notebook, run 6*7, see 42, and save a valid .ipynb', async ({ page }) => {
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);

	// A fresh workspace has no notebook.ipynb → the empty state offers to make one.
	const newBtn = page.getByTestId('empty-open-notebook');
	await newBtn.click();

	// The live notebook mounts with (at least) one code cell.
	const firstCell = page.getByTestId('cell').first();
	await expect(firstCell).toBeVisible();

	// Replace whatever the cell was seeded with, then run. Select-all first so the
	// typed expression is the cell's entire source (the starter cell is non-empty).
	const editor = firstCell.locator('.cm-content');
	await editor.click();
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.type('6*7');
	await expect(editor).toContainText('6*7');
	await firstCell.getByTestId('run').click();

	// The real kernel result appears in the cell's output area.
	await expect(firstCell.getByTestId('output-scroll')).toContainText('42', { timeout: 60_000 });

	// The run persisted a valid nbformat notebook to the workspace.
	const nbPath = join(workspace, 'notebook.ipynb');
	await expect(async () => {
		expect(existsSync(nbPath)).toBe(true);
		const nb = JSON.parse(readFileSync(nbPath, 'utf8'));
		expect(nb.nbformat).toBe(4);
		expect(Array.isArray(nb.cells)).toBe(true);
		const runCell = nb.cells.find((c: any) => (Array.isArray(c.source) ? c.source.join('') : c.source).includes('6*7'));
		expect(runCell).toBeTruthy();
		// Clean-on-save invariant: execution_count is nulled on disk.
		expect(runCell.execution_count).toBeNull();
		// The 42 output was persisted.
		const text = JSON.stringify(runCell.outputs);
		expect(text).toContain('42');
	}).toPass({ timeout: 15_000 });
});
