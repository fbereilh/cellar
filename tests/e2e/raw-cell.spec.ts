import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * An nbformat `raw` cell in the REAL browser, against a REAL kernel.
 *
 * A raw cell is verbatim text a downstream tool reads (Quarto/nbdev frontmatter,
 * nbconvert directives). Cellar used to render one as a Python cell in full -
 * grammar, Run button, output block - because every branch in `Cell.svelte` asked
 * `isMarkdown` and read "not markdown" as "code". So the user could press Run on
 * their frontmatter and post YAML to Python.
 *
 * The captain's requirement, and the reason this spec exists: **a committed raw
 * cell must be completely INERT, exactly like a markdown cell** - shown verbatim,
 * never executed, and never erroring on EITHER run path. The Mod-Enter test is
 * the one that proves it end to end, and it runs the code cell afterwards so a
 * silent no-output result cannot be mistaken for a dead kernel.
 *
 * Needs the real runtime (uv + python3 + host-venv) like the rest of the E2E
 * suite; skips gracefully without it. Cells are addressed by `data-cell-id` /
 * `data-cell-type` rather than by index, since the shipped default windows cells
 * out of the DOM.
 */

const FRONTMATTER = '---\ntitle: Post\nformat: html\n---';
const RAW_ID = 'rawcell00';
const CODE_ID = 'codecell0';

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

const cellBy = (page: Page, id: string) => page.locator(`[data-testid="cell"][data-cell-id="${id}"]`);
const rawCard = (page: Page) => page.locator('[data-testid="cell"][data-cell-type="raw"]');

/** Collect page + console errors, the unambiguous signal that a render threw. */
function watchErrors(page: Page): string[] {
	const errors: string[] = [];
	page.on('pageerror', (err) => errors.push(String(err?.message ?? err)));
	page.on('console', (msg) => {
		if (msg.type() === 'error') errors.push(msg.text());
	});
	return errors;
}

/** The notebook exactly as it sits on disk right now. */
function onDisk(name: string): { cells: Record<string, unknown>[] } {
	return JSON.parse(readFileSync(join(workspace, name), 'utf8'));
}

const diskCell = (name: string, id: string) => onDisk(name).cells.find((c) => c.id === id) as Record<string, unknown>;

/**
 * Write a FRESH notebook per test, under its own name. The tests mutate the
 * document (running the code cell persists its output; the conversion test
 * retypes it), and one shared fixture let a later test pass on state an earlier
 * one had left behind - a run-all assertion that would hold even if run-all did
 * nothing.
 */
function seedFixture(name: string): void {
	writeFileSync(
		join(workspace, name),
		JSON.stringify(
			{
				cells: [
					{ cell_type: 'raw', id: RAW_ID, metadata: {}, source: FRONTMATTER.split('\n').map((l, i, a) => (i < a.length - 1 ? l + '\n' : l)) },
					{
						cell_type: 'code',
						id: CODE_ID,
						metadata: {},
						source: ["print('kernel is live')"],
						outputs: [],
						execution_count: null
					}
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

/** Seed a notebook of this test's own, open it, and hand back its name. */
async function openFresh(page: Page, name: string): Promise<string> {
	seedFixture(name);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await page.locator(`[data-testid="tree-file"][data-path="${name}"]`).click();
	await expect(rawCard(page)).toBeVisible({ timeout: 30_000 });
	return name;
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available - E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-raw-cell-e2e-'));
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

test('renders verbatim, with no execution affordances and no Python highlighting', async ({ page }) => {
	test.setTimeout(120_000);
	const errors = watchErrors(page);
	await openFresh(page, 'raw-render.ipynb');

	const raw = rawCard(page);
	await expect(raw).toContainText('title: Post');
	// The raw badge says the cell is deliberate rather than a code cell that lost
	// its highlighting.
	await expect(raw.getByTestId('raw-badge')).toBeVisible();

	// Nothing execution-shaped: no Run, no Run-above, no Clear, no copy-output, no
	// output block, no cell-actions menu (hide-input / imports / export).
	for (const testid of ['run', 'run-above', 'clear', 'copy-output', 'output', 'cell-actions']) {
		await expect(raw.getByTestId(testid), `raw cell must not offer ${testid}`).toHaveCount(0);
	}
	// Copying the SOURCE is still right - a raw cell has one.
	await expect(raw.getByTestId('copy-input')).toBeVisible();

	// No grammar at all: the static render emits no token spans, while the code
	// cell's does. That contrast is what makes this an assertion about raw rather
	// than about the static path being empty.
	const rawSpans = await raw.locator('[data-testid="static-code"] span').count();
	const codeSpans = await cellBy(page, CODE_ID).locator('[data-testid="static-code"] span').count();
	expect(rawSpans).toBe(0);
	expect(codeSpans).toBeGreaterThan(0);

	expect(errors, `unexpected page/console errors:\n${errors.join('\n')}`).toEqual([]);
});

test('Mod-Enter on a raw cell runs nothing and raises nothing', async ({ page }) => {
	test.setTimeout(180_000);
	const errors = watchErrors(page);
	const nb = await openFresh(page, 'raw-mod-enter.ipynb');

	const raw = rawCard(page);
	await raw.click();
	await page.keyboard.press('ControlOrMeta+Enter');
	// Give a run that should never happen every chance to appear.
	await page.waitForTimeout(2000);

	await expect(raw.getByTestId('output')).toHaveCount(0);
	await expect(raw.getByTestId('run-meta')).toHaveCount(0);
	await expect(raw).toContainText('title: Post');

	// The kernel IS live: the code cell below runs and produces output. Without
	// this, "no output" would also be what a dead kernel looks like.
	const code = cellBy(page, CODE_ID);
	await code.click();
	await page.keyboard.press('ControlOrMeta+Enter');
	await expect(code.getByTestId('output')).toContainText('kernel is live', { timeout: 60_000 });

	// Still nothing on the raw cell, and the .ipynb never gained an outputs key.
	await expect(raw.getByTestId('output')).toHaveCount(0);
	expect(diskCell(nb, RAW_ID).cell_type).toBe('raw');
	expect('outputs' in diskCell(nb, RAW_ID)).toBe(false);

	expect(errors, `unexpected page/console errors:\n${errors.join('\n')}`).toEqual([]);
});

test('Run all skips the raw cell and runs the code cell', async ({ page }) => {
	test.setTimeout(180_000);
	const errors = watchErrors(page);
	const nb = await openFresh(page, 'raw-run-all.ipynb');
	// The fixture is fresh, so the code cell has NO output yet: the assertion below
	// really is about this run-all and not about state a prior test left behind.
	expect(diskCell(nb, CODE_ID).outputs).toEqual([]);

	await page.getByTestId('run-all').click();
	await expect(cellBy(page, CODE_ID).getByTestId('output')).toContainText('kernel is live', { timeout: 60_000 });

	const raw = rawCard(page);
	await expect(raw.getByTestId('output')).toHaveCount(0);
	await expect(raw.getByTestId('run-meta')).toHaveCount(0);

	expect(errors, `unexpected page/console errors:\n${errors.join('\n')}`).toEqual([]);
});

test('converts code -> raw -> code through the type menu, and round-trips on disk', async ({ page }) => {
	test.setTimeout(180_000);
	const errors = watchErrors(page);
	const nb = await openFresh(page, 'raw-convert.ipynb');

	const code = cellBy(page, CODE_ID);
	await expect(code.getByTestId('run')).toBeVisible();

	// -> raw. The toolbar collapses to the raw shape and the type stamps to disk.
	await code.getByTestId('type-toggle').click();
	// Every cell renders its own type menu, so the option MUST be scoped to this
	// cell's card or the locator matches the raw cell's menu too.
	await code.getByTestId('type-option-raw').click();
	await expect(code.getByTestId('raw-badge')).toBeVisible({ timeout: 15_000 });
	await expect(code.getByTestId('run')).toHaveCount(0);
	await expect(code.getByTestId('cell-actions')).toHaveCount(0);
	await expect.poll(() => diskCell(nb, CODE_ID).cell_type, { timeout: 15_000 }).toBe('raw');
	// A raw cell carries neither outputs nor an execution_count on disk.
	expect('outputs' in diskCell(nb, CODE_ID)).toBe(false);
	expect('execution_count' in diskCell(nb, CODE_ID)).toBe(false);

	// -> code. The Run button and the Python highlighting come back.
	await code.getByTestId('type-toggle').click();
	await code.getByTestId('type-option-code').click();
	await expect(code.getByTestId('run')).toBeVisible({ timeout: 15_000 });
	await expect(code.getByTestId('raw-badge')).toHaveCount(0);
	await expect.poll(() => diskCell(nb, CODE_ID).cell_type, { timeout: 15_000 }).toBe('code');
	await expect
		.poll(() => code.locator('[data-testid="static-code"] span').count(), { timeout: 15_000 })
		.toBeGreaterThan(0);

	// The raw cell alongside was untouched throughout.
	expect(diskCell(nb, RAW_ID).cell_type).toBe('raw');

	expect(errors, `unexpected page/console errors:\n${errors.join('\n')}`).toEqual([]);
});
