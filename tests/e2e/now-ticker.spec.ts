import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * E2E for the shared app-wide now-ticker (Tier 3 perf work). The per-cell run
 * badge ("ran 2m ago") used to refresh off a per-cell `setInterval`, so a big
 * notebook ran one timer per cell. This proves the consolidation end-to-end in a
 * real browser against the real app:
 *   1. a multi-cell notebook shows correct "ran ago" labels,
 *   2. those labels ADVANCE over time (the shared tick actually fires), and
 *   3. exactly ONE ~15s interval is armed regardless of cell count — a per-cell
 *      design would arm one per cell, so the count NOT growing with cells is the
 *      decisive signal.
 *
 * Boots the real launcher (see ./harness); skips when the kernel runtime is
 * absent, like the smoke spec.
 */

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-now-e2e-'));
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

/** Type `code` as a cell's whole source and run it, waiting for its run badge. */
async function typeAndRun(page: Page, cellIndex: number, code: string) {
	const cell = page.getByTestId('cell').nth(cellIndex);
	await expect(cell).toBeVisible();
	// Lazy editors: build the CodeMirror editor by clicking the editor area first
	// (the cell shows a read-only static render until then), then type into it.
	await cell.getByTestId('editor-scroll').click();
	const editor = cell.locator('.cm-content');
	await editor.click();
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.type(code);
	await cell.getByTestId('run').click();
	// The run badge only appears once lastRun is stamped (run finished).
	await expect(cell.getByTestId('run-meta')).toContainText('ran', { timeout: 60_000 });
	return cell;
}

test('multi-cell "ran ago" labels advance, driven by a single shared timer', async ({ page }) => {
	// Instrument setInterval/clearInterval BEFORE any app script runs, tracking the
	// ~15s intervals (the now-ticker cadence). Per-cell timers would register one
	// per cell; the shared ticker registers exactly one.
	await page.addInitScript(() => {
		const w = window as unknown as {
			__nowIntervals: { registered: number; active: number };
			setInterval: typeof setInterval;
			clearInterval: typeof clearInterval;
		};
		w.__nowIntervals = { registered: 0, active: 0 };
		const realSet = w.setInterval.bind(w);
		const realClear = w.clearInterval.bind(w);
		const tracked = new Set<unknown>();
		w.setInterval = ((fn: TimerHandler, delay?: number, ...rest: unknown[]) => {
			const id = realSet(fn as TimerHandler, delay as number, ...(rest as []));
			if (delay === 15000) {
				w.__nowIntervals.registered++;
				w.__nowIntervals.active++;
				tracked.add(id);
			}
			return id;
		}) as typeof setInterval;
		w.clearInterval = ((id?: number) => {
			if (tracked.has(id)) {
				w.__nowIntervals.active--;
				tracked.delete(id);
			}
			return realClear(id as number);
		}) as typeof clearInterval;
	});

	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);

	// Fresh workspace → empty state offers to make a notebook.
	await page.getByTestId('empty-open-notebook').click();

	// Build a 4-cell notebook, running each so it gets a run badge.
	await typeAndRun(page, 0, '1+1');
	for (let i = 1; i < 4; i++) {
		await page.getByTestId('add-cell').click();
		await typeAndRun(page, i, `${i}*10`);
	}

	// (1) Every run cell shows a "ran ..." label.
	const badges = page.getByTestId('run-meta');
	await expect(badges).toHaveCount(4);
	for (let i = 0; i < 4; i++) {
		await expect(badges.nth(i)).toContainText('ran');
	}

	// (3) Exactly ONE ~15s interval is armed despite 4 cells — the shared ticker.
	// A per-cell design would have registered 4. This is the decisive assertion.
	const intervals = await page.evaluate(
		() => (window as unknown as { __nowIntervals: { registered: number; active: number } }).__nowIntervals
	);
	expect(intervals.registered).toBe(1);
	expect(intervals.active).toBe(1);

	// (2) The labels advance: a badge that reads "just now" flips to "…s/m ago"
	// once the shared tick fires (~15s cadence). Poll on the observable text.
	await expect(badges.first()).toContainText(/ago/, { timeout: 40_000 });
});
