import { test, expect, type Page } from '@playwright/test';
import { spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * End-to-end proof of commit 3006eb0 — two per-notebook kernel-status surfaces:
 *
 *   A. Live kernel RSS by the navbar status. After a run boots the active
 *      notebook's kernel, the navbar shows a `kernel-memory` figure (e.g.
 *      "312 MB"), and the reported bytes equal what `ps` reports for that exact
 *      kernel process at the same instant (the host-side, out-of-band sampler).
 *   B. Running notebooks marked on their TAB, including a BACKGROUND run: a cell
 *      executing in a notebook the user is NOT viewing lights that notebook's tab
 *      with a warning-hued spinner (`tab-running`), then clears back to idle when
 *      the run finishes.
 *
 * Boots the REAL launcher (Node app + Jupyter sidecar + python3 kernel), so it
 * SKIPS when the runtime (uv + python3 + host-venv) is missing. Screenshots are
 * written for reviewer-visible evidence.
 */

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

const EVIDENCE = process.env.CELLAR_EVIDENCE_DIR || join(tmpdir(), 'cellar-kernel-status-evidence');

/** nbformat 4.5 notebook with deterministic cell ids; `source` per cell provided. */
function notebook(prefix: string, sources: string[]): string {
	const cells = sources.map((src, i) => ({
		cell_type: 'code',
		id: `${prefix}-cell-${String(i).padStart(2, '0')}`,
		metadata: {},
		execution_count: null,
		outputs: [],
		source: src.split('\n').map((l, j, a) => (j < a.length - 1 ? l + '\n' : l))
	}));
	return JSON.stringify({
		cells,
		metadata: { kernelspec: { name: 'python3', display_name: 'python3' } },
		nbformat: 4,
		nbformat_minor: 5
	});
}

/** Fire a run of `cellId` in `nb` from the page's own fetch, with NO originId — so
 *  the viewing tab reflects it live over SSE as an external (agent/other-tab) run. */
async function runCellOutOfBand(page: Page, nb: string, cellId: string, source: string): Promise<void> {
	await page.evaluate(
		async ({ nb, cellId, source }) => {
			fetch(`/api/cells/${cellId}/run`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ nb, source })
			}).catch(() => {});
		},
		{ nb, cellId, source }
	);
}

/** RSS (bytes) that `ps` reports for the process whose command line contains `id`. */
function psRssForKernel(id: string): number | null {
	const r = spawnSync('ps', ['-eo', 'pid=,rss=,command='], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
	if (r.status !== 0 || !r.stdout) return null;
	for (const line of r.stdout.split('\n')) {
		const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
		if (m && m[3].includes(id)) return parseInt(m[2], 10) * 1024;
	}
	return null;
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only');
	mkdirSync(EVIDENCE, { recursive: true });
	workspace = mkdtempSync(join(tmpdir(), 'cellar-kstatus-'));
	// Active notebook: one cell that allocates ~80 MB so RSS is unmistakably non-trivial.
	writeFileSync(
		join(workspace, 'notebook.ipynb'),
		notebook('main', ['import numpy as np\n_big = np.ones((10_000_000,), dtype="float64")\nprint(_big.nbytes)'])
	);
	// Background notebook: a cell that blocks long enough to observe the tab spinner.
	writeFileSync(join(workspace, 'background.ipynb'), notebook('bg', ['import time\ntime.sleep(6)\nprint("bg done")']));
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

test('kernel RSS shows by the navbar status (matches ps) + background runs mark their tab', async ({ page }) => {
	test.setTimeout(180_000);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await page.getByTestId('empty-open-notebook').click();
	await expect.poll(async () => page.getByTestId('cell').count(), { timeout: 30_000 }).toBe(1);

	// No kernel yet → navbar shows "not started" and NO memory figure.
	await expect(page.getByTestId('kernel-status')).toContainText('not started');
	await expect(page.getByTestId('kernel-memory')).toHaveCount(0);
	await page.screenshot({ path: join(EVIDENCE, '1-no-kernel-no-memory.png') });

	// ---- A. Run the active notebook's cell → kernel boots, navbar shows live RSS ----
	await runCellOutOfBand(
		page,
		'notebook.ipynb',
		'main-cell-00',
		'import numpy as np\n_big = np.ones((10_000_000,), dtype="float64")\nprint(_big.nbytes)'
	);

	// The memory figure appears once the poller samples the live kernel.
	const memEl = page.getByTestId('navbar').getByTestId('kernel-memory');
	await expect(memEl).toBeVisible({ timeout: 40_000 });
	await expect(memEl).toHaveText(/\d+(\.\d+)?\s(KB|MB|GB)/, { timeout: 40_000 });
	const shown = (await memEl.textContent())?.trim();
	console.log(`[evidence] navbar kernel-memory reads: ${shown}`);
	await page.screenshot({ path: join(EVIDENCE, '2-navbar-live-rss.png') });

	// Cross-check the reported bytes against `ps` for that exact kernel process.
	const api = await page.evaluate(async () => (await fetch('/api/kernel')).json());
	const live = (api.kernels as Array<{ path: string; id: string; memoryRss: number | null }>).find(
		(k) => k.path === 'notebook.ipynb'
	);
	expect(live?.id).toBeTruthy();
	const psBytes = psRssForKernel(live!.id);
	console.log(
		`[evidence] kernel id=${live!.id} reported memoryRss=${live!.memoryRss} bytes; ps RSS=${psBytes} bytes`
	);
	expect(psBytes).not.toBeNull();
	expect(live!.memoryRss).not.toBeNull();
	// Same process, sampled moments apart — within 15% of each other.
	const ratio = live!.memoryRss! / psBytes!;
	expect(ratio).toBeGreaterThan(0.85);
	expect(ratio).toBeLessThan(1.15);

	// ---- B. Background run marks its tab ----
	// Open the background notebook as a second tab, then return focus to the main
	// notebook so the background run happens in a NOT-viewed notebook.
	await page.getByTestId('tree-file').filter({ hasText: 'background.ipynb' }).first().click();
	// Its tab appears; switch back to the main notebook tab (id 'notebook').
	await page.locator('[data-testid="tab"][data-tab-id="notebook"]').click();
	await expect(page.locator('[data-testid="tab"][data-tab-id="notebook"]')).toHaveAttribute('data-active', 'true');

	const bgTab = page.locator('[data-testid="tab"]').filter({ hasText: 'background.ipynb' });
	// Sanity: the background tab is NOT the active one.
	await expect(bgTab).not.toHaveAttribute('data-active', 'true');

	await runCellOutOfBand(page, 'background.ipynb', 'bg-cell-00', 'import time\ntime.sleep(6)\nprint("bg done")');

	// The background tab lights up with the running spinner while we view the main tab.
	await expect(bgTab).toHaveAttribute('data-run-state', 'running', { timeout: 20_000 });
	await expect(bgTab.getByTestId('tab-running')).toBeVisible({ timeout: 20_000 });
	await page.screenshot({ path: join(EVIDENCE, '3-background-tab-running.png') });

	// When the background run finishes, the tab clears back to idle (no run-state).
    await expect(bgTab).not.toHaveAttribute('data-run-state', 'running', { timeout: 30_000 });
	await expect(bgTab.getByTestId('tab-running')).toHaveCount(0, { timeout: 5_000 });
	await page.screenshot({ path: join(EVIDENCE, '4-background-tab-idle.png') });
});
