import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';
import { UPLOAD_DATE_TOKENS } from '../../src/lib/databricksUploadName';

/**
 * E2E for the **cross-project default** upload prefix/postfix set in Settings.
 *
 * Someone who stamps every upload the same way should say so once rather than once
 * per repo, so the default lives in the global `~/.cellar/` store - and the rule
 * that makes that safe is a DIRECTION: a project with an affix of its own always
 * wins, and the default only fills in for a project that has never been asked.
 * Getting that backwards would silently rewrite naming a user set deliberately, so
 * this pins both halves against the real store, over two workspaces:
 *
 *   - a FRESH project seeds from the default (and uploads under it);
 *   - a project that already has its own keeps it when the default changes;
 *   - clearing a project's field is an ANSWER ("no prefix here"), so the default
 *     does not creep back on the next load;
 *   - the default survives a RELAUNCH on a new port, which is the whole reason it
 *     is not `localStorage`;
 *   - it takes the same tokens (`{YYYYMM}` and friends) and the same
 *     not-a-token warning as the sidebar's own fields.
 *
 * `CELLAR_USER_SETTINGS` redirects that global store into a temp file: it defaults
 * to a real file in the home directory, so without it this spec would rewrite the
 * settings of whoever ran the suite.
 */

let launcher: ChildProcess | null = null;
/** `fresh` has never had an affix; `owned` sets one of its own. */
let fresh = '';
let owned = '';
let settingsFile = '';
let settingsDir = '';
let baseURL = '';

const HOST = 'https://dbc-demo.cloud.databricks.com';
const USER = 'me@corp.example.com';

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

async function mockDatabricks(page: Page): Promise<Record<string, unknown>[]> {
	await page.route(/\/api\/databricks(\?.*)?$/, async (route) => {
		if (route.request().method() !== 'GET') return route.continue();
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(connectedStatus())
		});
	});
	await page.route(/\/api\/databricks\/clusters(\?.*)?$/, async (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ clusters: [] }) })
	);
	const seen: Record<string, unknown>[] = [];
	await page.route(/\/api\/databricks\/upload$/, async (route) => {
		const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
		seen.push(body);
		const path = `/Users/${USER}/${String(body.prefix ?? '')}notebook${String(body.postfix ?? '')}`;
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ ok: true, status: 'uploaded', path, url: null, overwritten: false })
		});
	});
	return seen;
}

async function openWorkspace(page: Page, ws: string): Promise<void> {
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(ws)}`);
	const openBtn = page.getByTestId('empty-open-notebook');
	if (await openBtn.isVisible().catch(() => false)) await openBtn.click();
	await expect(page.locator('[data-testid="cell"]:visible').first()).toBeVisible();
}

async function openDatabricksSection(page: Page): Promise<void> {
	const header = page.getByTestId('section-databricks');
	await expect(header).toBeVisible();
	if (!(await page.getByTestId('databricks-body').isVisible().catch(() => false))) await header.click();
	await expect(page.getByTestId('databricks-body')).toBeVisible();
}

async function openSettings(page: Page): Promise<void> {
	await page.getByTestId('app-menu').click();
	await page.getByTestId('open-settings').click();
	await expect(page.getByTestId('settings-modal')).toBeVisible();
}

async function closeSettings(page: Page): Promise<void> {
	await page.getByTestId('settings-close').click();
	await expect(page.getByTestId('settings-modal')).toHaveCount(0);
}

/** The global store as it is ON DISK - what a relaunch would actually read back. */
function storedDefaults(): Record<string, unknown> {
	try {
		return JSON.parse(readFileSync(settingsFile, 'utf8'));
	} catch {
		return {};
	}
}

function localToday() {
	const d = new Date();
	const yyyy = String(d.getFullYear());
	const mm = String(d.getMonth() + 1).padStart(2, '0');
	return { yyyymm: `${yyyy}${mm}`, dashed: `${yyyy}-${mm}` };
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only');
	fresh = mkdtempSync(join(tmpdir(), 'cellar-e2e-defaults-fresh-'));
	owned = mkdtempSync(join(tmpdir(), 'cellar-e2e-defaults-owned-'));
	settingsDir = mkdtempSync(join(tmpdir(), 'cellar-e2e-defaults-home-'));
	settingsFile = join(settingsDir, 'settings.json');
	const booted = await bootCellar(fresh, { CELLAR_USER_SETTINGS: settingsFile });
	launcher = booted.proc;
	baseURL = booted.url;
});

test.afterAll(async () => {
	if (launcher) killCellar(launcher);
	launcher = null;
	for (const d of [fresh, owned, settingsDir]) {
		if (d && existsSync(d)) {
			try {
				rmSync(d, { recursive: true, force: true });
			} catch {
				/* best effort */
			}
		}
	}
});

test('a default set in Settings seeds a project that has none - and uploads under it', async ({ page }) => {
	const seen = await mockDatabricks(page);
	await openWorkspace(page, fresh);

	await openSettings(page);
	// The token buttons are here too: this is where the pattern is authored, so it is
	// where the vocabulary is worth the most.
	await expect(page.getByTestId('settings-upload-token')).toHaveCount(UPLOAD_DATE_TOKENS.length);
	await page.getByTestId('settings-upload-prefix').fill('{YYYYMM}_');
	// Settings shows what it resolves to, through the same resolver the sidebar and the
	// server use - a fourth opinion about the name is exactly what must not exist.
	const { yyyymm } = localToday();
	await expect(page.getByTestId('settings-upload-preview')).toHaveText(`${yyyymm}_notebook`);
	// It is the PATTERN that persists, not today's resolved date.
	await expect
		.poll(() => storedDefaults()['cellar-databricks-upload-prefix-default'])
		.toBe('{YYYYMM}_');
	await closeSettings(page);

	// A project that has never set an affix inherits it - visibly, in the field.
	await page.reload();
	await openWorkspace(page, fresh);
	await openDatabricksSection(page);
	await expect(page.getByTestId('databricks-upload-prefix')).toHaveValue('{YYYYMM}_');
	await expect(page.getByTestId('databricks-upload-preview')).toHaveText(`${yyyymm}_notebook`);

	// …and it is a real default, not decoration: the upload goes out under it, expanded.
	await page.getByTestId('databricks-upload').click();
	expect(seen).toHaveLength(1);
	expect(seen[0].prefix).toBe(`${yyyymm}_`);
});

test('a project that set its OWN affix keeps it when the default changes', async ({ page }) => {
	await mockDatabricks(page);
	await openWorkspace(page, owned);
	await openDatabricksSection(page);

	// This project answers for itself.
	await page.getByTestId('databricks-upload-prefix').fill('team_');
	await expect(page.getByTestId('databricks-upload-preview')).toHaveText('team_notebook');

	// The user then changes the global default to something quite different.
	await openSettings(page);
	await page.getByTestId('settings-upload-prefix').fill('GLOBAL_');
	await expect
		.poll(() => storedDefaults()['cellar-databricks-upload-prefix-default'])
		.toBe('GLOBAL_');
	await closeSettings(page);

	// The project is UNTOUCHED - a default that overrode would silently rewrite naming
	// the user set deliberately, project by project.
	await page.reload();
	await openWorkspace(page, owned);
	await openDatabricksSection(page);
	await expect(page.getByTestId('databricks-upload-prefix')).toHaveValue('team_');
	await expect(page.getByTestId('databricks-upload-preview')).toHaveText('team_notebook');
});

test('CLEARING a project field is an answer, so the default does not creep back', async ({ page }) => {
	await mockDatabricks(page);
	await openWorkspace(page, owned);
	await openDatabricksSection(page);

	// "No prefix on this project" - said by emptying the field, the only way to say it.
	await page.getByTestId('databricks-upload-prefix').fill('');
	await expect(page.getByTestId('databricks-upload-preview')).toHaveText('notebook');

	await page.reload();
	await openWorkspace(page, owned);
	await openDatabricksSection(page);
	// Re-seeding `GLOBAL_` here would undo the clearing the moment the page reloaded,
	// leaving no way at all to opt one project out of a default.
	await expect(page.getByTestId('databricks-upload-prefix')).toHaveValue('');
	await expect(page.getByTestId('databricks-upload-preview')).toHaveText('notebook');
});

test('the default survives a RELAUNCH on a new port - the reason it is not localStorage', async ({
	page
}) => {
	// The store is the file, not the browser: a relaunch means a brand-new origin, so
	// anything kept per-origin would be gone. Restarting the launcher here would cost
	// the whole suite its instance, so this asserts the same thing at the layer that
	// decides it - what is ON DISK, and what a fresh SSR load hands the browser.
	expect(storedDefaults()['cellar-databricks-upload-prefix-default']).toBe('GLOBAL_');
	const res = await page.request.get(`${baseURL}/api/user-settings`);
	expect((await res.json())['cellar-databricks-upload-prefix-default']).toBe('GLOBAL_');
});

test('the default field takes the same tokens - and the same not-a-token warning', async ({ page }) => {
	await mockDatabricks(page);
	await openWorkspace(page, fresh);
	await openSettings(page);

	const prefix = page.getByTestId('settings-upload-prefix');
	const warning = page.getByTestId('settings-upload-token-warning');

	// A near-miss fails silently everywhere it is not named, and this is where the
	// pattern is written - so it is named here too.
	await prefix.fill('{YYYYMMD}_');
	await expect(warning).toBeVisible();
	await expect(warning).toContainText('{YYYYMMD}');

	// A chip writes the exact braced form into the field last focused.
	await prefix.fill('');
	await page.locator('[data-testid="settings-upload-token"][data-token="{YYYY-MM}"]').click();
	await expect(prefix).toHaveValue('{YYYY-MM}');
	await expect(warning).toHaveCount(0);
	const { dashed } = localToday();
	await expect(page.getByTestId('settings-upload-preview')).toHaveText(`${dashed}notebook`);

	// Leave the global store clean for anything that runs after this file.
	await prefix.fill('');
	await page.getByTestId('settings-upload-postfix').fill('');
	await expect.poll(() => storedDefaults()['cellar-databricks-upload-prefix-default']).toBeUndefined();
});
