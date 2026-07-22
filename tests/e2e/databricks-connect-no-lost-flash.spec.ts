import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * E2E for the connect-restart "connecting, not lost" behavior
 * (task cellar-connect-restart-connecting-state-c2).
 *
 * Connecting a cluster auto-enables the Databricks runtime and RESTARTS the
 * kernel so `spark`/`w` are live immediately. During that EXPECTED restart the
 * session momentarily drops - the server reports `{connected:false, lost}` for a
 * window until `reconnectAfterKernelRestart` rebuilds it. The sidebar must read
 * that window as CONNECTING (a continuous spinner), never flash the scary "lost"
 * card. This spec MOCKS the Databricks status/connect/cluster routes + the kernel
 * restart to script exactly that transient-lost window and asserts:
 *   - the "lost"/"expired" cards NEVER appear while connecting, and
 *   - the connecting spinner is shown throughout, landing on "connected".
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
 * Drive the whole connect sequence with a mocked backend that reproduces the
 * transient-lost window. Shared clock via a Node closure:
 *   - before connect POST → disconnected
 *   - connect POST seen, restart not yet → connected (session built, pre-restart)
 *   - kernel restart POST seen, within the drop window → LOST (the teardown)
 *   - after the drop window → connected (reconnectAfterKernelRestart rebuilt it)
 */
async function mockConnectSequence(page: Page, dropWindowMs: number): Promise<void> {
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

	// The kernel restart the connect flow triggers (via applyRuntime). Observe it to
	// open the transient-lost window, but let the REAL restart happen so the kernel
	// epoch actually changes and the panel's kernelSessionId `$effect` fires - the
	// faithful timing (a mocked restart would never change the epoch).
	await page.route(/\/api\/kernel\/restart(\?.*)?$/, async (route) => {
		restartAt = Date.now();
		await route.continue();
	});
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

test('connecting a cluster shows a continuous connecting spinner, never a "lost" flash', async ({ page }) => {
	await mockConnectSequence(page, 1400);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);

	// Start the kernel with a real run, so the connect-triggered restart actually
	// bumps the epoch (a never-started kernel makes restart a no-op, which would let
	// the transient-lost window slip past unexercised).
	const firstCell = page.getByTestId('cell').first();
	await firstCell.click();
	await page.keyboard.type('1+1');
	await page.keyboard.press('Shift+Enter');
	// Wait for the run to actually execute (output rendered), proving the kernel is live.
	await expect(firstCell.getByTestId('output').first()).toBeVisible({ timeout: 60000 });

	await openDatabricksSection(page);

	// Disconnected: the connect-form picker with our one cluster.
	await expect(page.getByTestId('databricks-picker')).toBeVisible();
	const cluster = page.getByTestId('databricks-cluster').first();
	await expect(cluster).toBeVisible();

	// Sample the DOM continuously for the whole connect sequence, recording whether
	// the "lost"/"expired" card is EVER visible and whether the connecting spinner is
	// shown. Runs in the page so it can't miss a sub-frame flash.
	const samplerPromise = page.evaluate(async () => {
		const seen = { lost: false, expired: false, connecting: false, connected: false };
		const deadline = Date.now() + 12000;
		const vis = (id: string) => {
			const el = document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
			return !!el && el.offsetParent !== null;
		};
		while (Date.now() < deadline) {
			if (vis('databricks-lost')) seen.lost = true;
			if (vis('databricks-expired')) seen.expired = true;
			if (vis('databricks-connecting')) seen.connecting = true;
			if (vis('databricks-connected')) {
				seen.connected = true;
				break;
			}
			await new Promise((r) => setTimeout(r, 25));
		}
		return seen;
	});

	// Kick off the connect (the sampler is already running in the page).
	await cluster.click();

	const seen = await samplerPromise;
	// The landing state is connected.
	await expect(page.getByTestId('databricks-connected')).toBeVisible();
	expect(seen.connected).toBe(true);
	// The connecting spinner was shown during the sequence.
	expect(seen.connecting).toBe(true);
	// The scary "lost"/"expired" card NEVER flashed.
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
