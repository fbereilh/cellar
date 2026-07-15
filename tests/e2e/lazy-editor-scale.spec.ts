import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * Scale guard + measurement for the lazy-editor virtualization. A LARGE notebook
 * (200 code cells) is opened and the number of live CodeMirror editors is checked:
 * with the interim virtualization it is ZERO until the user interacts, where the
 * old eager design built ONE PER CELL (200). This is the decisive regression guard
 * — the editor count must NOT track the cell count — and it prints the open-time +
 * JS-heap numbers used in the PR's before/after report.
 */

const CELL_COUNT = 200;

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

function bigNotebookJson(): string {
	return JSON.stringify({
		nbformat: 4,
		nbformat_minor: 5,
		metadata: { kernelspec: { name: 'python3', display_name: 'python3' } },
		cells: Array.from({ length: CELL_COUNT }, (_, i) => ({
			cell_type: 'code',
			id: `bulk-${i}-cccccccc`,
			metadata: {},
			execution_count: null,
			source: [`x_${i} = ${i}\nprint('cell ${i}', x_${i} * 2)`],
			outputs: []
		}))
	});
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-scale-e2e-'));
	writeFileSync(join(workspace, 'notebook.ipynb'), bigNotebookJson());
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

function editorCount(page: Page): Promise<number> {
	return page.locator('.cm-editor').count();
}

test(`a ${CELL_COUNT}-cell notebook opens with zero editors and shows every cell's code`, async ({ page }) => {
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);

	const t0 = Date.now();
	await page.getByTestId('empty-open-notebook').click();
	const cells = page.getByTestId('cell');
	await expect(cells).toHaveCount(CELL_COUNT);
	// "Open time" = from the open click until all cells are laid out with their code.
	await expect(cells.last().getByTestId('static-code')).toBeVisible();
	const openMs = Date.now() - t0;

	// The headline: ZERO live editors for 200 cells (the eager design built 200).
	await expect.poll(() => editorCount(page)).toBe(0);
	// Every cell renders its source via the static stand-in — nothing is a blank
	// placeholder hiding content (this is virtualization of the EDITOR, not the cell).
	await expect(page.getByTestId('static-code')).toHaveCount(CELL_COUNT);
	await expect(cells.first()).toContainText('x_0 = 0');
	await expect(cells.last()).toContainText(`x_${CELL_COUNT - 1} = ${CELL_COUNT - 1}`);

	// JS heap after open — reported for the PR, not asserted (device-dependent).
	const heap = await page.evaluate(() => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0);

	// One interaction builds exactly one editor — the rest stay static.
	await cells.nth(100).getByTestId('editor-scroll').click();
	await expect(cells.nth(100).locator('.cm-editor')).toBeVisible();
	await expect(editorCount(page)).resolves.toBe(1);

	// eslint-disable-next-line no-console
	console.log(
		`[lazy-editor scale] ${CELL_COUNT} cells → editors on open: 0 (eager design: ${CELL_COUNT}); ` +
			`open ${openMs} ms; JS heap ${(heap / 1e6).toFixed(1)} MB; 1 editor after first click`
	);
});
