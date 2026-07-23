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
 *                                    with an explicit confirmation that names the
 *                                    blast radius (it signs out EVERYWHERE).
 *   - disconnected, PAT profile    → no Log out: the credential lives in
 *                                    `~/.databrickscfg`, so there is nothing of
 *                                    Cellar's to clear and the button would lie.
 *   - disconnected, host signed in → Log out IS offered (that token is ours), and
 *                                    changing the selection drops a stale note.
 *   - an INCOMPLETE sign-out       → a warning, never the ordinary confirmation:
 *                                    the cached token may still be on disk.
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
			body: JSON.stringify({
				ok: true,
				disconnected: 1,
				clearedTokens: 1,
				externalSkipped: 0,
				clearedSignIns: 1,
				purgeFailed: 0,
				purgeMissed: 0,
				sessionsFailed: 0,
				incomplete: false,
				incompleteReason: null
			})
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
	// The tooltip has to name the blast radius: this signs out EVERYWHERE and
	// disconnects every notebook, not just the selection this panel is showing.
	await expect(logout).toHaveAttribute('title', /clears the saved sign-in/i);
	await expect(logout).toHaveAttribute('title', /everywhere/i);

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
	// ...and that it was global, so the user is not left thinking one panel's
	// selection was all that went away.
	await expect(page.getByTestId('databricks-logout-note')).toContainText(/everywhere/i);
	// A clean sign-out shows the confirmation and nothing else.
	await expect(page.getByTestId('databricks-logout-warning')).toHaveCount(0);

	await page.screenshot({ path: join(EVIDENCE_DIR, 'databricks-logout-after.png') });
});

test('an INCOMPLETE sign-out warns instead of confirming - the cached token may have survived', async ({ page }) => {
	await mockDatabricksStatus(page, signedInHostStatus);
	await mockDatabricksClusters(page);
	await page.route(/\/api\/databricks\/logout$/, async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				ok: true,
				disconnected: 0,
				clearedTokens: 0,
				externalSkipped: 0,
				clearedSignIns: 0,
				purgeFailed: 1,
				purgeMissed: 0,
				sessionsFailed: 0,
				incomplete: true,
				incompleteReason: 'the saved sign-in could not be cleared (no Python environment is bound)'
			})
		});
	});

	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	await openDatabricksSection(page);
	await page.getByTestId('databricks-host').fill(HOST);
	await page.getByTestId('databricks-logout').click();

	// Never the ordinary confirmation: reported as clean, a surviving token would
	// make the next "Sign in" a silent cache hit for a user who believes they left.
	const warning = page.getByTestId('databricks-logout-warning');
	await expect(warning).toBeVisible();
	await expect(warning).toContainText(/may be incomplete/i);
	await expect(warning).toContainText(/could not be cleared/i);
	await expect(page.getByTestId('databricks-logout-note')).toHaveCount(0);

	await page.screenshot({ path: join(EVIDENCE_DIR, 'databricks-logout-incomplete.png') });
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

test('disconnected but signed in to a bare host: Log out IS offered, and its note does not outlive the selection', async ({ page }) => {
	await mockDatabricksStatus(page, signedInHostStatus);
	await mockDatabricksClusters(page);
	await page.route(/\/api\/databricks\/logout$/, async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				ok: true,
				disconnected: 0,
				clearedTokens: 1,
				externalSkipped: 0,
				clearedSignIns: 1,
				purgeFailed: 0,
				purgeMissed: 0,
				sessionsFailed: 0,
				incomplete: false,
				incompleteReason: null
			})
		});
	});
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	await openDatabricksSection(page);

	await expect(page.getByTestId('databricks-picker')).toBeVisible();
	// The host field is the only auth source (no profiles); typing the host Cellar
	// already signed in to is what surfaces Log out.
	await page.getByTestId('databricks-host').fill(HOST);
	await expect(page.getByTestId('databricks-logout')).toBeVisible();

	await page.screenshot({ path: join(EVIDENCE_DIR, 'databricks-logout-signed-in-host.png') });

	// The confirmation deliberately outlives the card swap a log out causes...
	await page.getByTestId('databricks-logout').click();
	await expect(page.getByTestId('databricks-logout-note')).toBeVisible();

	// ...but it describes ONE selection, so typing a different host must drop it -
	// otherwise it claims something about a workspace it no longer describes. (That
	// host has no Cellar-cached sign-in, so the button goes away with it.)
	await page.getByTestId('databricks-host').fill('https://other-workspace.cloud.databricks.com');
	await expect(page.getByTestId('databricks-logout-note')).toHaveCount(0);
	await expect(page.getByTestId('databricks-logout')).toHaveCount(0);
});
