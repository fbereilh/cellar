import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * A notebook authored in nbdev, opened in Cellar: `#| export` in the SOURCE marks a
 * cell, and the row toggle must say so.
 *
 * The rules are unit-tested (`nbdev-directives`, `nbdev-export-directive`,
 * `nbdev-lib-path`). What only a real browser proves is the honesty claim the whole
 * increment turns on, and it is a claim about what a human SEES:
 *
 *  - a directive-marked cell shows the export toggle ON. An unticked toggle over a
 *    cell the exporter writes is the one outcome this must never produce.
 *  - clicking it does not silently do nothing: Cellar never writes a `#|` line into
 *    the user's source, so the mark cannot be cleared from here - and the click says
 *    which line to remove instead of leaving a control that appears broken.
 *  - the cell's SOURCE is untouched by the attempt, and the module on disk still
 *    contains it.
 *
 * Boots the REAL launcher, so it SKIPS when that runtime is missing.
 */

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

const NB = 'notebook.ipynb';
const DIRECTIVE = 'dir00000-0000-4000-8000-00000000000a';
const META = 'meta0000-0000-4000-8000-00000000000b';
const PLAIN = 'plan0000-0000-4000-8000-00000000000c';

function notebookJson(): string {
	const cell = (id: string, source: string, cellar?: Record<string, unknown>) => ({
		cell_type: 'code',
		id,
		metadata: cellar ? { cellar } : {},
		source: source.split(/(?<=\n)/),
		execution_count: null,
		outputs: []
	});
	return JSON.stringify(
		{
			cells: [
				cell(DIRECTIVE, '#| export\ndef from_directive():\n    return 1\n'),
				cell(META, 'def from_metadata():\n    return 2\n', { export: true }),
				cell(PLAIN, 'def not_exported():\n    return 3\n')
			],
			metadata: {
				cellar: { export_target: 'lib/mod.py' },
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

/** SETTLE before probing - the shell paints either the empty state or the notebook. */
async function openNotebook(page: Page): Promise<void> {
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	const emptyBtn = page.getByTestId('empty-open-notebook');
	const firstCell = page.getByTestId('cell').first();
	await expect(emptyBtn.or(firstCell).first()).toBeVisible({ timeout: 30_000 });
	if (await emptyBtn.isVisible()) await emptyBtn.click();
	await expect(firstCell).toBeVisible({ timeout: 30_000 });
}

const sourceOnDisk = (id: string): string => {
	const nb = JSON.parse(readFileSync(join(workspace, NB), 'utf8')) as {
		cells: Array<{ id: string; source: string[] }>;
	};
	return (nb.cells.find((c) => c.id === id)?.source ?? []).join('');
};

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available - E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-nbdev-directive-'));
	writeFileSync(join(workspace, NB), notebookJson());
	const booted = await bootCellar(workspace);
	launcher = booted.proc;
	baseURL = booted.url;
});

test.afterAll(() => {
	if (launcher) killCellar(launcher);
	launcher = null;
	if (workspace && existsSync(workspace)) rmSync(workspace, { recursive: true, force: true });
});

test.describe.configure({ mode: 'serial' });

test('a `#| export` cell shows the toggle ON, beside a metadata-marked one', async ({ page }) => {
	await openNotebook(page);
	const directive = cellEl(page, DIRECTIVE).getByTestId('toggle-export');
	await expect(directive).toHaveAttribute('aria-pressed', 'true');
	// ...and it is visibly the same ON state Cellar's own flag produces.
	await expect(cellEl(page, META).getByTestId('toggle-export')).toHaveAttribute('aria-pressed', 'true');
	await expect(cellEl(page, PLAIN).getByTestId('toggle-export')).toHaveAttribute('aria-pressed', 'false');

	// The reason rides `title`, which a browser exposes as the accessible DESCRIPTION
	// beside the STABLE aria-label - the label stays put because the state is
	// `aria-pressed`'s job.
	await expect(directive).toHaveAttribute('title', /#\| export/);
	await expect(directive).toHaveAttribute('aria-label', "Export this cell to the notebook's .py module");
	await expect(directive).toHaveAttribute('data-directive-export', 'true');
	await expect(cellEl(page, META).getByTestId('toggle-export')).not.toHaveAttribute('data-directive-export', 'true');
});

test('clicking it explains rather than silently doing nothing, and touches no source', async ({ page }) => {
	await openNotebook(page);
	const before = sourceOnDisk(DIRECTIVE);
	const directive = cellEl(page, DIRECTIVE).getByTestId('toggle-export');

	await directive.click();
	await expect(page.getByTestId('app-notice')).toContainText('#| export');
	// The toggle never flickers OFF: nothing optimistic is applied, because nothing
	// Cellar may write would take the mark away.
	await expect(directive).toHaveAttribute('aria-pressed', 'true');

	// The cell's own source is the user's code - Cellar never edits it to express a
	// mark, and it must not have edited it to refuse one either.
	expect(sourceOnDisk(DIRECTIVE)).toBe(before);
	expect(before).toContain('#| export');
});

test('the module really contains the directive-marked cell, and not the plain one', async ({ page }) => {
	await openNotebook(page);
	// Nudge a save so auto-on-save regenerates the module for this workspace.
	await cellEl(page, PLAIN).getByTestId('toggle-agent-hidden').click();

	const modulePath = join(workspace, 'lib', 'mod.py');
	await expect(async () => {
		expect(existsSync(modulePath)).toBe(true);
		const text = readFileSync(modulePath, 'utf8');
		expect(text).toContain('def from_directive()');
		expect(text).toContain('def from_metadata()');
		expect(text).not.toContain('def not_exported()');
	}).toPass({ timeout: 15_000 });
});

test('a metadata-marked cell still unmarks normally', async ({ page }) => {
	await openNotebook(page);
	const meta = cellEl(page, META).getByTestId('toggle-export');
	await expect(meta).toHaveAttribute('aria-pressed', 'true');
	await meta.click();
	await expect(meta).toHaveAttribute('aria-pressed', 'false');

	await page.reload();
	await openNotebook(page);
	await expect(cellEl(page, META).getByTestId('toggle-export')).toHaveAttribute('aria-pressed', 'false');
	// ...while the directive-marked one is untouched by all of it.
	await expect(cellEl(page, DIRECTIVE).getByTestId('toggle-export')).toHaveAttribute('aria-pressed', 'true');
});
