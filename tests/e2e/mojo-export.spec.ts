import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * A notebook whose export target is `.mojo` exports its Mojo cells to one module,
 * AND SAYS ON THE CELL which `main` blocks it is dropping.
 *
 * The per-cell warning is the half only a browser can prove. A Mojo module can
 * define `main` once (measured against Mojo 1.0.0: two is
 * `redefinition of function 'main'`), so the LAST exported cell that defines one
 * keeps it and the earlier blocks are dropped - which discards code the user
 * wrote. The user has to see that WHILE EDITING, on the cell, not only after
 * opening the generated file, so this spec drives the badge the way a person
 * would: mark cells, watch a badge appear when a later cell gains a `main`, and
 * watch it clear when that `main` goes away.
 *
 * No Mojo toolchain is needed or used: nothing here RUNS a Mojo cell. That the
 * generated module really compiles, runs and imports is pinned against a real
 * `mojo` in `tests/unit/mojo-export.test.ts`'s gated tier.
 */

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

const MAIN = 'def main():\n    print("hi")';
const HELPER = 'def helper() -> Int:\n    return 1';

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available - E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-e2e-mojo-export-'));
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

const readModule = (rel: string) => (existsSync(join(workspace, rel)) ? readFileSync(join(workspace, rel), 'utf8') : null);

/**
 * Build a notebook of Mojo cells with a `.mojo` target, every cell marked.
 *
 * The target is named BEFORE the cells are marked, deliberately: eligibility is a
 * language MATCH, so a Mojo cell can only be marked once the notebook names a
 * `.mojo` module for the marks to describe.
 */
async function mojoNotebook(api: APIRequestContext, rel: string, sources: string[], target: string): Promise<string[]> {
	const created = await api.post(`${baseURL}/api/notebooks`, { data: { path: rel, create: true } });
	expect(created.ok(), await created.text()).toBeTruthy();

	const set = await api.post(`${baseURL}/api/notebooks/export-py`, {
		data: { op: 'set-target', target, base: 'workspace', path: rel }
	});
	expect(set.ok(), await set.text()).toBeTruthy();

	const view = await api.get(`${baseURL}/api/notebooks?path=${encodeURIComponent(rel)}`);
	const ids = ((await view.json()).notebook.cells as Array<{ id: string }>).map((c) => c.id);
	// The starter notebook holds ONE empty cell; add the rest after it.
	for (let i = 1; i < sources.length; i++) {
		const added = await api.post(`${baseURL}/api/cells`, {
			data: { afterId: ids[ids.length - 1], cellType: 'mojo', source: sources[i], nb: rel }
		});
		expect(added.ok(), await added.text()).toBeTruthy();
		ids.push((await added.json()).cell.id as string);
	}
	for (const [i, id] of ids.entries()) {
		// The TYPE lands first because eligibility is a language MATCH: under a `.mojo`
		// target the server refuses a mark on an untagged code cell, which the starter
		// notebook's first cell still is. Conversion itself KEEPS an existing mark.
		const patched = await api.patch(`${baseURL}/api/cells/${id}`, {
			data: { cell_type: 'mojo', source: sources[i], nb: rel }
		});
		expect(patched.ok(), await patched.text()).toBeTruthy();
		const marked = await api.patch(`${baseURL}/api/cells/${id}`, { data: { export: true, nb: rel } });
		expect(marked.ok(), await marked.text()).toBeTruthy();
	}
	return ids;
}

async function openNotebook(page: Page, rel: string): Promise<void> {
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	// Settle before probing: the shell paints either the empty state or an
	// already-open notebook (the openNotebook-helper rule from AGENTS.md).
	// Every open notebook stays MOUNTED (hidden), so even the settle probe has to be
	// `:visible`-scoped: `getByTestId('cell').first()` can resolve to a cell in a
	// BACKGROUND pane, which is never visible and never will be.
	const openBtn = page.locator('[data-testid="empty-open-notebook"]:visible');
	const cell = page.locator('[data-testid="cell"]:visible').first();
	await expect(openBtn.or(cell)).toBeVisible();
	if (await openBtn.isVisible()) await openBtn.click();
	await expect(cell).toBeVisible();
	if (rel !== 'notebook.ipynb') {
		await page.getByText(rel).first().dblclick();
	}
	// Per-CELL locators are addressed by cell id instead, which is unique across the
	// mounted set.
	await expect(page.locator('[data-testid="export-bar"]:visible')).toBeVisible();
}

const badgeIn = (page: Page, id: string) =>
	page.locator(`[data-cell-id="${id}"]`).getByTestId('main-dropped-badge');

/** Replace a cell's whole source by hand, the way a user would. */
async function retype(page: Page, card: Locator, source: string): Promise<void> {
	await card.click();
	const editor = card.locator('.cm-content');
	await expect(editor).toBeVisible();
	await editor.click();
	await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
	await page.keyboard.type(source);
}

test('the warning names every cell losing its main, and never the last one', async ({ page, request }) => {
	const ids = await mojoNotebook(request, 'notebook.ipynb', [MAIN, HELPER, MAIN], 'lib/vec.mojo');
	await openNotebook(page, 'notebook.ipynb');

	// The button names the file it writes, so it tracks the target's language.
	await expect(page.locator('[data-testid="export-run"]:visible')).toHaveText('Export to .mojo');

	// Cell 0 loses its main to cell 2; cell 1 never had one; cell 2 keeps it.
	await expect(badgeIn(page, ids[0])).toBeVisible();
	await expect(badgeIn(page, ids[0])).toHaveText(/main not exported/);
	// The WHY rides the title, the stale chip's split - and it must name both halves.
	await expect(badgeIn(page, ids[0])).toHaveAttribute('title', /not exported/);
	await expect(badgeIn(page, ids[0])).toHaveAttribute('title', /later exported cell/);
	await expect(badgeIn(page, ids[1])).toHaveCount(0);
	await expect(badgeIn(page, ids[2])).toHaveCount(0);

	// ONE notebook-level finding is rendered: the code the export DISCARDED. It may
	// not read as "will not compile" - dropping the main is what makes the module
	// valid. The kept-main finding is agent-only and may not appear here: it fires on
	// the commonest shape a `.mojo` export has, so as standing chrome it was
	// permanent (`$lib/exportHazard`).
	const hazards = page.locator('[data-testid="export-hazard"]:visible');
	await expect(hazards).toHaveCount(1);
	await expect(hazards.nth(0)).toHaveText(/lost a top-level def main/);
	await expect(hazards.nth(0)).not.toHaveText(/will not import/);
	await expect(hazards.nth(0)).not.toHaveText(/NO PYTHON CELL CAN IMPORT IT/);

	// ...and the module on disk matches what the badges said.
	await page.locator('[data-testid="export-run"]:visible').click();
	await expect.poll(() => readModule('lib/vec.mojo')).toContain('def main():');
	const text = readModule('lib/vec.mojo')!;
	expect(text).not.toContain('__all__');
	expect(text).not.toContain('%%mojo');
	expect(text.match(/^def main\(/gm)).toHaveLength(1);
	expect(text).toContain('was NOT exported');
});

test('the warning appears and clears as the user edits a LATER cell', async ({ page, request }) => {
	const ids = await mojoNotebook(request, 'edits.ipynb', [MAIN, HELPER], 'lib/edits.mojo');
	await openNotebook(page, 'edits.ipynb');

	// One main in the notebook: nothing is dropped, so nothing warns.
	await expect(badgeIn(page, ids[0])).toHaveCount(0);

	// Type a `main` into the LATER cell. The first cell's main now loses, and the
	// badge has to appear while the user is still editing - not after an export.
	// The click on the CARD is what summons the editor (cells render a static
	// stand-in until then); the second puts the caret in it, since typing in
	// command mode would drive the modal keyboard instead.
	const later = page.locator(`[data-cell-id="${ids[1]}"]`);
	await retype(page, later, 'def main():\n    print(2)');
	await expect(badgeIn(page, ids[0])).toBeVisible();
	// The cell that now OWNS main never warns about itself.
	await expect(badgeIn(page, ids[1])).toHaveCount(0);

	// Take the later main away again and the warning clears.
	await retype(page, later, 'def other() -> Int:\n    return 2');
	await expect(badgeIn(page, ids[0])).toHaveCount(0);
	// Nothing is dropped now, so the bar carries NOTHING: the kept-main finding is
	// agent-only, and an ordinary Mojo export must not look like it went wrong.
	await expect(page.locator('[data-testid="export-hazard"]:visible')).toHaveCount(0);
});

test('a .py target shows no Mojo warning and takes no Mojo cell', async ({ page, request }) => {
	// The same three cells under a `.py` target: a Mojo cell is not eligible, so
	// none is marked, nothing is dropped and nothing warns.
	const rel = 'pytarget.ipynb';
	const created = await request.post(`${baseURL}/api/notebooks`, { data: { path: rel, create: true } });
	expect(created.ok(), await created.text()).toBeTruthy();
	const set = await request.post(`${baseURL}/api/notebooks/export-py`, {
		data: { op: 'set-target', target: 'lib/py.py', base: 'workspace', path: rel }
	});
	expect(set.ok(), await set.text()).toBeTruthy();
	const view = await request.get(`${baseURL}/api/notebooks?path=${encodeURIComponent(rel)}`);
	const id = ((await view.json()).notebook.cells as Array<{ id: string }>)[0].id;
	await request.patch(`${baseURL}/api/cells/${id}`, { data: { source: MAIN, cell_type: 'mojo', nb: rel } });
	// The server REFUSES the mark - a Mojo cell has no place in a `.py` module - and
	// the flag simply never lands. The route reports `not-code` SILENTLY (a
	// deliberate, pre-existing scope decision documented at the PATCH handler), so
	// the observable is the OUTCOME rather than the status.
	const marked = await request.patch(`${baseURL}/api/cells/${id}`, { data: { export: true, nb: rel } });
	expect(marked.ok(), await marked.text()).toBeTruthy();
	const after = await request.get(`${baseURL}/api/notebooks?path=${encodeURIComponent(rel)}`);
	const cells = (await after.json()).notebook.cells as Array<{ metadata?: { cellar?: { export?: boolean } } }>;
	expect(cells[0].metadata?.cellar?.export).toBeUndefined();

	await openNotebook(page, rel);
	await expect(page.locator('[data-testid="export-run"]:visible')).toHaveText('Export to .py');
	await expect(page.locator('[data-testid="export-count"]:visible')).toHaveText('0 cells marked');
	await expect(page.locator('[data-testid="main-dropped-badge"]:visible')).toHaveCount(0);
	// ...and the toggle is not even offered on a cell that cannot reach this module
	// AND carries no flag to clear: there is no state for it to show.
	await expect(page.locator(`[data-cell-id="${id}"]`).getByTestId('toggle-export')).toHaveCount(0);
});

test('the export toggle names the target language, and a stranded mark stays clearable', async ({
	page,
	request
}) => {
	// A Mojo notebook: the toggle must announce the module it really writes. A
	// hardcoded ".py" here is a false statement in the accessible NAME, in exactly
	// the place the feature is used.
	const ids = await mojoNotebook(request, 'labels.ipynb', [HELPER], 'lib/labels.mojo');
	await openNotebook(page, 'labels.ipynb');
	const toggle = page.locator(`[data-cell-id="${ids[0]}"]`).getByTestId('toggle-export');
	await expect(toggle).toHaveAttribute('aria-label', "Export this cell to the notebook's .mojo module");
	await expect(toggle).toHaveAttribute('title', /\.mojo module/);
	await expect(toggle).toHaveAttribute('aria-pressed', 'true');
	await expect(toggle).not.toHaveAttribute('data-export-stranded', 'true');

	// Repoint the target at a `.py` module. Nothing rewrites the notebook, so the
	// Mojo cell keeps a flag it is now eligible for nowhere - and that key would be
	// invisible if the toggle were simply omitted.
	const repoint = await request.post(`${baseURL}/api/notebooks/export-py`, {
		data: { op: 'set-target', target: 'lib/labels.py', base: 'workspace', path: 'labels.ipynb' }
	});
	expect(repoint.ok(), await repoint.text()).toBeTruthy();
	await page.reload();
	await openNotebook(page, 'labels.ipynb');

	const stranded = page.locator(`[data-cell-id="${ids[0]}"]`).getByTestId('toggle-export');
	await expect(stranded).toHaveAttribute('data-export-stranded', 'true');
	await expect(stranded).toHaveAttribute('aria-label', "Clear this cell's stale export mark");
	// The CELL carries a short marker, and the reason is stated ONCE for the notebook
	// in the export bar - not repeated on every previously marked cell.
	const badge = page.locator(`[data-cell-id="${ids[0]}"]`).getByTestId('export-stranded-badge');
	await expect(badge).toBeVisible();
	await expect(badge).toHaveText('not exported');
	const bar = page.locator('[data-testid="export-stranded"]:visible');
	await expect(bar).toHaveCount(1);
	await expect(bar).toHaveText(/1 cell is marked for export/);
	await expect(bar).toHaveText(/\.py module/);
	await expect(page.locator('[data-testid="export-count"]:visible')).toHaveText('0 cells marked');

	// CLEARING the target is a different fact and may not be worded as the first: the
	// notebook then targets nothing, so nothing may name a `.py` module.
	const cleared = await request.post(`${baseURL}/api/notebooks/export-py`, {
		data: { op: 'set-target', target: '', base: 'workspace', path: 'labels.ipynb' }
	});
	expect(cleared.ok(), await cleared.text()).toBeTruthy();
	await page.reload();
	await openNotebook(page, 'labels.ipynb');
	const noTarget = page.locator('[data-testid="export-stranded"]:visible');
	await expect(noTarget).toHaveText(/no target module/);
	await expect(noTarget).not.toHaveText(/\.py/);
	await expect(page.locator(`[data-cell-id="${ids[0]}"]`).getByTestId('export-stranded-badge')).toBeVisible();

	// Clicking it CLEARS the flag rather than trying to re-mark a cell the server
	// refuses: the toggle and its note go, and the key leaves the notebook.
	await page.locator(`[data-cell-id="${ids[0]}"]`).getByTestId('toggle-export').click();
	await expect(page.locator('[data-testid="export-stranded"]:visible')).toHaveCount(0);
	await expect(page.locator(`[data-cell-id="${ids[0]}"]`).getByTestId('toggle-export')).toHaveCount(0);
	await expect
		.poll(async () => {
			const r = await request.get(`${baseURL}/api/notebooks?path=labels.ipynb`);
			const cells = (await r.json()).notebook.cells as Array<{
				metadata?: { cellar?: { export?: boolean } };
			}>;
			return cells[0].metadata?.cellar?.export;
		})
		.toBeUndefined();
});
