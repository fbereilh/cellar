import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * E2E for the Databricks sidebar section-header status pill REMOVAL (target
 * commit "fix(databricks): remove sidebar section-header status pill").
 *
 * End-user intent: the d5 redesign added a connection-status badge
 * (`data-testid=databricks-header-status`) to the DATABRICKS section header row
 * - the "● cluster-name" / "connecting" / "reconnecting" / "lost" pill that
 * stayed visible next to the label. The captain wants it gone in ALL states.
 *
 * To exercise the states that USED to render the pill without a real Databricks
 * cluster, the `/api/databricks` status route is MOCKED to report a connected
 * session (formerly a green cluster-name pill) and an expired session (formerly
 * an amber "reconnecting" pill). In both, the header must now show only the
 * DATABRICKS label + refresh control - no `databricks-header-status` element -
 * while the panel body still proves the connection state is what it claims.
 *
 * Boots the REAL launcher against a throwaway workspace (see ./harness); SKIPS
 * when the kernel runtime is absent (local-only, like the other specs).
 */

const EVIDENCE_DIR =
	process.env.CELLAR_EVIDENCE_DIR ||
	'/var/folders/ds/m71hq5ln637g23x6xmrwqg080000gn/T/no-mistakes-evidence/01KY4M4DDS3WYADZQG78K2932G';

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

/** A DbxStatus body the Databricks panel treats as a live, connected session. */
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

/** A DbxStatus body the panel treats as a bound-but-expired session (was an amber pill). */
function expiredStatus() {
	return {
		connection: {
			connected: false,
			expired: true,
			lost: { clusterName: 'analytics-prod' },
			profile: 'DEFAULT',
			host: 'https://dbc-demo.cloud.databricks.com',
			clusterId: '0710-abc123-xyz',
			clusterName: 'analytics-prod'
		},
		config: { profiles: [{ name: 'DEFAULT', host: 'https://dbc-demo.cloud.databricks.com', hasToken: true }] },
		install: { python: '/tmp/.venv/bin/python', sdk: true, connect: true },
		uv: true
	};
}

/** Intercept the Databricks STATUS route only (not clusters/catalog) with a fixed body. */
async function mockDatabricksStatus(page: Page, body: unknown): Promise<void> {
	await page.route(/\/api\/databricks(\?.*)?$/, async (route) => {
		if (route.request().method() !== 'GET') return route.continue();
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(body)
		});
	});
}

/** Open the seeded/default notebook so the shell has an active notebook + full sidebar. */
async function openNotebook(page: Page): Promise<void> {
	const openBtn = page.getByTestId('empty-open-notebook');
	if (await openBtn.isVisible().catch(() => false)) await openBtn.click();
	await expect(page.getByTestId('cell').first()).toBeVisible();
}

/** Expand the DATABRICKS sidebar section (lazy-mounts the panel + fires its status probe). */
async function openDatabricksSection(page: Page): Promise<void> {
	const header = page.getByTestId('section-databricks');
	await expect(header).toBeVisible();
	// The panel body is the marker that the section is expanded + mounted.
	if (!(await page.getByTestId('databricks-body').isVisible().catch(() => false))) {
		await header.click();
	}
	await expect(page.getByTestId('databricks-body')).toBeVisible();
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-e2e-dbx-pill-'));
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

test('connected session: header shows no status pill (was a green cluster-name pill)', async ({ page }) => {
	await mockDatabricksStatus(page, connectedStatus());
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	await openDatabricksSection(page);

	// The panel body proves the state IS connected (the compact connected view +
	// its in-panel "connected" badge, which is deliberately KEPT).
	await expect(page.getByTestId('databricks-connected')).toBeVisible();
	await expect(page.getByTestId('databricks-connection-status')).toBeVisible();

	// The removed header pill must be gone even in this state.
	await expect(page.getByTestId('databricks-header-status')).toHaveCount(0);

	// Reviewer-visible evidence: the DATABRICKS header (label + refresh, no pill)
	// with the connected panel below it.
	const section = page.getByTestId('section-databricks').locator('xpath=ancestor::*[1]/parent::*');
	await section.screenshot({ path: join(EVIDENCE_DIR, 'databricks-header-connected-no-pill.png') });
	await page.screenshot({ path: join(EVIDENCE_DIR, 'databricks-connected-full.png') });
});

test('expired session: header shows no status pill (was an amber "reconnecting" pill)', async ({ page }) => {
	await mockDatabricksStatus(page, expiredStatus());
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	await openDatabricksSection(page);

	// Panel body proves the state is the bound-but-expired one that used to pill.
	await expect(page.getByTestId('databricks-expired')).toBeVisible();

	// No header pill in the expired state either.
	await expect(page.getByTestId('databricks-header-status')).toHaveCount(0);

	const section = page.getByTestId('section-databricks').locator('xpath=ancestor::*[1]/parent::*');
	await section.screenshot({ path: join(EVIDENCE_DIR, 'databricks-header-expired-no-pill.png') });
});
