import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * E2E for the "restarting, not lost" behavior of the Databricks sidebar.
 *
 * Connecting a cluster deliberately does NOT restart the kernel any more: it binds
 * `spark`/`w` in the running kernel and leaves the Databricks-runtime toggle OFF.
 * Flipping that toggle ON is the one thing that restarts. During that EXPECTED
 * restart the session momentarily drops - the server reports `{connected:false,
 * lost}` for a window until `reconnectAfterKernelRestart` rebuilds it - and the
 * sidebar must read that window as restarting, never flash the scary "lost" card.
 * This spec MOCKS the Databricks status/connect/cluster routes + observes the kernel
 * restart to script exactly that transient-lost window, and asserts:
 *   - connecting shows no restart at all and leaves the runtime toggle off;
 *   - turning the runtime on restarts, and the "lost"/"expired" cards NEVER appear
 *     during it, landing back on "connected";
 *   - a genuine loss with no restart in flight still shows the lost card.
 *
 * Boots the REAL launcher; SKIPS when the runtime is absent.
 */

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

function disconnectedStatus() {
	return {
		connection: { connected: false },
		config: { profiles: [{ name: 'DEFAULT', host: 'https://dbc-demo.cloud.databricks.com', hasToken: true }] },
		install: { python: '/tmp/.venv/bin/python', sdk: true, connect: true },
		uv: true
	};
}
function connectedStatus() {
	return {
		connection: {
			connected: true,
			profile: 'DEFAULT',
			host: 'https://dbc-demo.cloud.databricks.com',
			clusterId: '0710-abc123-xyz',
			clusterName: 'analytics-prod',
			sparkVersion: '15.4.x-scala2.12'
		},
		config: { profiles: [{ name: 'DEFAULT', host: 'https://dbc-demo.cloud.databricks.com', hasToken: true }] },
		install: { python: '/tmp/.venv/bin/python', sdk: true, connect: true },
		uv: true
	};
}
/** The server's view during the EXPECTED restart: session dropped, cluster remembered. */
function lostStatus() {
	return {
		connection: { connected: false, lost: { profile: 'DEFAULT', clusterName: 'analytics-prod' } },
		config: { profiles: [{ name: 'DEFAULT', host: 'https://dbc-demo.cloud.databricks.com', hasToken: true }] },
		install: { python: '/tmp/.venv/bin/python', sdk: true, connect: true },
		uv: true
	};
}

/**
 * Drive the connect-then-enable-runtime sequence with a mocked backend that
 * reproduces the transient-lost window. Shared clock via a Node closure:
 *   - before connect POST → disconnected
 *   - connect POST seen, restart not yet → connected (session built, no restart)
 *   - kernel restart POST seen, within the drop window → LOST (the teardown)
 *   - after the drop window → connected (reconnectAfterKernelRestart rebuilt it)
 *
 * Returns a handle on whether a kernel restart was ever requested, so a test can
 * assert that connecting on its own does NOT restart.
 */
async function mockConnectSequence(page: Page, dropWindowMs: number): Promise<{ restarted: () => boolean }> {
	let connectPosted = false;
	let restartAt: number | null = null;

	await page.route(/\/api\/databricks(\?.*)?$/, async (route) => {
		if (route.request().method() !== 'GET') return route.continue();
		let body: unknown;
		if (!connectPosted) body = disconnectedStatus();
		else if (restartAt == null) body = connectedStatus();
		else if (Date.now() - restartAt < dropWindowMs) body = lostStatus();
		else body = connectedStatus();
		await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
	});

	await page.route(/\/api\/databricks\/clusters(\?.*)?$/, async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				clusters: [{ cluster_id: '0710-abc123-xyz', name: 'analytics-prod', state: 'RUNNING', spark_version: '15.4.x-scala2.12' }]
			})
		});
	});

	await page.route(/\/api\/databricks\/connect(\?.*)?$/, async (route) => {
		if (route.request().method() !== 'POST') return route.continue();
		connectPosted = true;
		await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(connectedStatus().connection) });
	});

	// The kernel restart the runtime toggle triggers (via applyRuntime). Observe it to
	// open the transient-lost window, but let the REAL restart happen so the kernel
	// epoch actually changes and the panel's kernelSessionId `$effect` fires - the
	// faithful timing (a mocked restart would never change the epoch).
	await page.route(/\/api\/kernel\/restart(\?.*)?$/, async (route) => {
		restartAt = Date.now();
		await route.continue();
	});

	return { restarted: () => restartAt != null };
}

async function openNotebook(page: Page): Promise<void> {
	const openBtn = page.getByTestId('empty-open-notebook');
	if (await openBtn.isVisible().catch(() => false)) await openBtn.click();
	await expect(page.getByTestId('cell').first()).toBeVisible();
}

async function openDatabricksSection(page: Page): Promise<void> {
	const header = page.getByTestId('section-databricks');
	await expect(header).toBeVisible();
	if (!(await page.getByTestId('databricks-body').isVisible().catch(() => false))) await header.click();
	await expect(page.getByTestId('databricks-body')).toBeVisible();
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-e2e-dbx-noflash-'));
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

/**
 * Watch the panel for the whole of an action, in the PAGE so a sub-frame flash
 * cannot slip between polls. Resolves once the connected card is showing again (or
 * the deadline passes), reporting every card that was ever visible.
 */
function sampleCards(page: Page) {
	return page.evaluate(async () => {
		const seen = { lost: false, expired: false, connecting: false, connected: false };
		const deadline = Date.now() + 12000;
		const vis = (id: string) => {
			const el = document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
			return !!el && el.offsetParent !== null;
		};
		// A settle count, not a single sighting: the connected card is also what we
		// START from when toggling the runtime, so leaving on the first frame that shows
		// it would end the sample before the restart window even opens.
		let connectedRun = 0;
		while (Date.now() < deadline) {
			if (vis('databricks-lost')) seen.lost = true;
			if (vis('databricks-expired')) seen.expired = true;
			if (vis('databricks-connecting') || vis('databricks-runtime-applying')) seen.connecting = true;
			if (vis('databricks-connected') && !vis('databricks-runtime-applying')) {
				seen.connected = true;
				connectedRun++;
				if (seen.connecting && connectedRun > 20) break;
			} else {
				connectedRun = 0;
			}
			await new Promise((r) => setTimeout(r, 25));
		}
		return seen;
	});
}

/**
 * Boot a live kernel with a real run, so a later restart genuinely bumps the epoch
 * (a never-started kernel makes restart a no-op, which would let the transient-lost
 * window slip past unexercised). The click lands on the cell first (which is what
 * summons its CodeMirror editor - cells render a static stand-in until then), then
 * on `.cm-content` itself: typing in COMMAND mode would fire the modal keyboard,
 * where `1` means "make this an H1 markdown cell" rather than a character.
 */
async function startKernel(page: Page): Promise<void> {
	const firstCell = page.getByTestId('cell').first();
	await firstCell.click();
	const editor = firstCell.locator('.cm-content');
	await editor.waitFor({ state: 'visible', timeout: 30000 });
	await editor.click();
	await page.keyboard.type('1+1');
	await page.keyboard.press('Shift+Enter');
	// Wait for the run to actually execute (output rendered), proving the kernel is live.
	await expect(firstCell.getByTestId('output').first()).toBeVisible({ timeout: 60000 });
}

// ONE test for the whole connect → opt-in story, deliberately: both halves need the
// same live kernel and the same fresh notebook, and the second half's assertion is
// about what the FIRST half did not do (restart). Split across two tests they would
// share this file's one workspace, so the second would start on a notebook the first
// had already typed into.
test('connect leaves the runtime off (no restart); turning it on restarts without flashing "lost"', async ({
	page
}) => {
	const seq = await mockConnectSequence(page, 1400);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	await startKernel(page);
	await openDatabricksSection(page);

	// Disconnected: the connect-form picker with our one cluster.
	await expect(page.getByTestId('databricks-picker')).toBeVisible();
	await expect(page.getByTestId('databricks-cluster').first()).toBeVisible();
	await page.getByTestId('databricks-cluster').first().click();
	await expect(page.getByTestId('databricks-connected')).toBeVisible();

	// The runtime is an explicit opt-in: connecting neither engages it nor restarts.
	await expect(page.getByTestId('databricks-runtime-inactive')).toBeVisible();
	await expect(page.getByTestId('databricks-runtime-toggle')).not.toBeChecked();
	expect(seq.restarted()).toBe(false);
	// Give the panel a beat to settle, then confirm no restart snuck in late.
	await page.waitForTimeout(1000);
	expect(seq.restarted()).toBe(false);
	await expect(page.getByTestId('databricks-lost')).toHaveCount(0);

	// Now the opt-in. Sample the DOM continuously across the toggle-driven restart
	// (the sampler is already running in the page when the click lands).
	const samplerPromise = sampleCards(page);
	await page.getByTestId('databricks-runtime-toggle').click();

	const seen = await samplerPromise;
	// It really did restart, and it landed back on connected.
	expect(seq.restarted()).toBe(true);
	await expect(page.getByTestId('databricks-connected')).toBeVisible();
	expect(seen.connected).toBe(true);
	// A restart-in-progress affordance was shown throughout...
	expect(seen.connecting).toBe(true);
	// ...and the scary "lost"/"expired" card NEVER flashed.
	expect(seen.lost).toBe(false);
	expect(seen.expired).toBe(false);
});

test('a genuine session loss (no expected restart in flight) still shows "lost" + Reconnect', async ({ page }) => {
	// The suppression must be scoped to an EXPECTED restart ONLY. With no connect /
	// switch / runtime-apply in flight, a server-reported `lost` (kernel restarted
	// from elsewhere, idle timeout, closed client) must render the lost card with its
	// Reconnect button, exactly as before - the `restarting` gate must not swallow it.
	await page.route(/\/api\/databricks(\?.*)?$/, async (route) => {
		if (route.request().method() !== 'GET') return route.continue();
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(lostStatus())
		});
	});
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	await openDatabricksSection(page);

	await expect(page.getByTestId('databricks-lost')).toBeVisible();
	await expect(page.getByTestId('databricks-reconnect')).toBeVisible();
	// It is NOT masked as the connecting spinner.
	await expect(page.getByTestId('databricks-connecting')).toHaveCount(0);
});

test('a restart whose reconnect never lands falls through to the lost card', async ({ page }) => {
	// The server's `restarting` flag is time-boxed, and a reconnect that FAILS
	// publishes nothing - so the panel (which has no periodic poll) must re-check on
	// its own once the grace lapses instead of sitting on the spinner forever. The
	// route reproduces that: `restarting` for a window, then the plain lost shape.
	let firstReadAt = 0;
	const RESTARTING_WINDOW_MS = 2000;
	await page.route(/\/api\/databricks(\?.*)?$/, async (route) => {
		if (route.request().method() !== 'GET') return route.continue();
		if (!firstReadAt) firstReadAt = Date.now();
		const base = lostStatus();
		const body =
			Date.now() - firstReadAt < RESTARTING_WINDOW_MS
				? { ...base, connection: { ...base.connection, restarting: true } }
				: base;
		await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
	});
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	await openDatabricksSection(page);

	// Held as "reconnecting" while the server says so...
	await expect(page.getByTestId('databricks-connecting')).toBeVisible();
	// ...and the panel gets itself out of that state once the flag stops.
	await expect(page.getByTestId('databricks-lost')).toBeVisible({ timeout: 20_000 });
	await expect(page.getByTestId('databricks-reconnect')).toBeVisible();
});
