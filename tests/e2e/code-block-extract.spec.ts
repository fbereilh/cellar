import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * Lifting a rendered code block into a real cell, in the REAL browser.
 *
 * Both routes - the control on the block and the `Mod-Shift-E` chord - are
 * exercised here, and only here, because both depend on things no unit test can
 * stand in for: the control is injected into `{@html}` output after a Svelte
 * `tick`, and the chord resolves its target through the live `:hover` /
 * `:focus-within` pseudo-classes (jsdom implements neither).
 *
 * Every assertion about what was CREATED reads the notebook off DISK rather than
 * the DOM. The shipped default windows cells out of the DOM, so a count or an
 * `nth()` in the browser answers about what is mounted; disk answers about what
 * the document holds - which is the claim ("a cell whose source is byte-identical
 * to the block's content, of the type the fence asked for").
 *
 * The chat cell here carries a PERSISTED reply (a `display_data` `text/markdown`
 * output), so no model turn is billed and nothing is gated on a signed-in CLI:
 * the render path this feature hangs on is identical either way.
 */

const CHAT_ID = 'chatcell00';
const MD_ID = 'mdcell0000';

/** The three blocks the seeded reply carries, and the cells they must produce. */
const PY_BLOCK = 'import pandas as pd\ndf = pd.read_csv("sales.csv")\ndf.head()';
// Deliberately ONE very long line: it is what makes the overlap test meaningful,
// since a corner overlay covers code only where a line reaches the right edge.
const SQL_BLOCK =
	"select region, channel, segment, quarter, sum(amount) as total, count(id) as n, avg(amount) as avg_amount from sales group by region, channel, segment, quarter";
/** A markdown block that also contains a FENCE - nothing may re-read those markers. */
const MD_BLOCK = ['# Notes', '', 'Run it like this:', '', '```python', 'print("hi")', '```', '', 'Watch `a < b` and "&amp;".'].join('\n');

const REPLY = [
	'Here is how to load the data:',
	'',
	'```python',
	PY_BLOCK,
	'```',
	'',
	'And the aggregate:',
	'',
	'```sql',
	SQL_BLOCK,
	'```',
	'',
	'Notes for the write-up:',
	'',
	'````markdown',
	MD_BLOCK,
	'````',
	''
].join('\n');

/** A fenced block inside an ordinary MARKDOWN CELL - the other surface, same rule. */
const MD_CELL_BLOCK = 'x = 1\ny = 2';
const MD_CELL_SOURCE = ['## Setup', '', '```python', MD_CELL_BLOCK, '```', ''].join('\n');

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

interface DiskCell {
	id: string;
	cell_type: string;
	source: string[] | string;
	metadata?: { cellar?: { language?: string } };
}

/** The notebook exactly as it sits on disk right now. */
const onDisk = (name: string): DiskCell[] => JSON.parse(readFileSync(join(workspace, name), 'utf8')).cells;

/** nbformat stores source as a line array; join it back to the string the cell holds. */
const sourceOf = (c: DiskCell): string => (Array.isArray(c.source) ? c.source.join('') : (c.source ?? ''));

/** The LOGICAL type of a cell on disk (`cellar.language` is what makes a code cell SQL). */
const typeOf = (c: DiskCell): string => (c.cell_type === 'code' ? (c.metadata?.cellar?.language ?? 'code') : c.cell_type);

/** The two cells every fixture starts with; anything else was EXTRACTED. */
const SEEDED = new Set([MD_ID, CHAT_ID]);

/** The cells an extraction created, in document order. */
const created = (name: string): DiskCell[] => onDisk(name).filter((c) => !SEEDED.has(c.id));

/** Wait until the notebook on disk holds `n` created cells, then return them. */
async function settled(name: string, n: number): Promise<DiskCell[]> {
	await expect.poll(() => created(name).length, { timeout: 15_000 }).toBe(n);
	return created(name);
}

/** Every cell id on disk, in document order - what an ordering claim is about. */
const idsOf = (name: string): string[] => onDisk(name).map((c) => c.id);

function seedFixture(name: string): void {
	writeFileSync(
		join(workspace, name),
		JSON.stringify(
			{
				// The markdown cell comes FIRST so that a cell extracted from the chat
				// reply lands at the end of the notebook and one extracted from the
				// markdown cell lands BETWEEN the two - which is what makes "below the
				// cell it came from" an assertion rather than a coincidence of order.
				cells: [
					{ cell_type: 'markdown', id: MD_ID, metadata: {}, source: [MD_CELL_SOURCE] },
					{
						cell_type: 'code',
						id: CHAT_ID,
						metadata: { cellar: { language: 'chat' } },
						source: ['How do I load and aggregate the sales data?'],
						outputs: [{ output_type: 'display_data', data: { 'text/markdown': REPLY, 'text/plain': REPLY }, metadata: {} }],
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

/** A notebook of this test's own (they all mutate the document), opened and rendered. */
async function openFresh(page: Page, name: string): Promise<string> {
	seedFixture(name);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await page.locator(`[data-testid="tree-file"][data-path="${name}"]`).click();
	await expect(page.locator(`[data-testid="cell"][data-cell-id="${CHAT_ID}"]`)).toBeVisible({ timeout: 30_000 });
	// The controls are injected after the render settles, so wait for them rather
	// than for the prose.
	await expect(blocks(page)).toHaveCount(4, { timeout: 15_000 });
	return name;
}

/**
 * Every decorated block on the page, in document order. The markdown CELL's block
 * is index 0 (that cell is first); the reply's python / sql / markdown blocks are
 * 1, 2 and 3.
 */
const blocks = (page: Page) => page.locator('[data-cellar-code-block]');
const MD_CELL_BLOCK_AT = 0;
const PY_AT = 1;
const SQL_AT = 2;
const MD_AT = 3;
const extractBtn = (page: Page, i: number) => blocks(page).nth(i).getByTestId('extract-code');

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available - E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-code-extract-e2e-'));
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

test('the BUTTON creates a cell whose source is byte-identical, typed by the fence', async ({ page }) => {
	test.setTimeout(120_000);
	const nb = await openFresh(page, 'extract-button.ipynb');

	// Brightening on hover moves nothing: the control is out of flow, so the block
	// it belongs to is exactly where it was.
	const before = await blocks(page).nth(PY_AT).boundingBox();
	await blocks(page).nth(PY_AT).hover();
	await expect(extractBtn(page, PY_AT)).toBeVisible();
	expect(await blocks(page).nth(PY_AT).boundingBox()).toEqual(before);

	await extractBtn(page, PY_AT).click();

	const [cell] = await settled(nb, 1);
	expect(sourceOf(cell)).toBe(PY_BLOCK);
	expect(typeOf(cell)).toBe('code');
	// It landed directly below the cell it came from.
	expect(idsOf(nb)).toEqual([MD_ID, CHAT_ID, cell.id]);
});

test('the control covers no code, at rest, hovered, or scrolled to the end', async ({ page }) => {
	test.setTimeout(120_000);
	await openFresh(page, 'extract-overlap.ipynb');

	// The WIDE block: its single line is far longer than the box, so it is the one
	// a corner overlay would cover - and `padding-right` could not save it, since
	// the box scrolls under a control that does not.
	const block = blocks(page).nth(SQL_AT);
	const btn = block.getByTestId('extract-code');
	const code = block.locator('pre > code');

	const overlaps = async () => {
		const [b, c] = [await btn.boundingBox(), await code.boundingBox()];
		if (!b || !c) throw new Error('missing box');
		return b.x < c.x + c.width && c.x < b.x + b.width && b.y < c.y + c.height && c.y < b.y + b.height;
	};

	expect(await overlaps(), 'at rest').toBe(false);
	await block.hover();
	await expect(btn).toBeVisible();
	expect(await overlaps(), 'hovered').toBe(false);
	// Scrolled to the very end, so the LAST characters of the longest line sit at
	// the right edge - where the control is.
	await block.locator('pre').evaluate((el) => (el.scrollLeft = el.scrollWidth));
	expect(await overlaps(), 'scrolled to the end').toBe(false);
});

test('the SHORTCUT extracts the HOVERED block, with the same source and type', async ({ page }) => {
	test.setTimeout(120_000);
	const nb = await openFresh(page, 'extract-shortcut.ipynb');

	// The chord targets the block under the POINTER, so hovering IS the selection.
	// Focus stays on the notebook, which is where it sits while reading a reply -
	// nothing was clicked inside a block.
	await page.locator(`[data-testid="cell"][data-cell-id="${CHAT_ID}"]`).click();
	await blocks(page).nth(SQL_AT).hover();
	await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+e' : 'Control+Shift+e');

	const [cell] = await settled(nb, 1);
	expect(sourceOf(cell)).toBe(SQL_BLOCK);
	// A SQL cell is an nbformat code cell tagged `cellar.language` - the fence's
	// `sql` tag is what put it there.
	expect(cell.cell_type).toBe('code');
	expect(typeOf(cell)).toBe('sql');
});

test('the shortcut acts on the hovered block, not on whichever was extracted last', async ({ page }) => {
	test.setTimeout(120_000);
	const nb = await openFresh(page, 'extract-hover-wins.ipynb');

	// Click block 1's control (which leaves FOCUS on it), then move the pointer to
	// block 2 and fire the chord. Hover must win, or the chord would extract the
	// block the user has already taken - the case `targetCodeBlock` is written for.
	await blocks(page).nth(PY_AT).hover();
	await extractBtn(page, PY_AT).click();
	await settled(nb, 1);

	await blocks(page).nth(SQL_AT).hover();
	await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+e' : 'Control+Shift+e');

	const cells = await settled(nb, 2);
	expect(cells.map(sourceOf)).toEqual([PY_BLOCK, SQL_BLOCK]);
});

test('with NO pointer over any block, FOCUS is what the chord acts on', async ({ page }) => {
	test.setTimeout(120_000);
	const nb = await openFresh(page, 'extract-focus-route.ipynb');

	// The keyboard-only route. Nothing is hovered, so `targetCodeBlock` falls back
	// to `:focus-within` - which jsdom cannot evaluate, so this is the only level
	// that proves the fallback is reachable rather than merely written.
	await page.mouse.move(2, 2);
	await extractBtn(page, SQL_AT).focus();
	await expect(extractBtn(page, SQL_AT)).toBeFocused();
	await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+e' : 'Control+Shift+e');

	const [cell] = await settled(nb, 1);
	expect(sourceOf(cell)).toBe(SQL_BLOCK);
	expect(typeOf(cell)).toBe('sql');
});

test('the control is reachable and activatable by keyboard alone', async ({ page }) => {
	test.setTimeout(120_000);
	const nb = await openFresh(page, 'extract-keyboard.ipynb');

	// It is a real <button>, so it takes focus and its native activation keys - the
	// route that does not depend on the chord at all.
	await page.mouse.move(2, 2);
	await extractBtn(page, PY_AT).focus();
	await page.keyboard.press('Enter');

	const [cell] = await settled(nb, 1);
	expect(sourceOf(cell)).toBe(PY_BLOCK);
});

test('a block containing BACKTICKS and MARKDOWN survives intact, as a markdown cell', async ({ page }) => {
	test.setTimeout(120_000);
	const nb = await openFresh(page, 'extract-backticks.ipynb');

	await blocks(page).nth(MD_AT).hover();
	await extractBtn(page, MD_AT).click();

	const [cell] = await settled(nb, 1);
	expect(sourceOf(cell)).toBe(MD_BLOCK);
	expect(cell.cell_type).toBe('markdown');
	// The three things a re-parse or a re-encode would each destroy separately.
	expect(sourceOf(cell)).toContain('```python');
	expect(sourceOf(cell)).toContain('a < b');
	expect(sourceOf(cell)).toContain('"&amp;"');
});

test("extracting several blocks keeps the reply's reading order", async ({ page }) => {
	test.setTimeout(120_000);
	const nb = await openFresh(page, 'extract-order.ipynb');

	for (const [n, at] of [PY_AT, SQL_AT, MD_AT].entries()) {
		await blocks(page).nth(at).hover();
		await extractBtn(page, at).click();
		await settled(nb, n + 1);
	}

	const cells = await settled(nb, 3);
	// Top-to-bottom in the reply, top-to-bottom in the notebook - NOT reversed,
	// which is what "each one directly below the chat cell" would have produced.
	expect(cells.map(sourceOf)).toEqual([PY_BLOCK, SQL_BLOCK, MD_BLOCK]);
	expect(cells.map(typeOf)).toEqual(['code', 'sql', 'markdown']);
	// The chat cell and its reply are untouched by any of it: same question, same
	// three blocks still rendered in it.
	const chat = onDisk(nb).find((c) => c.id === CHAT_ID)!;
	expect(sourceOf(chat)).toBe('How do I load and aggregate the sales data?');
	await expect(page.locator(`[data-cell-id="${CHAT_ID}"] [data-cellar-code-block]`)).toHaveCount(3);
	// The page now holds FIVE blocks, not four, and that is the rule composing
	// rather than a leak: the markdown cell just created renders in its rendered
	// view, and its own content carries a ```python fence - which is a code block
	// on a notebook markdown surface, so it gets a control like any other.
	await expect(blocks(page)).toHaveCount(5);
});

test("a MARKDOWN CELL's code block extracts too, below THAT cell", async ({ page }) => {
	test.setTimeout(120_000);
	const nb = await openFresh(page, 'extract-mdcell.ipynb');

	await blocks(page).nth(MD_CELL_BLOCK_AT).hover();
	await extractBtn(page, MD_CELL_BLOCK_AT).click();

	const [cell] = await settled(nb, 1);
	expect(sourceOf(cell)).toBe(MD_CELL_BLOCK);
	expect(typeOf(cell)).toBe('code');
	// Below the MARKDOWN cell it came from - so ahead of the chat cell, not after it.
	expect(idsOf(nb)).toEqual([MD_ID, cell.id, CHAT_ID]);
});

test('a repeat inserts AGAIN, and the control says so before the second click', async ({ page }) => {
	test.setTimeout(120_000);
	const nb = await openFresh(page, 'extract-repeat.ipynb');

	const btn = extractBtn(page, PY_AT);
	await expect(btn).toHaveAttribute('aria-label', 'Extract to a new code cell below');

	await blocks(page).nth(PY_AT).hover();
	await btn.click();
	await settled(nb, 1);

	// The check confirms the click landed...
	await expect(btn).toHaveAttribute('data-extracted', 'true');
	// ...and expires, because it is a claim about one click.
	await expect(btn).not.toHaveAttribute('data-extracted', 'true', { timeout: 5_000 });
	// The NAME does not expire: that a repeat makes ANOTHER cell stays true, and
	// saying it before the second click is the whole point.
	await expect(btn).toHaveAttribute('aria-label', 'Extracted - click again for another cell');

	await btn.click();
	const cells = await settled(nb, 2);
	expect(cells.map(sourceOf)).toEqual([PY_BLOCK, PY_BLOCK]);
});

test('a REFUSED add confirms NOTHING - no check, and no "click again"', async ({ page }) => {
	test.setTimeout(120_000);
	const nb = await openFresh(page, 'extract-refused.ipynb');

	// The control must never claim a cell that did not land. An optimistic check
	// would also RENAME the control to "click again for another cell" - a permanent
	// claim about a cell that was never created.
	await page.route('**/api/cells', (route) =>
		route.request().method() === 'POST'
			? route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ ok: false, reason: 'bad-cell-type', message: 'nope' }) })
			: route.continue()
	);

	await blocks(page).nth(PY_AT).hover();
	await extractBtn(page, PY_AT).click();

	// The refused add resyncs the model, so the reply re-renders and the control is
	// rebuilt - wait for that to settle, then assert it is still an OFFER.
	await expect.poll(() => created(nb).length, { timeout: 10_000 }).toBe(0);
	await expect(extractBtn(page, PY_AT)).toHaveAttribute('aria-label', 'Extract to a new code cell below');
	await expect(extractBtn(page, PY_AT)).not.toHaveAttribute('data-extracted', 'true');
});

test('extraction steals no focus and moves no selection', async ({ page }) => {
	test.setTimeout(120_000);
	const nb = await openFresh(page, 'extract-focus.ipynb');

	const chat = page.locator(`[data-testid="cell"][data-cell-id="${CHAT_ID}"]`);
	await chat.click();
	await expect(chat).toHaveAttribute('data-active', 'true');

	await blocks(page).nth(PY_AT).hover();
	await extractBtn(page, PY_AT).click();
	await settled(nb, 1);

	// The user is READING. The cell they were on stays the active one, nothing else
	// became active, and the reply did not scroll away under them.
	await expect(chat).toHaveAttribute('data-active', 'true');
	await expect(page.locator('[data-testid="cell"][data-active="true"]')).toHaveCount(1);
});

test('the shortcut is listed in Settings, and the cell copy controls still work', async ({ page }) => {
	test.setTimeout(120_000);
	await openFresh(page, 'extract-settings.ipynb');

	// Acceptance: the copy affordance the cell already had is unchanged by the
	// decoration. Stubbed rather than read back, for the reason
	// `copy-cell-io.spec.ts` states - a real read needs a platform-varying grant.
	await page.evaluate(() => {
		const w = window as unknown as { __copied: string[] };
		w.__copied = [];
		Object.defineProperty(navigator, 'clipboard', {
			configurable: true,
			value: {
				writeText: (t: string) => {
					w.__copied.push(t);
					return Promise.resolve();
				}
			}
		});
	});
	const chat = page.locator(`[data-testid="cell"][data-cell-id="${CHAT_ID}"]`);
	await chat.getByTestId('copy-input').click();
	await expect(chat.getByTestId('copy-input')).toHaveAttribute('data-copied', 'true');
	expect(await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied)).toEqual([
		'How do I load and aggregate the sales data?'
	]);

	await page.getByTestId('app-menu').click();
	await page.getByTestId('open-settings').click();
	const row = page.locator('[data-shortcut-id="extract-code-block"]');
	await expect(row).toBeVisible();
	await expect(row).toContainText('Extract the hovered code block into a new cell below');
	// Rendered like every other binding, so it is rebindable from here too.
	await expect(row.locator('kbd').first()).toBeVisible();
});
