import { test, expect, type Page, type Locator } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * E2E for inserting cells BETWEEN cells (not just appending), from both the UI
 * (hover-between "+" control + per-cell insert-above/below buttons) and the
 * Jupyter command-mode `a`/`b` keyboard shortcuts. Also guards the mode gating:
 * `a`/`b` type characters while editing, never insert cells.
 *
 * SPLIT-CELL is the third way a cell appears between two others, and the last
 * test covers what only a real browser can: that the notebook hands the created
 * half the ORIGINAL cell's identity. The rule itself (which `cellar` keys ride
 * along, and why the imports role and the export flag do not) is unit-tested in
 * `tests/unit/split-cell.test.ts`; what is checked here is the WIRING, since a
 * split that forgot to pass the namespace turned a SQL cell's lower half into a
 * plain Python one that compiles through the wrong path, silently.
 *
 * Boots the REAL launcher against a throwaway workspace (see ./harness); SKIPS
 * when the kernel runtime is absent (local-only, like smoke.spec).
 */

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-e2e-insert-'));
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

/**
 * The code text of every cell, in document order. Reads the CONTENT column only
 * (mounted `.cm-content` or the static `.cm-static-content` stand-in) so the
 * line-number gutter is excluded, and joins per-line so multi-line sources keep
 * their newlines (both renderers drop `\n` from a flat `textContent`).
 */
async function cellTexts(page: Page): Promise<string[]> {
	return page.$$eval('[data-testid="cell"]', (cells) =>
		cells.map((c) => {
			const mounted = c.querySelector('.cm-content');
			const root = mounted ?? c.querySelector('.cm-static-content');
			if (!root) return '';
			const lineSel = mounted ? '.cm-line' : '.cm-static-line';
			return Array.from(root.querySelectorAll(lineSel))
				.map((l) => l.textContent ?? '')
				.join('\n')
				.trim();
		})
	);
}

/** Open the default notebook from the empty state if it is showing. */
async function openNotebook(page: Page): Promise<void> {
	const openBtn = page.getByTestId('empty-open-notebook');
	// Settle on whichever the shell paints - the empty state, or a notebook that is
	// already open - BEFORE probing. Probed earlier, a slow first paint reports the
	// button invisible, the click becomes a no-op, and the wait below then times out
	// on a notebook nothing ever opened (a real flake under `workers: 2`).
	await expect(openBtn.or(page.getByTestId('cell').first())).toBeVisible();
	if (await openBtn.isVisible().catch(() => false)) await openBtn.click();
	await expect(page.getByTestId('cell').first()).toBeVisible();
}

/** Build the lazy editor (click) and type `text` into cell `cell` (replacing any content). */
async function typeInto(page: Page, cell: Locator, text: string): Promise<void> {
	await cell.getByTestId('editor-scroll').click();
	const editor = cell.locator('.cm-content');
	await expect(editor).toBeVisible();
	await editor.click();
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.type(text);
	await expect(editor).toContainText(text);
}

/** Select cell `cell` and put it in COMMAND mode (Escape out of any editor). */
async function selectCommand(page: Page, cell: Locator): Promise<void> {
	await cell.getByTestId('editor-scroll').click();
	await page.keyboard.press('Escape'); // edit → command; the card keeps the selection
	await expect(cell.getByTestId('cell-mode')).toHaveAttribute('data-mode', 'command');
}

test('UI insert points: hover-between "+" and per-cell buttons insert at position, mount, and persist', async ({ page }) => {
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);

	const cells = page.getByTestId('cell');

	// Two cells to insert between: type into the seeded one, append a second.
	await typeInto(page, cells.nth(0), 'aaa');
	await page.getByTestId('add-cell').click();
	await expect(cells).toHaveCount(2);
	await typeInto(page, cells.nth(1), 'bbb');
	await expect(await cellTexts(page)).toEqual(['aaa', 'bbb']);

	// --- Hover-between control: insert a code cell in the gap ABOVE cell "bbb". ---
	const gapAboveBbb = page.getByTestId('insert-between').nth(1);
	await gapAboveBbb.hover();
	await gapAboveBbb.getByTestId('insert-code').click();
	await expect(cells).toHaveCount(3);
	// The new (empty) cell landed BETWEEN aaa and bbb, and is selected.
	await expect(await cellTexts(page)).toEqual(['aaa', '', 'bbb']);
	// It can be typed into — the lazy editor mounts via the reveal-and-mount path.
	await typeInto(page, cells.nth(1), 'mmm');
	await expect(await cellTexts(page)).toEqual(['aaa', 'mmm', 'bbb']);

	// --- Per-cell "insert below" on cell "aaa" (index 0). ---
	await cells.nth(0).getByTestId('cell-insert-below').click();
	await expect(cells).toHaveCount(4);
	await expect(await cellTexts(page)).toEqual(['aaa', '', 'mmm', 'bbb']);
	await typeInto(page, cells.nth(1), 'xxx');

	// --- Per-cell "insert above" on cell "bbb" (now index 3). ---
	await cells.nth(3).getByTestId('cell-insert-above').click();
	await expect(cells).toHaveCount(5);
	await typeInto(page, cells.nth(3), 'yyy');
	await expect(await cellTexts(page)).toEqual(['aaa', 'xxx', 'mmm', 'yyy', 'bbb']);

	// The inserted middle cell runs like any other, proving it's a real kernel cell.
	await typeInto(page, cells.nth(2), '6*7');
	await cells.nth(2).getByTestId('run').click();
	await expect(cells.nth(2).getByTestId('output-scroll')).toContainText('42', { timeout: 60_000 });

	// --- Positions survive a reload (persisted to the .ipynb in order). ---
	await page.reload();
	await expect(page.getByTestId('cell')).toHaveCount(5);
	await expect(async () => {
		expect(await cellTexts(page)).toEqual(['aaa', 'xxx', '6*7', 'yyy', 'bbb']);
	}).toPass({ timeout: 15_000 });
});

test('command mode: `a` inserts above, `b` inserts below; while editing they type characters', async ({ page }) => {
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	const cells = page.getByTestId('cell');
	const before = await cells.count();

	// Command mode on the first cell, then `b` → insert below (selection moves to it).
	await selectCommand(page, cells.nth(0));
	await page.keyboard.press('b');
	await expect(cells).toHaveCount(before + 1);
	// The freshly inserted cell is the selected one, in command mode.
	const insertedBelow = cells.nth(1);
	await expect(insertedBelow.getByTestId('cell-mode')).toHaveAttribute('data-mode', 'command');

	// `a` → insert above the selection.
	await page.keyboard.press('a');
	await expect(cells).toHaveCount(before + 2);

	// --- Mode gating: inside an editor, `a`/`b` type characters, never insert. ---
	const countBeforeTyping = await cells.count();
	const target = cells.nth(0);
	await target.getByTestId('editor-scroll').click();
	const editor = target.locator('.cm-content');
	await expect(editor).toBeVisible();
	await editor.click();
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.type('ab');
	// Characters landed in the editor; NO new cell was created.
	await expect(editor).toContainText('ab');
	await expect(cells).toHaveCount(countBeforeTyping);
});

/** Every cell's id + source + `cellar` namespace, in document order, from the SERVER model. */
async function serverCells(page: Page): Promise<{ id: string; source: string; cellar: Record<string, unknown> }[]> {
	return page.evaluate(async () => {
		const res = await fetch('/api/notebooks?path=notebook.ipynb');
		const body = await res.json();
		return (body.notebook.cells as { id: string; source: string; metadata?: { cellar?: Record<string, unknown> } }[]).map((c) => ({
			id: c.id,
			source: c.source,
			cellar: c.metadata?.cellar ?? {}
		}));
	});
}

/** PATCH a cell the way the ⋮ actions / type menus do; callers wait for the tab to apply the event. */
async function patchCell(page: Page, id: string, body: Record<string, unknown>): Promise<void> {
	await page.evaluate(
		async ([cellId, payload]) => {
			await fetch(`/api/cells/${cellId}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ ...(payload as object), nb: 'notebook.ipynb' })
			});
		},
		[id, body] as [string, Record<string, unknown>]
	);
}

/**
 * Type two lines into `cell`, leaving the caret at the END of the second - so a
 * following `Home` lands exactly on the line break, a deterministic split point.
 * Not `typeInto`: its whole-text assertion cannot express a newline, because
 * CodeMirror renders each line as its own element and `textContent` joins them
 * with nothing at all.
 */
async function typeTwoLines(page: Page, cell: Locator, first: string, second: string): Promise<void> {
	await cell.getByTestId('editor-scroll').click();
	const editor = cell.locator('.cm-content');
	await expect(editor).toBeVisible();
	await editor.click();
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.type(`${first}\n${second}`);
	await expect(editor).toContainText(second);
}

test('split-cell hands the created half the cell it came out of - language yes, export no', async ({ page }) => {
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	const cells = page.getByTestId('cell');

	// ---- A SQL cell, split in two: the lower half must still be SQL ----------
	const beforeSql = await cells.count();
	await page.getByTestId('add-cell').click();
	await expect(cells).toHaveCount(beforeSql + 1);
	const sqlCell = cells.last();
	const sqlId = (await sqlCell.getAttribute('data-cell-id')) ?? '';
	expect(sqlId).not.toBe('');
	await patchCell(page, sqlId, { cell_type: 'sql' });
	await expect(sqlCell.getByTestId('type-toggle')).toHaveText(/sql/i);

	// Two lines, so the split has a distinguishable upper and lower half. Typing
	// leaves the caret at the end of line 2, so `Home` puts it exactly at the split.
	await typeTwoLines(page, sqlCell, 'select 1', 'select 2');
	await page.keyboard.press('Home');
	// `Ctrl Shift -` names the physical Ctrl key on every platform (JupyterLab's).
	await page.keyboard.press('Control+Shift+Minus');
	await expect(cells).toHaveCount(beforeSql + 2);

	await expect(async () => {
		const after = await serverCells(page);
		const upper = after.findIndex((c) => c.id === sqlId);
		expect(upper).toBeGreaterThanOrEqual(0);
		expect(after[upper].source).toBe('select 1\n');
		expect(after[upper + 1].source).toBe('select 2');
		// The half a split creates is the same cell's second half - so it is SQL, not
		// a plain Python cell that would compile through the Python path.
		expect(after[upper + 1].cellar.language).toBe('sql');
	}).toPass({ timeout: 15_000 });

	// ---- An EXPORT-marked Python cell: the designation stays with the original --
	const beforeExport = await cells.count();
	await page.getByTestId('add-cell').click();
	await expect(cells).toHaveCount(beforeExport + 1);
	const exportCell = cells.last();
	const exportId = (await exportCell.getAttribute('data-cell-id')) ?? '';
	await patchCell(page, exportId, { export: true });
	await expect(exportCell.getByTestId('export-badge')).toBeVisible();

	await typeTwoLines(page, exportCell, 'a = 1', 'b = 2');
	await page.keyboard.press('Home');
	await page.keyboard.press('Control+Shift+Minus');
	await expect(cells).toHaveCount(beforeExport + 2);

	await expect(async () => {
		const after = await serverCells(page);
		const upper = after.findIndex((c) => c.id === exportId);
		expect(upper).toBeGreaterThanOrEqual(0);
		expect(after[upper].source).toBe('a = 1\n');
		expect(after[upper + 1].source).toBe('b = 2');
		// The user marked THAT cell for export; inheriting it would silently double
		// what the `.py` module writes out.
		expect(after[upper].cellar.export).toBe(true);
		expect(after[upper + 1].cellar.export).toBeUndefined();
	}).toPass({ timeout: 15_000 });
});
