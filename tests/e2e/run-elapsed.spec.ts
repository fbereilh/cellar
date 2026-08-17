import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * End-to-end proof of the LIVE elapsed clock beside a running cell's spinner.
 *
 * Everything below needs a real kernel and a real clock, which is the whole point:
 * the unit suite pins the format, the ticker's ref-counting and the wiring, but
 * only a browser can show that the number ADVANCES, that it does not shove the
 * toolbar sideways as its digits grow, that it disappears when the run ends, and
 * that a fast cell still never flashes the indicator.
 *
 * One sequential scenario against a single live launcher, like
 * `follow-running-cell.spec.ts` — a shared kernel dislikes overlapping runs from
 * racing fresh contexts, so each phase settles before the next:
 *
 *   A. A slow cell shows `running Ns` and the number climbs.
 *   B. The toolbar controls to its left do not move while it climbs.
 *   C. The run ends: the live clock is gone and the settled `ran … · Ns` badge
 *      has taken over — the duration is reported once, not twice.
 *   D. A run this tab never started (an out-of-band POST standing in for an agent)
 *      gets the same live clock, timed from the SERVER's start.
 *   E. A fast cell shows neither the indicator nor a clock (the 180ms reveal).
 *
 * Skips when the runtime is missing, like every other kernel-backed spec.
 */

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

const EVIDENCE = process.env.CELLAR_EVIDENCE_DIR || join(tmpdir(), 'cellar-elapsed-evidence');

/** Deterministic cell ids so a phase can address exactly the cell it seeded. */
const SLOW = 'elapsed-slow-cell';
const FAST = 'elapsed-fast-cell';
const AGENT = 'elapsed-agent-cell';

function notebook(): string {
	const cell = (id: string, source: string) => ({
		cell_type: 'code',
		id,
		metadata: {},
		execution_count: null,
		outputs: [],
		source: source.split('\n').map((l, i, a) => (i === a.length - 1 ? l : l + '\n'))
	});
	return JSON.stringify(
		{
			cells: [
				cell(SLOW, 'import time\ntime.sleep(6)\nprint("slow done")'),
				cell(FAST, 'print("fast done")'),
				cell(AGENT, 'import time\ntime.sleep(5)\nprint("agent done")')
			],
			metadata: { kernelspec: { name: 'python3', display_name: 'python3' } },
			nbformat: 4,
			nbformat_minor: 5
		},
		null,
		1
	);
}

const cellFor = (page: Page, id: string) => page.locator(`[data-testid="cell"][data-cell-id="${id}"]`);

/** The whole seconds the live clock currently reads, or null when there is none. */
async function elapsedSeconds(page: Page, id: string): Promise<number | null> {
	const el = cellFor(page, id).getByTestId('running-elapsed');
	if ((await el.count()) === 0) return null;
	const text = (await el.textContent())?.trim() ?? '';
	const m = /^(?:(\d+)m )?(\d+)s$/.exec(text);
	if (!m) return null;
	return (m[1] ? Number(m[1]) * 60 : 0) + Number(m[2]);
}

/** Fire a run with NO originId, so the viewing tab treats it as an agent/other-tab
 *  run and learns about it purely over SSE — the path that must still be timed
 *  from the server's start rather than from this tab's arrival. */
async function runOutOfBand(page: Page, nb: string, cellId: string): Promise<void> {
	await page.evaluate(
		async ({ nb, cellId }) => {
			fetch(`/api/cells/${cellId}/run`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ nb, source: 'import time\ntime.sleep(5)\nprint("agent done")' })
			}).catch(() => {});
		},
		{ nb, cellId }
	);
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only');
	mkdirSync(EVIDENCE, { recursive: true });
	workspace = mkdtempSync(join(tmpdir(), 'cellar-elapsed-'));
	writeFileSync(join(workspace, 'notebook.ipynb'), notebook());
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

test('live elapsed: ticks up beside the spinner, holds the layout, hands over to the badge', async ({ page }) => {
	test.setTimeout(180_000);
	const errors: string[] = [];
	page.on('pageerror', (e) => errors.push(String(e)));

	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	// Fresh session → the empty state offers to open the seeded notebook (open tabs
	// are per-workspace session memory, so a new browser context has none).
	await page.getByTestId('empty-open-notebook').click();
	await expect(cellFor(page, SLOW)).toBeVisible({ timeout: 60_000 });

	// ---- A. it appears and it CLIMBS --------------------------------------
	await cellFor(page, SLOW).getByTestId('run').click();

	const indicator = cellFor(page, SLOW).getByTestId('running-indicator');
	await expect(indicator).toBeVisible({ timeout: 60_000 });
	// The clock is part of the running indicator, not a separate badge elsewhere.
	await expect(indicator).toHaveText(/running\s+\d+s/, { timeout: 15_000 });

	const first = await elapsedSeconds(page, SLOW);
	expect(first, 'the running indicator carries a whole-second elapsed').not.toBeNull();
	// It starts at THIS run's beginning, not at some inherited clock.
	expect(first!).toBeLessThan(3);

	// ---- B. it does not shove the toolbar as its digits grow ---------------
	// The slot is justify-end, so an unreserved width would nudge everything to
	// the clock's left once a second. Measure the neighbouring control.
	const stop = cellFor(page, SLOW).getByTestId('cell-interrupt');
	const boxBefore = await stop.boundingBox();

	// It must not merely INCREMENT — it must track real time. Two readings a
	// measured wall-clock interval apart have to differ by that interval (±1s for
	// the tick's phase against our sampling), which a counter driven by anything
	// other than the clock would fail.
	await expect
		.poll(async () => (await elapsedSeconds(page, SLOW)) ?? -1, {
			timeout: 20_000,
			message: 'the elapsed clock must advance while the cell runs'
		})
		.toBeGreaterThan(first!);

	const t0 = Date.now();
	const e0 = (await elapsedSeconds(page, SLOW))!;
	await page.waitForTimeout(3000);
	const realDelta = (Date.now() - t0) / 1000;
	const later = (await elapsedSeconds(page, SLOW))!;
	expect(later).toBeGreaterThan(first!);
	expect(Math.abs(later - e0 - realDelta), `clock drifted: ${e0}s → ${later}s over ${realDelta}s`).toBeLessThanOrEqual(1.5);

	const boxAfter = await stop.boundingBox();
	expect(boxBefore).not.toBeNull();
	expect(boxAfter).not.toBeNull();
	// Sub-pixel layout jitter is tolerable; a digit's width (~6px) is not.
	expect(
		Math.abs(boxAfter!.x - boxBefore!.x),
		'the controls beside the clock must not move as its digits grow'
	).toBeLessThan(1.5);

	await page.screenshot({ path: join(EVIDENCE, 'running-elapsed.png'), fullPage: false });

	// ---- C. the run ends: one duration, not two ---------------------------
	await expect(indicator).toBeHidden({ timeout: 60_000 });
	await expect(cellFor(page, SLOW).getByTestId('running-elapsed')).toHaveCount(0);
	// The settled badge takes over and reports the same run's duration.
	const badge = cellFor(page, SLOW).getByTestId('run-meta');
	await expect(badge).toContainText(/·\s*\d/, { timeout: 15_000 });
	const badgeText = (await badge.textContent()) ?? '';
	const seconds = /·\s*(?:(\d+)m\s*)?([\d.]+)s/.exec(badgeText);
	expect(seconds, `the settled badge should carry a duration, got: ${badgeText}`).not.toBeNull();
	const settled = (seconds![1] ? Number(seconds![1]) * 60 : 0) + Number(seconds![2]);
	// The live clock and the badge measure from the SAME server instant, so the
	// handover never goes BACKWARDS: the settled duration is at least as large as
	// any reading the live clock showed. (An origin derived client-side — from when
	// this tab noticed `running` flip — would sit later than the server's and could
	// hand over to a smaller number.) Note the first run's duration legitimately
	// includes the lazy kernel boot, which is exactly why this is a floor and not a
	// window around the cell's sleep.
	expect(settled, `settled ${settled}s must not be below the live ${later}s`).toBeGreaterThanOrEqual(later);

	// ---- D. an agent's run gets the same clock ----------------------------
	// This tab never started it and never sees an NDJSON stream for it: the start
	// arrives over SSE, and the clock must be timed from it.
	await runOutOfBand(page, 'notebook.ipynb', AGENT);
	const agentIndicator = cellFor(page, AGENT).getByTestId('running-indicator');
	await expect(agentIndicator).toBeVisible({ timeout: 30_000 });
	await expect(agentIndicator).toHaveText(/running\s+\d+s/, { timeout: 15_000 });
	const agentFirst = await elapsedSeconds(page, AGENT);
	expect(agentFirst!).toBeLessThan(3); // its own run, not the previous cell's clock
	await expect
		.poll(async () => (await elapsedSeconds(page, AGENT)) ?? -1, { timeout: 20_000 })
		.toBeGreaterThan(agentFirst!);
	await expect(agentIndicator).toBeHidden({ timeout: 60_000 });

	// ---- E. a fast cell still flashes nothing -----------------------------
	// The 180ms reveal delay is untouched, so neither the indicator nor a clock
	// appears for a cell that finishes immediately.
	let flashed = false;
	const watch = setInterval(async () => {
		try {
			if ((await cellFor(page, FAST).getByTestId('running-elapsed').count()) > 0) flashed = true;
		} catch {
			/* the page may be mid-navigation */
		}
	}, 25);
	await cellFor(page, FAST).getByTestId('run').click();
	await expect(cellFor(page, FAST).getByTestId('run-meta')).toContainText(/·\s*\d/, { timeout: 30_000 });
	clearInterval(watch);
	expect(flashed, 'a fast cell must never flash the running clock').toBe(false);

	expect(errors, `page errors: ${errors.join('\n')}`).toEqual([]);
});
