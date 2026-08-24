import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * The `t` command-mode shortcut: change the selected cell(s) to chat.
 *
 * The registry rules (mode, category, collisions) and the conversion's document
 * semantics are unit-tested in `tests/unit/to-chat-shortcut.test.ts`. What only a
 * real browser can prove is the part in between - that a REAL keypress reaches
 * the notebook's mode-aware dispatcher and converts the whole SELECTION - because
 * that dispatcher reads a keystroke's mode off the DOM (`target.closest('.cm-editor')`),
 * which no unit test can stage. That is also what makes the edit-mode case worth
 * its own test: `t` is a bare letter, so a mode gate that regressed would make the
 * letter untypable in every cell of every notebook.
 *
 * Every assertion about WHICH cells were converted reads the notebook ON DISK
 * rather than the DOM: the shipped default windows cells out of the DOM, so "it
 * looked right on screen" cannot answer the question, and the on-disk shape is
 * also what proves the conversion survived clean-on-save as a TAGGED code cell.
 *
 * Needs the real runtime (uv + python3 + host-venv) like the rest of the E2E
 * suite; skips gracefully without it.
 */

const IDS = ['chatcell0', 'chatcell1', 'chatcell2', 'chatcell3'];
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

const cellBy = (page: Page, id: string) => page.locator(`[data-testid="cell"][data-cell-id="${id}"]`);

interface DiskCell {
	id: string;
	cell_type: string;
	source: string | string[];
	metadata?: { cellar?: { language?: string } };
}

/** The notebook exactly as it sits on disk right now. */
const onDisk = (name: string): { cells: DiskCell[] } => JSON.parse(readFileSync(join(workspace, name), 'utf8'));

/** The LOGICAL type of each cell on disk, in document order. */
function diskTypes(name: string): string[] {
	return onDisk(name).cells.map((c) => (c.cell_type === 'code' ? (c.metadata?.cellar?.language ?? 'code') : c.cell_type));
}

/** One cell's source on disk, joined (nbformat stores it as an array of lines). */
function diskSource(name: string, i: number): string {
	const s = onDisk(name).cells[i].source;
	return Array.isArray(s) ? s.join('') : s;
}

/**
 * Write a FRESH notebook per test, under its own name. Each test retypes cells,
 * so one shared fixture would let a later test pass on state an earlier one left
 * behind - a conversion assertion that would hold even if the keypress did
 * nothing.
 */
function seedFixture(name: string): void {
	writeFileSync(
		join(workspace, name),
		JSON.stringify(
			{
				cells: IDS.map((id, i) => ({
					cell_type: 'code',
					id,
					metadata: {},
					source: [`a = ${i}`],
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

/** Seed a notebook of this test's own, open it, and hand back its name. */
async function openFresh(page: Page, name: string): Promise<string> {
	seedFixture(name);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await page.locator(`[data-testid="tree-file"][data-path="${name}"]`).click();
	await expect(cellBy(page, IDS[0])).toBeVisible({ timeout: 30_000 });
	return name;
}

/**
 * Click a cell to select it WITHOUT opening its editor: the empty middle of the
 * toolbar strip, since the editor would take focus (dropping us into edit mode,
 * where `t` types a character) and the toolbar's own controls sit at both ends.
 */
async function selectCell(page: Page, id: string, modifiers: ('Shift' | 'Meta' | 'Control')[] = []) {
	const card = cellBy(page, id);
	const box = await card.boundingBox();
	if (!box) throw new Error(`cell ${id} is not mounted`);
	await card.click({ position: { x: Math.round(box.width / 2), y: 14 }, modifiers });
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available - E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-to-chat-e2e-'));
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

test('`t` converts a whole multi-cell selection to chat, and nothing else', async ({ page }) => {
	test.setTimeout(120_000);
	const nb = await openFresh(page, 'multi.ipynb');

	// A NON-CONTIGUOUS selection, which is the case a per-cell affordance cannot
	// express at all: cell 0 and cell 2, built with the toggle modifier.
	await selectCell(page, IDS[0]);
	await selectCell(page, IDS[2], [MOD]);
	await expect(page.getByTestId('selection-count')).toHaveText('2 selected');

	await page.keyboard.press('t');

	// On disk, so the assertion survives windowing AND proves the tagged-code-cell
	// shape came through clean-on-save rather than living only in memory.
	await expect.poll(() => diskTypes(nb), { timeout: 20_000 }).toEqual(['chat', 'code', 'chat', 'code']);
	expect(onDisk(nb).cells.map((c) => c.cell_type)).toEqual(['code', 'code', 'code', 'code']);
	// The source is the cell's content and is kept - a conversion retypes, it does
	// not clear.
	expect([0, 1, 2, 3].map((i) => diskSource(nb, i))).toEqual(['a = 0', 'a = 1', 'a = 2', 'a = 3']);

	// And the browser agrees: the chat badge on exactly the two converted cells.
	await expect(cellBy(page, IDS[0]).getByTestId('chat-badge')).toBeVisible();
	await expect(cellBy(page, IDS[2]).getByTestId('chat-badge')).toBeVisible();
	await expect(cellBy(page, IDS[1]).getByTestId('chat-badge')).toHaveCount(0);
	await expect(cellBy(page, IDS[3]).getByTestId('chat-badge')).toHaveCount(0);
});

test('a Shift range converts as one action, and a second `t` is a no-op', async ({ page }) => {
	test.setTimeout(120_000);
	const nb = await openFresh(page, 'range.ipynb');

	await selectCell(page, IDS[0]);
	await page.keyboard.press('Shift+j');
	await page.keyboard.press('Shift+j');
	await expect(page.getByTestId('selection-count')).toHaveText('3 selected');

	await page.keyboard.press('t');
	await expect.poll(() => diskTypes(nb), { timeout: 20_000 }).toEqual(['chat', 'chat', 'chat', 'code']);

	// Idempotent, exactly like `m` on an already-markdown selection: the server
	// skips a cell already of the target type, so the document is unchanged.
	const before = readFileSync(join(workspace, nb), 'utf8');
	await page.keyboard.press('t');
	await page.waitForTimeout(1500);
	expect(readFileSync(join(workspace, nb), 'utf8')).toBe(before);

	// `y` takes them back, which is the sibling conversion doing its own job - the
	// tag is removed, not merely shadowed.
	await page.keyboard.press('y');
	await expect.poll(() => diskTypes(nb), { timeout: 20_000 }).toEqual(['code', 'code', 'code', 'code']);
});

test('`t` types a character in EDIT mode - it never converts while you are typing', async ({ page }) => {
	test.setTimeout(120_000);
	const nb = await openFresh(page, 'editmode.ipynb');

	// Click INTO the editor: that is what puts the dispatcher in edit mode, and it
	// is the only way to stage this - the mode is read off the focused element.
	// The click on `editor-scroll` also BUILDS the lazy editor, which does not exist
	// until a cell is edited.
	const cell = cellBy(page, IDS[0]);
	await cell.getByTestId('editor-scroll').click();
	const editor = cell.locator('.cm-content');
	await expect(editor).toBeVisible({ timeout: 10_000 });
	await editor.click();
	// The notebook's own mode readout, which is what the dispatcher branches on.
	await expect(cell.getByTestId('cell-mode')).toHaveAttribute('data-mode', 'edit');

	await page.keyboard.press('End');
	await page.keyboard.type('tt');
	await expect(editor).toContainText('a = 0tt');

	// The characters landed in the cell, persisted, and the cell is still code -
	// the keystroke typed rather than converting.
	await expect.poll(() => diskSource(nb, 0), { timeout: 20_000 }).toBe('a = 0tt');
	expect(diskTypes(nb)).toEqual(['code', 'code', 'code', 'code']);

	// Escape back to COMMAND mode and the very same key converts, which is what
	// makes the assertion above about the MODE rather than about a dead binding.
	await page.keyboard.press('Escape');
	await expect(cell.getByTestId('cell-mode')).toHaveAttribute('data-mode', 'command');
	await page.keyboard.press('t');
	await expect.poll(() => diskTypes(nb), { timeout: 20_000 }).toEqual(['chat', 'code', 'code', 'code']);
	expect(diskSource(nb, 0)).toBe('a = 0tt');
});

test('`z` after a conversion changes nothing - the undo stack is deletes only', async ({ page }) => {
	test.setTimeout(120_000);
	const nb = await openFresh(page, 'undo.ipynb');

	// Cellar's `z` is undo-DELETE (it pops the local deleted-cells stack); no cell
	// type conversion pushes onto it, so `z` is a no-op after one. Pinned for the
	// new member AND for a sibling, because "behaves as m/y/r do" is the whole
	// claim - the coarse route back is the History panel's checkpoints.
	await selectCell(page, IDS[0]);
	await page.keyboard.press('t');
	await expect.poll(() => diskTypes(nb), { timeout: 20_000 }).toEqual(['chat', 'code', 'code', 'code']);

	await selectCell(page, IDS[1]);
	await page.keyboard.press('m');
	await expect.poll(() => diskTypes(nb), { timeout: 20_000 }).toEqual(['chat', 'markdown', 'code', 'code']);

	const before = readFileSync(join(workspace, nb), 'utf8');
	await page.keyboard.press('z');
	await page.waitForTimeout(1500);
	expect(readFileSync(join(workspace, nb), 'utf8')).toBe(before);
	// Nothing was resurrected either - `z` did not treat the conversion as a delete.
	expect(onDisk(nb).cells).toHaveLength(4);
});

test('the shortcut is listed in Settings with its binding', async ({ page }) => {
	test.setTimeout(120_000);
	await openFresh(page, 'settings.ipynb');

	await page.getByTestId('app-menu').click();
	await page.getByTestId('open-settings').click();

	const row = page.locator('[data-shortcut-id="to-chat"]');
	await expect(row).toBeVisible({ timeout: 10_000 });
	await row.scrollIntoViewIfNeeded();
	await expect(row).toContainText('Change the selected cell(s) to chat');
	await expect(row).toContainText('Command mode');
	// The rebind button carries the chord it would replace, so this reads the
	// binding the panel really offers rather than a glyph that merely looks like one.
	await expect(row.getByTestId('shortcut-key')).toHaveAttribute('data-chord', 't');

	// The panel reports NO collision - the shipped app's own answer to "does `t`
	// clash with anything", which is what acceptance criterion 3 asks.
	await expect(page.getByTestId('shortcuts-conflict-warning')).toHaveCount(0);
});
