import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';
import { SDK_DBUTILS_FOREIGN_WARNING } from '../../src/lib/dbutilsShim';

/**
 * E2E for the human half of the `dbutils` SDK-import bypass report.
 *
 * The bug is SILENT: when `from databricks.sdk.runtime import dbutils` resolves to
 * the SDK's own object instead of Cellar's shim, the SDK renders the same
 * parameter controls and then discards every entered value on re-declaration - so
 * rendered widgets are exactly the signal a user reads as "this works". The only
 * thing that can tell them otherwise is the sidebar, which is why the WARNING has
 * to be seen, not merely asserted: this spec captures what the reviewer would see.
 *
 * Whether the rebind itself works is proven against real Python in
 * `tests/unit/dbutils-sdk-import.test.ts`; what needs a browser is the copy, the
 * placement and the "only for the OBSERVED foreign state" rule. The server state
 * is MOCKED at `/api/databricks` (the `databricks-two-card-redesign` /
 * `databricks-header-pill` precedent) - a real foreign binding needs a Databricks
 * connection this spec must not require. Boots the REAL launcher; SKIPS when the
 * kernel runtime is absent.
 */

const EVIDENCE_DIR =
	process.env.CELLAR_EVIDENCE_DIR ||
	join(tmpdir(), 'cellar-dbutils-warning-evidence');

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

type SdkState = 'shim' | 'foreign' | 'not_imported' | 'unknown';

/** A connected session whose kernel advertises the runtime, with a chosen binding state. */
function connectedStatus(sdkDbutils: SdkState) {
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
		runtime: { kernelStarted: true, liveVersion: '15.4', sdkDbutils },
		uv: true
	};
}

/**
 * No cluster attached, but the kernel still advertises the runtime - the shim is
 * installed on EVERY kernel, so the widgets can be dead here too. This is the
 * state that proves the warning is not scoped to the connected card.
 */
function disconnectedStatus(sdkDbutils: SdkState) {
	return {
		connection: { connected: false },
		config: { profiles: [{ name: 'DEFAULT', host: 'https://dbc-demo.cloud.databricks.com', hasToken: true }] },
		install: { python: '/tmp/.venv/bin/python', sdk: true, connect: true },
		runtime: { kernelStarted: true, liveVersion: '15.4', sdkDbutils },
		uv: true
	};
}

async function mockDatabricksStatus(page: Page, body: unknown): Promise<void> {
	await page.route(/\/api\/databricks(\?.*)?$/, async (route) => {
		if (route.request().method() !== 'GET') return route.continue();
		await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
	});
}

async function mockDatabricksClusters(page: Page): Promise<void> {
	await page.route(/\/api\/databricks\/clusters(\?.*)?$/, async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				clusters: [
					{ cluster_id: '0710-abc123-xyz', name: 'analytics-prod', state: 'RUNNING', spark_version: '15.4.x-scala2.12' }
				]
			})
		});
	});
}

async function openNotebook(page: Page): Promise<void> {
	const openBtn = page.getByTestId('empty-open-notebook');
	if (await openBtn.isVisible().catch(() => false)) await openBtn.click();
	else if (!(await page.getByTestId('cell').first().isVisible().catch(() => false))) {
		// A reload restores the persisted tab set, which may hold no notebook and so
		// render neither the empty-state button nor a cell: open it from the tree.
		await page.getByRole('button', { name: 'notebook.ipynb' }).first().click();
	}
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

/** The rendered sidebar section - the artifact a reviewer reads the copy off. */
async function sectionShot(page: Page, name: string): Promise<void> {
	const section = page.getByTestId('section-databricks').locator('xpath=ancestor::*[1]/parent::*');
	await section.screenshot({ path: join(EVIDENCE_DIR, name) });
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-e2e-dbx-sdkwarn-'));
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

test('foreign binding: the Runtime card says the parameter widgets are dead', async ({ page }) => {
	await mockDatabricksStatus(page, connectedStatus('foreign'));
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	await openDatabricksSection(page);

	const warning = page.getByTestId('databricks-runtime-sdk-warning');
	await expect(warning).toBeVisible();
	// The one sentence, verbatim from the shared module - the same string
	// `databricks_status` hands the agent, so the two cannot tell different stories.
	await expect(warning).toHaveText(SDK_DBUTILS_FOREIGN_WARNING);
	// It belongs to the Runtime card (where the runtime is explained), not floating
	// somewhere in the section.
	await expect(page.getByTestId('databricks-runtime-card').getByTestId('databricks-runtime-sdk-warning')).toBeVisible();
	// One branch renders at a time, so the marker stays unique in the DOM.
	await expect(warning).toHaveCount(1);

	// The card on its own, so the whole sentence is legible rather than clipped by
	// the sidebar's scroll viewport.
	const card = page.getByTestId('databricks-runtime-card');
	await card.scrollIntoViewIfNeeded();
	await card.screenshot({ path: join(EVIDENCE_DIR, 'dbutils-warning-runtime-card.png') });
	await sectionShot(page, 'dbutils-warning-runtime-card-in-sidebar.png');
	await page.screenshot({ path: join(EVIDENCE_DIR, 'dbutils-warning-runtime-card-full.png') });
});

test('the warning is silent for every state the server did not observe as foreign', async ({ page }) => {
	for (const state of ['shim', 'not_imported', 'unknown'] as SdkState[]) {
		await page.unrouteAll({ behavior: 'ignoreErrors' });
		await mockDatabricksStatus(page, connectedStatus(state));
		await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
		await openNotebook(page);
		await openDatabricksSection(page);
		await expect(page.getByTestId('databricks-runtime-card')).toBeVisible();
		// `unknown` in particular: a defect nobody verified must never be reported,
		// or a healthy kernel gets restarted over it.
		await expect(page.getByTestId('databricks-runtime-sdk-warning')).toHaveCount(0);
		if (state === 'shim') {
			const bound = page.getByTestId('databricks-runtime-card');
			await bound.scrollIntoViewIfNeeded();
			await bound.screenshot({ path: join(EVIDENCE_DIR, 'dbutils-warning-absent-when-bound.png') });
		}
	}
});

test('a disconnected session still says it: the shim rides every kernel', async ({ page }) => {
	await mockDatabricksStatus(page, disconnectedStatus('foreign'));
	await mockDatabricksClusters(page);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	await openDatabricksSection(page);

	// No cluster, so no Runtime card - the picker Cluster card carries it instead.
	await expect(page.getByTestId('databricks-runtime-card')).toHaveCount(0);
	const warning = page.getByTestId('databricks-runtime-sdk-warning');
	await expect(warning).toBeVisible();
	await expect(warning).toHaveText(SDK_DBUTILS_FOREIGN_WARNING);

	await sectionShot(page, 'dbutils-warning-disconnected-card.png');
});
