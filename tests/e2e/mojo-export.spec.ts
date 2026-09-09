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
/**
 * The one cell that is Mojo REGARDLESS of its notebook: a plain code cell whose
 * SOURCE opens with the magic, which is what a user gets by pasting an example out
 * of Modular's docs. It is the only reachable language mismatch now that the
 * language itself is the notebook's, so it is what the `.py`-module refusal below
 * is driven with.
 */
const MAGIC_MAIN = `%%mojo\n${MAIN}`;

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
 * Build a MOJO NOTEBOOK with a `.mojo` target, every cell marked.
 *
 * The LANGUAGE is set first, then the target: the module's language is the
 * notebook's, so its extension has to agree - a `.mojo` path on a Python notebook
 * is refused by design. Its code cells are then Mojo cells by virtue of the
 * notebook alone; there is no per-cell type to set.
 */
async function mojoNotebook(api: APIRequestContext, rel: string, sources: string[], target: string): Promise<string[]> {
	const created = await api.post(`${baseURL}/api/notebooks`, { data: { path: rel, create: true } });
	expect(created.ok(), await created.text()).toBeTruthy();

	const lang = await api.post(`${baseURL}/api/notebooks/language`, {
		data: { language: 'mojo', path: rel }
	});
	expect(lang.ok(), await lang.text()).toBeTruthy();

	const set = await api.post(`${baseURL}/api/notebooks/export-py`, {
		data: { op: 'set-target', target, base: 'workspace', path: rel }
	});
	expect(set.ok(), await set.text()).toBeTruthy();

	const view = await api.get(`${baseURL}/api/notebooks?path=${encodeURIComponent(rel)}`);
	const ids = ((await view.json()).notebook.cells as Array<{ id: string }>).map((c) => c.id);
	// The starter notebook holds ONE empty cell; add the rest after it.
	for (let i = 1; i < sources.length; i++) {
		const added = await api.post(`${baseURL}/api/cells`, {
			data: { afterId: ids[ids.length - 1], cellType: 'code', source: sources[i], nb: rel }
		});
		expect(added.ok(), await added.text()).toBeTruthy();
		ids.push((await added.json()).cell.id as string);
	}
	for (const [i, id] of ids.entries()) {
		// Only the SOURCE has to land - every code cell of this notebook is already a
		// Mojo cell, because the notebook is.
		const patched = await api.patch(`${baseURL}/api/cells/${id}`, {
			data: { source: sources[i], nb: rel }
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

test('a .py module shows no Mojo warning and takes no Mojo cell', async ({ page, request }) => {
	// A PYTHON notebook, so its module is a `.py` one - and a cell whose own source
	// is Mojo is not eligible for it, so it is never marked, nothing is dropped and
	// nothing warns.
	const rel = 'pytarget.ipynb';
	const created = await request.post(`${baseURL}/api/notebooks`, { data: { path: rel, create: true } });
	expect(created.ok(), await created.text()).toBeTruthy();
	const set = await request.post(`${baseURL}/api/notebooks/export-py`, {
		data: { op: 'set-target', target: 'lib/py.py', base: 'workspace', path: rel }
	});
	expect(set.ok(), await set.text()).toBeTruthy();
	const view = await request.get(`${baseURL}/api/notebooks?path=${encodeURIComponent(rel)}`);
	const id = ((await view.json()).notebook.cells as Array<{ id: string }>)[0].id;
	await request.patch(`${baseURL}/api/cells/${id}`, { data: { source: MAGIC_MAIN, nb: rel } });
	// The server REFUSES the mark - a Mojo cell has no place in a `.py` module - and
	// SAYS SO: `not-code` is one of the two refusals the PATCH handler reports as a
	// 409, precisely because the browser applies this mark optimistically and would
	// otherwise be left showing a flag that exists in no file. Both halves are
	// observable, so both are asserted: the reported refusal, and the flag that
	// never lands.
	const marked = await request.patch(`${baseURL}/api/cells/${id}`, { data: { export: true, nb: rel } });
	expect(marked.status(), await marked.text()).toBe(409);
	expect(await marked.json()).toEqual({ ok: false, reason: 'not-code', alsoFlagged: false });
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

	// Now STRAND the mark. Repointing the target cannot do it any more - the module's
	// language follows the notebook, so the two can never disagree - and that is the
	// improvement. What CAN strand a mark is converting the cell to a type that
	// contributes no module source: `applyCellType` deliberately KEEPS the flag
	// rather than silently deleting a key from the user's committed `.ipynb`, which
	// is precisely why the toggle has to stay reachable for it.
	const converted = await request.patch(`${baseURL}/api/cells/${ids[0]}`, {
		data: { cell_type: 'markdown', nb: 'labels.ipynb' }
	});
	expect(converted.ok(), await converted.text()).toBeTruthy();
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
	// A markdown cell contributes no module source in ANY language, so the one
	// explanation names CLEARING the mark and no target action at all - pointing the
	// target elsewhere could never resolve it.
	await expect(bar).toHaveText(/no module source/);
	await expect(bar).toHaveText(/clear the mark/);
	await expect(page.locator('[data-testid="export-count"]:visible')).toHaveText('0 cells marked');

	// CLEARING the target is a different fact and may not be worded as the first: the
	// notebook then targets nothing, so nothing may name a module at all.
	const cleared = await request.post(`${baseURL}/api/notebooks/export-py`, {
		data: { op: 'set-target', target: '', base: 'workspace', path: 'labels.ipynb' }
	});
	expect(cleared.ok(), await cleared.text()).toBeTruthy();
	await page.reload();
	await openNotebook(page, 'labels.ipynb');
	const noTarget = page.locator('[data-testid="export-stranded"]:visible');
	await expect(noTarget).toHaveText(/no module source/);
	await expect(noTarget).not.toHaveText(/\.mojo/);
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

test('a Mojo notebook with NO target still judges eligibility by the NOTEBOOK language', async ({
	page,
	request
}) => {
	// The client evaluated eligibility with `exportLanguage ?? 'python'`, and
	// `exportLanguage` is the MODULE language - null until a target names a module.
	// So a Mojo notebook that has not been given a target yet had its cells judged as
	// Python: a `%%mojo` cell came out STRANDED, greyed, with the notebook-wide
	// explanation (which reads the notebook language) reporting nothing - and
	// clicking that greyed toggle cleared a mark the server considers perfectly
	// eligible. The server decides this against the notebook's language, full stop.
	const created = await request.post(`${baseURL}/api/notebooks`, {
		data: { path: 'no-target.ipynb', create: true }
	});
	expect(created.ok(), await created.text()).toBeTruthy();
	const lang = await request.post(`${baseURL}/api/notebooks/language`, {
		data: { language: 'mojo', path: 'no-target.ipynb' }
	});
	expect(lang.ok(), await lang.text()).toBeTruthy();
	const view = await request.get(`${baseURL}/api/notebooks?path=no-target.ipynb`);
	const id = ((await view.json()).notebook.cells as Array<{ id: string }>)[0].id;
	// A `%%mojo` cell: Mojo whichever notebook it sits in, so it is what tells the two
	// readings apart (a plain code cell answers the same either way).
	const patched = await request.patch(`${baseURL}/api/cells/${id}`, {
		data: { source: MAGIC_MAIN, nb: 'no-target.ipynb' }
	});
	expect(patched.ok(), await patched.text()).toBeTruthy();
	const marked = await request.patch(`${baseURL}/api/cells/${id}`, {
		data: { export: true, nb: 'no-target.ipynb' }
	});
	// The SERVER accepts the mark - which is the whole point: the row must not
	// contradict it.
	expect(marked.ok(), await marked.text()).toBeTruthy();

	await openNotebook(page, 'no-target.ipynb');
	const toggle = page.locator(`[data-cell-id="${id}"]`).getByTestId('toggle-export');
	await expect(toggle).toHaveAttribute('aria-pressed', 'true');
	await expect(toggle).not.toHaveAttribute('data-export-stranded', 'true');
	await expect(page.locator(`[data-cell-id="${id}"]`).getByTestId('export-stranded-badge')).toHaveCount(0);
	await expect(page.locator('[data-testid="export-stranded"]:visible')).toHaveCount(0);
	// With no target there is still no module to NAME, so the sentence stays honest.
	await expect(toggle).toHaveAttribute('aria-label', "Export this cell to the notebook's module");
});

test('switching the language NAMES the generated module it leaves behind', async ({ page, request }) => {
	// The switch re-expresses the stored target (`.py` -> `.mojo`) and renames nothing
	// on disk: Cellar never deletes a generated module the user's repository holds. In
	// an nbdev repo that file is git-tracked and still importable while this notebook
	// has stopped writing it, so the path is named ONCE in the export bar and the
	// decision is the user's.
	const created = await request.post(`${baseURL}/api/notebooks`, {
		data: { path: 'orphan.ipynb', create: true }
	});
	expect(created.ok(), await created.text()).toBeTruthy();
	const set = await request.post(`${baseURL}/api/notebooks/export-py`, {
		data: { op: 'set-target', target: 'lib/orphan.py', base: 'workspace', path: 'orphan.ipynb' }
	});
	expect(set.ok(), await set.text()).toBeTruthy();
	const view = await request.get(`${baseURL}/api/notebooks?path=orphan.ipynb`);
	const id = ((await view.json()).notebook.cells as Array<{ id: string }>)[0].id;
	await request.patch(`${baseURL}/api/cells/${id}`, {
		data: { source: 'def one():\n    return 1', nb: 'orphan.ipynb' }
	});
	const marked = await request.patch(`${baseURL}/api/cells/${id}`, {
		data: { export: true, nb: 'orphan.ipynb' }
	});
	expect(marked.ok(), await marked.text()).toBeTruthy();
	expect(readModule('lib/orphan.py')).toContain('def one()');

	await openNotebook(page, 'orphan.ipynb');
	// Nothing left behind yet, so an ordinary notebook shows no such line.
	await expect(page.locator('[data-testid="export-orphan"]:visible')).toHaveCount(0);

	await page.locator('[data-testid="language-select"]:visible').selectOption('mojo');
	await expect(page.locator('[data-testid="export-target-input"]:visible')).toHaveValue(
		'lib/orphan.mojo',
		{ timeout: 30_000 }
	);
	// The FILE is still there - that is the fact being reported, not a prediction.
	expect(readModule('lib/orphan.py')).not.toBeNull();
	const orphan = page.locator('[data-testid="export-orphan"]:visible');
	await expect(orphan).toHaveCount(1, { timeout: 30_000 });
	// It NAMES the path, so the user can find and delete it, and names where the
	// notebook writes now.
	await expect(orphan).toContainText('lib/orphan.py');
	await expect(orphan).toContainText('lib/orphan.mojo');
	await expect(orphan).toContainText(/will not remove it for you/i);
});

