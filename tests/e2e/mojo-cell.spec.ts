import { test, expect, type Page, type Locator } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * The `mojo` cell type in the REAL browser, against a REAL kernel.
 *
 * Three things only a real run can establish, and all three are acceptance
 * criteria rather than nice-to-haves:
 *
 *  1. **A user can pick Mojo and get a Mojo cell** - the type menu offers it, the
 *     badge says so, and the Python-only affordances (export toggle, imports role,
 *     staleness chip) are HIDDEN rather than shown permanently greyed.
 *  2. **The next code cell is Mojo without re-picking.** That is the whole reason
 *     inheritance exists; the unit tests pin the RULE, this pins that the rule is
 *     wired into the affordances a human actually clicks.
 *  3. **With no toolchain the user gets an INSTRUCTION, not a traceback and not a
 *     534 MB surprise install.** The e2e workspace has no `max` (Cellar never
 *     installs it), so this is the path every first-time user meets - and IPython's
 *     own answer without the pre-flight would be the opaque
 *     `UsageError: Cell magic function %%mojo not found`.
 *
 * The toolchain-PRESENT half (the magic really registering, `mojo run` really
 * running, no state between cells) is measured against a real Mojo 1.0.0 in
 * `tests/unit/mojo-toolchain-probe.test.ts`, gated on `CELLAR_MOJO_PYTHON` - a
 * 534 MB install has no business in the e2e harness.
 *
 * Needs the real runtime (uv + python3 + host-venv) like the rest of the E2E suite;
 * skips gracefully without it. Cells are addressed by `data-cell-id` rather than by
 * index, since the shipped default windows cells out of the DOM.
 */

const PY_ID = 'pycell0000';
const MD_ID = 'mdcell0000';

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

const cellBy = (page: Page, id: string) => page.locator(`[data-testid="cell"][data-cell-id="${id}"]`);
const mojoCards = (page: Page) => page.locator('[data-testid="cell"]:has([data-testid="mojo-badge"])');

/** Collect page + console errors: the unambiguous signal that a render threw. */
function watchErrors(page: Page): string[] {
	const errors: string[] = [];
	page.on('pageerror', (err) => errors.push(String(err?.message ?? err)));
	page.on('console', (msg) => {
		if (msg.type() === 'error') errors.push(msg.text());
	});
	return errors;
}

/** A python cell then a markdown cell, so "skip the prose" is exercised by the bottom add row. */
function seed(name: string): void {
	writeFileSync(
		join(workspace, name),
		JSON.stringify(
			{
				cells: [
					{ cell_type: 'code', id: PY_ID, metadata: {}, source: ["print('python')"], outputs: [], execution_count: null },
					{ cell_type: 'markdown', id: MD_ID, metadata: {}, source: ['## A heading'] }
				],
				metadata: {},
				nbformat: 4,
				nbformat_minor: 5
			},
			null,
			1
		)
	);
}

async function openFresh(page: Page, name: string): Promise<void> {
	seed(name);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await page.locator(`[data-testid="tree-file"][data-path="${name}"]`).click();
	await expect(cellBy(page, PY_ID)).toBeVisible({ timeout: 30_000 });
}

/** Convert `cell` to `type` through the type menu - the path a human uses. */
async function chooseType(cell: Locator, type: string): Promise<void> {
	await cell.getByTestId('type-toggle').click();
	await cell.getByTestId(`type-option-${type}`).click();
}

/** Build the lazy editor and replace `cell`'s source. */
async function typeInto(page: Page, cell: Locator, text: string): Promise<void> {
	await cell.getByTestId('editor-scroll').click();
	const editor = cell.locator('.cm-content');
	await expect(editor).toBeVisible();
	await editor.click();
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.type(text);
}

type DiskCell = { id?: string; cell_type?: string; metadata?: { cellar?: { language?: string } } };
const onDisk = (name: string): { cells: DiskCell[] } => JSON.parse(readFileSync(join(workspace, name), 'utf8'));

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available - E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-mojo-e2e-'));
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

test('the type menu creates a mojo cell, badged, with Python-only affordances HIDDEN', async ({ page }) => {
	test.setTimeout(120_000);
	const errors = watchErrors(page);
	await openFresh(page, 'mojo-type.ipynb');
	const cell = cellBy(page, PY_ID);

	await chooseType(cell, 'mojo');
	await expect(cell.getByTestId('mojo-badge')).toBeVisible();
	await expect(cell.getByTestId('type-toggle')).toHaveText(/mojo/);
	// The tooltip carries the one fact a Mojo user must know, because it is
	// Modular's semantics rather than anything Cellar chose.
	await expect(cell.getByTestId('mojo-badge')).toHaveAttribute('title', /complete program/i);
	await expect(cell.getByTestId('mojo-badge')).toHaveAttribute('title', /carry over/i);

	// HIDDEN, not greyed (the raw-cell precedent for per-cell affordances): a
	// permanently-disabled control on every Mojo cell is noise.
	await expect(cell.getByTestId('toggle-export'), 'nbdev export cannot apply to Mojo').toHaveCount(0);
	await cell.getByTestId('cell-actions').click();
	await expect(cell.getByTestId('toggle-imports-role'), 'the imports cell must hold Python').toHaveCount(0);
	// ...but hide-code, which is a report-view choice and DOES apply, is still there.
	await expect(cell.getByTestId('toggle-hide-input')).toBeVisible();
	await page.keyboard.press('Escape');

	// It IS runnable, unlike raw: the Run affordances stay.
	await expect(cell.getByTestId('run')).toBeVisible();
	await expect(cell.getByTestId('clear')).toBeVisible();

	// On disk it is a PLAIN nbformat code cell any Jupyter/nbdev consumer opens.
	await expect
		.poll(() => onDisk('mojo-type.ipynb').cells.find((c) => c.id === PY_ID)?.metadata?.cellar?.language, { timeout: 15_000 })
		.toBe('mojo');
	expect(onDisk('mojo-type.ipynb').cells.find((c) => c.id === PY_ID)?.cell_type).toBe('code');
	expect(errors).toEqual([]);
});

test('a code cell inserted after a mojo cell is a mojo cell, without re-picking', async ({ page }) => {
	test.setTimeout(120_000);
	const errors = watchErrors(page);
	await openFresh(page, 'mojo-inherit.ipynb');
	const cell = cellBy(page, PY_ID);
	await chooseType(cell, 'mojo');
	await expect(cell.getByTestId('mojo-badge')).toBeVisible();

	// (a) the per-cell insert-below button
	await cell.getByTestId('cell-insert-below').click();
	await expect(mojoCards(page)).toHaveCount(2, { timeout: 15_000 });

	// (b) the BOTTOM add row - which appends after the MARKDOWN cell, so it also
	//     proves prose between the cells is SKIPPED rather than stopped at.
	await page.getByTestId('add-cell').click();
	await expect(mojoCards(page)).toHaveCount(3, { timeout: 15_000 });
	await expect(page.locator('[data-testid="cell"]').last().getByTestId('mojo-badge')).toBeVisible();

	// (c) the `b` command-mode shortcut
	await cellBy(page, PY_ID).click();
	await page.keyboard.press('Escape');
	await page.keyboard.press('b');
	await expect(mojoCards(page)).toHaveCount(4, { timeout: 15_000 });

	// Every one of them is a tagged code cell on disk.
	await expect
		.poll(() => onDisk('mojo-inherit.ipynb').cells.filter((c) => c.metadata?.cellar?.language === 'mojo').length, { timeout: 15_000 })
		.toBe(4);
	expect(errors).toEqual([]);
});

test('the common case is unchanged: a code cell after a PYTHON cell is still Python', async ({ page }) => {
	test.setTimeout(120_000);
	await openFresh(page, 'mojo-noregress.ipynb');
	// Nothing converted: the seeded first cell is plain Python.
	await cellBy(page, PY_ID).getByTestId('cell-insert-below').click();
	await page.getByTestId('add-cell').click();
	await expect(page.locator('[data-testid="cell"]')).toHaveCount(4, { timeout: 15_000 });
	await expect(mojoCards(page)).toHaveCount(0);
	// ...and the export toggle, a Python-only affordance, is back on every one of them.
	await expect(page.locator('[data-testid="cell"][data-cell-type="code"] [data-testid="toggle-export"]')).toHaveCount(3);
	await expect
		.poll(() => onDisk('mojo-noregress.ipynb').cells.filter((c) => c.metadata?.cellar?.language).length, { timeout: 15_000 })
		.toBe(0);
});

test('running a mojo cell with no toolchain gives the install command, not a traceback', async ({ page }) => {
	test.setTimeout(180_000);
	const errors = watchErrors(page);
	await openFresh(page, 'mojo-run.ipynb');
	const cell = cellBy(page, PY_ID);
	await chooseType(cell, 'mojo');
	await typeInto(page, cell, 'def main():\n    print("hi")');

	await cell.getByTestId('run').click();
	const output = cell.getByTestId('output');
	await expect(output).toContainText('uv pip install max', { timeout: 120_000 });
	// It says WHY, how big, and that Cellar will not do it for the user.
	await expect(output).toContainText(/534 MB/);
	await expect(output).toContainText(/does not install it for you/i);
	// And it is NOT IPython's opaque answer to an unregistered cell magic.
	await expect(output).not.toContainText('Cell magic function');
	await expect(output).not.toContainText('UsageError');
	expect(errors).toEqual([]);
});

test('a mojo cell shows NO staleness chip, and never goes stale', async ({ page }) => {
	test.setTimeout(180_000);
	await openFresh(page, 'mojo-stale.ipynb');
	const cell = cellBy(page, PY_ID);
	await chooseType(cell, 'mojo');
	// `def main()` is valid Python too - which is exactly what made the probe
	// fabricate `defines: ['main']` before this type existed.
	await typeInto(page, cell, 'def main():\n    print("hi")');
	await cell.getByTestId('run').click();
	await expect(cell.getByTestId('run-meta')).toBeVisible({ timeout: 120_000 });

	// A run that FAILED (no toolchain here) on a Python cell would leave a verdict;
	// a mojo cell has no dataflow at all, so there is nothing to be fresh or stale.
	await expect(cell.getByTestId('stale-badge')).toHaveCount(0);
	await expect(cell.getByTestId('not-run-badge')).toHaveCount(0);
	// Editing it does not stale anything below it either.
	await typeInto(page, cell, 'def main():\n    print("edited")');
	await page.waitForTimeout(2_000);
	await expect(page.getByTestId('stale-badge')).toHaveCount(0);
});
