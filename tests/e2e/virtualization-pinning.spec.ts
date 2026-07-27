import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess, spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar, REPO } from './harness';
import {
	paneMetric,
	setScrollTop,
	scrollToBottom,
	isCellMounted,
	cellHeight,
	cellIsOnScreen,
	mountedCellIds,
	markCellNode,
	cellNodeMarked
} from './notebook-scroll';

/**
 * Cell virtualization P3 — the PINNED set, behind the off-by-default flag
 * (report `data/cellar-perf-cell-virtualization-a2/report.md` §6 P3, §5.2, §5.3).
 *
 * Windowing (P2) unmounts every off-screen cell. P3's job is that the handful of
 * cells which must survive that — running, the heads of the kernel's run queue, the
 * selected cell, and the cell holding DOM focus — keep a live node wherever they
 * are. This spec proves the two correctness properties pinning exists for, on the
 * P0 large-notebook harness, windowing pinned ON explicitly with `?virtualize=1`
 * (it is the default since P5, but this spec must exercise the ON path regardless):
 *
 *   A. STREAMING. A cell streaming output while scrolled far off-screen (follow OFF)
 *      keeps a real node whose height GROWS with its output — so the scroll height
 *      tracks the run instead of freezing at a stale spacer, and the finished output
 *      is complete when the user scrolls back. Ordinary far cells stay spacers, so
 *      the window is genuinely still on.
 *   B. QUEUE + JUMP. Cells queued behind that run are mounted while queued (heads),
 *      and the tab's "jump to running cell" spinner lands on the live running cell.
 *   C. EDITING. A cell whose editor holds focus, scrolled far out of the window,
 *      NEVER unmounts (proved by a marker attribute a re-mount would destroy), so
 *      its CodeMirror cursor and undo history survive; after blur it is unmount-
 *      eligible again with its text already flushed.
 *   D. VIEW STATE. The flip side of C: an UNPINNED cell really is destroyed, so any
 *      per-cell view choice that must outlive a scroll belongs to the NOTEBOOK, not
 *      to Cell-local `$state`. A markdown cell opened for raw source editing is
 *      still open for raw editing after it windows out and back - and, the other
 *      half of that decision, is rendered normally again after a RELOAD, because the
 *      notebook holds that choice in session only and never persists it.
 *
 * Boots the REAL launcher (Node app + Jupyter sidecar + python3 kernel), so it SKIPS
 * when that runtime is missing — the vitest unit suite (`tests/unit/virtualization
 * .test.ts`, `pinnedCellIds`/`queuedHeadIds`) is the must-pass gate for the logic.
 */

const CELL_COUNT = 300;
const NB = 'notebook.ipynb';

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

const spacers = (page: Page) => page.locator('[data-testid="cell-spacer"]').count();

/**
 * Open the (already generated) notebook windowed, and settle at the top. The open
 * tab set lives in the per-project server store (not localStorage), so a later test
 * in this file finds the notebook already open rather than the empty state.
 */
async function openWindowed(page: Page): Promise<string[]> {
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}&virtualize=1`);
	const openButton = page.getByTestId('empty-open-notebook');
	if (await openButton.isVisible({ timeout: 10_000 }).catch(() => false)) await openButton.click();
	await expect(page.getByTestId('cell').first()).toBeVisible({ timeout: 30_000 });
	// Windowing is engaged once off-screen cells have collapsed into spacers.
	await expect.poll(() => spacers(page), { timeout: 30_000 }).toBeGreaterThan(0);
	await setScrollTop(page, 0);
	await page.waitForTimeout(300);
	return mountedCellIds(page);
}

/**
 * Fire a run from the page's own fetch with NO originId, so the viewing tab treats
 * it as an external (agent / other-tab) run and reflects it over SSE — the same
 * device `follow-running-cell.spec.ts` uses. Returns immediately; the run streams.
 */
async function runOutOfBand(page: Page, cellId: string, source: string): Promise<void> {
	await page.evaluate(
		({ nb, cellId, source }) => {
			fetch(`/api/cells/${cellId}/run`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ nb, source })
			}).catch(() => {});
		},
		{ nb: NB, cellId, source }
	);
}

/**
 * A cell's output text read from the SERVER model, not the DOM — the only way to
 * observe an off-screen (windowed-out) cell, and the proof that the model updates
 * regardless of what is mounted.
 */
async function modelOutputText(page: Page, cellId: string): Promise<string> {
	return page.evaluate(
		async ({ nb, id }) => {
			const res = await fetch(`/api/notebooks?path=${encodeURIComponent(nb)}`);
			const body = await res.json();
			const cell = body.notebook.cells.find((c: { id: string }) => c.id === id);
			return (cell?.outputs ?? [])
				.map((o: { text?: string | string[] }) => (Array.isArray(o.text) ? o.text.join('') : (o.text ?? '')))
				.join('');
		},
		{ nb: NB, id: cellId }
	);
}

/** A python source that prints `ticks` lines, one every `everyMs`, flushing each. */
const streamSource = (ticks: number, everyMs: number, tag: string) =>
	`import time\nfor i in range(${ticks}):\n    print("${tag} tick %d" % i, flush=True)\n    time.sleep(${everyMs / 1000})\n`;

/**
 * Turn the "follow the running cell" viewer preference OFF. Idempotent: the
 * preference is persisted per project (server-side UI state), so a retry of this
 * spec may find it already off.
 */
async function disableFollow(page: Page): Promise<void> {
	await page.getByTestId('app-menu').click();
	const toggle = page.getByTestId('toggle-follow-running-cell');
	if ((await toggle.getAttribute('aria-pressed')) === 'true') await toggle.click();
	await expect(toggle).toHaveAttribute('aria-pressed', 'false');
	await page.keyboard.press('Escape');
	await page.mouse.click(500, 400);
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-virt-pin-'));
	// The P0 harness seeds a realistic mixed N-cell notebook.
	const gen = spawnSync('node', [join(REPO, 'scripts', 'gen-large-notebook.js'), String(CELL_COUNT), join(workspace, NB)], {
		stdio: 'inherit'
	});
	if (gen.status !== 0) throw new Error('gen-large-notebook.js failed');
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

test('pins the running + queued cells: streaming stays live and honest off-screen', async ({ page }) => {
	test.setTimeout(180_000);

	const mountedAtTop = await openWindowed(page);
	expect(mountedAtTop.length).toBeGreaterThan(3);
	await disableFollow(page);
	await setScrollTop(page, 0);
	await page.waitForTimeout(200);

	// The streaming cell: the 2nd cell of the notebook (mounted while we are at the
	// top, and far above the viewport once we scroll to the bottom).
	const streamId = mountedAtTop[1];
	await runOutOfBand(page, streamId, streamSource(30, 250, 'A')); // ~7.5s of output

	const runningBar = page.locator(`[data-cell-id="${streamId}"] [data-testid="running-bar"]`);
	await expect(runningBar).toBeVisible({ timeout: 30_000 });
	// A re-mount would build a fresh element: this marker is how we prove the node
	// survived the scroll away (it is the same node, so its state survived too).
	expect(await markCellNode(page, streamId, 'stream')).toBe(true);

	// ---- A. Scroll far away, mid-run: the running cell keeps a LIVE node ----
	await scrollToBottom(page);
	await page.waitForTimeout(500);
	expect(await cellIsOnScreen(page, streamId)).toBe(false); // genuinely off-screen
	expect(await isCellMounted(page, streamId)).toBe(true); // …but pinned, so mounted
	expect(await cellNodeMarked(page, streamId, 'stream')).toBe(true); // never re-mounted

	// The window is still doing its job: ordinary cells near the top are spacers.
	const mountedNow = await mountedCellIds(page);
	expect(mountedNow).toContain(streamId);
	expect(mountedNow).not.toContain(mountedAtTop[5]);
	expect(mountedNow.length).toBeLessThan(CELL_COUNT / 3);

	// …and its height GROWS with the streamed output, so the scroll height tracks the
	// run instead of freezing at the spacer height it had when it left the viewport.
	const h0 = (await cellHeight(page, streamId)) ?? 0;
	const sh0 = await paneMetric(page, 'scrollHeight');
	expect(h0).toBeGreaterThan(0);
	await expect
		.poll(async () => (await cellHeight(page, streamId)) ?? 0, { timeout: 20_000 })
		.toBeGreaterThan(h0 + 40);
	const h1 = (await cellHeight(page, streamId)) ?? 0;
	const sh1 = await paneMetric(page, 'scrollHeight');
	// The pane grew by (at least most of) the cell's growth: the scrollbar did not lie.
	expect(sh1 - sh0).toBeGreaterThan((h1 - h0) * 0.5);

	// ---- B. Queue heads stay mounted, and the tab spinner jumps to the run ----
	// Two runs fired at DEEP cells while the streamer holds the kernel: they queue
	// server-side. They sit far outside the window, so only the queued-head pin can
	// keep them mounted. Their ids come from the server model — under windowing the
	// DOM only knows the mounted cells.
	const modelIds: string[] = await page.evaluate(async (nb) => {
		const res = await fetch(`/api/notebooks?path=${encodeURIComponent(nb)}`);
		const body = await res.json();
		return body.notebook.cells.map((c: { id: string }) => c.id);
	}, NB);
	expect(modelIds.length).toBe(CELL_COUNT);

	const queuedA = modelIds[120];
	const queuedB = modelIds[121];
	const neverQueued = modelIds[124];
	await runOutOfBand(page, queuedA, 'import time\ntime.sleep(1)\nprint("queued A")\n');
	await runOutOfBand(page, queuedB, 'import time\ntime.sleep(1)\nprint("queued B")\n');

	// While they wait (the streamer still holds the kernel) both heads are mounted…
	await expect.poll(() => isCellMounted(page, queuedA), { timeout: 20_000 }).toBe(true);
	expect(await isCellMounted(page, queuedB)).toBe(true);
	expect(await cellIsOnScreen(page, queuedA)).toBe(false); // mounted purely by the pin
	expect(await page.locator(`[data-cell-id="${queuedA}"][data-queued="true"]`).count()).toBe(1);
	// …while an equally far, NOT-queued neighbour is still a spacer.
	expect(await isCellMounted(page, neverQueued)).toBe(false);

	// The tab's run indicator jumps to the live running cell (still the streamer).
	await page.getByTestId('tab-jump-running').first().click();
	await expect.poll(() => cellIsOnScreen(page, streamId), { timeout: 15_000 }).toBe(true);

	// ---- The streamed output is COMPLETE once the run ends ----
	await expect(runningBar).toBeHidden({ timeout: 60_000 });
	const outputText = await page
		.locator(`[data-cell-id="${streamId}"] [data-testid="output"]`)
		.innerText();
	expect(outputText).toContain('A tick 0');
	expect(outputText).toContain('A tick 29'); // nothing lost while it streamed off-screen

	// ---- A pin lasts exactly as long as its reason ----
	// Let the queued pair drain (their cells may be spacers by then, so the model —
	// not the DOM — is what says they ran), then scroll away: with nothing running
	// or waiting, all three collapse back into spacers. Pinning costs the window
	// nothing once the run is over.
	await expect
		.poll(() => modelOutputText(page, queuedB), { timeout: 60_000, intervals: [500] })
		.toContain('queued B');
	await scrollToBottom(page);
	await expect.poll(() => isCellMounted(page, streamId), { timeout: 15_000 }).toBe(false);
	await expect.poll(() => isCellMounted(page, queuedA), { timeout: 15_000 }).toBe(false);
	await expect.poll(() => isCellMounted(page, queuedB), { timeout: 15_000 }).toBe(false);
});

test('with windowing on, an interrupt still cancels the queue and releases every pin', async ({ page }) => {
	test.setTimeout(180_000);

	const mountedAtTop = await openWindowed(page);
	await setScrollTop(page, 0);
	await page.waitForTimeout(200);

	// A long streamer holding the kernel, with two deep cells queued behind it.
	const streamId = mountedAtTop[1];
	await runOutOfBand(page, streamId, streamSource(80, 250, 'B')); // ~20s if never interrupted
	const runningBar = page.locator(`[data-cell-id="${streamId}"] [data-testid="running-bar"]`);
	await expect(runningBar).toBeVisible({ timeout: 30_000 });

	const modelIds: string[] = await page.evaluate(async (nb) => {
		const res = await fetch(`/api/notebooks?path=${encodeURIComponent(nb)}`);
		const body = await res.json();
		return body.notebook.cells.map((c: { id: string }) => c.id);
	}, NB);
	const queuedA = modelIds[133];
	const queuedB = modelIds[139];
	await runOutOfBand(page, queuedA, 'interrupt_leak_a = 1\nprint("leak A")\n');
	await runOutOfBand(page, queuedB, 'interrupt_leak_b = 1\nprint("leak B")\n');
	await expect.poll(() => isCellMounted(page, queuedA), { timeout: 20_000 }).toBe(true);

	// Interrupt from the running cell's own stop button (the real user action; the
	// cell is pinned, so the button exists even though we scrolled past it).
	await page.waitForTimeout(1500);
	await page.locator(`[data-cell-id="${streamId}"] [data-testid="cell-interrupt"]`).click();
	await expect(runningBar).toBeHidden({ timeout: 20_000 });

	// The queue is cleared server-side, so nothing behind the interrupt ever ran…
	await page.waitForTimeout(4000);
	expect(await page.getByTestId('queued-indicator').count()).toBe(0);
	expect(await page.getByTestId('running-indicator').count()).toBe(0);
	expect(await modelOutputText(page, queuedA)).not.toContain('leak A');
	expect(await modelOutputText(page, queuedB)).not.toContain('leak B');

	// …and with the queue gone, the queued-head pins are released: scrolling away
	// collapses those cells back into spacers.
	await scrollToBottom(page);
	await expect.poll(() => isCellMounted(page, queuedA), { timeout: 15_000 }).toBe(false);
	expect(await isCellMounted(page, queuedB)).toBe(false);
	// The interrupted cell stays mounted — clicking its stop button selected AND
	// focused it, so it is pinned for those reasons now, not as the running cell.
	// That is the doctrine working, not a leak: a pin lasts as long as its reason.
	expect(await isCellMounted(page, streamId)).toBe(true);
	expect(await page.locator(`[data-cell-id="${streamId}"][data-active="true"]`).count()).toBe(1);
});

test('pins the focused cell: an edited cell scrolled out of the window keeps its editor state', async ({ page }) => {
	test.setTimeout(120_000);

	const mountedAtTop = await openWindowed(page);
	// Pick a code cell near the top with a short source (the generator's `x_i = i*2`).
	const editId = await page.evaluate((ids: string[]) => {
		for (const id of ids) {
			const el = document.querySelector(`[data-cell-id="${CSS.escape(id)}"]`) as HTMLElement | null;
			if (el?.dataset.cellType === 'code') return id;
		}
		return null;
	}, mountedAtTop);
	expect(editId).not.toBeNull();
	const cell = page.locator(`[data-cell-id="${editId}"]`);

	// Summon the editor (the lazy CodeMirror stand-in builds on first edit intent).
	await cell.getByTestId('static-code').click();
	await expect(cell.locator('.cm-editor')).toBeVisible({ timeout: 10_000 });
	const before = (await cell.locator('.cm-content').innerText()).trim();
	await page.keyboard.press('End');
	await page.keyboard.type('  # edited');
	await expect(cell.locator('.cm-content')).toContainText('# edited');
	expect(await markCellNode(page, editId as string, 'edit')).toBe(true);

	// ---- Scroll it far out of the natural window, in steps ----
	const scrollHeight = await paneMetric(page, 'scrollHeight');
	for (const f of [0.25, 0.5, 0.75, 1]) {
		await setScrollTop(page, Math.round(scrollHeight * f));
		await page.waitForTimeout(150);
		// It never unmounts at ANY point of the journey — the pin holds throughout.
		expect(await cellNodeMarked(page, editId as string, 'edit')).toBe(true);
	}
	expect(await cellIsOnScreen(page, editId as string)).toBe(false);
	// The window is genuinely on: mounted count is O(viewport), not O(N).
	expect((await mountedCellIds(page)).length).toBeLessThan(CELL_COUNT / 3);

	// ---- Scroll back: same node, same editor, cursor + undo history intact ----
	await setScrollTop(page, 0);
	await page.waitForTimeout(300);
	expect(await cellNodeMarked(page, editId as string, 'edit')).toBe(true);
	// The caret is still where the user left it: typing continues the same word.
	await page.keyboard.type('!');
	await expect(cell.locator('.cm-content')).toContainText('# edited!');
	// And the undo stack survived the round trip: undoing walks the edit all the way
	// back to the pre-edit source. A re-mounted editor would have an empty history
	// (its doc seeded from `cell.source`), so this could never reach `before`.
	for (let i = 0; i < 8; i++) {
		if ((await cell.locator('.cm-content').innerText()).trim() === before) break;
		await page.keyboard.press('ControlOrMeta+z');
		await page.waitForTimeout(120);
	}
	expect((await cell.locator('.cm-content').innerText()).trim()).toBe(before);

	// ---- After blur the cell is unmount-eligible again (text already flushed) ----
	// Move focus (and the selection) to a different cell, then scroll away: the old
	// cell is no longer pinned by focus/active and collapses back into a spacer.
	const otherId = mountedAtTop.find((id) => id !== editId) as string;
	await page.locator(`[data-cell-id="${otherId}"]`).click({ position: { x: 5, y: 5 } });
	await scrollToBottom(page);
	await expect.poll(() => isCellMounted(page, editId as string), { timeout: 15_000 }).toBe(false);
	// The edit was flushed on blur, so the model kept the text the editor held.
	const persisted: string = await page.evaluate(
		async ({ nb, id }) => {
			const res = await fetch(`/api/notebooks?path=${encodeURIComponent(nb)}`);
			const body = await res.json();
			return body.notebook.cells.find((c: { id: string }) => c.id === id)?.source ?? '';
		},
		{ nb: NB, id: editId }
	);
	expect(persisted.trim()).toBe(before);
});

test('markdown raw-edit mode survives a windowed unmount (the notebook owns it, not the Cell)', async ({
	page
}) => {
	test.setTimeout(120_000);

	const mountedAtTop = await openWindowed(page);
	// The generator's every-6th cell is markdown (heading + prose), so it mounts
	// RENDERED - the state we are about to change.
	const mdId = await page.evaluate((ids: string[]) => {
		for (const id of ids) {
			const el = document.querySelector(`[data-cell-id="${CSS.escape(id)}"]`) as HTMLElement | null;
			if (el?.dataset.cellType === 'markdown') return id;
		}
		return null;
	}, mountedAtTop);
	expect(mdId).not.toBeNull();
	const cell = page.locator(`[data-cell-id="${mdId}"]`);
	await expect(cell.getByTestId('markdown-rendered')).toBeVisible();

	// Open it for RAW editing the way a user does: double-click the rendered body.
	await cell.getByTestId('markdown-rendered').dblclick();
	await expect(cell.getByTestId('markdown-rendered')).toHaveCount(0);
	await expect(cell.locator('.cm-content')).toContainText('## Section', { timeout: 10_000 });

	// Move focus AND the selection to another cell, so NOTHING pins this one: the
	// raw-edit choice has to survive on its own, not because the cell stayed mounted.
	const otherId = mountedAtTop.find((id) => id !== mdId) as string;
	await page.locator(`[data-cell-id="${otherId}"]`).click({ position: { x: 5, y: 5 } });

	// ---- Windowed out: the Cell instance is genuinely destroyed ----
	await scrollToBottom(page);
	await expect.poll(() => isCellMounted(page, mdId as string), { timeout: 15_000 }).toBe(false);

	// ---- Scrolled back: a FRESH Cell instance, still showing the RAW source ----
	// A Cell-local `rawEdit` would have reset here and snapped the cell back to its
	// rendered view; the notebook-owned `rawEdits` map is what keeps it open. The
	// editor is lazily built, so the raw source may render through `StaticCode`:
	// what matters is that the rendered-markdown view is NOT what came back.
	await setScrollTop(page, 0);
	await expect.poll(() => isCellMounted(page, mdId as string), { timeout: 15_000 }).toBe(true);
	await expect(cell.getByTestId('editor-scroll')).toBeVisible({ timeout: 10_000 });
	await expect(cell.getByTestId('editor-scroll')).toContainText('## Section');
	expect(await cell.getByTestId('markdown-rendered').count()).toBe(0);

	// ---- Across a RELOAD: back to rendered ----
	// The other half of the decision: the map is IN-SESSION only (no UI-store key),
	// so a reopened notebook renders its markdown normally rather than greeting the
	// user with every cell they ever edited as raw source. This assertion is what
	// pins that - reintroducing persistence fails here.
	//
	// The wait + round-trip is what makes that pin deterministic rather than a race:
	// `setUi` writes are debounced (300ms) before their PUT, so a reload fired inside
	// that window would find an empty store and pass even WITH persistence. Waiting
	// past the debounce and then reading the store back means any write this session
	// would have made has already reached the server before we reload.
	await page.waitForTimeout(800);
	await page.evaluate(() => fetch('/api/ui-state').then((r) => r.text()));
	await openWindowed(page);
	await expect.poll(() => isCellMounted(page, mdId as string), { timeout: 15_000 }).toBe(true);
	await expect(page.locator(`[data-cell-id="${mdId}"]`).getByTestId('markdown-rendered')).toBeVisible({
		timeout: 10_000
	});
});

test('a consumed remote edit is never replayed onto a newer local edit by a re-mounted cell', async ({
	page
}) => {
	test.setTimeout(120_000);

	const mountedAtTop = await openWindowed(page);
	const editId = (await page.evaluate((ids: string[]) => {
		for (const id of ids) {
			const el = document.querySelector(`[data-cell-id="${CSS.escape(id)}"]`) as HTMLElement | null;
			if (el?.dataset.cellType === 'code') return id;
		}
		return null;
	}, mountedAtTop)) as string;
	expect(editId).not.toBeNull();
	const cell = page.locator(`[data-cell-id="${editId}"]`);

	// ---- 1. An AGENT (out-of-band, no originId) rewrites the cell ----
	// The viewing tab gets `cell:edited` over SSE and adopts it: the cell is
	// unfocused with no editor built, so there is nothing to clobber.
	await page.evaluate(
		({ nb, id }) => {
			return fetch(`/api/cells/${id}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ nb, source: 'agent_wrote = "REMOTE"\n' })
			}).then(() => undefined);
		},
		{ nb: NB, id: editId }
	);
	await expect(cell.getByTestId('editor-scroll')).toContainText('REMOTE', { timeout: 15_000 });

	// ---- 2. The USER then edits it locally and blurs (flushing the edit) ----
	await cell.getByTestId('static-code').click();
	await expect(cell.locator('.cm-editor')).toBeVisible({ timeout: 10_000 });
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.type('user_wrote = "LOCAL"');
	const otherId = mountedAtTop.find((id) => id !== editId) as string;
	await page.locator(`[data-cell-id="${otherId}"]`).click({ position: { x: 5, y: 5 } });
	await expect
		.poll(
			async () =>
				page.evaluate(
					async ({ nb, id }) => {
						const res = await fetch(`/api/notebooks?path=${encodeURIComponent(nb)}`);
						const body = await res.json();
						return body.notebook.cells.find((c: { id: string }) => c.id === id)?.source ?? '';
					},
					{ nb: NB, id: editId }
				),
			{ timeout: 15_000 }
		)
		.toContain('LOCAL');

	// ---- 3. Window it out and back: the fresh Cell must NOT replay the remote ----
	// `cell.remoteEdit` is a one-shot command consumed when it was handled in step 1.
	// Left uncleared, the re-mounted instance (whose per-instance `appliedRemote`
	// dedupe reset) re-adopts it, silently reverting the user's newer text - and
	// marking it saved, so nothing ever corrects the divergence from the server.
	await scrollToBottom(page);
	await expect.poll(() => isCellMounted(page, editId), { timeout: 15_000 }).toBe(false);
	await setScrollTop(page, 0);
	await expect.poll(() => isCellMounted(page, editId), { timeout: 15_000 }).toBe(true);
	await page.waitForTimeout(500);
	await expect(cell.getByTestId('editor-scroll')).toContainText('LOCAL');
	expect(await cell.getByTestId('editor-scroll').innerText()).not.toContain('REMOTE');
});
