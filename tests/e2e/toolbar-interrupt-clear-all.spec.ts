import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

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
 *  - clearing while a cell streams clears that cell too (its produced-so-far
 *    output really leaves disk while it is still running), the run goes on
 *    writing, and at `run:end` the whole transcript — the pre-clear ticks
 *    included — is persisted back from the run's accumulator.
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
	clearMidRun: 'clear-mid-run.ipynb'
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
const TICKS = 14;

/** c1 streams for ~TICKS seconds; c0 and c2 carry saved outputs. */
function streamingNotebook(): string {
	return buildNotebook([
		{ type: 'code', source: 'print("before")', output: 'before' },
		{
			type: 'code',
			source: `import time\nfor i in range(${TICKS}):\n    print(f"tick {i}", flush=True)\n    time.sleep(1)`
		},
		{ type: 'code', source: 'print("after")', output: 'after' }
	]);
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

type DiskCell = { id: string; outputs?: { text?: string[] }[] };

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

/** One cell's persisted stream output, concatenated. */
function outputTextOnDisk(file: string, id: string): string {
	const cell = notebookOnDisk(file).find((c) => c.id === id);
	return (cell?.outputs ?? []).flatMap((o) => o.text ?? []).join('');
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

test('Clear all outputs clears a streaming cell too, and the run keeps writing after it', async ({ page }) => {
	test.setTimeout(180_000);
	await openNotebook(page, NB.clearMidRun);
	expect(cellIdsWithOutputsOnDisk(NB.clearMidRun)).toEqual(['c0', 'c2']);

	// Run the streamer alone and wait until it has emitted its first two ticks, so
	// "produced before the clear" is a fact about specific text rather than timing.
	await page.locator('[data-cell-id="c1"] [data-testid="run"]').click();
	const streaming = page.locator('[data-cell-id="c1"] [data-testid="output"]');
	await expect(streaming).toContainText('tick 1', { timeout: 90_000 });

	await page.getByTestId('notebook-toolbar').getByTestId('clear-all-outputs').click();

	// Poll for the STREAMING cell's own outputs leaving disk — that is the claim, and
	// it is what a skip-the-running-cell implementation would never satisfy. The
	// other cells clear in the same sequential loop, so polling on one of them
	// would fire before this one had been reached.
	await expect.poll(() => cellIdsWithOutputsOnDisk(NB.clearMidRun), { timeout: 60_000 }).not.toContain('c1');
	// One shot, so it is provably still INSIDE the run rather than after some later
	// state settled: the cell whose produced-so-far output just went is the very
	// cell still executing.
	const stillRunning = await page.locator('[data-cell-id="c1"] [data-testid="running-bar"]').isVisible();
	expect(stillRunning, 'the streamer finished before the mid-run read — raise TICKS').toBe(true);

	// The run goes on writing, and what it produces AFTER the clear is kept.
	await expect(page.locator('[data-cell-id="c1"] [data-testid="running-bar"]')).toBeHidden({ timeout: 90_000 });
	await expect.poll(() => outputTextOnDisk(NB.clearMidRun, 'c1'), { timeout: 30_000 }).toContain(`tick ${TICKS - 1}`);
	// ...and so are the ticks from BEFORE it: `run:end` persists `acc.finish()`, the
	// run's whole buffer, which the clear never touched (it emptied the document,
	// not the accumulator). So a mid-run clear frees the streaming cell's outputs
	// only until that run ends, at which point the full transcript is written back.
	// Pinned because it is surprising and because the honest statement of what this
	// button does to a running cell depends on it, not because it is desirable.
	const persisted = outputTextOnDisk(NB.clearMidRun, 'c1');
	expect(persisted).toContain('tick 0');
	expect(persisted).toContain('tick 1');
	// The cells that were not running stay cleared.
	expect(cellIdsWithOutputsOnDisk(NB.clearMidRun)).toEqual(['c1']);
});

