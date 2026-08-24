import { test, expect, type Page, type Locator } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * The cell row's two STATE toggles - nbdev export, and hidden-from-agent -
 * operated from the row itself with no menu open.
 *
 * The rules are unit-tested (`tests/unit/cell-row-toggles.test.ts`). What only a
 * real browser proves is the part that IS the feature: that the controls are
 * reachable without opening anything, that a flip is visible immediately and
 * survives a reload having reached the `.ipynb`, that it moves NOTHING else in
 * the row - including mid-run, while the elapsed clock is ticking through a
 * digit change, which is the one moment the row's own layout is under pressure -
 * and that the keyboard reaches both with a state that a screen reader can read.
 *
 * Boots the REAL launcher, so it SKIPS when that runtime is missing.
 */

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

const NB = 'notebook.ipynb';

const MD = 'md000000-0000-4000-8000-00000000000a';
const CODE = 'code0000-0000-4000-8000-00000000000b';
const SLEEP = 'slep0000-0000-4000-8000-00000000000c';
const SQL = 'sql00000-0000-4000-8000-00000000000d';
const RAW = 'raw00000-0000-4000-8000-00000000000e';

function notebookJson(): string {
	const cell = (
		id: string,
		cell_type: string,
		source: string,
		cellar?: Record<string, unknown>
	) => ({
		cell_type,
		id,
		metadata: cellar ? { cellar } : {},
		source: [source],
		...(cell_type === 'code' ? { execution_count: null, outputs: [] } : {})
	});
	return JSON.stringify(
		{
			cells: [
				cell(MD, 'markdown', '# Toggles'),
				cell(CODE, 'code', 'x = 1'),
				cell(SLEEP, 'code', 'import time\ntime.sleep(14)'),
				cell(SQL, 'code', 'select 1', { language: 'sql' }),
				cell(RAW, 'raw', 'frontmatter')
			],
			metadata: { kernelspec: { display_name: 'python3', language: 'python', name: 'python3' } },
			nbformat: 4,
			nbformat_minor: 5
		},
		null,
		1
	);
}

const cellEl = (page: Page, id: string) => page.locator(`[data-cell-id="${id}"]`);
const onDisk = () =>
	JSON.parse(readFileSync(join(workspace, NB), 'utf8')) as {
		cells: Array<{ id: string; metadata?: { cellar?: Record<string, unknown> } }>;
	};
const diskCellar = (id: string) => onDisk().cells.find((c) => c.id === id)?.metadata?.cellar ?? {};

/**
 * SETTLE before probing: the shell paints either the empty state or an
 * already-open notebook, and probing before either arrives reports the button
 * invisible, turns the click into a no-op, and then times out on a notebook
 * nothing ever opened. Needed after a RELOAD as much as after the first goto -
 * which is how this file first failed, under full-suite load only.
 */
async function settleNotebook(page: Page): Promise<void> {
	const emptyBtn = page.getByTestId('empty-open-notebook');
	const firstCell = page.getByTestId('cell').first();
	await expect(emptyBtn.or(firstCell).first()).toBeVisible({ timeout: 30_000 });
	if (await emptyBtn.isVisible()) await emptyBtn.click();
	await expect(firstCell).toBeVisible({ timeout: 30_000 });
}

async function openNotebook(page: Page): Promise<void> {
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await settleNotebook(page);
}

/** Every cell renders its own "⋮" popover, so ask how many are actually OPEN. */
const openMenus = (page: Page) => page.locator('[data-testid="cell-actions-menu"]:popover-open');

/** Put a toggle into a known state without depending on any other test. */
async function setToggle(cell: Locator, testid: string, on: boolean): Promise<void> {
	const btn = cell.getByTestId(testid);
	if ((await btn.getAttribute('aria-pressed')) !== String(on)) await btn.click();
	await expect(btn).toHaveAttribute('aria-pressed', String(on));
}

/** The x of every control in this cell's row, so a flip can be shown to move none. */
async function rowPositions(cell: Locator): Promise<Record<string, number>> {
	const out: Record<string, number> = {};
	for (const t of [
		'cell-collapse-toggle',
		'drag-handle',
		'run',
		'copy-input',
		'cell-id-copy',
		'cell-insert-above',
		'move-up',
		'delete',
		'cell-actions'
	]) {
		const el = cell.getByTestId(t);
		if (!(await el.count())) continue;
		const bb = await el.boundingBox();
		if (bb) out[t] = Math.round(bb.x * 100) / 100;
	}
	return out;
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available - E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-row-toggles-'));
	writeFileSync(join(workspace, NB), notebookJson());
	const booted = await bootCellar(workspace);
	launcher = booted.proc;
	baseURL = booted.url;
});

test.afterAll(() => {
	if (launcher) killCellar(launcher);
	if (workspace && existsSync(workspace)) rmSync(workspace, { recursive: true, force: true });
});

test('both toggles are in the row, and no menu is opened to reach them', async ({ page }) => {
	await openNotebook(page);
	const cell = cellEl(page, CODE);

	// visible without any disclosure first - the whole point of the change
	await expect(cell.getByTestId('toggle-export')).toBeVisible();
	await expect(cell.getByTestId('toggle-agent-hidden')).toBeVisible();
	await expect(openMenus(page)).toHaveCount(0);

	await setToggle(cell, 'toggle-export', true);
	await setToggle(cell, 'toggle-agent-hidden', true);

	// no popover ever opened - neither click went through the "⋮" menu
	await expect(openMenus(page)).toHaveCount(0);

	// and the menu keeps no duplicate of either
	await cell.getByTestId('cell-actions').click();
	const menu = cell.getByTestId('cell-actions-menu');
	await expect(menu).toBeVisible();
	await expect(menu.getByTestId('toggle-export')).toHaveCount(0);
	await expect(menu.getByTestId('toggle-agent-hidden')).toHaveCount(0);
	await expect(menu.getByTestId('toggle-imports-role')).toBeVisible();
	await page.keyboard.press('Escape');

	await setToggle(cell, 'toggle-export', false);
	await setToggle(cell, 'toggle-agent-hidden', false);
});

test('each flip reaches the .ipynb and survives a reload', async ({ page }) => {
	await openNotebook(page);
	const cell = cellEl(page, CODE);

	await setToggle(cell, 'toggle-export', true);
	await setToggle(cell, 'toggle-agent-hidden', true);
	await expect.poll(() => diskCellar(CODE).export).toBe(true);
	await expect.poll(() => diskCellar(CODE).hidden_from_agent).toBe(true);

	await setToggle(cell, 'toggle-export', false);
	await setToggle(cell, 'toggle-agent-hidden', false);

	// showing DELETES the key rather than storing false, so a visible cell's
	// metadata is what it was before it was ever hidden - no git noise
	await expect.poll(() => 'export' in diskCellar(CODE)).toBe(false);
	await expect.poll(() => 'hidden_from_agent' in diskCellar(CODE)).toBe(false);

	await page.reload();
	await settleNotebook(page);
	await expect(cellEl(page, CODE).getByTestId('toggle-export')).toHaveAttribute('aria-pressed', 'false');
	await expect(cellEl(page, CODE).getByTestId('toggle-agent-hidden')).toHaveAttribute('aria-pressed', 'false');
});

test('offered exactly where each applies', async ({ page }) => {
	await openNotebook(page);
	// hide-from-agent is UNGATED - a markdown cell's prose and a raw cell's
	// frontmatter are as much a thing to withhold as a code cell's source
	for (const id of [MD, CODE, SQL, RAW]) {
		await expect(cellEl(page, id).getByTestId('toggle-agent-hidden'), `agent toggle on ${id}`).toBeVisible();
	}
	// export is offered only where a cell can carry it: a plain Python code cell.
	// A SQL cell is an nbformat `code` cell, so this is the case a `cell_type`
	// test would get wrong - its raw SQL would land in a git-tracked .py module.
	await expect(cellEl(page, CODE).getByTestId('toggle-export')).toBeVisible();
	for (const id of [MD, SQL, RAW]) {
		await expect(cellEl(page, id).getByTestId('toggle-export'), `export toggle on ${id}`).toHaveCount(0);
	}
});

test('hiding a markdown cell works from its row and persists', async ({ page }) => {
	await openNotebook(page);
	const md = cellEl(page, MD);
	await md.getByTestId('toggle-agent-hidden').click();
	await expect(md.getByTestId('toggle-agent-hidden')).toHaveAttribute('aria-pressed', 'true');
	await expect.poll(() => diskCellar(MD).hidden_from_agent).toBe(true);
	await md.getByTestId('toggle-agent-hidden').click();
	await expect.poll(() => 'hidden_from_agent' in diskCellar(MD)).toBe(false);
});

test('toggling moves nothing else in the row', async ({ page }) => {
	await openNotebook(page);
	const cell = cellEl(page, CODE);
	await setToggle(cell, 'toggle-export', false);
	await setToggle(cell, 'toggle-agent-hidden', false);
	const before = await rowPositions(cell);

	await setToggle(cell, 'toggle-export', true);
	expect(await rowPositions(cell)).toEqual(before);

	await setToggle(cell, 'toggle-agent-hidden', true);
	expect(await rowPositions(cell)).toEqual(before);

	await setToggle(cell, 'toggle-export', false);
	await setToggle(cell, 'toggle-agent-hidden', false);
	expect(await rowPositions(cell)).toEqual(before);
});

test('and moves nothing while the cell is running and its clock is ticking', async ({ page }) => {
	test.setTimeout(120_000);
	await openNotebook(page);
	const cell = cellEl(page, SLEEP);
	await cell.getByTestId('run').click();
	await expect(cell.getByTestId('running-indicator')).toBeVisible({ timeout: 60_000 });

	// wait out the 9s -> 10s digit change, the moment the reserved elapsed box
	// exists for: an unreserved clock shifts the controls beside it there
	await expect(cell.getByTestId('running-elapsed')).toHaveText('9s', { timeout: 30_000 });
	const before = await rowPositions(cell);
	await expect(cell.getByTestId('running-elapsed')).toHaveText('10s', { timeout: 5_000 });

	await cell.getByTestId('toggle-export').click();
	await cell.getByTestId('toggle-agent-hidden').click();
	await expect(cell.getByTestId('toggle-agent-hidden')).toHaveAttribute('aria-pressed', 'true');
	await expect(cell.getByTestId('running-elapsed')).toHaveText('11s', { timeout: 5_000 });

	expect(await rowPositions(cell)).toEqual(before);

	await expect(cell.getByTestId('running-indicator')).toBeHidden({ timeout: 60_000 });
	await cell.getByTestId('toggle-export').click();
	await cell.getByTestId('toggle-agent-hidden').click();
});

test('keyboard reaches both, and the state is in the accessibility tree', async ({ page }) => {
	await openNotebook(page);
	const cell = cellEl(page, CODE);
	const exp = cell.getByTestId('toggle-export');
	const hid = cell.getByTestId('toggle-agent-hidden');
	await setToggle(cell, 'toggle-export', false);
	await setToggle(cell, 'toggle-agent-hidden', false);

	// They follow the copy controls they were styled after, and are adjacent to
	// each other. The number of Tabs between is deliberately NOT asserted:
	// `copy-output` is disabled on a cell with no output, and a disabled button
	// is skipped - which would make the count a fact about this fixture rather
	// than about the tab order.
	expect(
		await cell.getByTestId('copy-input').evaluate(
			(a, b) => !!(a.compareDocumentPosition(b!) & Node.DOCUMENT_POSITION_FOLLOWING),
			await exp.elementHandle()
		)
	).toBe(true);

	await cell.getByTestId('copy-input').focus();
	for (let i = 0; i < 4 && !(await exp.evaluate((el) => el === document.activeElement)); i++)
		await page.keyboard.press('Tab');
	await expect(exp).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(exp).toHaveAttribute('aria-pressed', 'true');

	// the two are adjacent, so exactly one Tab separates them
	await page.keyboard.press('Tab');
	await expect(hid).toBeFocused();
	await page.keyboard.press(' ');
	await expect(hid).toHaveAttribute('aria-pressed', 'true');

	// a toggle button's NAME stays put while `aria-pressed` carries the state, so
	// a screen reader is never told two things at once
	await expect(exp).toHaveAttribute('aria-label', "Export this cell to the notebook's .py module");
	await expect(hid).toHaveAttribute('aria-label', 'Hide this cell from AI agents');
	// the sighted tooltip DOES track the state
	await expect(hid).toHaveAttribute('title', /Hidden from AI agents/);

	await page.keyboard.press('Enter');
	await expect(hid).toHaveAttribute('aria-pressed', 'false');
	await expect(hid).toHaveAttribute('title', /Visible to AI agents/);
	await setToggle(cell, 'toggle-export', false);
});

test('a second tab sees a flip made in the first', async ({ page, context }) => {
	await openNotebook(page);
	const other = await context.newPage();
	await openNotebook(other);

	await setToggle(cellEl(page, CODE), 'toggle-agent-hidden', true);
	// the cell:visibility event is what carries this - without it the other tab
	// stays stale until it reloads
	await expect(cellEl(other, CODE).getByTestId('toggle-agent-hidden')).toHaveAttribute(
		'aria-pressed',
		'true',
		{ timeout: 15_000 }
	);
	await setToggle(cellEl(page, CODE), 'toggle-agent-hidden', false);
	await expect(cellEl(other, CODE).getByTestId('toggle-agent-hidden')).toHaveAttribute(
		'aria-pressed',
		'false',
		{ timeout: 15_000 }
	);
	await other.close();
});

test('a hide that does not save reverts and says the cell is still visible', async ({ page }) => {
	await openNotebook(page);
	const cell = cellEl(page, CODE);
	await setToggle(cell, 'toggle-agent-hidden', false);
	const before = JSON.stringify(diskCellar(CODE));

	// Fail ONLY this write. Hiding a cell from agents is a WITHHOLDING control, so
	// unlike its preference-shaped neighbours a swallowed failure would leave the
	// row claiming a concealment the document never took.
	await page.route('**/api/cells/**', async (route) => {
		const req = route.request();
		if (req.method() === 'PATCH' && (req.postData() ?? '').includes('hiddenFromAgent')) {
			await route.fulfill({ status: 500, contentType: 'application/json', body: '{"ok":false}' });
			return;
		}
		await route.continue();
	});

	try {
		await cell.getByTestId('toggle-agent-hidden').click();
		// it goes back, rather than sitting pressed over a cell agents can still read
		await expect(cell.getByTestId('toggle-agent-hidden')).toHaveAttribute('aria-pressed', 'false');
		// and SAYS what is true, on the shell's own transient notice line (asserted
		// first - it self-dismisses after NOTICE_TIMEOUT_MS)
		await expect(page.getByTestId('app-notice')).toContainText('still VISIBLE to AI agents');
		// nothing reached the .ipynb
		expect(JSON.stringify(diskCellar(CODE))).toBe(before);
	} finally {
		await page.unroute('**/api/cells/**');
	}

	// and the very next flip, unblocked, still works - the failure left no residue
	await setToggle(cell, 'toggle-agent-hidden', true);
	await expect.poll(() => diskCellar(CODE).hidden_from_agent).toBe(true);
	await setToggle(cell, 'toggle-agent-hidden', false);
	await expect.poll(() => 'hidden_from_agent' in diskCellar(CODE)).toBe(false);
});

test('a failed hide that another writer superseded neither reverts nor claims anything', async ({
	page,
	request
}) => {
	await openNotebook(page);
	const cell = cellEl(page, MD);
	const toggle = cell.getByTestId('toggle-agent-hidden');
	await setToggle(cell, 'toggle-agent-hidden', false);

	// HOLD this page's write open, so the window in which another writer can take
	// the cell is a real interleaving rather than a race we hope to hit.
	let release: (() => Promise<void>) | null = null;
	await page.route('**/api/cells/**', async (route) => {
		const req = route.request();
		if (req.method() === 'PATCH' && (req.postData() ?? '').includes('hiddenFromAgent') && !release) {
			release = () =>
				route.fulfill({ status: 500, contentType: 'application/json', body: '{"ok":false}' });
			return;
		}
		await route.continue();
	});

	try {
		await toggle.click();
		await expect(toggle).toHaveAttribute('aria-pressed', 'true');
		await expect.poll(() => release !== null).toBe(true);

		// An agent (or another tab) hides the SAME cell while our write is in flight.
		// This goes through Playwright's own request context, so `page.route` does not
		// intercept it, and the foreign originId means the page applies the resulting
		// cell:visibility rather than echo-suppressing it.
		const res = await request.patch(`${baseURL}/api/cells/${MD}`, {
			data: { hiddenFromAgent: true, nb: NB, originId: 'other-tab' }
		});
		expect(res.ok()).toBe(true);

		// Proving the PAGE applied that event is the whole hinge of this test, and a
		// disk poll cannot do it: `setVisibility` persists BEFORE it emits, so a true
		// read on disk says only that the SERVER wrote. Instead write a SECOND foreign
		// change to a DIFFERENT cell and wait for THAT toggle to render: SSE for one
		// notebook is ordered into the one subscriber, so observing the second event
		// proves the first was already applied - and it is the first that bumps the
		// generation this test is about.
		const marker = await request.patch(`${baseURL}/api/cells/${CODE}`, {
			data: { hiddenFromAgent: true, nb: NB, originId: 'other-tab' }
		});
		expect(marker.ok()).toBe(true);
		await expect(cellEl(page, CODE).getByTestId('toggle-agent-hidden')).toHaveAttribute(
			'aria-pressed',
			'true',
			{ timeout: 15_000 }
		);

		// only now does OUR write fail. `route.fulfill` resolves when the response is
		// DISPATCHED, not when the page's fetch has settled and the revert has run, and
		// both assertions below already hold at t=0 - so without waiting for the page to
		// receive the 500 they would pass on their first poll whatever the code did.
		const failed = page.waitForResponse(
			(r) => r.url().includes(`/api/cells/${MD}`) && r.request().method() === 'PATCH'
		);
		await release!();
		await failed;
		await page.waitForTimeout(300); // the handler microtask that would revert

		// The cell is hidden and the server says so, so nothing may put it back or
		// announce otherwise. VERIFIED BY MUTATION to fail under the value-equality
		// form this replaced: swapping the generation check back for "current value
		// === what we wrote" makes this exact assertion report aria-pressed "false" -
		// the revert fires and the notice claims the cell is still visible. That is
		// what makes these assertions load-bearing rather than decorative, and why the
		// synchronization above is not optional: without it they pass on their first
		// poll, before the page has even received the 500.
		await expect(toggle).toHaveAttribute('aria-pressed', 'true');
		await expect(page.getByTestId('app-notice')).toHaveCount(0);
		expect(diskCellar(MD).hidden_from_agent).toBe(true);
	} finally {
		await page.unroute('**/api/cells/**');
		// leave the shared notebook as found - the marker cell belongs to other tests
		await request
			.patch(`${baseURL}/api/cells/${CODE}`, {
				data: { hiddenFromAgent: false, nb: NB, originId: 'other-tab' }
			})
			.catch(() => {});
	}

	await setToggle(cell, 'toggle-agent-hidden', false);
	await expect.poll(() => 'hidden_from_agent' in diskCellar(MD)).toBe(false);
});

test('a failed hide superseded across a load() refetch still claims nothing', async ({
	page,
	request
}) => {
	// The generation guard's THIRD carrier: `load()` replaces `cells` wholesale, so it
	// supersedes every in-flight local write at once and clears the ownership map
	// rather than bumping per cell. That clear is what made the token minting
	// load-bearing - counted per cell as `(current ?? 0) + 1`, a cleared map re-issues
	// the SAME token to the next write, so a failing write that was the cell's first
	// (the ordinary case) read as still owning a cell another writer had taken. This
	// drives that exact interleaving through a REAL carrier: a checkpoint restore
	// publishes `notebook:restored`, which every tab refetches on.
	//
	// VERIFIED BY MUTATION: minting the token per cell again -
	// `agentVisibilitySeq.set(id, (agentVisibilitySeq.get(id) ?? 0) + 1)` - fails the
	// final assertions with aria-pressed "false". The write that fails here is a
	// HIDE, so the notice that comes with it is "That cell is still VISIBLE to AI
	// agents - hiding it was not saved", over a document that holds it HIDDEN. It
	// passes with the single monotonic counter restored.

	// Normalize through the SERVER, never a click: the collision needs OUR click to be
	// this cell's first local write in this component's life, and a click would spend
	// that first token on the setup.
	await request.patch(`${baseURL}/api/cells/${RAW}`, {
		data: { hiddenFromAgent: false, nb: NB, originId: 'other-tab' }
	});
	await openNotebook(page); // a fresh component, so the ownership map starts empty
	const cell = cellEl(page, RAW);
	const toggle = cell.getByTestId('toggle-agent-hidden');
	await expect(toggle).toHaveAttribute('aria-pressed', 'false');

	// The state the restore below returns to - taken with the notebook exactly as this
	// test found it, so the restore also leaves it that way.
	const created = await request.post(`${baseURL}/api/checkpoints`, {
		data: { path: NB, action: 'create', label: 'aba-guard' }
	});
	expect(created.ok()).toBe(true);
	const checkpointId = (await created.json()).created.id as string;

	let release: (() => Promise<void>) | null = null;
	await page.route('**/api/cells/**', async (route) => {
		const req = route.request();
		if (req.method() === 'PATCH' && (req.postData() ?? '').includes('hiddenFromAgent') && !release) {
			release = () =>
				route.fulfill({ status: 500, contentType: 'application/json', body: '{"ok":false}' });
			return;
		}
		await route.continue();
	});

	try {
		await toggle.click();
		await expect(toggle).toHaveAttribute('aria-pressed', 'true');
		await expect.poll(() => release !== null).toBe(true);

		// Now the carrier. Waiting for the toggle to fall BACK to "false" is what makes
		// the interleaving deterministic rather than hoped-for: only `load()` can undo
		// the optimistic hide (it replaces `cells` with the checkpoint's visible RAW
		// cell), so observing it proves the refetch landed and therefore that the map
		// was cleared. Sequencing matters - a foreign event applied BEFORE the clear
		// mints a distinct token even under the broken form, and the bug would hide.
		const restored = await request.post(`${baseURL}/api/checkpoints`, {
			data: { path: NB, action: 'restore', id: checkpointId, originId: 'other-tab' }
		});
		expect(restored.ok()).toBe(true);
		await expect(toggle).toHaveAttribute('aria-pressed', 'false', { timeout: 15_000 });

		// An agent (or another tab) takes the cell while our write is still in flight.
		// Its arrival is directly observable here - the restore put the toggle back to
		// "false", so it flipping to "true" IS the event being applied - which is why
		// this needs none of the marker-cell indirection its sibling test does.
		const foreign = await request.patch(`${baseURL}/api/cells/${RAW}`, {
			data: { hiddenFromAgent: true, nb: NB, originId: 'other-tab' }
		});
		expect(foreign.ok()).toBe(true);
		await expect(toggle).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 });

		// Only now does OUR write fail. `route.fulfill` resolves when the response is
		// dispatched, not when the page's fetch has settled, and both assertions below
		// already hold at t=0 - so without waiting for the page to receive the 500 they
		// would pass on their first poll whatever the code did.
		const failed = page.waitForResponse(
			(r) => r.url().includes(`/api/cells/${RAW}`) && r.request().method() === 'PATCH'
		);
		await release!();
		await failed;
		await page.waitForTimeout(300); // the handler microtask that would revert

		// The document holds the cell HIDDEN, so nothing may show it or say otherwise.
		await expect(toggle).toHaveAttribute('aria-pressed', 'true');
		await expect(page.getByTestId('app-notice')).toHaveCount(0);
		expect(diskCellar(RAW).hidden_from_agent).toBe(true);
	} finally {
		await page.unroute('**/api/cells/**');
	}

	// leave the shared notebook as found
	await setToggle(cell, 'toggle-agent-hidden', false);
	await expect.poll(() => 'hidden_from_agent' in diskCellar(RAW)).toBe(false);
});

test('two rapid flips of one toggle land in the order they were clicked', async ({ page }) => {
	// Two flips of the SAME cell are two PATCHes of the same field to the same URL.
	// Unserialized, if they settle out of order the server ends on the FIRST click's
	// value while the row shows the SECOND's - and silently, since both responses are
	// ok (no revert, no notice) and both `cell:visibility` echoes carry this tab's
	// originId (both suppressed). This is the disclosure control, so the row and the
	// document may not diverge even in a small window.
	//
	// The fault is injected at DELIVERY, not at the response: the first PATCH is held
	// in the route handler for a second and a half before it is continued, so without
	// client-side chaining the second request reaches the server first and the server
	// settles on the first click's value. With the chaining the second fetch is not
	// issued until the first has settled, so the order cannot invert.
	await openNotebook(page);
	const cell = cellEl(page, SQL);
	const toggle = cell.getByTestId('toggle-agent-hidden');
	await setToggle(cell, 'toggle-agent-hidden', false);

	let sent = 0;
	let settled = 0;
	page.on('response', (r) => {
		if (r.url().includes(`/api/cells/${SQL}`) && r.request().method() === 'PATCH') settled++;
	});
	await page.route('**/api/cells/**', async (route) => {
		const req = route.request();
		if (req.method() === 'PATCH' && (req.postData() ?? '').includes('hiddenFromAgent')) {
			sent++;
			if (sent === 1) await new Promise((r) => setTimeout(r, 1500));
		}
		await route.continue();
	});

	try {
		await toggle.click(); // hide
		await expect(toggle).toHaveAttribute('aria-pressed', 'true');
		await toggle.click(); // and immediately show again

		// The optimistic apply must stay IMMEDIATE - serializing the fetch must not
		// serialize the row. Asserted while the first write is demonstrably still in
		// flight, which is the only window where putting the apply behind the await
		// would show.
		expect(settled).toBeLessThan(2);
		expect(await toggle.getAttribute('aria-pressed')).toBe('false');

		await expect.poll(() => settled, { timeout: 20_000 }).toBe(2);
		await page.waitForTimeout(300);

		// The row says visible; the document must too.
		await expect(toggle).toHaveAttribute('aria-pressed', 'false');
		expect('hidden_from_agent' in diskCellar(SQL)).toBe(false);
	} finally {
		await page.unroute('**/api/cells/**');
	}
});

test('every control stays reachable inside the card when the row is narrow', async ({ page }) => {
	await openNotebook(page);
	const cell = cellEl(page, CODE);
	// the card is `overflow-hidden`, so anything past its edge is CLIPPED rather
	// than merely cramped - the row wraps instead
	await page.setViewportSize({ width: 700, height: 900 });
	await page.waitForTimeout(400);
	const card = await cell.boundingBox();
	expect(card).not.toBeNull();
	for (const t of ['toggle-export', 'toggle-agent-hidden', 'delete', 'cell-actions', 'type-toggle']) {
		const bb = await cell.getByTestId(t).boundingBox();
		expect(bb, t).not.toBeNull();
		expect(bb!.x, `${t} left edge`).toBeGreaterThanOrEqual(card!.x - 0.5);
		expect(bb!.x + bb!.width, `${t} right edge`).toBeLessThanOrEqual(card!.x + card!.width + 0.5);
	}
	// and it is still operable there
	await cell.getByTestId('toggle-agent-hidden').click();
	await expect(cell.getByTestId('toggle-agent-hidden')).toHaveAttribute('aria-pressed', 'true');
	await cell.getByTestId('toggle-agent-hidden').click();
	await page.setViewportSize({ width: 1280, height: 900 });
});
