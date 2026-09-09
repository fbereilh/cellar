import { test, expect, type Page, type Locator } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * The NOTEBOOK LANGUAGE SELECTOR in the REAL browser, against a REAL kernel.
 *
 * A notebook is Python or Mojo and never both, chosen once at the top - so the
 * things only a real run can establish are all about that ONE control:
 *
 *  1. **A new notebook is Python, and its metadata says nothing.** The default
 *     costs no key in the committed `.ipynb`, which is what makes "no migration"
 *     true at the file level.
 *  2. **Flipping to Mojo makes every code cell run as Mojo** - the badge says so,
 *     the run really takes the `%%mojo` path (below), and the switch touches NO
 *     cell, so markdown, raw, SQL and chat cells are untouched.
 *  3. **Flipping BACK leaves nothing stale** - the key is deleted rather than set
 *     to `python`, so the file returns to what it was.
 *  4. **With no toolchain a Mojo run gives an INSTRUCTION, not a traceback and not
 *     a 534 MB surprise install.** The e2e workspace has no `max` (Cellar never
 *     installs it), so this is the path every first-time user meets - and it is
 *     ALSO the deterministic proof that the run took the Mojo path: the same
 *     source, run before the flip, is executed as ordinary Python.
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

/** Set the NOTEBOOK's language from the selector at the top - the whole feature. */
async function chooseLanguage(page: Page, language: 'python' | 'mojo'): Promise<void> {
	await page.getByTestId('language-select').selectOption(language);
	await expect(page.getByTestId('language-feedback')).toContainText(
		language === 'mojo' ? 'Mojo' : 'Python',
		{ timeout: 15_000 }
	);
}

/** The notebook-level `cellar` metadata as it stands ON DISK. */
const nbMeta = (name: string): Record<string, unknown> =>
	(JSON.parse(readFileSync(join(workspace, name), 'utf8')).metadata?.cellar ?? {}) as Record<string, unknown>;

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

test('a NEW notebook is Python, and its metadata says nothing', async ({ page }) => {
	test.setTimeout(120_000);
	const errors = watchErrors(page);
	await openFresh(page, 'lang-default.ipynb');

	// The selector is standing chrome on every `.ipynb` - the one place that says
	// what the notebook is - and it starts on Python.
	await expect(page.getByTestId('language-bar')).toBeVisible();
	await expect(page.getByTestId('language-select')).toHaveValue('python');
	// ...and the default costs NO key in the committed file. That is what makes
	// "no migration" true rather than merely intended.
	expect(nbMeta('lang-default.ipynb').language).toBeUndefined();
	// Every Python affordance is exactly where it was: the export toggle, the
	// imports role, and no Mojo badge anywhere.
	const cell = cellBy(page, PY_ID);
	await expect(cell.getByTestId('toggle-export')).toBeVisible();
	await expect(mojoCards(page)).toHaveCount(0);
	expect(errors).toEqual([]);
});

test('flipping the selector to Mojo makes every code cell a Mojo cell', async ({ page }) => {
	test.setTimeout(120_000);
	const errors = watchErrors(page);
	await openFresh(page, 'lang-flip.ipynb');
	const cell = cellBy(page, PY_ID);

	await chooseLanguage(page, 'mojo');
	await expect(cell.getByTestId('mojo-badge')).toBeVisible();
	await expect(cell.getByTestId('type-toggle')).toHaveText(/mojo/);
	// The tooltip carries the one fact a Mojo user must know, because it is
	// Modular's semantics rather than anything Cellar chose.
	await expect(cell.getByTestId('mojo-badge')).toHaveAttribute('title', /complete program/i);
	await expect(cell.getByTestId('mojo-badge')).toHaveAttribute('title', /carry over/i);

	// It IS runnable, unlike raw: the Run affordances stay.
	await expect(cell.getByTestId('run')).toBeVisible();
	await expect(cell.getByTestId('clear')).toBeVisible();
	// ...and the one Python-only per-cell affordance that would be a DEAD control
	// here is withheld: the imports cell is run by the PYTHON kernel, so the role
	// can do nothing on a Mojo notebook. The export toggle stays, because a Mojo
	// notebook's code cells ARE the eligible kind for its `.mojo` module.
	await cell.getByTestId('cell-actions').click();
	await expect(cell.getByTestId('toggle-imports-role')).toHaveCount(0);
	await expect(cell.getByTestId('toggle-hide-input')).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(cell.getByTestId('toggle-export')).toBeVisible();

	// ONE notebook-level key on disk, and NOT ONE CELL touched - which is what makes
	// switching cost nothing to undo.
	await expect.poll(() => nbMeta('lang-flip.ipynb').language, { timeout: 15_000 }).toBe('mojo');
	expect(onDisk('lang-flip.ipynb').cells.every((c) => !c.metadata?.cellar?.language)).toBe(true);
	expect(onDisk('lang-flip.ipynb').cells.find((c) => c.id === PY_ID)?.cell_type).toBe('code');

	// A cell added afterwards is Mojo too, with no per-cell choice to make.
	await page.getByTestId('add-cell').click();
	await expect(mojoCards(page)).toHaveCount(2, { timeout: 15_000 });
	expect(errors).toEqual([]);
});

test('markdown and raw cells are untouched by the selector', async ({ page }) => {
	test.setTimeout(120_000);
	const errors = watchErrors(page);
	await openFresh(page, 'lang-others.ipynb');
	// A code cell to compare against, then turn the seeded Python cell into a RAW one
	// so both nbformat types the language must not touch are on screen. Addressed by
	// id throughout: the shipped default windows cells out of the DOM, so `.last()`
	// names whichever cell happens to be mounted.
	await page.getByTestId('add-cell').click();
	await expect(page.locator('[data-testid="cell"]')).toHaveCount(3, { timeout: 15_000 });
	await chooseType(cellBy(page, PY_ID), 'raw');
	await expect(cellBy(page, PY_ID).getByTestId('raw-badge')).toBeVisible();

	await chooseLanguage(page, 'mojo');

	// Neither the raw nor the markdown cell gains a badge, becomes runnable, or
	// reports Mojo - while the CODE cell beside them does, so this is not a test that
	// would pass over a selector that does nothing.
	await expect(mojoCards(page)).toHaveCount(1, { timeout: 15_000 });
	await expect(cellBy(page, MD_ID).getByTestId('mojo-badge')).toHaveCount(0);
	await expect(cellBy(page, PY_ID).getByTestId('mojo-badge')).toHaveCount(0);
	await expect(cellBy(page, PY_ID).getByTestId('raw-badge')).toBeVisible();
	await expect(cellBy(page, PY_ID).getByTestId('run')).toHaveCount(0);
	// On disk they are exactly the cells they were.
	await expect.poll(() => nbMeta('lang-others.ipynb').language, { timeout: 15_000 }).toBe('mojo');
	const cells = onDisk('lang-others.ipynb').cells;
	expect(cells.find((c) => c.id === MD_ID)?.cell_type).toBe('markdown');
	expect(cells.find((c) => c.id === PY_ID)?.cell_type).toBe('raw');
	expect(cells.every((c) => !c.metadata?.cellar?.language)).toBe(true);
	expect(errors).toEqual([]);
});

test('flipping BACK to Python leaves nothing stale', async ({ page }) => {
	test.setTimeout(120_000);
	const errors = watchErrors(page);
	await openFresh(page, 'lang-back.ipynb');
	const cell = cellBy(page, PY_ID);

	await chooseLanguage(page, 'mojo');
	await expect.poll(() => nbMeta('lang-back.ipynb').language, { timeout: 15_000 }).toBe('mojo');

	await chooseLanguage(page, 'python');
	// The key is DELETED rather than set to `python`: absence is the one spelling of
	// the default, so the file goes back to what a notebook that never switched has.
	await expect.poll(() => nbMeta('lang-back.ipynb').language, { timeout: 15_000 }).toBeUndefined();
	await expect(cell.getByTestId('mojo-badge')).toHaveCount(0);
	await expect(cell.getByTestId('type-toggle')).toHaveText(/python3/);
	// The Python affordances are back, and no cell carries a leftover tag.
	await expect(cell.getByTestId('toggle-export')).toBeVisible();
	expect(onDisk('lang-back.ipynb').cells.every((c) => !c.metadata?.cellar?.language)).toBe(true);
	expect(errors).toEqual([]);
});

test('the language SURVIVES a reload, which is what makes it a setting', async ({ page }) => {
	test.setTimeout(120_000);
	await openFresh(page, 'lang-reload.ipynb');
	await chooseLanguage(page, 'mojo');
	await expect.poll(() => nbMeta('lang-reload.ipynb').language, { timeout: 15_000 }).toBe('mojo');

	await page.reload();
	await page.locator('[data-testid="tree-file"][data-path="lang-reload.ipynb"]').click();
	await expect(cellBy(page, PY_ID)).toBeVisible({ timeout: 30_000 });
	await expect(page.getByTestId('language-select')).toHaveValue('mojo');
	await expect(cellBy(page, PY_ID).getByTestId('mojo-badge')).toBeVisible();
});

test('the export target FOLLOWS the language, so the two can never disagree', async ({ page }) => {
	test.setTimeout(120_000);
	const errors = watchErrors(page);
	await openFresh(page, 'lang-export.ipynb');

	const target = page.getByTestId('export-target-input');
	await target.fill('lib/utils.py');
	await target.blur();
	await expect.poll(() => nbMeta('lang-export.ipynb').export_target, { timeout: 15_000 }).toBe('lib/utils.py');

	// Switching the notebook re-extensions the stored target: the module is written
	// in the notebook's language, so its file has to name that language.
	await chooseLanguage(page, 'mojo');
	await expect.poll(() => nbMeta('lang-export.ipynb').export_target, { timeout: 15_000 }).toBe('lib/utils.mojo');
	await expect(target).toHaveValue('lib/utils.mojo');
	await expect(page.getByTestId('export-run')).toHaveText(/\.mojo/);

	// ...and a path in the OTHER language is refused rather than silently stored,
	// which is the other half of "no second setting that can contradict".
	await target.fill('lib/utils.py');
	await target.blur();
	await expect(page.getByTestId('app-notice')).toContainText(/language is Mojo/i, { timeout: 15_000 });
	expect(nbMeta('lang-export.ipynb').export_target).toBe('lib/utils.mojo');
	// This test DELIBERATELY provokes a refusal, and the browser logs every 4xx to
	// the console - so a blanket "no console errors" assertion would fail for the one
	// thing the test is proving. Assert what a render throw would leave instead: no
	// page error, and no cell absorbed by the per-cell error boundary.
	expect(errors.filter((e) => !/Failed to load resource/.test(e))).toEqual([]);
	await expect(page.getByTestId('cell-render-error')).toHaveCount(0);
});

test('a cell RUNS as Python before the flip and as Mojo after it', async ({ page }) => {
	test.setTimeout(240_000);
	const errors = watchErrors(page);
	await openFresh(page, 'lang-run.ipynb');
	const cell = cellBy(page, PY_ID);
	// One line, so CodeMirror's auto-indent cannot mangle it on the way in - and
	// nothing about this source says which language it is, which is exactly why the
	// NOTEBOOK has to decide.
	await typeInto(page, cell, 'print("hi")');

	// PYTHON: the kernel runs it and prints.
	await cell.getByTestId('run').click();
	await expect(cell.getByTestId('output')).toContainText('hi', { timeout: 120_000 });

	// MOJO: the same source now takes the `%%mojo` path, which this workspace has no
	// toolchain for - so the user gets the INSTALL COMMAND rather than a traceback,
	// and that instruction IS the deterministic proof the run went the Mojo way.
	await chooseLanguage(page, 'mojo');
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

test('a Mojo notebook shows NO staleness chip, and never goes stale', async ({ page }) => {
	test.setTimeout(180_000);
	await openFresh(page, 'lang-stale.ipynb');
	const cell = cellBy(page, PY_ID);

	// FIRST make the notebook produce a verdict as PYTHON: run the cell, then edit it
	// so it goes visibly stale. Flipping the language must then clear that chip
	// WITHOUT any further interaction - this tab suppresses its own `notebook:language`
	// echo, so nothing else would recompute the verdicts.
	await typeInto(page, cell, 'x = 1');
	await cell.getByTestId('run').click();
	await expect(cell.getByTestId('run-meta')).toBeVisible({ timeout: 120_000 });
	await typeInto(page, cell, 'x = 2');
	await expect(cell.getByTestId('stale-badge')).toBeVisible({ timeout: 30_000 });

	await chooseLanguage(page, 'mojo');
	await expect(cell.getByTestId('stale-badge')).toHaveCount(0, { timeout: 30_000 });
	// `def main()` is valid Python too - which is exactly what made the probe
	// fabricate `defines: ['main']` before the language axis existed.
	await typeInto(page, cell, 'def main():\n    print("hi")');
	await cell.getByTestId('run').click();
	await expect(cell.getByTestId('run-meta')).toBeVisible({ timeout: 120_000 });

	// A run that FAILED (no toolchain here) in a PYTHON notebook would leave a
	// verdict; a Mojo notebook has no Python dataflow at all, so there is nothing to
	// be fresh or stale.
	await expect(cell.getByTestId('stale-badge')).toHaveCount(0);
	await expect(cell.getByTestId('not-run-badge')).toHaveCount(0);
	// Editing it does not stale anything below it either.
	await typeInto(page, cell, 'def main():\n    print("edited")');
	await page.waitForTimeout(2_000);
	await expect(page.getByTestId('stale-badge')).toHaveCount(0);
});

test('a .py TEXT notebook offers no selector - it can only ever be Python', async ({ page }) => {
	test.setTimeout(120_000);
	// Such a document is rebuilt from its cells on save and stores no notebook
	// metadata, so a control offering Mojo would be refused on click.
	writeFileSync(
		join(workspace, 'text-nb.py'),
		'# Databricks notebook source\nprint(1)\n\n# COMMAND ----------\n\nprint(2)\n'
	);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await page.locator('[data-testid="tree-file"][data-path="text-nb.py"]').click();
	await expect(page.locator('[data-testid="cell"]').first()).toBeVisible({ timeout: 30_000 });
	await expect(page.getByTestId('language-bar')).toHaveCount(0);
	await expect(page.getByTestId('language-select')).toHaveCount(0);
});
