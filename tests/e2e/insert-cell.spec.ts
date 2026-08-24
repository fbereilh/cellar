import { test, expect, type Page, type Locator } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * E2E for inserting cells BETWEEN cells (not just appending), from both the UI
 * (hover-between "+" control + per-cell insert-above/below buttons) and the
 * Jupyter command-mode `a`/`b` keyboard shortcuts. Also guards the mode gating:
 * `a`/`b` type characters while editing, never insert cells.
 *
 * The last two tests cover the TYPED create paths: a CHAT cell created from the
 * gap strip and from the bottom add row (never through the type menu), and both
 * chat controls ABSENT on a `.py` notebook - which cannot hold one - while its
 * Code/Markdown controls keep working. The gating rule itself is source-guarded
 * in `tests/unit/add-chat-cell-controls.test.ts` (e2e is absent from CI).
 *
 * SPLIT-CELL is the third way a cell appears between two others, and the
 * split test covers what only a real browser can: that the notebook hands the
 * created half the ORIGINAL cell's identity. The rule itself (which `cellar` keys ride
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
	// the export toggle in the row IS the marker now - the separate badge that
	// said the same thing is gone (tests/unit/cell-row-toggles.test.ts)
	await expect(exportCell.getByTestId('toggle-export')).toHaveAttribute('aria-pressed', 'true');

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

/** Every cell's `cellar` namespace for notebook `nb`, in document order, from the SERVER model. */
async function serverCellarOf(page: Page, nb: string): Promise<Record<string, unknown>[]> {
	return page.evaluate(async (path) => {
		const res = await fetch(`/api/notebooks?path=${encodeURIComponent(path)}`);
		const body = await res.json();
		return (body.notebook.cells as { metadata?: { cellar?: Record<string, unknown> } }[]).map(
			(c) => c.metadata?.cellar ?? {}
		);
	}, nb);
}

const CHAT_C1 = 'c11e0001-0000-4000-8000-000000000001';
const CHAT_C2 = 'c11e0002-0000-4000-8000-000000000002';

/**
 * The ACTIVE pane's nodes only. The tab session is server-owned `.cellar/`
 * state, so a fresh context still restores every notebook earlier tests opened,
 * all kept mounted-but-hidden - an unscoped `getByTestId` counts (and, under
 * strict mode, refuses to click through) the hidden panes' copies too.
 */
function vis(page: Page, testId: string): Locator {
	return page.locator(`[data-testid="${testId}"]:visible`);
}

/**
 * Open `path` from the file tree and wait for `opened` to show. Retried,
 * because the server-owned tab-session restore lands at hydration, after the
 * first paint - a click landing before it is wiped when the restored tab set
 * replaces the preview tab it just opened.
 */
async function openFromTree(page: Page, path: string, opened: Locator): Promise<void> {
	await expect(async () => {
		await page.locator(`[data-testid="tree-file"][data-path="${path}"]`).click();
		await expect(opened).toBeVisible({ timeout: 2_000 });
		// The restore can land AFTER the open was confirmed (observed in a trace
		// ~600ms post-load on a cold start, replacing the tab array wholesale), so
		// the opened notebook must be seen to OUTLIVE that window.
		await page.waitForTimeout(800);
		await expect(opened).toBeVisible({ timeout: 200 });
	}).toPass({ timeout: 30_000 });
}

test('the gap strip and the bottom add row create a CHAT cell - no type menu involved', async ({ page }) => {
	// A notebook of this test's own, so the default notebook's accumulated cells
	// never shift what "the gap above the second cell" addresses.
	const nb = 'chat-create.ipynb';
	writeFileSync(
		join(workspace, nb),
		JSON.stringify(
			{
				cells: [CHAT_C1, CHAT_C2].map((id, i) => ({
					cell_type: 'code',
					id,
					metadata: {},
					source: [`x${i} = ${i}`],
					outputs: [],
					execution_count: null
				})),
				metadata: { kernelspec: { display_name: 'python3', language: 'python', name: 'python3' } },
				nbformat: 4,
				nbformat_minor: 5
			},
			null,
			1
		)
	);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openFromTree(page, nb, page.locator(`[data-testid="cell"][data-cell-id="${CHAT_C2}"]`));
	const cells = vis(page, 'cell');
	await expect(cells).toHaveCount(2);

	// --- Gap strip: the hover-between control above cell 2 inserts a chat cell. ---
	// Scope the gap to CHAT_C2's own row wrapper, never an ordinal over every gap.
	const gapAboveC2 = page
		.locator(`[data-testid="cell"][data-cell-id="${CHAT_C2}"]`)
		.locator('..')
		.getByTestId('insert-between');
	await gapAboveC2.hover();
	await gapAboveC2.getByTestId('insert-chat').click();
	await expect(cells).toHaveCount(3);
	// The new cell landed BETWEEN the two, and IS a chat cell (the badge is the
	// user-facing identity; the tag is asserted on the server model below).
	await expect(cells.nth(1).getByTestId('chat-badge')).toBeVisible();

	// --- Bottom add row: the labelled Chat button appends a chat cell. ---
	await vis(page, 'add-chat').click();
	await expect(cells).toHaveCount(4);
	await expect(cells.nth(3).getByTestId('chat-badge')).toBeVisible();

	// Both persisted as TAGGED code cells (`cellar.language`), the same shape the
	// type menu writes - one create path, not a second kind of chat cell.
	await expect(async () => {
		const cellar = await serverCellarOf(page, nb);
		expect(cellar.length).toBe(4);
		expect(cellar[1].language).toBe('chat');
		expect(cellar[3].language).toBe('chat');
		expect(cellar[0].language).toBeUndefined();
	}).toPass({ timeout: 15_000 });

	// The tag survives to DISK through clean-on-save: the persisted `.ipynb`
	// carries `cellar.language: 'chat'` on exactly the two created cells.
	await expect(async () => {
		const doc = JSON.parse(readFileSync(join(workspace, nb), 'utf8')) as {
			cells: { metadata?: { cellar?: { language?: string } } }[];
		};
		expect(doc.cells.length).toBe(4);
		expect(doc.cells[1].metadata?.cellar?.language).toBe('chat');
		expect(doc.cells[3].metadata?.cellar?.language).toBe('chat');
		expect(doc.cells[0].metadata?.cellar?.language).toBeUndefined();
	}).toPass({ timeout: 15_000 });

	// And a reload renders both chat badges again from the reopened file. The tab
	// session's debounced write can race the reload, so the notebook is re-opened
	// from the tree rather than trusted to restore (the chat-cell.spec pattern).
	await page.reload();
	await openFromTree(page, nb, page.locator(`[data-testid="cell"][data-cell-id="${CHAT_C2}"]`));
	await expect(cells.nth(1).getByTestId('chat-badge')).toBeVisible();
	await expect(cells.nth(3).getByTestId('chat-badge')).toBeVisible();
});

test('a .py notebook offers NO chat add control, while Code and Markdown stay', async ({ page }) => {
	// Databricks source format: read through the helper's pure-text converter, so
	// this needs no jupytext install. Such a document cannot HOLD a chat cell
	// (`assertCanHoldType`), so a control offering one must not render at all.
	writeFileSync(
		join(workspace, 'dbx_nb.py'),
		'# Databricks notebook source\nprint(1)\n\n# COMMAND ----------\n\nprint(2)\n'
	);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	const cells = vis(page, 'cell');
	// `print(1)` appears in no other notebook, so it is the "dbx really opened"
	// signal (a bare visible-cell count is satisfied by the restored .ipynb tab).
	await openFromTree(page, 'dbx_nb.py', cells.filter({ hasText: 'print(1)' }).first());
	await expect(cells).toHaveCount(2);

	// Bottom add row: Code and Markdown render, Chat does not (visible-scoped:
	// a hidden .ipynb pane restored from the server tab session HAS the button,
	// and counting it would pass this test against a broken gate).
	await expect(vis(page, 'add-cell')).toBeVisible();
	await expect(vis(page, 'add-markdown')).toBeVisible();
	await expect(vis(page, 'add-chat')).toHaveCount(0);

	// Gap strip: hovering reveals Code/Markdown, and no Chat button exists.
	const gap = cells.nth(1).locator('..').getByTestId('insert-between');
	await gap.hover();
	await expect(gap.getByTestId('insert-code')).toBeVisible();
	await expect(gap.getByTestId('insert-markdown')).toBeVisible();
	await expect(gap.getByTestId('insert-chat')).toHaveCount(0);

	// The withheld control is a REFUSAL mirror, not a broken row: inserting a code
	// cell from this same gap still works on a .py notebook.
	await gap.getByTestId('insert-code').click();
	await expect(cells).toHaveCount(3);
});
