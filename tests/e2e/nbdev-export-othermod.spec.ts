import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar, removeWorkspace, openNotebookSettings } from './harness';

/**
 * nbdev's valued `#| export <module>`, seen by a human in a real browser.
 *
 * The rules are unit-tested (`nbdev-export-othermod`). What only the real launcher
 * and browser prove:
 *
 *  - a cell in extra.ipynb marked `#| export core` shows its export toggle ON and a
 *    chip naming `core.py`, the module core.ipynb owns;
 *  - pressing "Export to .py" in EITHER notebook writes the same core.py: the owner's
 *    cells, then the fed cell, with the fed name in `__all__` and the contributor named
 *    in the header. A second export does not append it again;
 *  - a cell that names a module no notebook owns, or one two notebooks own, goes into
 *    no module: its badge says so and no file is created or touched for it.
 *
 * Boots the REAL launcher, so it SKIPS when that runtime is missing.
 */

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

const FED = 'fed00000-0000-4000-8000-00000000000a';
const ORPHAN = 'orph0000-0000-4000-8000-00000000000b';
const SHARED = 'shar0000-0000-4000-8000-00000000000c';
const PLAIN = 'plan0000-0000-4000-8000-00000000000d';

function nbJson(cells: Array<{ id: string; source: string }>): string {
	return JSON.stringify(
		{
			cells: cells.map((c) => ({
				cell_type: 'code',
				id: c.id,
				metadata: {},
				source: c.source.split(/(?<=\n)/),
				execution_count: null,
				outputs: []
			})),
			metadata: {
				kernelspec: { display_name: 'python3', language: 'python', name: 'python3' }
			},
			nbformat: 4,
			nbformat_minor: 5
		},
		null,
		1
	);
}

const cellEl = (page: Page, id: string) => page.locator(`[data-cell-id="${id}"]`);
const read = (rel: string) => readFileSync(join(workspace, rel), 'utf8');

async function openNotebook(page: Page, nb: string, reload = true): Promise<void> {
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	const emptyBtn = page.getByTestId('empty-open-notebook');
	const firstCell = page.locator('[data-testid="cell"]:visible').first();
	await expect(emptyBtn.or(firstCell).first()).toBeVisible({ timeout: 30_000 });
	await page.getByTestId('tree-file').filter({ hasText: nb }).dblclick();
	await expect(page.locator(`[data-testid="tab"][data-tab-id="file:${nb}"]`)).toHaveAttribute('data-active', 'true', { timeout: 30_000 });
	await expect(page.locator('[data-testid="cell"]:visible').first()).toBeVisible({ timeout: 30_000 });
	if (!reload) return;
	// Open it once more in a fresh page: the workspace scan has finished by now.
	await page.waitForTimeout(1_000);
	await openNotebook(page, nb, false);
}

/** The "Export to .py" button result, read from the route the button calls. */
async function exportVia(page: Page, nb: string) {
	return page.evaluate(
		(path) =>
			fetch('/api/notebooks/export-py', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ op: 'export', path })
			}).then((r) => r.json()),
		nb
	);
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available - E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-nbdev-othermod-'));
	writeFileSync(
		join(workspace, 'core.ipynb'),
		nbJson([
			{ id: 'core0000-0000-4000-8000-000000000001', source: '#| default_exp core' },
			{ id: 'core0000-0000-4000-8000-000000000002', source: '#| export\ndef base():\n    return 1\n' }
		])
	);
	// Two notebooks that both own shared.py, so a cell feeding it has no single owner.
	for (const name of ['shared_a.ipynb', 'shared_b.ipynb'])
		writeFileSync(
			join(workspace, name),
			nbJson([
				{ id: `${name.slice(0, 8)}-0000-4000-8000-000000000001`, source: '#| default_exp shared' },
				{ id: `${name.slice(0, 8)}-0000-4000-8000-000000000002`, source: '#| export\nS = 1\n' }
			])
		);
	writeFileSync(
		join(workspace, 'extra.ipynb'),
		nbJson([
			{ id: FED, source: '#| export core\ndef extra():\n    return base() + 1\n' },
			{ id: ORPHAN, source: '#| export nowhere\ndef lost():\n    return 0\n' },
			{ id: SHARED, source: '#| export shared\ndef twice():\n    return 2\n' },
			{ id: PLAIN, source: 'def scratch():\n    pass\n' }
		])
	);
	const booted = await bootCellar(workspace);
	launcher = booted.proc;
	baseURL = booted.url;
});

test.afterAll(() => {
	if (launcher) killCellar(launcher);
	launcher = null;
	removeWorkspace(workspace);
});

test('first open on a fresh server: the fed cell shows its chip without a reload', async ({ page }) => {
	// The first GET answers before the workspace scan, and the scan's
	// `notebook:export-derived` push can arrive before the tab knows its notebook
	// id. The tab must keep that push and apply it once the load resolves.
	await openNotebook(page, 'extra.ipynb', false);
	const fed = cellEl(page, FED);
	await expect(fed).toBeVisible({ timeout: 30_000 });
	try {
		await expect(fed.getByTestId('export-other-module-chip')).toHaveText('→ core.py', { timeout: 10_000 });
	} finally {
		if (process.env.OTHERMOD_SHOTS) await page.screenshot({ path: join(process.env.OTHERMOD_SHOTS, 'first-open-no-reload.png'), fullPage: true });
	}
});

test('a #| export core cell shows ON with a chip naming the owner module', async ({ page }) => {
	await openNotebook(page, 'extra.ipynb');
	const fed = cellEl(page, FED);
	await expect(fed).toBeVisible({ timeout: 30_000 });
	await expect(fed.getByTestId('toggle-export')).toHaveAttribute('aria-pressed', 'true');
	await expect(fed.getByTestId('export-other-module-chip')).toHaveText('→ core.py');
	await expect(fed.getByTestId('toggle-export')).toHaveAttribute('title', /core\.ipynb/);
	await expect(cellEl(page, PLAIN).getByTestId('toggle-export')).toHaveAttribute('aria-pressed', 'false');
	await page.screenshot({ path: process.env.OTHERMOD_SHOTS ? join(process.env.OTHERMOD_SHOTS, 'extra-notebook.png') : test.info().outputPath('extra-notebook.png'), fullPage: true });
});

test('unowned and doubly-owned modules are refused with a badge', async ({ page }) => {
	await openNotebook(page, 'extra.ipynb');
	const orphan = cellEl(page, ORPHAN);
	await expect(orphan.getByTestId('export-other-refused-badge')).toHaveText(/nowhere not exported/);
	await expect(orphan.getByTestId('toggle-export')).toHaveAttribute('aria-pressed', 'false');
	await expect(orphan.getByTestId('export-other-module-chip')).toHaveCount(0);
	const shared = cellEl(page, SHARED);
	await expect(shared.getByTestId('export-other-refused-badge')).toHaveText(/shared not exported/);
	await expect(shared.getByTestId('toggle-export')).toHaveAttribute('aria-pressed', 'false');
	await orphan.scrollIntoViewIfNeeded();
	await page.screenshot({ path: process.env.OTHERMOD_SHOTS ? join(process.env.OTHERMOD_SHOTS, 'refused-badges.png') : test.info().outputPath('refused-badges.png'), fullPage: true });
});

test('exporting the owner writes the fed cell into core.py, and the contributor builds the same bytes', async ({ page }) => {
	await openNotebook(page, 'core.ipynb');
	await expect(page.locator('[data-testid="cell"]:visible').first()).toBeVisible({ timeout: 30_000 });
	await openNotebookSettings(page);
	await page.locator('[data-testid="export-run"]:visible').click();
	await expect(async () => {
		expect(existsSync(join(workspace, 'core.py'))).toBe(true);
		expect(read('core.py')).toContain('def extra()');
	}).toPass({ timeout: 15_000 });
	const fromOwner = read('core.py');
	expect(fromOwner).toContain('# Source notebook: core.ipynb');
	expect(fromOwner).toContain('# Also from notebook: extra.ipynb');
	expect(fromOwner).toContain("__all__ = ['base', 'extra']");
	expect(fromOwner.indexOf('def base()')).toBeLessThan(fromOwner.indexOf('def extra()'));
	expect(fromOwner).not.toContain('def scratch()');
	expect(fromOwner).not.toContain('def lost()');
	expect(fromOwner).not.toContain('def twice()');
	if (process.env.OTHERMOD_SHOTS) writeFileSync(join(process.env.OTHERMOD_SHOTS, 'core-from-owner.py'), fromOwner);

	// Export again from the owner: rebuilt, never appended twice.
	await exportVia(page, 'core.ipynb');
	expect(read('core.py')).toBe(fromOwner);
	expect(read('core.py').split('def extra()').length).toBe(2);

	// Export from the contributor: the same module bytes, and nothing for the refused cells.
	const res = await exportVia(page, 'extra.ipynb');
	if (process.env.OTHERMOD_SHOTS)
		writeFileSync(join(process.env.OTHERMOD_SHOTS, 'export-from-extra.json'), JSON.stringify(res, null, 1));
	expect(read('core.py')).toBe(fromOwner);
	expect(existsSync(join(workspace, 'nowhere.py'))).toBe(false);
	expect(existsSync(join(workspace, 'shared.py'))).toBe(false);
});

test('removing the directive drops the cell from core.py on the next export', async ({ page }) => {
	await openNotebook(page, 'extra.ipynb');
	await expect(cellEl(page, FED)).toBeVisible({ timeout: 30_000 });
	await page.evaluate(
		({ id }) =>
			fetch(`/api/cells/${id}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ nb: 'extra.ipynb', source: 'def extra():\n    return base() + 1\n' })
			}).then((r) => r.status),
		{ id: FED }
	);
	await expect(cellEl(page, FED).getByTestId('export-other-module-chip')).toHaveCount(0, { timeout: 15_000 });
	await exportVia(page, 'extra.ipynb');
	const after = read('core.py');
	if (process.env.OTHERMOD_SHOTS) writeFileSync(join(process.env.OTHERMOD_SHOTS, 'core-after-removal.py'), after);
	expect(after).not.toContain('def extra()');
	expect(after).not.toContain('extra.ipynb');
	expect(after).toContain('def base()');
	expect(after).toContain("__all__ = ['base']");
});
