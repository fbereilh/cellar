import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar, openSidebarSection } from './harness';

/**
 * The Python-only AFFORDANCES a Mojo notebook does not offer, in the REAL browser.
 *
 * Two of the four already answered correctly by construction when the notebook
 * language landed and are pinned in `notebook-language.spec.ts` (the staleness
 * chips, and the imports-role menu item with its greyed stranded-mark exception).
 * This file is the other two, and they are the two the SHELL owns rather than the
 * notebook: the sidebar's VARIABLE INSPECTOR and the palette twin of the toolbar's
 * CONSOLIDATE IMPORTS.
 *
 * Only a real browser can establish the three things that matter here:
 *
 *  1. **A Python notebook is completely unchanged.** Asserted FIRST and again at
 *     the end of the round trip, because it is the case that matters most - the
 *     whole change is a gate, and a gate that reads the wrong way costs a Python
 *     user two affordances with nothing failing.
 *  2. **The switch updates what is shown with NO reload.** These two surfaces live
 *     outside the notebook component, so they only follow if the language really
 *     travels up to the shell - which no unit test can observe.
 *  3. **Which notebook is ACTIVE decides.** The sidebar and the palette are
 *     shell-level and single, so tabbing between a Mojo notebook and a Python one
 *     has to flip them; a per-tab gate that read the wrong notebook would pass
 *     every single-notebook assertion above.
 *
 * Criterion 4 (nothing is stranded) is asserted directly here too rather than
 * left to its own file: the point is that the imports MARK stays clearable on the
 * very notebook where the Consolidate button has just been taken away.
 *
 * Needs the real runtime (uv + python3 + host-venv) like the rest of the E2E
 * suite; skips gracefully without it. Cells are addressed by `data-cell-id`, since
 * the shipped default windows cells out of the DOM.
 */

const PY_ID = 'pycell0000';
const MARKED_ID = 'impcell000';

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

const cellBy = (page: Page, id: string) =>
	page.locator(`[data-testid="cell"][data-cell-id="${id}"]:visible`);
const varsSection = (page: Page) => page.locator('[data-testid="sidebar-section"][data-section="vars"]');
/**
 * Every notebook tab stays MOUNTED (hidden panes keep their editor + run state),
 * and the tab session is server-owned `.cellar/` state that a fresh browser
 * context restores - so a bare testid matches every notebook this file ever
 * opened - and cell ids repeat across notebooks, so even a `data-cell-id` is
 * ambiguous once two are open. `:visible` scopes each notebook-local locator to
 * the pane on screen, which is also exactly the question being asked ("is it
 * OFFERED here?"). The sidebar and the palette are shell-level and single, so
 * they need no scoping.
 */
const consolidateBtn = (page: Page) => page.locator('[data-testid="consolidate-imports"]:visible');
const languageSelect = (page: Page) => page.locator('[data-testid="language-select"]:visible');

/** Collect page + console errors: the unambiguous signal that a render threw. */
function watchErrors(page: Page): string[] {
	const errors: string[] = [];
	page.on('pageerror', (err) => errors.push(String(err?.message ?? err)));
	page.on('console', (msg) => {
		if (msg.type() === 'error') errors.push(msg.text());
	});
	return errors;
}

type SeedCell = { id: string; source: string; cellar?: Record<string, unknown> };

function seed(name: string, cells: SeedCell[] = [{ id: PY_ID, source: "print('hi')" }]): void {
	writeFileSync(
		join(workspace, name),
		JSON.stringify(
			{
				cells: cells.map((c) => ({
					cell_type: 'code',
					id: c.id,
					metadata: c.cellar ? { cellar: c.cellar } : {},
					source: [c.source],
					outputs: [],
					execution_count: null
				})),
				metadata: {},
				nbformat: 4,
				nbformat_minor: 5
			},
			null,
			1
		)
	);
}

/**
 * Open (or focus) a notebook as a PERMANENT tab. A double-click is what promotes
 * it out of the shared preview slot, which is what lets two notebooks be open at
 * once - and on an already-open tab it simply focuses it.
 */
async function openFile(page: Page, name: string, firstCell = PY_ID): Promise<void> {
	await page.locator(`[data-testid="tree-file"][data-path="${name}"]`).dblclick();
	await expect(cellBy(page, firstCell)).toBeVisible({ timeout: 30_000 });
}

async function openFresh(page: Page, name: string, cells?: SeedCell[]): Promise<void> {
	seed(name, cells);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openFile(page, name, cells?.[0].id ?? PY_ID);
}

/** Set the NOTEBOOK's language from the selector at the top - the whole feature. */
async function chooseLanguage(page: Page, language: 'python' | 'mojo'): Promise<void> {
	await languageSelect(page).selectOption(language);
	await expect(page.locator('[data-testid="language-feedback"]:visible')).toContainText(
		language === 'mojo' ? 'Mojo' : 'Python',
		{ timeout: 15_000 }
	);
}

/** Open the palette, read every command title it lists, close it again. */
async function paletteTitles(page: Page): Promise<string[]> {
	await page.keyboard.press('ControlOrMeta+k');
	const palette = page.getByTestId('command-palette');
	await expect(palette).toBeVisible({ timeout: 15_000 });
	const titles = await palette.getByTestId('command-palette-item').allTextContents();
	await page.keyboard.press('Escape');
	await expect(palette).toHaveCount(0);
	return titles.map((t) => t.trim());
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available - E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-mojo-affordances-'));
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

test('a Mojo notebook drops both shell-owned affordances, and a switch restores them with no reload', async ({
	page
}) => {
	test.setTimeout(180_000);
	const errors = watchErrors(page);
	await openFresh(page, 'aff-switch.ipynb');
	await openSidebarSection(page, 'vars', 'vars-body');

	// (1) THE CASE THAT MATTERS MOST: a Python notebook is exactly as it was.
	await expect(varsSection(page)).toBeVisible();
	await expect(consolidateBtn(page)).toBeVisible();
	expect(await paletteTitles(page)).toContain('Consolidate imports');

	// (2) The switch alone takes both away - no reload, no second interaction. This
	// tab suppresses its own `notebook:language` echo, so nothing else would.
	await chooseLanguage(page, 'mojo');
	await expect(varsSection(page)).toHaveCount(0, { timeout: 15_000 });
	await expect(consolidateBtn(page)).toHaveCount(0);
	expect(await paletteTitles(page)).not.toContain('Consolidate imports');
	// Hidden, not merely emptied: the Variables HEADER goes too, so the sidebar does
	// not carry a section that can never say anything.
	await expect(page.getByTestId('section-vars')).toHaveCount(0);
	// The rest of the sidebar is untouched - this is one section, not a purge.
	await expect(page.locator('[data-testid="sidebar-section"][data-section="files"]')).toBeVisible();
	await expect(page.locator('[data-testid="sidebar-section"][data-section="search"]')).toBeVisible();
	// ...and the toolbar keeps its other three buttons.
	await expect(page.getByTestId('run-all')).toBeVisible();
	await expect(page.getByTestId('interrupt-all')).toBeVisible();
	await expect(page.getByTestId('clear-all-outputs')).toBeVisible();

	// (3) Switching BACK restores both, in place - the persisted section ORDER was
	// never rewritten, so Variables returns between History and Search.
	await chooseLanguage(page, 'python');
	await expect(varsSection(page)).toBeVisible({ timeout: 15_000 });
	await expect(consolidateBtn(page)).toBeVisible();
	expect(await paletteTitles(page)).toContain('Consolidate imports');
	const order = await page.locator('[data-testid="sidebar-section"]').evaluateAll((els) =>
		els.map((e) => e.getAttribute('data-section'))
	);
	expect(order.indexOf('vars')).toBe(order.indexOf('history') + 1);
	expect(order.indexOf('search')).toBe(order.indexOf('vars') + 1);

	expect(errors.filter((e) => !/Failed to load resource/.test(e))).toEqual([]);
});

test('the ACTIVE notebook decides: tabbing between a Mojo and a Python notebook flips both', async ({
	page
}) => {
	test.setTimeout(180_000);
	const errors = watchErrors(page);
	// The sidebar and the palette are shell-level and SINGLE, so a gate that read
	// the wrong notebook would still pass every assertion in the test above.
	// BOTH seeded before the page loads, so the tree lists them without a refresh.
	seed('aff-python.ipynb');
	await openFresh(page, 'aff-mojo.ipynb');
	await openSidebarSection(page, 'vars', 'vars-body');
	await chooseLanguage(page, 'mojo');
	await expect(varsSection(page)).toHaveCount(0, { timeout: 15_000 });

	await openFile(page, 'aff-python.ipynb');
	await expect(languageSelect(page)).toHaveValue('python', { timeout: 30_000 });
	// The Python notebook is now active, so both come back with no language change
	// at all - the shell followed the TAB.
	await expect(varsSection(page)).toBeVisible({ timeout: 15_000 });
	await expect(consolidateBtn(page)).toHaveCount(1);
	expect(await paletteTitles(page)).toContain('Consolidate imports');

	// ...and tabbing back to the Mojo notebook takes them away again.
	await openFile(page, 'aff-mojo.ipynb');
	await expect(languageSelect(page)).toHaveValue('mojo', { timeout: 15_000 });
	await expect(varsSection(page)).toHaveCount(0, { timeout: 15_000 });
	expect(await paletteTitles(page)).not.toContain('Consolidate imports');

	expect(errors.filter((e) => !/Failed to load resource/.test(e))).toEqual([]);
});

test('a plain FILE tab keeps both: the gate only trusts a language while a NOTEBOOK tab is active', async ({
	page
}) => {
	test.setTimeout(180_000);
	const errors = watchErrors(page);
	// The shell's `activeNotebookPath` falls back to the CANONICAL notebook whenever a
	// plain file tab holds focus, but these two affordances answer about the SERVER's
	// active notebook - which stays on the last-focused one. So a MOJO canonical
	// notebook must not take the inspector away from a live PYTHON namespace: that is
	// the fail-CLOSED direction, and it costs a Python user an affordance with nothing
	// failing, which is precisely why it needs a browser to catch.
	writeFileSync(join(workspace, 'aff-notes.md'), '# notes\n');
	seed('aff-live.ipynb');
	await openFresh(page, 'notebook.ipynb');
	await openSidebarSection(page, 'vars', 'vars-body');
	await chooseLanguage(page, 'mojo');
	await expect(varsSection(page)).toHaveCount(0, { timeout: 15_000 });

	// A PYTHON notebook is now the active one, so both come back...
	await openFile(page, 'aff-live.ipynb');
	await expect(languageSelect(page)).toHaveValue('python', { timeout: 30_000 });
	await expect(varsSection(page)).toBeVisible({ timeout: 15_000 });

	// ...and focusing a plain FILE tab must not hand the gate to the canonical Mojo
	// notebook: nothing about the kernel being inspected changed.
	await page.locator('[data-testid="tree-file"][data-path="aff-notes.md"]').click();
	await expect(page.locator('[data-testid="file-view-source"]:visible')).toBeVisible({
		timeout: 30_000
	});
	await expect(varsSection(page)).toBeVisible({ timeout: 15_000 });
	expect(await paletteTitles(page)).toContain('Consolidate imports');

	expect(errors.filter((e) => !/Failed to load resource/.test(e))).toEqual([]);
});

test('taking Consolidate away strands nothing: a kept imports mark is still clearable', async ({
	page
}) => {
	test.setTimeout(180_000);
	const errors = watchErrors(page);
	// A language switch writes to NO cell, so a mark made while the notebook was
	// Python survives it. That is the one piece of state any of these four
	// affordances leaves behind, and it is why the ⋮ item is greyed rather than
	// hidden while the toolbar button beside it is hidden outright.
	const name = 'aff-stranded.ipynb';
	await openFresh(page, name, [
		{ id: MARKED_ID, source: 'import os', cellar: { role: 'imports' } },
		{ id: PY_ID, source: "print('hi')" }
	]);
	const marked = cellBy(page, MARKED_ID);
	await expect(marked.getByTestId('imports-badge')).toBeVisible();

	await chooseLanguage(page, 'mojo');
	// The sweep that CREATES this state is gone...
	await expect(consolidateBtn(page)).toHaveCount(0, { timeout: 15_000 });
	// ...while the state it left behind is still on screen and still reachable.
	await expect(marked.getByTestId('imports-badge')).toBeVisible();
	await marked.getByTestId('cell-actions').click();
	const item = marked.getByTestId('toggle-imports-role');
	await expect(item).toBeVisible();
	await expect(item).toHaveAttribute('data-imports-stranded', 'true');
	await item.click();

	await expect(marked.getByTestId('imports-badge')).toHaveCount(0);
	// It really left the user's committed file - a badge that merely stopped
	// rendering would leave the key behind.
	await expect
		.poll(
			() => {
				const doc = JSON.parse(readFileSync(join(workspace, name), 'utf8')) as {
					cells: Array<{ id?: string; metadata?: { cellar?: { role?: string } } }>;
				};
				return doc.cells.find((c) => c.id === MARKED_ID)?.metadata?.cellar?.role;
			},
			{ timeout: 15_000 }
		)
		.toBeUndefined();

	expect(errors.filter((e) => !/Failed to load resource/.test(e))).toEqual([]);
});
