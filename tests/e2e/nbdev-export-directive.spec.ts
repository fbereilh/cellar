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

test('a refusal this tab could not predict still puts the toggle back, and says why', async ({ page }) => {
	// The one window the optimistic client-side guard cannot cover: it reads
	// `cell.source`, which is deliberately NOT refreshed for a MOUNTED cell whose
	// remote edit is stashed behind the "changed on server" banner. So the directive
	// is on the SERVER's copy of the cell and not on ours, the guard passes, the
	// PATCH goes out and the server refuses it - and an unread refusal would leave
	// the row showing an unticked toggle over a cell the exporter still writes, which
	// is precisely the lie this whole feature exists to prevent.
	await openNotebook(page);
	const cell = cellEl(page, PLAIN);
	const toggle = cell.getByTestId('toggle-export');

	// Mark it the ordinary way, so a click is an UNMARK (the only refusable direction).
	await expect(toggle).toHaveAttribute('aria-pressed', 'false');
	await toggle.click();
	await expect(toggle).toHaveAttribute('aria-pressed', 'true');

	// Put the caret in its editor: that is what makes the next remote edit STASH
	// rather than apply, leaving this tab's copy of the source stale.
	await cell.getByTestId('editor-scroll').click();
	await expect(cell.locator('.cm-content')).toBeVisible({ timeout: 10_000 });
	await cell.locator('.cm-content').click();

	// Another writer (an agent / another tab) adds the directive to the SOURCE.
	await page.evaluate(
		({ nb, id }) =>
			fetch(`/api/cells/${id}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ nb, source: '#| export\ndef not_exported():\n    return 3\n' })
			}).then(() => undefined),
		{ nb: NB, id: PLAIN }
	);
	await expect(cell.getByTestId('remote-changed')).toBeVisible({ timeout: 15_000 });

	// HOLD the export PATCH open, so a concurrent write to this same cell's `cellar`
	// namespace can land inside the window the revert runs after. The revert owns the
	// `export` key and nothing else; putting a pre-click SNAPSHOT of the namespace
	// back would silently undo that other change.
	let releaseExport: () => void = () => {};
	const held = new Promise<void>((resolve) => (releaseExport = resolve));
	await page.route(`**/api/cells/${PLAIN}`, async (route) => {
		let body: Record<string, unknown> | null = null;
		try {
			body = route.request().postDataJSON() as Record<string, unknown> | null;
		} catch {
			body = null;
		}
		if (body && 'export' in body) await held;
		await route.continue();
	});

	// Its own precondition, not one an earlier test in this serial file happens to
	// leave behind: the concurrent change below has to be a CHANGE, so start from
	// shown. A no-op write emits nothing and simply leaves it shown.
	const agentHidden = cell.getByTestId('toggle-agent-hidden');
	await page.evaluate(
		({ nb, id }) =>
			fetch(`/api/cells/${id}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ nb, hiddenFromAgent: false })
			}).then(() => undefined),
		{ nb: NB, id: PLAIN }
	);
	await expect(agentHidden).toHaveAttribute('aria-pressed', 'false', { timeout: 15_000 });

	// Now unmark. The client cannot see the directive, so it really does send this.
	await toggle.click();

	// ...and while it is in flight, an agent withholds the cell from every agent
	// surface - a DIFFERENT key in the same namespace, applied to this tab over SSE.
	await page.evaluate(
		({ nb, id }) =>
			fetch(`/api/cells/${id}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ nb, hiddenFromAgent: true })
			}).then(() => undefined),
		{ nb: NB, id: PLAIN }
	);
	await expect(agentHidden).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 });

	releaseExport();
	// The cell is marked TWICE here (Cellar's flag, then the directive), so the notice
	// must not promise that removing the line alone stops the export.
	await expect(page.getByTestId('app-notice')).toContainText('marked for export twice');
	// Reverted: the cell IS exported, so the row must say so.
	await expect(toggle).toHaveAttribute('aria-pressed', 'true');
	// ...and the revert put back ONLY the key it owns: the disclosure-shaped change
	// that landed mid-flight survives it.
	await expect(agentHidden).toHaveAttribute('aria-pressed', 'true');
	await page.unroute(`**/api/cells/${PLAIN}`);

	// ...and the server agrees - the mark was never cleared on disk.
	await expect(async () => {
		expect(sourceOnDisk(PLAIN)).toContain('#| export');
	}).toPass({ timeout: 15_000 });
	await page.reload();
	await openNotebook(page);
	await expect(cellEl(page, PLAIN).getByTestId('toggle-export')).toHaveAttribute('aria-pressed', 'true');
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
