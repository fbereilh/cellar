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
 *   - connected                    → Log out is offered next to Disconnect, takes a
 *                                    two-step confirm (arming alone signs nothing
 *                                    out), and returns the panel to the connect form
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

/**
 * Connected through a PAT profile, while this process ALSO holds an OAuth sign-in
 * for a different, bare host. Log out is global, so that other sign-in is about to
 * be purged even though the panel is showing the PAT selection.
 */
function connectedWithOtherSignInStatus() {
	return { ...connectedStatus(), signedInHosts: ['https://other-workspace.cloud.databricks.com'] };
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

/**
 * Drive the two-step confirm. Log out is the panel's most destructive control - it
 * signs out EVERYWHERE and disconnects every notebook - and it sits directly below
 * the everyday Disconnect, so nothing fires until the second, explicit click.
 */
async function logOut(page: Page): Promise<void> {
	await page.getByTestId('databricks-logout').click();
	const confirm = page.getByTestId('databricks-logout-confirm');
	await expect(confirm).toBeVisible();
	await confirm.click();
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
				sessionsBusy: 0,
				sessionsStuck: 0,
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
	// disconnects every notebook, not just the selection this panel is showing. This
	// connection is a PAT profile with no Cellar sign-in anywhere, so it must NOT
	// promise a purge - the post-action note says the credentials were left untouched,
	// and the two must not contradict each other.
	await expect(logout).toHaveAttribute('title', /everywhere/i);
	await expect(logout).toHaveAttribute('title', /disconnects every notebook/i);
	await expect(logout).toHaveAttribute('title', /no saved Cellar sign-in to clear/i);

	await page.screenshot({ path: join(EVIDENCE_DIR, 'databricks-logout-connected.png') });

	await logout.click();
	// The confirm has to state the blast radius plainly - a tooltip is not a
	// confirmation, and "Disconnect" one row up looks almost the same.
	const confirmBox = page.getByTestId('databricks-logout-confirm-box');
	await expect(confirmBox).toBeVisible();
	await expect(confirmBox).toContainText(/everywhere/i);
	// `\s+` because the copy wraps in the markup - the rendered text carries the
	// source newline, and the point of the assertion is the words, not the layout.
	await expect(confirmBox).toContainText(/every\s+notebook/i);
	await expect(confirmBox).toContainText(/cold cluster/i);
	// ...and only the blast radius it really has. No Cellar sign-in exists here, so
	// the confirm says so rather than promising a clear that cannot happen.
	await expect(confirmBox).toContainText(/no saved Cellar sign-in to clear/i);
	await expect(confirmBox).not.toContainText(/clears every saved sign-in/i);
	await page.screenshot({ path: join(EVIDENCE_DIR, 'databricks-logout-confirm.png') });
	await page.getByTestId('databricks-logout-confirm').click();

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

test('arming alone signs nothing out, and cancelling leaves the session intact', async ({ page }) => {
	await mockDatabricksStatus(page, connectedStatus);
	await mockDatabricksClusters(page);

	let posted = 0;
	await page.route(/\/api\/databricks\/logout$/, async (route) => {
		posted += 1;
		await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
	});

	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	await openDatabricksSection(page);
	await expect(page.getByTestId('databricks-connected')).toBeVisible();

	// One click ARMS. It must not sign out: this control is a misclick away from
	// Disconnect, and its blast radius is every notebook in the app.
	await page.getByTestId('databricks-logout').click();
	await expect(page.getByTestId('databricks-logout-confirm')).toBeVisible();
	expect(posted).toBe(0);

	// Cancelling disarms and changes nothing - still connected, still never posted.
	await page.getByTestId('databricks-logout-cancel').click();
	await expect(page.getByTestId('databricks-logout-confirm')).toHaveCount(0);
	await expect(page.getByTestId('databricks-logout')).toBeVisible();
	await expect(page.getByTestId('databricks-connected')).toBeVisible();
	expect(posted).toBe(0);
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
				sessionsBusy: 0,
				sessionsStuck: 0,
				incomplete: true,
				incompleteReason: 'the saved sign-in could not be cleared (no Python environment is bound)'
			})
		});
	});

	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	await openDatabricksSection(page);
	await page.getByTestId('databricks-host').fill(HOST);

	// This host DOES carry a Cellar sign-in, so here the confirm keeps the strong
	// wording - the two branches must stay distinguishable.
	await page.getByTestId('databricks-logout').click();
	await expect(page.getByTestId('databricks-logout-confirm-box')).toContainText(/clears every saved sign-in/i);
	await page.getByTestId('databricks-logout-confirm').click();

	// Never the ordinary confirmation: reported as clean, a surviving token would
	// make the next "Sign in" a silent cache hit for a user who believes they left.
	const warning = page.getByTestId('databricks-logout-warning');
	await expect(warning).toBeVisible();
	await expect(warning).toContainText(/may be incomplete/i);
	await expect(warning).toContainText(/could not be cleared/i);
	// The remedy is reason-specific: this one IS a surviving file, so it says so.
	await expect(warning).toContainText(/remove the cached sign-in yourself/i);
	await expect(page.getByTestId('databricks-logout-note')).toHaveCount(0);

	await page.screenshot({ path: join(EVIDENCE_DIR, 'databricks-logout-incomplete.png') });
});

test('an incomplete sign-out whose only failure is a mid-connect notebook does NOT tell the user to delete a file', async ({ page }) => {
	await mockDatabricksStatus(page, signedInHostStatus);
	await mockDatabricksClusters(page);
	await page.route(/\/api\/databricks\/logout$/, async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				ok: true,
				disconnected: 0,
				// The token WAS deleted and the gate cleared; the only thing left undone is
				// a notebook whose connect was still in flight.
				clearedTokens: 1,
				externalSkipped: 0,
				clearedSignIns: 1,
				purgeFailed: 0,
				purgeMissed: 0,
				sessionsFailed: 1,
				sessionsBusy: 1,
				sessionsStuck: 0,
				incomplete: true,
				incompleteReason: 'a connect is still in progress, so 1 notebook may still hold a session (notebook.ipynb (busy))'
			})
		});
	});

	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	await openDatabricksSection(page);
	await page.getByTestId('databricks-host').fill(HOST);
	await logOut(page);

	const warning = page.getByTestId('databricks-logout-warning');
	await expect(warning).toBeVisible();
	await expect(warning).toContainText(/still in progress/i);
	await expect(warning).toContainText(/Disconnect that notebook/i);
	// Advising a purge that already succeeded would be wrong advice about a file that
	// is gone - the remedy follows what actually failed, not one fixed sentence.
	await expect(warning).not.toContainText(/remove the cached sign-in/i);
	await expect(warning).not.toContainText(/databricks-sdk-py/i);
});

test('the log-out note does not outlive a later sign-in on the same selection', async ({ page }) => {
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
				sessionsBusy: 0,
				sessionsStuck: 0,
				incomplete: false,
				incompleteReason: null
			})
		});
	});
	await page.route(/\/api\/databricks\/login$/, async (route) => {
		await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
	});

	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	await openDatabricksSection(page);
	await page.getByTestId('databricks-host').fill(HOST);
	await logOut(page);
	await expect(page.getByTestId('databricks-logout-note')).toBeVisible();

	// Signing in again on the SAME selection never runs `resetSelection`, so without
	// its own clear the "signed out everywhere" note survives - and a connect from
	// there renders it under a live cluster, claiming the opposite of what is shown.
	await page.getByTestId('databricks-signin').click();
	await expect(page.getByTestId('databricks-logout-note')).toHaveCount(0);
});

test('the incomplete warning does not outlive the disconnect it asks for', async ({ page }) => {
	// A notebook mid-connect is what made the sign-out incomplete, so the connection
	// survives the log out - the card comes back with the warning above its Disconnect.
	await mockDatabricksStatus(page, connectedStatus);
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
				sessionsFailed: 1,
				sessionsBusy: 1,
				sessionsStuck: 0,
				incomplete: true,
				incompleteReason: 'a notebook was mid-connect, so its session could not be disconnected'
			})
		});
	});
	await page.route(/\/api\/databricks\/connect(\?.*)?$/, async (route) => {
		if (route.request().method() !== 'DELETE') return route.continue();
		await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
	});

	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	await openDatabricksSection(page);
	await logOut(page);

	const warning = page.getByTestId('databricks-logout-warning');
	await expect(warning).toContainText(/Disconnect that notebook/i);

	// Doing exactly what it asks must not leave it still claiming the sign-out is
	// unfinished: disconnecting is a "user moved on" action like sign-in and connect.
	await page.getByTestId('databricks-disconnect').click();
	await expect(warning).toHaveCount(0);
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
	// The sign-in really goes away, so the status has to stop reporting it - the
	// button's visibility now tracks whether ANY sign-in is recorded (Log out is
	// global), so a frozen "still signed in" body would keep it on screen forever.
	let signedOut = false;
	await mockDatabricksStatus(page, () => (signedOut ? { ...signedInHostStatus(), signedInHosts: [] } : signedInHostStatus()));
	await mockDatabricksClusters(page);
	await page.route(/\/api\/databricks\/logout$/, async (route) => {
		signedOut = true;
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
				sessionsBusy: 0,
				sessionsStuck: 0,
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
	await logOut(page);
	await expect(page.getByTestId('databricks-logout-note')).toBeVisible();

	// ...but it describes ONE selection, so typing a different host must drop it -
	// otherwise it claims something about a workspace it no longer describes. (That
	// host has no Cellar-cached sign-in, so the button goes away with it.)
	await page.getByTestId('databricks-host').fill('https://other-workspace.cloud.databricks.com');
	await expect(page.getByTestId('databricks-logout-note')).toHaveCount(0);
	await expect(page.getByTestId('databricks-logout')).toHaveCount(0);
});

test('the confirm is scoped to the ACTION, not the panel: another selection\'s sign-in still counts', async ({ page }) => {
	// Log out is global. Keyed off the selection alone, the confirm for this PAT
	// connection would say "there is nothing to clear" while the purge deletes the
	// bare host's Cellar-minted token - and the post-action note would then say the
	// opposite of the confirm the user had just read.
	await mockDatabricksStatus(page, connectedWithOtherSignInStatus);
	await mockDatabricksClusters(page);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	await openDatabricksSection(page);
	await expect(page.getByTestId('databricks-connected')).toBeVisible();

	const logout = page.getByTestId('databricks-logout');
	await expect(logout).toHaveAttribute('title', /clears the saved sign-ins/i);
	await logout.click();
	const confirmBox = page.getByTestId('databricks-logout-confirm-box');
	await expect(confirmBox).toContainText(/clears every saved sign-in/i);
	await expect(confirmBox).not.toContainText(/no saved Cellar sign-in to clear/i);
});

test('a sign-in recorded for another selection keeps Log out REACHABLE in the picker', async ({ page }) => {
	// The picker is showing a PAT profile, which owns nothing of Cellar's - but a bare
	// host sign-in IS recorded, and Log out is the only control that clears it. Gating
	// visibility on the selection would hide it exactly when it matters.
	await mockDatabricksStatus(page, () => ({
		...disconnectedPatStatus(),
		signedInHosts: ['https://other-workspace.cloud.databricks.com']
	}));
	await mockDatabricksClusters(page);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	await openDatabricksSection(page);

	await expect(page.getByTestId('databricks-picker')).toBeVisible();
	await expect(page.getByTestId('databricks-logout')).toBeVisible();
});

test('a notebook whose teardown FAILED is reported as still bound, not as waiting on a connect', async ({ page }) => {
	// `disconnect()` threw out of the kernel, BEFORE the assignments that clear the
	// state - so that notebook keeps its reconnect intent and would rebuild `spark` on
	// the next kernel restart. There is no connect to wait for, so the busy remedy
	// ("once its connect finishes") would send the user to wait for nothing.
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
				sessionsFailed: 1,
				sessionsBusy: 0,
				sessionsStuck: 1,
				incomplete: true,
				incompleteReason:
					'1 notebook could not be disconnected and is still bound to a cluster (notebook.ipynb (the Python kernel could not be reached))'
			})
		});
	});

	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	await openDatabricksSection(page);
	await page.getByTestId('databricks-host').fill(HOST);
	await logOut(page);

	const warning = page.getByTestId('databricks-logout-warning');
	await expect(warning).toBeVisible();
	await expect(warning).toContainText(/still bound to/i);
	await expect(warning).toContainText(/kernel is reachable again/i);
	// Not the wrong remedy, and not the token one either - that purge succeeded.
	await expect(warning).not.toContainText(/once its connect finishes/i);
	await expect(warning).not.toContainText(/remove the cached sign-in yourself/i);
});
