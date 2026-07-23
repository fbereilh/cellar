import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * E2E for the Databricks sidebar's **Log out** control.
 *
 * Log out is the deliberate sibling of Disconnect, and the two must never read as
 * the same button: Disconnect ends the Spark session and leaves you
 * authenticated; Log out also clears the sign-in Cellar itself cached, so the next
 * connect has to authenticate again. What that means per auth mode is the thing
 * this spec pins in the UI:
 *
 *   - connected                    → Log out is offered next to Disconnect, and
 *                                    taking it returns the panel to the connect form
 *                                    with an explicit confirmation.
 *   - disconnected, PAT profile    → no Log out: the credential lives in
 *                                    `~/.databrickscfg`, so there is nothing of
 *                                    Cellar's to clear and the button would lie.
 *   - disconnected, host signed in → Log out IS offered (that token is ours).
 *
 * The purge itself (which file is deleted, and which are provably not) is proven
 * against the real databricks-sdk in `tests/unit/databricks-logout.test.ts`. Here
 * the routes are MOCKED - exactly like the two-card-redesign spec - so no real
 * workspace, credential or cluster is involved: a test must never be able to sign
 * the user out of their own Databricks account.
 */

const EVIDENCE_DIR = process.env.CELLAR_EVIDENCE_DIR || join(tmpdir(), 'cellar-evidence-databricks-logout');

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

const HOST = 'https://dbc-demo.cloud.databricks.com';

/** Installed + connected, via a PAT profile. */
function connectedStatus() {
	return {
		connection: {
			connected: true,
			profile: 'DEFAULT',
			host: HOST,
			clusterId: '0710-abc123-xyz',
			clusterName: 'analytics-prod',
			sparkVersion: '15.4.x-scala2.12'
		},
		config: { profiles: [{ name: 'DEFAULT', host: HOST, hasToken: true }] },
		install: { python: '/tmp/.venv/bin/python', sdk: true, connect: true },
		uv: true,
		signedInHosts: [],
		signedInProfiles: []
	};
}

/** Installed, disconnected, and the only profile is a PAT: nothing of Cellar's is cached. */
function disconnectedPatStatus() {
	return {
		connection: { connected: false },
		config: { profiles: [{ name: 'DEFAULT', host: HOST, hasToken: true }] },
		install: { python: '/tmp/.venv/bin/python', sdk: true, connect: true },
		uv: true,
		signedInHosts: [],
		signedInProfiles: []
	};
}

/** Installed, disconnected, no profiles at all - and this process signed in to a bare host. */
function signedInHostStatus() {
	return {
		connection: { connected: false },
		config: { profiles: [] },
		install: { python: '/tmp/.venv/bin/python', sdk: true, connect: true },
		uv: true,
		signedInHosts: [HOST],
		signedInProfiles: []
	};
}

async function mockDatabricksStatus(page: Page, body: () => unknown): Promise<void> {
	await page.route(/\/api\/databricks(\?.*)?$/, async (route) => {
		if (route.request().method() !== 'GET') return route.continue();
		await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body()) });
	});
}

async function mockDatabricksClusters(page: Page): Promise<void> {
	await page.route(/\/api\/databricks\/clusters(\?.*)?$/, async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				clusters: [{ cluster_id: '0710-abc123-xyz', name: 'analytics-prod', state: 'RUNNING', spark_version: '15.4.x-scala2.12' }]
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
	if (!(await page.getByTestId('databricks-body').isVisible().catch(() => false))) await header.click();
	await expect(page.getByTestId('databricks-body')).toBeVisible();
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-e2e-dbx-logout-'));
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

test('connected: Log out sits beside Disconnect, ends the session and returns to the signed-out form', async ({ page }) => {
	// The status flips to disconnected once the logout POST has been served, the way
	// the real server behaves (logout tears the session down through `disconnect`).
	let loggedOut = false;
	await mockDatabricksStatus(page, () => (loggedOut ? disconnectedPatStatus() : connectedStatus()));
	await mockDatabricksClusters(page);

	let logoutBody: Record<string, unknown> | null = null;
	await page.route(/\/api\/databricks\/logout$/, async (route) => {
		logoutBody = route.request().postDataJSON();
		loggedOut = true;
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ ok: true, disconnected: 1, clearedTokens: 1, externalSkipped: 0, clearedSignIns: 1 })
		});
	});

	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	await openDatabricksSection(page);

	const cluster = page.getByTestId('databricks-connected');
	await expect(cluster).toBeVisible();
	const disconnect = page.getByTestId('databricks-disconnect');
	const logout = page.getByTestId('databricks-logout');
	await expect(disconnect).toBeVisible();
	await expect(logout).toBeVisible();

	// Both live in the Cluster card, but they must not read as the same control:
	// Disconnect is the everyday outlined action, Log out the quieter, rarer one
	// sitting BELOW it. (A user reaching for "end my session" must not sign out.)
	const dBox = (await disconnect.boundingBox())!;
	const lBox = (await logout.boundingBox())!;
	expect(lBox.y).toBeGreaterThan(dBox.y);
	expect(lBox.width).toBeLessThan(dBox.width);
	await expect(logout).toHaveAttribute('title', /clears the saved sign-in/i);

	await page.screenshot({ path: join(EVIDENCE_DIR, 'databricks-logout-connected.png') });

	await logout.click();

	// It targets the notebook AND carries the current selection, so a selection this
	// server never recorded a sign-in for is still purged.
	await expect.poll(() => logoutBody).not.toBeNull();
	expect(logoutBody!).toHaveProperty('profile', 'DEFAULT');

	// Signed out: back to the connect form, with an explicit confirmation that the
	// saved sign-in (not just the session) is what went away.
	await expect(page.getByTestId('databricks-picker')).toBeVisible();
	await expect(page.getByTestId('databricks-connected')).toHaveCount(0);
	await expect(page.getByTestId('databricks-logout-note')).toContainText(/signed out/i);
	await expect(page.getByTestId('databricks-logout-note')).toContainText(/sign(s)? in again/i);

	await page.screenshot({ path: join(EVIDENCE_DIR, 'databricks-logout-after.png') });
});

test('disconnected with only a PAT profile: no Log out - that credential is not Cellar\'s', async ({ page }) => {
	await mockDatabricksStatus(page, disconnectedPatStatus);
	await mockDatabricksClusters(page);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	await openDatabricksSection(page);

	await expect(page.getByTestId('databricks-picker')).toBeVisible();
	// Nothing Cellar cached, so offering "Log out" would promise a purge that cannot
	// happen: the PAT lives in the user's own ~/.databrickscfg.
	await expect(page.getByTestId('databricks-logout')).toHaveCount(0);
});

test('disconnected but signed in to a bare host: Log out IS offered', async ({ page }) => {
	await mockDatabricksStatus(page, signedInHostStatus);
	await mockDatabricksClusters(page);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	await openDatabricksSection(page);

	await expect(page.getByTestId('databricks-picker')).toBeVisible();
	// The host field is the only auth source (no profiles); typing the host Cellar
	// already signed in to is what surfaces Log out.
	await page.getByTestId('databricks-host').fill(HOST);
	await expect(page.getByTestId('databricks-logout')).toBeVisible();

	// A DIFFERENT host has no Cellar-cached sign-in, so the button goes away again.
	await page.getByTestId('databricks-host').fill('https://other-workspace.cloud.databricks.com');
	await expect(page.getByTestId('databricks-logout')).toHaveCount(0);

	await page.screenshot({ path: join(EVIDENCE_DIR, 'databricks-logout-signed-in-host.png') });
});
