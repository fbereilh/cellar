import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar, removeWorkspace } from './harness';

/**
 * The per-cell export toggle on a `.py` (jupytext) notebook versus an `.ipynb`.
 *
 * The reported defect: on a `.py` notebook the toggle showed a mark ON while the
 * document stored nothing - jupytext writes no cell metadata - so the mark lived
 * only in the server's memory and was gone after the next relaunch. The fix asks
 * the ONE rule the server's export refusals ask (`notebookHoldsExport`), so the
 * toggle is not offered on such a notebook and the server refuses a mark sent
 * anyway. On an `.ipynb` nothing changes: the toggle marks, and the mark is on
 * disk and survives a reload.
 *
 * A mark on the `.py` would survive a plain page RELOAD (the server keeps the
 * document in memory), which is why the `.py` half asserts the absence of the
 * control and the server's refusal rather than a reload round trip.
 */

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

const PY_SOURCE = '# %%\nx = 1\n\n# %%\ndef f():\n    return 2\n';

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available - E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-e2e-export-toggle-py-'));
	writeFileSync(join(workspace, 'analysis.py'), PY_SOURCE);
	const booted = await bootCellar(workspace);
	launcher = booted.proc;
	baseURL = booted.url;
});

test.afterAll(async () => {
	if (launcher) killCellar(launcher);
	launcher = null;
	removeWorkspace(workspace);
});

/** Open a workspace file as a notebook tab from the file tree, and wait for its cells. */
async function openFromTree(page: Page, name: string, cells: number): Promise<void> {
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await page.getByText(name, { exact: true }).first().dblclick();
	await expect(page.locator('[data-testid="cell"]:visible')).toHaveCount(cells);
}

test('a .py notebook offers no export toggle, and the server refuses a mark sent anyway', async ({ page, request }) => {
	await openFromTree(page, 'analysis.py', 2);
	const cells = page.locator('[data-testid="cell"]:visible');

	// Offered nothing: neither the per-cell toggle nor the notebook's export bar.
	await expect(cells.first().getByTestId('toggle-export')).toHaveCount(0);
	await expect(page.locator('[data-testid="toggle-export"]:visible')).toHaveCount(0);
	await expect(page.locator('[data-testid="export-bar"]:visible')).toHaveCount(0);
	// The per-row controls beside it are still there, so the absence is the gate
	// and not a row that failed to render.
	await expect(cells.first().getByTestId('toggle-agent-hidden')).toBeVisible();

	// The server half: a mark sent directly is REFUSED with its own reason, and
	// nothing was applied - the document still reports the cell unmarked.
	const view = await (await request.get(`${baseURL}/api/notebooks?path=analysis.py`)).json();
	const id = view.notebook.cells[0].id as string;
	const res = await request.patch(`${baseURL}/api/cells/${id}`, {
		data: { export: true, nb: 'analysis.py' }
	});
	expect(res.status()).toBe(409);
	expect((await res.json()).reason).toBe('py-notebook');
	const after = await (await request.get(`${baseURL}/api/notebooks?path=analysis.py`)).json();
	expect(after.notebook.cells[0].metadata?.cellar?.export).toBeUndefined();

	// And the file is byte-identical: nothing was ever written for the mark.
	expect(readFileSync(join(workspace, 'analysis.py'), 'utf8')).toBe(PY_SOURCE);
});

test('an .ipynb notebook still marks a cell, and the mark survives a reload', async ({ page, request }) => {
	const created = await request.post(`${baseURL}/api/notebooks`, {
		data: { path: 'report.ipynb', create: true }
	});
	expect(created.ok(), await created.text()).toBeTruthy();

	await openFromTree(page, 'report.ipynb', 1);
	const toggle = page.locator('[data-testid="cell"]:visible').first().getByTestId('toggle-export');
	await expect(toggle).toBeVisible();
	await expect(toggle).toHaveAttribute('aria-pressed', 'false');
	await expect(page.locator('[data-testid="export-bar"]:visible')).toHaveCount(1);

	await toggle.click();
	await expect(toggle).toHaveAttribute('aria-pressed', 'true');
	await expect
		.poll(() => JSON.parse(readFileSync(join(workspace, 'report.ipynb'), 'utf8')).cells[0].metadata?.cellar?.export)
		.toBe(true);

	// A fresh page load, reopening the notebook: the mark is read back from the
	// server, not from this tab's optimistic write.
	await openFromTree(page, 'report.ipynb', 1);
	await expect(
		page.locator('[data-testid="cell"]:visible').first().getByTestId('toggle-export')
	).toHaveAttribute('aria-pressed', 'true');
});
