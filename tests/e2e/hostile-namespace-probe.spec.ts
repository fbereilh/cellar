import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar, removeWorkspace } from './harness';

/**
 * E2E: a value that answers every attribute must not hang the kernel.
 *
 * The report: after `from fasthtml.common import *` the next cell never finished.
 * fastcore's `null` answers every attribute and index with itself, and Cellar's
 * Variables probe, which runs after every cell, iterated its `.shape` forever. The
 * next user cell parked behind the probe and read "running" until a restart.
 *
 * Driven through the real launcher, kernel and browser with the minimal case from
 * the report, so it needs no fastcore: define the object, then run another cell.
 * Before the fix the second cell never finished.
 */

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

function notebook(): string {
	const cell = (id: string, source: string[]) => ({
		cell_type: 'code',
		id,
		metadata: {},
		execution_count: null,
		outputs: [],
		source
	});
	return JSON.stringify({
		cells: [
			cell('hostile', [
				'class Hostile:\n',
				'    def __getattr__(self, k): return self\n',
				'    def __getitem__(self, i): return self\n',
				'x = Hostile()\n',
				"print('hostile defined')"
			]),
			cell('next', ["print('next cell ran')"])
		],
		metadata: { kernelspec: { name: 'python3', display_name: 'python3' } },
		nbformat: 4,
		nbformat_minor: 5
	});
}

async function openNotebook(page: Page): Promise<void> {
	const emptyOpen = page.getByTestId('empty-open-notebook');
	// Settle before probing: the shell paints either the empty state or an already
	// open notebook, and probing before either arrives makes the click a no-op.
	await expect(emptyOpen.or(page.getByTestId('cell').first())).toBeVisible({ timeout: 30_000 });
	if (await emptyOpen.isVisible().catch(() => false)) await emptyOpen.click();
	await expect.poll(async () => page.getByTestId('cell').count(), { timeout: 30_000 }).toBe(2);
}

/** Run one cell via its own Run button and wait for the line it prints. */
async function runCell(page: Page, id: string, printed: string, timeout: number): Promise<void> {
	await page.locator(`[data-cell-id="${id}"] [data-testid="run"]`).click();
	await expect(page.locator(`[data-cell-id="${id}"]`).getByTestId('output')).toContainText(printed, { timeout });
	await expect(page.locator(`[data-cell-id="${id}"] [data-testid="running-bar"]`)).toBeHidden({ timeout });
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-hostile-probe-'));
	writeFileSync(join(workspace, 'notebook.ipynb'), notebook());
	const booted = await bootCellar(workspace);
	launcher = booted.proc;
	baseURL = booted.url;
});

test.afterAll(async () => {
	if (launcher) killCellar(launcher);
	launcher = null;
	if (workspace && existsSync(workspace)) {
		try {
			removeWorkspace(workspace);
		} catch {
			/* best effort */
		}
	}
});

test('a cell after an object that answers every attribute still runs', async ({ page }) => {
	test.setTimeout(150_000);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);

	// The first run boots the kernel, so it gets the generous bound.
	await runCell(page, 'hostile', 'hostile defined', 60_000);
	// The Variables probe runs after that cell. Before the fix it never ended, and
	// this cell parked behind it forever.
	await runCell(page, 'next', 'next cell ran', 20_000);

	// The probe itself answers, and lists the object without inventing a shape.
	const x = await page.evaluate(async () => {
		const res = await fetch('/api/kernel/variables');
		const body = await res.json();
		return (body.variables ?? []).find((v: { name: string }) => v.name === 'x') ?? null;
	});
	expect(x).toMatchObject({ name: 'x', type: 'Hostile', shape: '' });
});
