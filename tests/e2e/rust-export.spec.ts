import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { type ChildProcess, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar, removeWorkspace, openNotebookSettings, closeNotebookSettings } from './harness';
import { tabPanelDomId } from '../../src/lib/tabIds';

/**
 * A Rust notebook exports to ONE `.rs` module: every exported cell's top-level
 * items go in at module level, and the statements of the ONE cell marked as the
 * main cell go inside a generated `fn main()`. Statements in any OTHER exported
 * cell cannot go anywhere in a `.rs` file, so they are dropped - and the cell
 * says so while the user is editing, not only in the generated file.
 *
 * This spec drives the two browser-only halves: the per-cell main toggle (one per
 * notebook - marking a second cell moves the mark) and the dropped-code badge.
 * No Evcxr kernel is needed: nothing here RUNS a cell. When `rustc` is on PATH,
 * the module the button wrote is compiled and run, which is the proof that a
 * realistic notebook - items across cells, a `:dep` line, a stray statement -
 * really becomes a valid program. The splitter itself is pinned against a real
 * `rustc` in `tests/unit/rust-export.test.ts`.
 */

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

const DEPS = ':dep rand = "0.8"\nuse std::collections::HashMap;';
const ITEMS = [
	'/// Adds two numbers.',
	'#[inline]',
	'fn add(a: i32, b: i32) -> i32 {',
	'    a + b',
	'}',
	'',
	'struct Counter {',
	'    seen: HashMap<String, u32>,',
	'}'
].join('\n');
const STRAY = 'let scratch = add(40, 2);\nprintln!("scratch {scratch}");';
const MAIN = 'let x = add(1, 2);\nlet c = Counter { seen: HashMap::new() };\nprintln!("x={x} seen={}", c.seen.len());';

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available - E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-e2e-rust-export-'));
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

const readModule = (rel: string) => (existsSync(join(workspace, rel)) ? readFileSync(join(workspace, rel), 'utf8') : null);

/**
 * Build a RUST notebook with a `.rs` target, every cell marked for export.
 * The language goes first: the module's language is the notebook's, so a `.rs`
 * path on a Python notebook is refused by design.
 */
async function rustNotebook(api: APIRequestContext, rel: string, sources: string[], target: string): Promise<string[]> {
	const created = await api.post(`${baseURL}/api/notebooks`, { data: { path: rel, create: true } });
	expect(created.ok(), await created.text()).toBeTruthy();
	const lang = await api.post(`${baseURL}/api/notebooks/language`, { data: { language: 'rust', path: rel } });
	expect(lang.ok(), await lang.text()).toBeTruthy();
	const set = await api.post(`${baseURL}/api/notebooks/export-py`, {
		data: { op: 'set-target', target, base: 'workspace', path: rel }
	});
	expect(set.ok(), await set.text()).toBeTruthy();

	const view = await api.get(`${baseURL}/api/notebooks?path=${encodeURIComponent(rel)}`);
	const ids = ((await view.json()).notebook.cells as Array<{ id: string }>).map((c) => c.id);
	for (let i = 1; i < sources.length; i++) {
		const added = await api.post(`${baseURL}/api/cells`, {
			data: { afterId: ids[ids.length - 1], cellType: 'code', source: sources[i], nb: rel }
		});
		expect(added.ok(), await added.text()).toBeTruthy();
		ids.push((await added.json()).cell.id as string);
	}
	for (const [i, id] of ids.entries()) {
		const patched = await api.patch(`${baseURL}/api/cells/${id}`, { data: { source: sources[i], nb: rel } });
		expect(patched.ok(), await patched.text()).toBeTruthy();
		const marked = await api.patch(`${baseURL}/api/cells/${id}`, { data: { export: true, nb: rel } });
		expect(marked.ok(), await marked.text()).toBeTruthy();
	}
	return ids;
}

async function openNotebook(page: Page, rel: string): Promise<void> {
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	const openBtn = page.locator('[data-testid="empty-open-notebook"]:visible');
	const cell = page.locator('[data-testid="cell"]:visible').first();
	await expect(openBtn.or(cell)).toBeVisible();
	if (await openBtn.isVisible()) await openBtn.click();
	await expect(cell).toBeVisible();
	if (rel !== 'notebook.ipynb') {
		// A single click, never a dblclick: the tab strip can wrap between the two
		// clicks and push the tree row out from under the second one.
		await page.getByTestId('tree-file').filter({ hasText: rel }).first().click();
		await expect(page.locator(`[id="${tabPanelDomId('file:' + rel)}"]`)).toBeVisible();
	}
}

const inCell = (page: Page, id: string, testid: string) => page.locator(`[data-cell-id="${id}"]`).getByTestId(testid);

test('the main cell becomes fn main(), a stray statement is dropped and badged, and the module runs', async ({
	page,
	request
}) => {
	const ids = await rustNotebook(request, 'notebook.ipynb', [DEPS, ITEMS, STRAY, MAIN], 'src/lib.rs');
	await openNotebook(page, 'notebook.ipynb');

	// Every exported cell offers the main toggle, and none is pressed yet.
	for (const id of ids) await expect(inCell(page, id, 'toggle-export-main')).toHaveAttribute('aria-pressed', 'false');
	// With no main cell, both statement cells lose their statements.
	await expect(inCell(page, ids[2], 'rust-export-dropped-badge')).toHaveText(/statements not exported/);
	await expect(inCell(page, ids[3], 'rust-export-dropped-badge')).toHaveText(/statements not exported/);
	// Cells holding only items (and a `:dep` line) lose nothing.
	await expect(inCell(page, ids[0], 'rust-export-dropped-badge')).toHaveCount(0);
	await expect(inCell(page, ids[1], 'rust-export-dropped-badge')).toHaveCount(0);

	// Mark the last cell as the main cell, the way a person would.
	await inCell(page, ids[3], 'toggle-export-main').click();
	await expect(inCell(page, ids[3], 'toggle-export-main')).toHaveAttribute('aria-pressed', 'true');
	await expect(inCell(page, ids[3], 'rust-export-dropped-badge')).toHaveCount(0);
	// The stray cell still loses its statements, and its title says where they belong.
	const stray = inCell(page, ids[2], 'rust-export-dropped-badge');
	await expect(stray).toHaveText(/statements not exported/);
	await expect(stray).toHaveAttribute('title', /main cell/);

	// Export from the menu, then read what the button wrote.
	await openNotebookSettings(page);
	await expect(page.locator('[data-testid="export-run"]:visible')).toHaveText('Export to .rs');
	await page.locator('[data-testid="export-run"]:visible').click();
	await expect.poll(() => readModule('src/lib.rs')).toContain('fn main() {');
	const text = readModule('src/lib.rs')!;
	expect(text.split('\n')[0]).toBe('// AUTOGENERATED BY CELLAR! DO NOT EDIT!');
	expect(text).toContain('rand = "0.8"');
	expect(text).not.toMatch(/^:dep/m);
	expect(text).toContain('/// Adds two numbers.\n#[inline]\nfn add(');
	expect(text).toContain('let x = add(1, 2);');
	expect(text).not.toContain('let scratch');
	expect(text.match(/^fn main\(\)/gm)).toHaveLength(1);
	// The one notebook-level finding names the dropped code.
	await expect(page.locator('[data-testid="export-hazard"]:visible')).toHaveCount(1);
	await closeNotebookSettings(page);

	// With a toolchain, prove the module is a real program.
	const rustc = spawnSync('rustc', ['--version']);
	if (rustc.status === 0) {
		const out = mkdtempSync(join(tmpdir(), 'cellar-e2e-rustc-'));
		const bin = join(out, 'prog');
		const build = spawnSync('rustc', ['--edition', '2021', '-A', 'warnings', '-o', bin, join(workspace, 'src/lib.rs')], {
			encoding: 'utf8'
		});
		expect(build.status, build.stderr).toBe(0);
		const run = spawnSync(bin, [], { encoding: 'utf8' });
		expect(run.stdout.trim()).toBe('x=3 seen=0');
		removeWorkspace(out);
	}
});

test('marking another cell moves the mark: one main cell per notebook', async ({ page, request }) => {
	const ids = await rustNotebook(request, 'moves.ipynb', [ITEMS, STRAY, MAIN], 'src/moves.rs');
	await openNotebook(page, 'moves.ipynb');

	await inCell(page, ids[2], 'toggle-export-main').click();
	await expect(inCell(page, ids[2], 'toggle-export-main')).toHaveAttribute('aria-pressed', 'true');
	await expect(inCell(page, ids[1], 'rust-export-dropped-badge')).toBeVisible();

	await inCell(page, ids[1], 'toggle-export-main').click();
	await expect(inCell(page, ids[1], 'toggle-export-main')).toHaveAttribute('aria-pressed', 'true');
	await expect(inCell(page, ids[2], 'toggle-export-main')).toHaveAttribute('aria-pressed', 'false');
	// The badge follows the mark: the old main cell now loses its statements.
	await expect(inCell(page, ids[1], 'rust-export-dropped-badge')).toHaveCount(0);
	await expect(inCell(page, ids[2], 'rust-export-dropped-badge')).toHaveText(/statements not exported/);

	// The server holds exactly the mark the page shows, and it survives a reload.
	const view = await request.get(`${baseURL}/api/notebooks?path=moves.ipynb`);
	const cells = (await view.json()).notebook.cells as Array<{ id: string; metadata?: { cellar?: { export_main?: boolean } } }>;
	expect(cells.filter((c) => c.metadata?.cellar?.export_main === true).map((c) => c.id)).toEqual([ids[1]]);
	// A single-click preview tab is not kept across a reload, so open it again.
	await openNotebook(page, 'moves.ipynb');
	await expect(inCell(page, ids[1], 'toggle-export-main')).toHaveAttribute('aria-pressed', 'true');

	// Unmarking the main cell clears it; the export flags stay.
	await inCell(page, ids[1], 'toggle-export-main').click();
	await expect(inCell(page, ids[1], 'toggle-export-main')).toHaveAttribute('aria-pressed', 'false');
	await expect(inCell(page, ids[1], 'toggle-export')).toHaveAttribute('aria-pressed', 'true');
});

test('a cell that is not exported offers no main toggle', async ({ page, request }) => {
	const ids = await rustNotebook(request, 'unmarked.ipynb', [ITEMS, MAIN], 'src/unmarked.rs');
	await openNotebook(page, 'unmarked.ipynb');
	await inCell(page, ids[1], 'toggle-export').click();
	await expect(inCell(page, ids[1], 'toggle-export')).toHaveAttribute('aria-pressed', 'false');
	await expect(inCell(page, ids[1], 'toggle-export-main')).toHaveCount(0);
	// The other cell, still exported, keeps its toggle.
	await expect(inCell(page, ids[0], 'toggle-export-main')).toHaveCount(1);
});
