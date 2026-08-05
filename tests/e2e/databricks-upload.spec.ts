import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * E2E for the Databricks sidebar's **Upload notebook to workspace** control.
 *
 * It copies the open notebook into `/Users/<you>/` as a real Databricks notebook.
 * What this spec pins in the UI:
 *
 *   - connected      → the button is offered beside Switch/Disconnect, uploads on
 *                      one click, and reports the workspace PATH it landed at
 *                      (with a link), never a spinner that goes nowhere.
 *   - already there  → NOTHING is written; a confirm names the path and the blast
 *                      radius, Cancel leaves it alone, and only Replace sends
 *                      `overwrite:true`. The confirm stays MOUNTED for the whole
 *                      replace, so the path being overwritten is on screen while
 *                      it happens, and a failed replace drops back to the button
 *                      with the error rather than into a dead end.
 *   - switched away  → a reply that lands after the panel moved to another
 *                      notebook is dropped entirely: it could otherwise arm the
 *                      confirm for one path while Replace posted another's.
 *   - too large      → the size ceiling's actionable copy (clear the outputs),
 *                      not just the raw server sentence.
 *   - disconnected   → no button at all: without a connection there is no user
 *                      folder to resolve and nothing to upload as.
 *   - expired auth   → the panel's existing actionable re-auth message, with the
 *                      exact `databricks auth login --profile <name>` command -
 *                      not a bare failure.
 *
 * The server op (auth path, JUPYTER format, the exists check gating `import_`) is
 * proven in `tests/unit/databricks-upload-notebook.test.ts`. Here the routes are
 * MOCKED, like the logout/redesign specs: a test must never be able to write into
 * the user's real Databricks workspace.
 */

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

const HOST = 'https://dbc-demo.cloud.databricks.com';
const USER = 'me@corp.example.com';
const WS_PATH = `/Users/${USER}/notebook`;

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

/** Installed, but no session: the upload has no identity to upload as. */
function disconnectedStatus() {
	return {
		connection: { connected: false },
		config: { profiles: [{ name: 'DEFAULT', host: HOST, hasToken: true }] },
		install: { python: '/tmp/.venv/bin/python', sdk: true, connect: true },
		uv: true,
		signedInHosts: [],
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
 * Serve `/api/databricks/upload` from a scripted reply, recording every request body.
 *
 * `hold` lets a test keep a reply IN FLIGHT: the confirm box has to stay on screen
 * for the whole replace, and that is only observable while the request is pending.
 */
async function mockUpload(
	page: Page,
	reply: (body: Record<string, unknown>) => { status: number; json: unknown },
	hold?: (body: Record<string, unknown>) => Promise<void>
): Promise<Record<string, unknown>[]> {
	const seen: Record<string, unknown>[] = [];
	await page.route(/\/api\/databricks\/upload$/, async (route) => {
		const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
		seen.push(body);
		if (hold) await hold(body);
		const { status, json } = reply(body);
		await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(json) });
	});
	return seen;
}

/**
 * Land on the canonical notebook, whatever the last test left focused.
 *
 * Every test here shares ONE workspace, and the ACTIVE notebook pointer is
 * server-side - so the switch-notebooks test below leaks its focus into the next
 * page load. A background pane is `display:none`, so without re-activating this
 * tab the first `cell` in the DOM belongs to a hidden notebook and never becomes
 * visible.
 */
async function openNotebook(page: Page): Promise<void> {
	const openBtn = page.getByTestId('empty-open-notebook');
	if (await openBtn.isVisible().catch(() => false)) await openBtn.click();
	const tab = page.locator('[data-testid="tab"][data-tab-id="notebook"]');
	if ((await tab.count()) > 0 && (await tab.getAttribute('data-active')) !== 'true') await tab.click();
	await expect(page.locator('[data-testid="cell"]:visible').first()).toBeVisible();
}

async function openDatabricksSection(page: Page): Promise<void> {
	const header = page.getByTestId('section-databricks');
	await expect(header).toBeVisible();
	if (!(await page.getByTestId('databricks-body').isVisible().catch(() => false))) await header.click();
	await expect(page.getByTestId('databricks-body')).toBeVisible();
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-e2e-dbx-upload-'));
	// A second notebook to switch to: the pending replace confirm must never survive
	// a notebook change, since Replace posts the CURRENT notebook's path.
	writeFileSync(
		join(workspace, 'other.ipynb'),
		JSON.stringify({
			nbformat: 4,
			nbformat_minor: 5,
			metadata: { kernelspec: { name: 'python3', display_name: 'python3', language: 'python' } },
			cells: [{ cell_type: 'code', id: 'other-0', metadata: {}, execution_count: null, outputs: [], source: ['1\n'] }]
		})
	);
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

test('connected: one click uploads and the panel reports the workspace path', async ({ page }) => {
	await mockDatabricksStatus(page, connectedStatus);
	await mockDatabricksClusters(page);
	const seen = await mockUpload(page, () => ({
		status: 200,
		json: { ok: true, status: 'uploaded', path: WS_PATH, url: `${HOST}/#workspace${WS_PATH}`, overwritten: false }
	}));

	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	await openDatabricksSection(page);

	await page.getByTestId('databricks-upload').click();

	const note = page.getByTestId('databricks-upload-note');
	await expect(note).toBeVisible();
	// Never leave the user guessing where it went.
	await expect(note).toContainText(WS_PATH);
	await expect(page.getByTestId('databricks-upload-link')).toHaveAttribute('href', `${HOST}/#workspace${WS_PATH}`);
	// The first attempt never asks to overwrite - that is what makes the confirm real.
	expect(seen).toHaveLength(1);
	expect(seen[0].overwrite).toBe(false);
});

test('already in the workspace: nothing is written until Replace is confirmed', async ({ page }) => {
	await mockDatabricksStatus(page, connectedStatus);
	await mockDatabricksClusters(page);
	const seen = await mockUpload(page, (body) =>
		body.overwrite === true
			? {
					status: 200,
					json: { ok: true, status: 'uploaded', path: WS_PATH, url: `${HOST}/#workspace${WS_PATH}`, overwritten: true }
				}
			: { status: 200, json: { ok: true, status: 'exists', path: WS_PATH, url: null, overwritten: false } }
	);

	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	await openDatabricksSection(page);

	await page.getByTestId('databricks-upload').click();

	// The confirm names the path AND what replacing costs - no silent clobber.
	const box = page.getByTestId('databricks-upload-confirm-box');
	await expect(box).toBeVisible();
	await expect(box).toContainText(WS_PATH);
	await expect(box).toContainText('overwrites');
	await expect(page.getByTestId('databricks-upload-note')).toHaveCount(0);

	// Cancel is a real out: it sends nothing and puts the button back.
	await page.getByTestId('databricks-upload-cancel').click();
	await expect(page.getByTestId('databricks-upload')).toBeVisible();
	expect(seen.filter((b) => b.overwrite === true)).toHaveLength(0);

	// Only the deliberate second click replaces.
	await page.getByTestId('databricks-upload').click();
	await page.getByTestId('databricks-upload-replace').click();
	await expect(page.getByTestId('databricks-upload-note')).toContainText('Replaced in your Databricks workspace');
	expect(seen.filter((b) => b.overwrite === true)).toHaveLength(1);
});

test('replacing keeps the confirm box up, so the path being overwritten stays on screen', async ({ page }) => {
	await mockDatabricksStatus(page, connectedStatus);
	await mockDatabricksClusters(page);
	let release!: () => void;
	const held = new Promise<void>((resolve) => (release = resolve));
	await mockUpload(
		page,
		(body) =>
			body.overwrite === true
				? {
						status: 200,
						json: { ok: true, status: 'uploaded', path: WS_PATH, url: `${HOST}/#workspace${WS_PATH}`, overwritten: true }
					}
				: { status: 200, json: { ok: true, status: 'exists', path: WS_PATH, url: null, overwritten: false } },
		async (body) => {
			// Only the replace is held: the first call must settle so the confirm arms.
			if (body.overwrite === true) await held;
		}
	);

	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	await openDatabricksSection(page);

	await page.getByTestId('databricks-upload').click();
	const box = page.getByTestId('databricks-upload-confirm-box');
	await expect(box).toBeVisible();

	await page.getByTestId('databricks-upload-replace').click();

	// Mid-replace: the box is still mounted and still naming the path being
	// overwritten. Swapping it for the plain button here would take that away at
	// exactly the moment it matters most.
	await expect(page.getByTestId('databricks-upload-replace')).toContainText('Replacing');
	await expect(box).toBeVisible();
	await expect(box).toContainText(WS_PATH);
	await expect(page.getByTestId('databricks-upload')).toHaveCount(0);

	release();

	// ...and torn down once it settles, replaced by the outcome.
	await expect(page.getByTestId('databricks-upload-note')).toContainText('Replaced in your Databricks workspace');
	await expect(box).toHaveCount(0);
	await expect(page.getByTestId('databricks-upload')).toBeVisible();
});

test('a reply that lands after a notebook switch is DROPPED - it can never arm the confirm', async ({ page }) => {
	await mockDatabricksStatus(page, connectedStatus);
	await mockDatabricksClusters(page);
	let release!: () => void;
	const held = new Promise<void>((resolve) => (release = resolve));
	const seen = await mockUpload(
		page,
		() => ({ status: 200, json: { ok: true, status: 'exists', path: WS_PATH, url: null, overwritten: false } }),
		async () => held
	);

	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	await openDatabricksSection(page);

	await page.getByTestId('databricks-upload').click();

	// Switch notebooks while the reply is still in flight.
	await page.getByTestId('tree-file').filter({ hasText: 'other.ipynb' }).dblclick();
	await expect(page.locator('[data-testid="tab"][data-tab-id="file:other.ipynb"]')).toHaveAttribute('data-active', 'true');

	release();
	await expect.poll(() => seen.length).toBe(1);

	// The reply describes the notebook the panel LEFT. Arming the confirm from it
	// would show one path while Replace posted the current notebook's - overwriting
	// something the user was never prompted for.
	await expect(page.getByTestId('databricks-upload-confirm-box')).toHaveCount(0);
	await expect(page.getByTestId('databricks-upload-note')).toHaveCount(0);
	await expect(page.getByTestId('databricks-upload-error')).toHaveCount(0);
	await expect(page.getByTestId('databricks-upload')).toBeEnabled();
});

test('a failed replace reports the error and puts the button back - never a dead end', async ({ page }) => {
	await mockDatabricksStatus(page, connectedStatus);
	await mockDatabricksClusters(page);
	await mockUpload(page, (body) =>
		body.overwrite === true
			? { status: 403, json: { code: 'permission_denied', message: 'PermissionDenied: not yours' } }
			: { status: 200, json: { ok: true, status: 'exists', path: WS_PATH, url: null, overwritten: false } }
	);

	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	await openDatabricksSection(page);

	await page.getByTestId('databricks-upload').click();
	await page.getByTestId('databricks-upload-replace').click();

	await expect(page.getByTestId('databricks-upload-error')).toBeVisible();
	// The confirm is gone and the ordinary button is back: a Replace that failed must
	// not leave the user inside a box whose only action just failed.
	await expect(page.getByTestId('databricks-upload-confirm-box')).toHaveCount(0);
	await expect(page.getByTestId('databricks-upload')).toBeEnabled();
});

test('a notebook too large to import says so, with the remedy', async ({ page }) => {
	await mockDatabricksStatus(page, connectedStatus);
	await mockDatabricksClusters(page);
	await mockUpload(page, () => ({
		status: 413,
		json: {
			code: 'notebook_too_large',
			message: '"notebook.ipynb" is 9.4 MB, past the 7.0 MB a Databricks workspace import accepts.'
		}
	}));

	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	await openDatabricksSection(page);

	await page.getByTestId('databricks-upload').click();

	// Actionable copy, not just the raw server sentence: the size is a fact, "clear
	// the outputs" is what the user can do about it.
	const err = page.getByTestId('databricks-upload-error');
	await expect(err).toBeVisible();
	await expect(err).toContainText('Clear all outputs');
	await expect(page.getByTestId('databricks-upload')).toBeEnabled();
});

test('not connected: the upload control is not offered at all', async ({ page }) => {
	await mockDatabricksStatus(page, disconnectedStatus);
	await mockDatabricksClusters(page);

	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	await openDatabricksSection(page);

	await expect(page.getByTestId('databricks-picker')).toBeVisible();
	await expect(page.getByTestId('databricks-upload')).toHaveCount(0);
});

test('an expired profile sign-in surfaces the exact re-auth command, not a bare failure', async ({ page }) => {
	await mockDatabricksStatus(page, connectedStatus);
	await mockDatabricksClusters(page);
	await mockUpload(page, () => ({
		status: 401,
		json: {
			code: 'profile_reauth_required',
			profile: 'DEFAULT',
			message:
				'Your saved Databricks sign-in for profile "DEFAULT" has expired. ValueError: default auth: databricks-cli: cannot get access token.'
		}
	}));

	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	await openDatabricksSection(page);

	await page.getByTestId('databricks-upload').click();

	// The one auth dead end Cellar cannot fix for the user: it must show the command,
	// never the sidebar's own sign-in button.
	await expect(page.getByTestId('databricks-upload-error')).toBeVisible();
	await expect(page.getByTestId('databricks-upload-error-reauth-command')).toContainText(
		'databricks auth login --profile DEFAULT'
	);
});
