import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * E2E for the Databricks sidebar TWO-CARD REDESIGN (target commit
 * "feat(databricks): two-card sidebar redesign + connect auto-enables runtime").
 *
 * End-user intent (design-first, captain-approved): the flat divider-stack is
 * replaced by TWO clearly separated bordered cards - a Cluster card (connection
 * identity + Switch/Disconnect, OR the connect-form picker when disconnected) and
 * a SEPARATE Runtime card (the DATABRICKS_RUNTIME_VERSION toggle + version + a
 * live active/off/restarting status) - with the Unity Catalog data browser as a
 * subordinate labeled region below. The now-obsolete "restart to apply" hint
 * (data-testid databricks-runtime-hint / databricks-runtime-restart) is removed.
 *
 * The connect->kernel-restart auto-enable behavior needs a real cluster and is
 * out of scope here (covered by the unit suite + the author's manual verification
 * against a live cluster); this spec proves the RENDERED two-card LAYOUT and its
 * data-testids by MOCKING the /api/databricks status route, exactly like the
 * header-pill spec. Boots the REAL launcher; SKIPS when the runtime is absent.
 */

const EVIDENCE_DIR =
	process.env.CELLAR_EVIDENCE_DIR ||
	'/var/folders/ds/m71hq5ln637g23x6xmrwqg080000gn/T/no-mistakes-evidence/01KY4RNR5SWSZ5TZGBV6MHHR3K';

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

/** A DbxStatus body the panel treats as a live, connected session. */
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

/** A DbxStatus body the panel treats as installed-but-disconnected (the connect form). */
function disconnectedStatus() {
	return {
		connection: { connected: false },
		config: { profiles: [{ name: 'DEFAULT', host: 'https://dbc-demo.cloud.databricks.com', hasToken: true }] },
		install: { python: '/tmp/.venv/bin/python', sdk: true, connect: true },
		uv: true
	};
}

/** Intercept the Databricks STATUS route only (not clusters/catalog) with a fixed body. */
async function mockDatabricksStatus(page: Page, body: unknown): Promise<void> {
	await page.route(/\/api\/databricks(\?.*)?$/, async (route) => {
		if (route.request().method() !== 'GET') return route.continue();
		await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
	});
}

/** Intercept the clusters listing so the disconnected connect-form renders a real list. */
async function mockDatabricksClusters(page: Page): Promise<void> {
	await page.route(/\/api\/databricks\/clusters(\?.*)?$/, async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				clusters: [
					{ cluster_id: '0710-abc123-xyz', name: 'analytics-prod', state: 'RUNNING', spark_version: '15.4.x-scala2.12' },
					{ cluster_id: '0710-def456-uvw', name: 'ml-training', state: 'TERMINATED', spark_version: '16.1.x-scala2.12' }
				]
			})
		});
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
	if (!(await page.getByTestId('databricks-body').isVisible().catch(() => false))) {
		await header.click();
	}
	await expect(page.getByTestId('databricks-body')).toBeVisible();
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-e2e-dbx-2card-'));
	const booted = await bootCellar(workspace);
	launcher = booted.proc;
	baseURL = booted.url;
	try {
		mkdirSync(EVIDENCE_DIR, { recursive: true });
	} catch {
		/* best effort */
	}
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

test('connected: TWO separate bordered cards (Cluster + Runtime) + subordinate data browser', async ({ page }) => {
	await mockDatabricksStatus(page, connectedStatus());
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	await openDatabricksSection(page);

	// Card 1 - the Cluster card (connection identity + Switch/Disconnect).
	const cluster = page.getByTestId('databricks-connected');
	await expect(cluster).toBeVisible();
	await expect(page.getByTestId('databricks-connection-status')).toBeVisible();
	await expect(page.getByTestId('databricks-switch')).toBeVisible();
	await expect(page.getByTestId('databricks-disconnect')).toBeVisible();

	// Card 2 - the SEPARATE Runtime card, with its toggle + live status.
	const runtime = page.getByTestId('databricks-runtime-card');
	await expect(runtime).toBeVisible();
	await expect(page.getByTestId('databricks-runtime-toggle')).toBeVisible();
	// Exactly one of active/off/restarting is shown.
	const statusCount =
		(await page.getByTestId('databricks-runtime-active').count()) +
		(await page.getByTestId('databricks-runtime-inactive').count()) +
		(await page.getByTestId('databricks-runtime-applying').count());
	expect(statusCount).toBe(1);

	// The two cards are DISTINCT bordered elements (requirement #1).
	expect(await cluster.evaluate((el) => el.getBoundingClientRect().bottom <= 0)).toBe(false);
	const clusterBox = await cluster.boundingBox();
	const runtimeBox = await runtime.boundingBox();
	expect(clusterBox).not.toBeNull();
	expect(runtimeBox).not.toBeNull();
	// Runtime card sits below the Cluster card, and they do not overlap (separated).
	expect(runtimeBox!.y).toBeGreaterThanOrEqual(clusterBox!.y + clusterBox!.height - 2);

	// Card 3 (subordinate) - the Unity Catalog data browser below the two cards.
	await expect(page.getByTestId('databricks-browser')).toBeVisible();

	// The obsolete "restart to apply" hint is GONE in every state.
	await expect(page.getByTestId('databricks-runtime-hint')).toHaveCount(0);
	await expect(page.getByTestId('databricks-runtime-restart')).toHaveCount(0);

	// Reviewer-visible evidence: the full two-card panel.
	const section = page.getByTestId('section-databricks').locator('xpath=ancestor::*[1]/parent::*');
	await section.screenshot({ path: join(EVIDENCE_DIR, 'databricks-two-card-connected.png') });
	await page.screenshot({ path: join(EVIDENCE_DIR, 'databricks-two-card-connected-full.png') });
});

test('disconnected: the Cluster card renders its connect-form picker', async ({ page }) => {
	await mockDatabricksStatus(page, disconnectedStatus());
	await mockDatabricksClusters(page);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	await openDatabricksSection(page);

	// The Cluster card in its connect-form (the picker) - and NO runtime card yet
	// (the Runtime card is shown only once connected).
	await expect(page.getByTestId('databricks-picker')).toBeVisible();
	await expect(page.getByTestId('databricks-cluster').first()).toBeVisible();
	// The approved connect->auto-enable-runtime consequence is surfaced inline.
	await expect(page.getByTestId('databricks-connect-note')).toBeVisible();
	await expect(page.getByTestId('databricks-runtime-card')).toHaveCount(0);
	await expect(page.getByTestId('databricks-runtime-hint')).toHaveCount(0);

	const section = page.getByTestId('section-databricks').locator('xpath=ancestor::*[1]/parent::*');
	await section.screenshot({ path: join(EVIDENCE_DIR, 'databricks-disconnected-picker.png') });
});
