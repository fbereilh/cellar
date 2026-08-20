import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * Regression: a page RELOAD mid-run must not lose the running cell's spinner
 * (reported as "if i reload the page, the spinner on the running cell is lost
 * and i dont know which cell is running. I just see the kernel busy").
 *
 * Root cause (diagnosed in a real browser, perfectly correlated over repeated
 * reloads): on a fresh page the mount `load()` races the SSE connect. When the
 * load resolves FIRST, the `sse:open` backstop triggers a SECOND `load()`; the
 * connect-seeded `queue:changed` snapshot lands while that load is in flight
 * and marks the running cell - then the load resolves and its `clearRunning()`
 * stale-state wipe erases it. The old one-shot `pendingQueueEvent` had already
 * been consumed, so nothing restored `runningId` until the next genuine queue
 * change (i.e. `run:end` - or the user running some other cell, which is why
 * the live-broadcast path always worked while only the reload seed path
 * failed). The proof the snapshot itself arrives and is applied: the QUEUED
 * badge - set by the very same `applyQueueEvent` call from the very same
 * snapshot - survived every reload, because `load()` clears `runningId` but
 * deliberately not `queued`. The fix retains the latest snapshot and re-applies
 * it after every `load()`'s wipe, so the seed path converges with the live path.
 *
 * The race is made DETERMINISTIC here (it hit ~half of manual reloads):
 *   - `/api/events` is delayed, so the mount load always resolves before the
 *     SSE connect → the `sse:open` backstop load always fires;
 *   - the SECOND post-reload `GET /api/notebooks?path=` has its response held,
 *     so the seeded snapshot always applies while that load is in flight.
 * Without the fix the spinner then reliably disappears when the held load
 * resolves; with it, the re-apply restores the running cell.
 *
 * Both runs are issued from the TEST process (never `page.evaluate` fetch): a
 * reload aborts page-owned connections, and the `/run` route's stream cancel
 * drops its own pending queue entry - the queued half of the scenario must
 * survive the reload to be observable.
 */

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

const RUN_CELL = 'run-cell-0000-0000-0000-000000000001';
const QUEUED_CELL = 'queued-cell-00-0000-0000-000000000002';

function notebookJson(): string {
	const cell = (id: string, source: string[]) => ({
		cell_type: 'code',
		id,
		metadata: {},
		execution_count: null,
		outputs: [],
		source
	});
	return JSON.stringify({
		cells: [
			cell(RUN_CELL, ['print("long cell placeholder")']),
			cell(QUEUED_CELL, ['print("queued cell")'])
		],
		metadata: { kernelspec: { name: 'python3', display_name: 'python3' } },
		nbformat: 4,
		nbformat_minor: 5
	});
}

/** Open the seeded notebook, settling on either the empty state or the cells
 *  (the shell paints one of the two - probing before either arrives misreads
 *  the button as absent and the click becomes a no-op). */
async function openNotebook(page: Page): Promise<void> {
	const emptyOpen = page.getByTestId('empty-open-notebook');
	await Promise.race([
		emptyOpen.waitFor({ timeout: 30_000 }).catch(() => {}),
		page.getByTestId('cell').first().waitFor({ timeout: 30_000 }).catch(() => {})
	]);
	if (await emptyOpen.isVisible().catch(() => false)) await emptyOpen.click();
	await expect.poll(async () => page.getByTestId('cell').count(), { timeout: 30_000 }).toBe(2);
}

/** Start a run from the TEST process so its connection survives the page
 *  reload. Resolves once the response headers arrive (the run is accepted); the
 *  NDJSON body is then actively drained in the background for the life of the
 *  run - an UNREAD body gets garbage-collected and aborted by undici, and the
 *  `/run` route's stream cancel drops its own pending queue entry, which is
 *  exactly the connection-death this helper exists to avoid. */
const heldRuns: Promise<void>[] = [];
async function startRun(cellId: string, source: string): Promise<void> {
	const res = await fetch(`${baseURL}/api/cells/${cellId}/run`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ nb: 'notebook.ipynb', source })
	});
	if (!res.ok) throw new Error(`run POST for ${cellId} failed: ${res.status}`);
	const reader = res.body?.getReader();
	if (reader)
		heldRuns.push(
			(async () => {
				try {
					while (!(await reader.read()).done) {
						/* drain until the run settles */
					}
				} catch {
					/* the run ended or the launcher went away - either is fine */
				}
			})()
		);
}

test.beforeAll(async () => {
	test.skip(
		!runtimeAvailable(),
		'kernel runtime (uv + python3 + host-venv) not available - E2E is local-only'
	);
	workspace = mkdtempSync(join(tmpdir(), 'cellar-reload-spinner-'));
	writeFileSync(join(workspace, 'notebook.ipynb'), notebookJson());
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

test('reload mid-run keeps the running cell identifiable (and the queued badge with it)', async ({
	page
}) => {
	test.setTimeout(180_000);
	await page.goto(`${baseURL}/`);
	await openNotebook(page);

	const runningBar = page.locator(`[data-cell-id="${RUN_CELL}"] [data-testid="running-bar"]`);
	const queuedIndicator = page.locator(
		`[data-cell-id="${QUEUED_CELL}"] [data-testid="queued-indicator"]`
	);

	// A run long enough to reload during (interrupted at the end), plus a second
	// run queued behind it - both held open by the test process, not the page.
	await startRun(
		RUN_CELL,
		'import time\nfor i in range(300):\n    print(f"tick {i}", flush=True)\n    time.sleep(1)\n'
	);
	await expect(runningBar).toBeVisible({ timeout: 30_000 });
	await startRun(QUEUED_CELL, 'print("queued cell")');
	await expect(queuedIndicator).toBeVisible({ timeout: 30_000 });

	// Force the failing interleaving deterministically. Delaying `/api/events`
	// makes the mount load resolve before `sse:open` (→ the backstop load always
	// fires); holding the SECOND `/api/notebooks?path=` response keeps that load
	// in flight while the connect-seeded `queue:changed` applies, so the load's
	// `clearRunning()` provably lands AFTER the seed marked the running cell.
	let notebookLoads = 0;
	await page.route('**/api/events', async (route) => {
		await new Promise((r) => setTimeout(r, 600));
		await route.continue();
	});
	await page.route(
		(url) => url.pathname === '/api/notebooks' && url.searchParams.has('path'),
		async (route) => {
			notebookLoads += 1;
			if (notebookLoads <= 1) return route.continue();
			const response = await route.fetch();
			await new Promise((r) => setTimeout(r, 600));
			await route.fulfill({ response });
		}
	);

	await page.reload();
	await openNotebook(page);

	// The seed marks the running cell shortly after the SSE connect…
	await expect(runningBar).toBeVisible({ timeout: 30_000 });
	// …and the backstop load really ran (the failing interleaving happened, so a
	// pass can never be vacuous)…
	await expect.poll(() => notebookLoads, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
	// …and once it resolves (held 600ms), the running cell must STILL be marked.
	// Without the fix its `clearRunning()` wipes the spinner here for the rest of
	// the run - the reported bug: kernel badge busy, no way to tell which cell.
	await page.waitForTimeout(1500);
	await expect(runningBar).toBeVisible();

	// The elapsed clock reads the run's TRUE start (carried on the snapshot), not
	// our arrival: the run is several seconds old by now, so the clock can never
	// read "0s" if the seed's `startedAt` made it through.
	const elapsed = page.locator(`[data-cell-id="${RUN_CELL}"] [data-testid="running-elapsed"]`);
	await expect(elapsed).toBeVisible();
	await expect(elapsed).not.toHaveText(/^0s/);

	// The queued cell behind it is still identifiable too (same snapshot, same
	// reload) - it never even started, so only the seed can be telling us.
	await expect(queuedIndicator).toBeVisible();

	// The retained snapshot must never resurrect a DEAD run: interrupting ends
	// the run and drops the queue, and both indicators clear. A single SIGINT is
	// occasionally swallowed by the interpreter (observed as a rare flake), so
	// re-interrupt while the run survives - the assertion itself stays strict.
	for (let attempt = 0; attempt < 4; attempt++) {
		const res = await fetch(`${baseURL}/api/kernel/interrupt`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ path: 'notebook.ipynb' })
		});
		expect(res.ok).toBe(true);
		const gone = await runningBar
			.waitFor({ state: 'hidden', timeout: 8_000 })
			.then(() => true)
			.catch(() => false);
		if (gone) break;
	}
	await expect(runningBar).toBeHidden({ timeout: 30_000 });
	await expect(queuedIndicator).toBeHidden({ timeout: 30_000 });
});
