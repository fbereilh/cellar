import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * E2E for the dead end this fix retires.
 *
 * A `~/.databrickscfg` profile with `auth_type = databricks-cli` whose OAuth
 * refresh token expired used to surface as `oauth_login_required`, so the sidebar
 * offered "Sign in with Databricks" - Cellar's OWN browser OAuth, which writes a
 * token that profile never reads. Clicking it did nothing, forever.
 *
 * What the panel must show instead is the one command that actually fixes it,
 * naming the REAL selected profile, copyable. That is what this pins, plus the two
 * regressions it must not cause: a bare typed host, and a no-token
 * `external-browser` profile, still get the sign-in button (for those, Cellar's own
 * sign-in genuinely is the remedy).
 *
 * The routes are MOCKED (the same stance as `databricks-logout.spec.ts`): no real
 * workspace, credential or cluster is involved. The server-side classification is
 * proven separately in `tests/unit/databricks-profile-reauth.test.ts`, against the
 * real SDK error text.
 */

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

const HOST = 'https://dbc-demo.cloud.databricks.com';
const PROFILE = 'prod-eu';

/** What the server now returns for an expired named profile: the code, the profile, the command. */
function reauthBody(profile: string) {
	return {
		code: 'profile_reauth_required',
		profile,
		message:
			`Your saved ${profile} sign-in expired. Re-authenticate in a terminal, then reconnect. ` +
			`Run: databricks auth login --profile ${profile}\n\n` +
			'ValueError: default auth: databricks-cli: cannot get access token: Error: A new access token ' +
			'could not be retrieved because the refresh token is invalid.'
	};
}

/** Disconnected, one no-PAT `databricks-cli` profile - the captain's shape. */
function cliProfileStatus() {
	return {
		connection: { connected: false },
		config: { profiles: [{ name: PROFILE, host: HOST, hasToken: false, authType: 'databricks-cli' }] },
		install: { python: '/tmp/.venv/bin/python', sdk: true, connect: true },
		uv: true,
		signedInHosts: [],
		signedInProfiles: []
	};
}

/** Disconnected, no profiles at all: a bare typed host is the only way in. */
function noProfileStatus() {
	return {
		connection: { connected: false },
		config: { profiles: [] },
		install: { python: '/tmp/.venv/bin/python', sdk: true, connect: true },
		uv: true,
		signedInHosts: [],
		signedInProfiles: []
	};
}

/** Disconnected, one no-token `external-browser` profile: Cellar's own sign-in mints its token. */
function extBrowserProfileStatus() {
	return {
		...cliProfileStatus(),
		config: {
			profiles: [{ name: PROFILE, host: HOST, hasToken: false, authType: 'external-browser' }]
		}
	};
}

async function mockDatabricksStatus(page: Page, body: () => unknown): Promise<void> {
	await page.route(/\/api\/databricks(\?.*)?$/, async (route) => {
		if (route.request().method() !== 'GET') return route.continue();
		await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body()) });
	});
}

async function mockClustersFailing(page: Page, body: unknown, status = 401): Promise<void> {
	await page.route(/\/api\/databricks\/clusters(\?.*)?$/, async (route) => {
		await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
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
	workspace = mkdtempSync(join(tmpdir(), 'cellar-e2e-dbx-reauth-'));
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

test('an expired profile shows the exact re-auth command, not the sign-in dead end', async ({ page }) => {
	await mockDatabricksStatus(page, cliProfileStatus);
	await mockClustersFailing(page, reauthBody(PROFILE));

	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	await openDatabricksSection(page);

	const box = page.getByTestId('databricks-clusters-error');
	await expect(box).toBeVisible();

	// The remedy names the REAL selected profile - never a hardcoded one.
	await expect(page.getByTestId('databricks-clusters-error-reauth-command')).toHaveText(
		`databricks auth login --profile ${PROFILE}`
	);
	await expect(page.getByTestId('databricks-clusters-error-reauth-explain')).toContainText(PROFILE);

	// The dead end is gone: no "Sign in with Databricks" for this failure.
	await expect(page.getByTestId('databricks-signin')).toHaveCount(0);

	// The SDK's own text is still there - the real cause is never hidden - but
	// CELLAR's own remedy sentence appears exactly once: the detail row carries the
	// SDK text alone, so the box never states the same remedy twice. (The SDK's text
	// may itself name the login command; that is its wording, not a repeat of ours.)
	await expect(box).toContainText('cannot get access token');
	expect((await box.innerText()).match(/sign-in expired/g)?.length).toBe(1);

	// Copyable.
	await page.getByTestId('databricks-clusters-error-reauth-copy').click();
	const clipboard = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
	if (clipboard) expect(clipboard).toBe(`databricks auth login --profile ${PROFILE}`);
});

test('regression: a bare typed host still offers Cellar’s browser sign-in', async ({ page }) => {
	await mockDatabricksStatus(page, noProfileStatus);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	await openDatabricksSection(page);

	await page.getByTestId('databricks-host').fill(HOST);
	await expect(page.getByTestId('databricks-signin')).toBeVisible();
	await expect(page.getByTestId('databricks-clusters-error-reauth-command')).toHaveCount(0);
});

test('regression: a no-token external-browser profile still offers Cellar’s browser sign-in', async ({ page }) => {
	await mockDatabricksStatus(page, extBrowserProfileStatus);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	await openDatabricksSection(page);

	// Pre-gated: it could pop a browser, so it never lists - it asks to sign in.
	await expect(page.getByTestId('databricks-signin')).toBeVisible();
	await expect(page.getByTestId('databricks-clusters-error-reauth-command')).toHaveCount(0);
});

test('with no profile name on the error, the box explains but shows no command', async ({ page }) => {
	await mockDatabricksStatus(page, cliProfileStatus);
	// The `profile` field is what every server path sets; a body without one is the
	// shape that must FAIL CLOSED. Guessing from the picker would print a command
	// re-authenticating the wrong profile - or `--profile` with nothing after it,
	// which the copy button would hand over verbatim.
	const { profile: _dropped, ...noProfile } = reauthBody(PROFILE);
	await mockClustersFailing(page, noProfile);

	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	await openDatabricksSection(page);

	const explain = page.getByTestId('databricks-clusters-error-reauth-explain');
	await expect(explain).toBeVisible();
	// It names no profile it does not know - and offers no command at all.
	await expect(explain).not.toContainText(PROFILE);
	await expect(page.getByTestId('databricks-clusters-error-reauth-command')).toHaveCount(0);
	await expect(page.getByTestId('databricks-clusters-error-reauth-copy')).toHaveCount(0);
});

test('a session the auto-heal could not restore shows the command on the panel itself', async ({ page }) => {
	// What the panel actually reaches after a failed self-heal: no live session (so
	// the picker card, with its useless "Sign in with Databricks" button) - and the
	// server's verdict riding along, so the user is told why before clicking it.
	await mockDatabricksStatus(page, () => ({
		...cliProfileStatus(),
		connection: { connected: false, reauth: reauthBody(PROFILE) }
	}));
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	await openDatabricksSection(page);

	await expect(page.getByTestId('databricks-session-error')).toBeVisible();
	await expect(page.getByTestId('databricks-session-error-reauth-command')).toHaveText(
		`databricks auth login --profile ${PROFILE}`
	);
});
