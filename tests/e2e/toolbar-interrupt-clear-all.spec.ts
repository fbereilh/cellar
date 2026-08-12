import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';
import { scrollToBottom, isCellMounted } from './notebook-scroll';

/**
 * E2E: the two toolbar buttons added beside "Run all" — Interrupt and Clear all
 * outputs. Both are pure SURFACING of actions that already existed (the palette's
 * `kernel-interrupt` / `clear-all-outputs`), so what is proven here is the wiring
 * and the gating, not the underlying kernel/output logic:
 *
 *  - all three buttons render in the toolbar and gate on real state;
 *  - Interrupt is disabled while nothing runs, arms while a run is in flight, and
 *    clicking it really stops the batch (the sleeper ends far short of its sleep
 *    and no later cell runs) — the same effect as the palette command;
 *  - Interrupt stays armed ACROSS a cell-to-cell transition of a bulk run: a
 *    sequential batch leaves nothing running and nothing queued between two cells,
 *    so gating on those alone would drop the button for a round trip per cell;
 *  - Clear all outputs is disabled when there is nothing to clear, clears EVERY
 *    cell including ones virtualization has windowed out (it reads the document
 *    model, not the mounted DOM), and the cleared state is on DISK — asserted
 *    against the `.ipynb` itself, not just the in-memory doc, plus a reload;
 *  - clearing while a cell streams clears that cell too, PERMANENTLY: its output
 *    leaves disk while it is still running and never comes back, because the clear
 *    truncates that run's own accumulator — so `run:end` persists only what the
 *    cell produced afterwards, including the execute_result that closed it, and
 *    the notebook is still rendering (that second element used to land past the end
 *    of the emptied array and leave a hole, which throws).
 *
 * ONE launcher for the whole file (`beforeAll`), like every sibling spec in this
 * suite. Kernels are per notebook, so each test gets its isolation from its OWN
 * seeded `.ipynb` — opened from the file tree — not from its own launcher; every
 * test drives a different notebook, so they do not depend on each other's order.
 */

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

/** One notebook per test — the unit of isolation here, since kernels are per notebook. */
const NB = {
	gating: 'gating.ipynb',
	interrupt: 'interrupt.ipynb',
	bulkGap: 'bulk-gap.ipynb',
	clearAll: 'clear-all.ipynb',
	clearMidRun: 'clear-mid-run.ipynb',
	parityClear: 'parity-clear.ipynb',
	parityInterrupt: 'parity-interrupt.ipynb'
} as const;

type CellSpec = { type: 'code' | 'markdown'; source: string; output?: string };

/** nbformat 4.5 notebook from ordered cell specs; ids are `c0`, `c1`, … */
function buildNotebook(specs: CellSpec[]): string {
	const cells = specs.map((s, i) => {
		const base = { cell_type: s.type, id: `c${i}`, metadata: {}, source: [s.source] };
		if (s.type !== 'code') return base;
		const outputs = s.output ? [{ output_type: 'stream', name: 'stdout', text: [`${s.output}\n`] }] : [];
		return { ...base, execution_count: null, outputs };
	});
	return JSON.stringify({
		cells,
		metadata: { kernelspec: { name: 'python3', display_name: 'python3' } },
		nbformat: 4,
		nbformat_minor: 5
	});
}

/** A long sleeper first, then fast marker cells — for the Interrupt test. */
function sleeperNotebook(): string {
	const specs: CellSpec[] = [{ type: 'code', source: 'import time\ntime.sleep(20)\nsleeper_ran = True' }];
	for (let i = 0; i < 5; i++) specs.push({ type: 'code', source: `marker_${i} = ${i}` });
	return buildNotebook(specs);
}

/**
 * Many cells, EVERY code cell carrying a saved output. Long enough that windowing
 * (on by default) leaves most of them unmounted, which is the point: clear-all must
 * reach a cell that has no DOM at all.
 */
function manyOutputsNotebook(count: number): string {
	const specs: CellSpec[] = [];
	for (let i = 0; i < count; i++) {
		specs.push({ type: 'markdown', source: `## Section ${i}` });
		specs.push({ type: 'code', source: `print(${i})`, output: `${i}` });
	}
	return buildNotebook(specs);
}

/** How many ticks the mid-run streamer prints, one per second. */
const TICKS = 20;
/** Code cells seeded ahead of the streamer, each carrying a saved output. */
const MID_RUN_FILLER = 24;
/** The streamer's cell id — last in the document, after `MID_RUN_FILLER` pairs. */
const STREAM_ID = `c${MID_RUN_FILLER * 2}`;

/**
 * `MID_RUN_FILLER` markdown/code pairs, then the streamer LAST. Long enough that
 * scrolling down to the streamer windows the early cells out of the DOM entirely,
 * which is the case a clear-all must still reach.
 *
 * Every code cell carries a saved output, the streamer included, so its output is
 * really on DISK when the run begins. Ticks read `tick NN end` rather than `tick N`
 * so "produced before the clear" is a substring test that cannot collide (`tick 1`
 * is a substring of `tick 10`). The trailing bare string is an execute_result: a
 * SECOND output element arriving AFTER the clear, which is the shape that used to
 * land at the server's stale index and leave a hole in the client's emptied array.
 */
function streamingNotebook(): string {
	const specs: CellSpec[] = [];
	for (let i = 0; i < MID_RUN_FILLER; i++) {
		specs.push({ type: 'markdown', source: `## Filler ${i}` });
		specs.push({ type: 'code', source: `print("filler ${i}")`, output: `filler ${i}` });
	}
	specs.push({
		type: 'code',
		source: `import time\nfor i in range(${TICKS}):\n    print(f"tick {i:02d} end", flush=True)\n    time.sleep(1)\n"post-clear result"`,
		output: 'saved run'
	});
	return buildNotebook(specs);
}

/**
 * Run a command from the command palette by its label — the OTHER user-facing route
 * to these same two actions, and the one the toolbar buttons are claimed not to
 * diverge from.
 */
async function runViaPalette(page: Page, label: string): Promise<void> {
	await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
	await expect(page.getByTestId('command-palette')).toBeVisible({ timeout: 10_000 });
	await page.getByTestId('command-palette-input').fill(label);
	await expect(page.getByTestId('command-palette-item').first()).toContainText(label);
	await page.getByTestId('command-palette-input').press('Enter');
	await expect(page.getByTestId('command-palette')).toBeHidden({ timeout: 10_000 });
}

/** Open `file` from the file tree in a fresh page and wait for its notebook to render. */
async function openNotebook(page: Page, file: string): Promise<void> {
	await page.goto(baseURL);
	await page.getByTestId('tree-file').filter({ hasText: file }).first().click();
	await expect(page.getByTestId('notebook-toolbar')).toBeVisible({ timeout: 30_000 });
	await expect.poll(async () => page.getByTestId('cell').count(), { timeout: 30_000 }).toBeGreaterThan(0);
}

/** Marker variable names currently defined in `file`'s kernel namespace. */
async function definedMarkers(page: Page, file: string): Promise<string[]> {
	return page.evaluate(async (nb) => {
		const res = await fetch(`/api/kernel/variables?path=${encodeURIComponent(nb)}`);
		if (!res.ok) return [];
		const body = await res.json();
		const vars: { name: string }[] = body.variables ?? body ?? [];
		return vars.map((v) => v.name).filter((n) => n.startsWith('marker_')).sort();
	}, file);
}

type DiskOutput = { text?: string[]; data?: Record<string, string[] | string> };
type DiskCell = { id: string; outputs?: DiskOutput[] };

/** A notebook ON DISK — the persisted document, not the in-memory doc. */
function notebookOnDisk(file: string): DiskCell[] {
	return JSON.parse(readFileSync(join(workspace, file), 'utf8')).cells;
}

/** How many code cells in `file` still hold outputs, read from the `.ipynb` ON DISK. */
function cellsWithOutputsOnDisk(file: string): number {
	return notebookOnDisk(file).filter((c) => (c.outputs?.length ?? 0) > 0).length;
}

/** Ids of the cells in `file` that still hold outputs on disk, in document order. */
function cellIdsWithOutputsOnDisk(file: string): string[] {
	return notebookOnDisk(file)
		.filter((c) => (c.outputs?.length ?? 0) > 0)
		.map((c) => c.id);
}

/**
 * One cell's persisted output as text — stream chunks plus the `text/plain` of any
 * rich element, so an `execute_result` arriving after a mid-run clear is visible
 * here too rather than silently reading as no output.
 */
function outputTextOnDisk(file: string, id: string): string {
	const cell = notebookOnDisk(file).find((c) => c.id === id);
	const asText = (v: string[] | string | undefined): string => (Array.isArray(v) ? v.join('') : (v ?? ''));
	return (cell?.outputs ?? []).map((o) => asText(o.text) + asText(o.data?.['text/plain'])).join('');
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-toolbar-'));
	// One code cell WITHOUT output, so clear-all has nothing to do at load.
	writeFileSync(
		join(workspace, NB.gating),
		buildNotebook([{ type: 'markdown', source: '# Report' }, { type: 'code', source: "print('hi')" }])
	);
	writeFileSync(join(workspace, NB.interrupt), sleeperNotebook());
	// Three cells that each take a beat: long enough that a cell's running state is
	// observable, short enough that the batch is quick. What the test is about is
	// the gap BETWEEN two of them.
	writeFileSync(
		join(workspace, NB.bulkGap),
		buildNotebook(
			[0, 1, 2].map((i) => ({ type: 'code' as const, source: `import time\nstep_${i} = ${i}\ntime.sleep(2)` }))
		)
	);
	writeFileSync(join(workspace, NB.clearAll), manyOutputsNotebook(60));
	writeFileSync(join(workspace, NB.clearMidRun), streamingNotebook());
	// Two code cells, each carrying a saved output, so a clear has something to do
	// twice over — once per surface.
	writeFileSync(
		join(workspace, NB.parityClear),
		buildNotebook([
			{ type: 'code', source: "print('alpha')", output: 'alpha' },
			{ type: 'code', source: "print('beta')", output: 'beta' }
		])
	);
	writeFileSync(join(workspace, NB.parityInterrupt), sleeperNotebook());
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
	workspace = '';
});

test('the toolbar renders Run all, Interrupt and Clear all outputs, each gated on state', async ({ page }) => {
	test.setTimeout(120_000);
	await openNotebook(page, NB.gating);

	const toolbar = page.getByTestId('notebook-toolbar');
	const runAll = toolbar.getByTestId('run-all');
	const interrupt = toolbar.getByTestId('interrupt-all');
	const clearAll = toolbar.getByTestId('clear-all-outputs');

	// All three are in the toolbar, and each is a real labelled control.
	await expect(runAll).toBeVisible();
	await expect(interrupt).toBeVisible();
	await expect(clearAll).toBeVisible();
	await expect(interrupt).toHaveAttribute('aria-label', /interrupt/i);
	await expect(clearAll).toHaveAttribute('aria-label', /clear all outputs/i);

	// Nothing running, nothing to clear.
	await expect(runAll).toBeEnabled();
	await expect(interrupt).toBeDisabled();
	await expect(clearAll).toBeDisabled();

	// Running a cell that prints gives the notebook an output — clear-all arms.
	await page.locator('[data-cell-id="c1"] [data-testid="run"]').click();
	await expect(clearAll).toBeEnabled({ timeout: 60_000 });
});

test('Interrupt is disabled until a run is in flight, then stops the whole batch', async ({ page }) => {
	test.setTimeout(180_000);
	await openNotebook(page, NB.interrupt);

	const interrupt = page.getByTestId('notebook-toolbar').getByTestId('interrupt-all');
	await expect(interrupt).toBeDisabled();

	// Run all: the sleeper runs first, so the markers behind it are not submitted yet.
	await page.getByTestId('notebook-toolbar').getByTestId('run-all').click();
	await expect(page.locator('[data-cell-id="c0"] [data-testid="running-bar"]')).toBeVisible({ timeout: 60_000 });
	await expect(interrupt).toBeEnabled();

	// Let the kernel boot and the sleep genuinely begin.
	await page.waitForTimeout(4000);
	await interrupt.click();

	// The sleeper stops well short of its 20s sleep, and the batch does not continue.
	await expect(page.locator('[data-cell-id="c0"] [data-testid="running-bar"]')).toBeHidden({ timeout: 20_000 });
	await page.waitForTimeout(6000);
	expect(await definedMarkers(page, NB.interrupt)).toEqual([]);

	// With nothing left running the button disarms again.
	await expect(interrupt).toBeDisabled();
});

test('Interrupt stays armed between the cells of a bulk run, and disarms after it', async ({ page }) => {
	test.setTimeout(180_000);
	await openNotebook(page, NB.bulkGap);

	// Widen the inter-cell gap to something observable by delaying the run POST
	// itself. This slows the real request; it invents no state — the gap exists at
	// full speed too, it is just one round trip wide and would make the assertion
	// below a race.
	const GAP_MS = 2000;
	await page.route('**/api/cells/*/run', async (route) => {
		await new Promise((r) => setTimeout(r, GAP_MS));
		await route.continue();
	});

	const interrupt = page.getByTestId('notebook-toolbar').getByTestId('interrupt-all');
	await expect(interrupt).toBeDisabled();

	await page.getByTestId('notebook-toolbar').getByTestId('run-all').click();
	await expect(page.locator('[data-cell-id="c0"] [data-testid="running-bar"]')).toBeVisible({ timeout: 90_000 });
	await expect(interrupt).toBeEnabled();

	// The first cell has finished and the second has not started: the batch is
	// between cells. Single-shot reads — `toBeEnabled()` retries, so it would hide a
	// button that is disabled right now and re-arms when the next cell starts.
	await expect(page.locator('[data-cell-id="c0"] [data-testid="running-bar"]')).toBeHidden({ timeout: 60_000 });
	expect(await interrupt.isDisabled(), 'Interrupt dropped out between two cells of Run all').toBe(false);
	await page.waitForTimeout(GAP_MS / 2);
	expect(await interrupt.isDisabled(), 'Interrupt dropped out between two cells of Run all').toBe(false);

	// The batch really did advance across that gap (so the window above was a
	// cell-to-cell transition, not the end of the run).
	await expect(page.locator('[data-cell-id="c1"] [data-testid="running-bar"]')).toBeVisible({ timeout: 60_000 });
	await expect(interrupt).toBeEnabled();

	// Once the whole batch is done — not merely between cells — it disarms.
	await page.unroute('**/api/cells/*/run');
	await expect(interrupt).toBeDisabled({ timeout: 90_000 });
});

test('Clear all outputs clears every cell — windowed-out ones included — and persists', async ({ page }) => {
	test.setTimeout(180_000);
	const CODE_CELLS = 60;
	await openNotebook(page, NB.clearAll);

	// Windowing is on by default: most cells have no DOM at all, so this really is
	// the "clear must read the model, not the mounted cells" case.
	const mounted = await page.getByTestId('cell').count();
	expect(mounted).toBeLessThan(CODE_CELLS * 2);
	expect(cellsWithOutputsOnDisk(NB.clearAll)).toBe(CODE_CELLS);

	const clearAll = page.getByTestId('notebook-toolbar').getByTestId('clear-all-outputs');
	await expect(clearAll).toBeEnabled();
	await clearAll.click();

	// Every cell's outputs are gone on DISK — including the ones never mounted.
	await expect.poll(() => cellsWithOutputsOnDisk(NB.clearAll), { timeout: 90_000 }).toBe(0);
	await expect(clearAll).toBeDisabled();

	// And the cleared state survives a reload.
	await page.reload();
	await page.getByTestId('tree-file').filter({ hasText: NB.clearAll }).first().click();
	await expect(page.getByTestId('notebook-toolbar').getByTestId('clear-all-outputs')).toBeDisabled();
	expect(cellsWithOutputsOnDisk(NB.clearAll)).toBe(0);
});

/**
 * The two buttons are pure SURFACING: each is claimed to reach the very action its
 * command-palette twin does. The unit suite pins that as a source guard (it cannot
 * mount the component); this is the BEHAVIOURAL half — drive both surfaces against
 * the same notebook and assert they produce the same observable outcome, so a
 * button silently wired to a second, divergent path would fail here.
 */
test('the toolbar`s Clear all outputs does the same thing as its palette twin', async ({ page }) => {
	test.setTimeout(180_000);
	await openNotebook(page, NB.parityClear);
	const clearAll = page.getByTestId('notebook-toolbar').getByTestId('clear-all-outputs');

	// Baseline: both cells hold a saved output on disk.
	expect(cellIdsWithOutputsOnDisk(NB.parityClear)).toEqual(['c0', 'c1']);
	await expect(clearAll).toBeEnabled();

	// Route 1 — the palette command.
	await runViaPalette(page, 'Clear all outputs');
	await expect.poll(() => cellsWithOutputsOnDisk(NB.parityClear), { timeout: 60_000 }).toBe(0);
	await expect(clearAll).toBeDisabled();

	// Put the same two outputs back, this time by really running the cells.
	await page.locator('[data-cell-id="c0"] [data-testid="run"]').click();
	await page.locator('[data-cell-id="c1"] [data-testid="run"]').click();
	await expect.poll(() => cellIdsWithOutputsOnDisk(NB.parityClear), { timeout: 90_000 }).toEqual(['c0', 'c1']);
	await expect(clearAll).toBeEnabled();

	// Route 2 — the new toolbar button. Same end state, from the same starting one.
	await clearAll.click();
	await expect.poll(() => cellsWithOutputsOnDisk(NB.parityClear), { timeout: 60_000 }).toBe(0);
	await expect(clearAll).toBeDisabled();
});

test('the toolbar`s Interrupt does the same thing as its palette twin', async ({ page }) => {
	test.setTimeout(240_000);
	await openNotebook(page, NB.parityInterrupt);
	const interrupt = page.getByTestId('notebook-toolbar').getByTestId('interrupt-all');
	const sleeperBar = page.locator('[data-cell-id="c0"] [data-testid="running-bar"]');
	const sleeperOutput = page.locator('[data-cell-id="c0"] [data-testid="output"]');
	const runSleeper = page.locator('[data-cell-id="c0"] [data-testid="run"]');

	// Route 1 — the palette command stops the 20s sleeper.
	await runSleeper.click();
	await expect(sleeperBar).toBeVisible({ timeout: 90_000 });
	await expect(interrupt).toBeEnabled();
	await page.waitForTimeout(2000);
	await runViaPalette(page, 'Interrupt kernel');
	await expect(sleeperBar).toBeHidden({ timeout: 20_000 });
	await expect(sleeperOutput).toContainText('KeyboardInterrupt', { timeout: 20_000 });
	await expect(interrupt).toBeDisabled();

	// Route 2 — the new toolbar button, from the same starting state. Same outcome:
	// the sleeper ends far short of its 20s sleep, with a KeyboardInterrupt.
	await runSleeper.click();
	await expect(sleeperBar).toBeVisible({ timeout: 60_000 });
	await expect(interrupt).toBeEnabled();
	await page.waitForTimeout(2000);
	await interrupt.click();
	await expect(sleeperBar).toBeHidden({ timeout: 20_000 });
	await expect(sleeperOutput).toContainText('KeyboardInterrupt', { timeout: 20_000 });
	await expect(interrupt).toBeDisabled();

	// Neither route let the batch behind the sleeper run.
	expect(await definedMarkers(page, NB.parityInterrupt)).toEqual([]);
});

test('a mid-run Clear all drops the streaming cell`s output for good and keeps what follows', async ({ page }) => {
	test.setTimeout(240_000);
	// A hole in a cell's outputs throws while rendering and, with no error boundary
	// anywhere in the app, takes the whole notebook's render tree down — so page
	// errors are an assertion here, not diagnostics.
	const pageErrors: string[] = [];
	page.on('pageerror', (e) => pageErrors.push(String(e)));

	await openNotebook(page, NB.clearMidRun);
	// Every code cell starts with an output on disk — the streaming one included.
	expect(cellsWithOutputsOnDisk(NB.clearMidRun)).toBe(MID_RUN_FILLER + 1);

	const runBar = page.locator(`[data-cell-id="${STREAM_ID}"] [data-testid="running-bar"]`);
	const streaming = page.locator(`[data-cell-id="${STREAM_ID}"] [data-testid="output"]`);

	// The streamer is the last cell, so reaching it windows the early ones out.
	await scrollToBottom(page);
	await page.locator(`[data-cell-id="${STREAM_ID}"] [data-testid="run"]`).click();
	await expect(streaming).toContainText('tick 01 end', { timeout: 90_000 });
	expect(await isCellMounted(page, 'c1'), 'c1 should be windowed out from down here').toBe(false);

	await page.getByTestId('notebook-toolbar').getByTestId('clear-all-outputs').click();

	// Wait for EVERY cell's outputs to be off disk. That state is only reachable once
	// the streamer — the last cell, so the last one `clearAll`'s document-order loop
	// reaches — has been cleared too, and nothing persists again until `run:end`, so
	// it is a stable point to read at. It is also the assertion a
	// skip-the-running-cell implementation cannot satisfy: it never clears that cell,
	// and each sibling's clear re-persists the whole document with its live buffer in
	// it, so the streamer's ticks would still be there.
	await expect.poll(() => cellsWithOutputsOnDisk(NB.clearMidRun), { timeout: 60_000 }).toBe(0);
	// Read in ONE shot, so it is provably from INSIDE the run: the cell whose output
	// just went is the one still executing, and the clear reached a cell with no DOM.
	const stillRunning = await runBar.isVisible();
	const midRun = outputTextOnDisk(NB.clearMidRun, STREAM_ID);
	const windowedOut = outputTextOnDisk(NB.clearMidRun, 'c1');
	expect(stillRunning, 'the streamer finished before the mid-run read — raise TICKS').toBe(true);
	expect(midRun).not.toContain('tick 00 end');
	expect(midRun).not.toContain('tick 01 end');
	expect(windowedOut, 'a windowed-out cell was not cleared').toBe('');

	// The run goes on writing, and the cell shows what it produces after the clear.
	await expect(streaming).toContainText(`tick ${String(TICKS - 1).padStart(2, '0')} end`, { timeout: 120_000 });
	await expect(runBar).toBeHidden({ timeout: 120_000 });

	// The clear STICKS: `run:end` persists the run's accumulator, which the clear
	// truncated, so the pre-clear ticks never come back — while everything the cell
	// produced afterwards, including the execute_result that closed it, is kept.
	await expect
		.poll(() => outputTextOnDisk(NB.clearMidRun, STREAM_ID), { timeout: 30_000 })
		.toContain(`tick ${String(TICKS - 1).padStart(2, '0')} end`);
	const persisted = outputTextOnDisk(NB.clearMidRun, STREAM_ID);
	expect(persisted).not.toContain('tick 00 end');
	expect(persisted).not.toContain('tick 01 end');
	expect(persisted, 'the execute_result that arrived after the clear').toContain('post-clear result');
	expect(persisted).not.toContain('saved run');

	// That second element is the shape that used to land past the end of the emptied
	// array and leave a hole: the notebook must still be rendering.
	await expect(streaming).toContainText('post-clear result');
	expect(await page.getByTestId('cell').count()).toBeGreaterThan(0);
	expect(pageErrors).toEqual([]);

	// The cells that were not running stay cleared.
	expect(cellIdsWithOutputsOnDisk(NB.clearMidRun)).toEqual([STREAM_ID]);
});

