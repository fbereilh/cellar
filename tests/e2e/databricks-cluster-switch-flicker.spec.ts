import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * The reported defect, in a real browser: "when i change dbx clusters there is a
 * flickering of the screen".
 *
 * The connecting state was a SIBLING BRANCH of the connected view, so a cluster switch
 * unmounted the Cluster card, the Upload card, the Runtime card and the whole Unity
 * Catalog browser down to one small "Connecting…" card and sprang them all back a
 * moment later. Measured here before the fix: the sidebar section went 971px -> 144px
 * -> 709px, i.e. an 800px collapse-and-restore, which on a warm cluster is one hard
 * blink and on a cold one is a panel that empties out for minutes.
 *
 * The RULE is unit-tested in `tests/unit/databricks-panel-state.test.ts` (e2e runs in
 * neither CI nor the no-mistakes gate, so the rule may not be pinned here alone). This
 * spec proves the thing only a browser can: the rendered panel does not move.
 *
 * Every /api/databricks route is MOCKED - a switch needs two real clusters and would
 * start compute in a live workspace, and the defect is entirely client-side. Boots the
 * REAL launcher; SKIPS when the kernel runtime is absent.
 */

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

const CLUSTER_A = { id: '0710-abc123-xyz', name: 'analytics-prod', ver: '15.4.x-scala2.12' };
const CLUSTER_B = { id: '0710-def456-uvw', name: 'ml-training', ver: '16.1.x-scala2.12' };

/** Which cluster the mocked server currently reports as connected. */
let live = CLUSTER_A;

function connectedStatus() {
	return {
		connection: {
			connected: true,
			profile: 'DEFAULT',
			host: 'https://dbc-demo.cloud.databricks.com',
			clusterId: live.id,
			clusterName: live.name,
			sparkVersion: live.ver
		},
		config: { profiles: [{ name: 'DEFAULT', host: 'https://dbc-demo.cloud.databricks.com', hasToken: true }] },
		install: { python: '/tmp/.venv/bin/python', sdk: true, connect: true },
		runtime: { kernelStarted: true, liveVersion: null },
		uv: true
	};
}

interface MockOpts {
	/** How long the connect POST takes, so the in-flight panel can be measured. */
	connectDelayMs?: number;
	/** Start disconnected (the first-connect path). */
	disconnected?: boolean;
	/** Fail the connect with this message. */
	failConnect?: string;
}

async function mockDatabricks(page: Page, opts: MockOpts = {}): Promise<void> {
	const { connectDelayMs = 0, disconnected = false, failConnect } = opts;
	let connected = !disconnected;

	await page.route(/\/api\/databricks(\?.*)?$/, async (route) => {
		if (route.request().method() !== 'GET') return route.continue();
		const body = connected
			? connectedStatus()
			: { ...connectedStatus(), connection: { connected: false } };
		await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
	});

	await page.route(/\/api\/databricks\/clusters(\?.*)?$/, async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				clusters: [
					{ cluster_id: CLUSTER_A.id, name: CLUSTER_A.name, state: 'RUNNING', spark_version: CLUSTER_A.ver },
					{ cluster_id: CLUSTER_B.id, name: CLUSTER_B.name, state: 'RUNNING', spark_version: CLUSTER_B.ver }
				]
			})
		});
	});

	await page.route(/\/api\/databricks\/connect(\?.*)?$/, async (route) => {
		if (route.request().method() !== 'POST') return route.continue();
		const post = route.request().postDataJSON() as { clusterId: string; clusterName: string };
		if (connectDelayMs) await new Promise((r) => setTimeout(r, connectDelayMs));
		if (failConnect) {
			return route.fulfill({
				status: 502,
				contentType: 'application/json',
				body: JSON.stringify({ code: 'connect_failed', message: failConnect })
			});
		}
		live = post.clusterId === CLUSTER_B.id ? CLUSTER_B : CLUSTER_A;
		connected = true;
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ ok: true, connection: connectedStatus().connection })
		});
	});

	// The Unity Catalog browser (one level per expand).
	await page.route(/\/api\/databricks\/catalog(\?.*)?$/, async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ catalogs: [{ name: 'main' }, { name: 'samples' }, { name: 'system' }] })
		});
	});
}

async function openNotebook(page: Page): Promise<void> {
	const openBtn = page.getByTestId('empty-open-notebook');
	// Settle on whichever the shell paints - the empty state, or a notebook that is
	// already open - BEFORE probing. Probed earlier, a slow first paint reports the
	// button invisible, the click becomes a no-op, and the wait below then times out
	// on a notebook nothing ever opened (a real flake under `workers: 2`).
	await expect(openBtn.or(page.getByTestId('cell').first())).toBeVisible();
	if (await openBtn.isVisible().catch(() => false)) await openBtn.click();
	await expect(page.getByTestId('cell').first()).toBeVisible();
}

async function openDatabricksSection(page: Page): Promise<void> {
	const header = page.getByTestId('section-databricks');
	await expect(header).toBeVisible();
	if (!(await page.getByTestId('databricks-body').isVisible().catch(() => false))) await header.click();
	await expect(page.getByTestId('databricks-body')).toBeVisible();
}

/** Rendered height of the whole Databricks panel, rounded to a whole pixel. */
async function panelHeight(page: Page): Promise<number> {
	const bb = await page.getByTestId('databricks-body').boundingBox();
	return Math.round(bb?.height ?? -1);
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-e2e-dbx-switch-'));
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

test.beforeEach(() => {
	live = CLUSTER_A;
});

test('switching clusters never collapses the panel: the cards stay put and the height holds', async ({ page }) => {
	await mockDatabricks(page, { connectDelayMs: 2500 });
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	await openDatabricksSection(page);
	await expect(page.getByTestId('databricks-connected')).toBeVisible();
	await expect(page.getByTestId('databricks-browser')).toBeVisible();

	const before = await panelHeight(page);
	expect(before).toBeGreaterThan(0);

	await page.getByTestId('databricks-switch').click();
	await page.getByTestId('databricks-cluster').nth(1).click();

	// The Cluster card wears the connecting face...
	await expect(page.getByTestId('databricks-connecting-badge')).toBeVisible();
	await expect(page.getByTestId('databricks-connecting-name')).toContainText(CLUSTER_B.name);
	// ...and the standalone card - the thing that used to replace the whole panel -
	// is never rendered over a live session.
	await expect(page.getByTestId('databricks-connecting')).toHaveCount(0);

	// Every card the collapse used to take with it is still mounted, throughout.
	await expect(page.getByTestId('databricks-connected')).toBeVisible();
	await expect(page.getByTestId('databricks-upload-card')).toBeVisible();
	await expect(page.getByTestId('databricks-runtime-card')).toBeVisible();
	await expect(page.getByTestId('databricks-browser')).toBeVisible();

	// The panel does not move for the whole wait. Before the fix this window was a
	// 144px card where a ~700px panel had been.
	const during: number[] = [];
	for (let i = 0; i < 20; i++) {
		during.push(await panelHeight(page));
		await page.waitForTimeout(75);
	}
	expect(Math.min(...during)).toBeGreaterThanOrEqual(before - 2);
	expect(Math.max(...during)).toBeLessThanOrEqual(before + 2);

	// Landed on the new cluster, back to the resting card, same height.
	await expect(page.getByTestId('databricks-connection-status')).toBeVisible({ timeout: 15000 });
	await expect(page.getByTestId('databricks-connected')).toContainText(CLUSTER_B.name);
	await page.waitForTimeout(400);
	expect(Math.abs((await panelHeight(page)) - before)).toBeLessThanOrEqual(2);
});

test('the Unity Catalog tree survives a switch instead of flashing "loading catalogs…"', async ({ page }) => {
	await mockDatabricks(page, { connectDelayMs: 400 });
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	await openDatabricksSection(page);
	const firstCatalog = page.getByTestId('databricks-catalog').first();
	await expect(firstCatalog).toBeVisible();

	// The listing is workspace-scoped (`connectionParams()` sends profile/host and no
	// cluster), so the same workspace's tree must not be torn down and rebuilt.
	const loading = page.getByText('loading catalogs…');
	await page.getByTestId('databricks-switch').click();
	await page.getByTestId('databricks-cluster').nth(1).click();
	await expect(page.getByTestId('databricks-connection-status')).toBeVisible({ timeout: 15000 });
	await expect(page.getByTestId('databricks-connected')).toContainText(CLUSTER_B.name);
	await expect(loading).toHaveCount(0);
	await expect(firstCatalog).toBeVisible();
});

test('a FIRST connect still shows the standalone connecting card', async ({ page }) => {
	await mockDatabricks(page, { connectDelayMs: 1200, disconnected: true });
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	await openDatabricksSection(page);
	await expect(page.getByTestId('databricks-picker')).toBeVisible();

	await page.getByTestId('databricks-cluster').nth(1).click();
	// Nothing to hold here, so the standalone card IS the progression rather than a
	// collapse - picker -> connecting -> connected.
	await expect(page.getByTestId('databricks-connecting')).toBeVisible();
	await expect(page.getByTestId('databricks-connecting')).toContainText(CLUSTER_B.name);
	await expect(page.getByTestId('databricks-picker')).toHaveCount(0);

	await expect(page.getByTestId('databricks-connection-status')).toBeVisible({ timeout: 15000 });
	await expect(page.getByTestId('databricks-connected')).toContainText(CLUSTER_B.name);
});

test('a FAILED switch keeps the cards, reopens the picker and shows the error', async ({ page }) => {
	await mockDatabricks(page, { connectDelayMs: 200, failConnect: 'cluster is unreachable' });
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	await openDatabricksSection(page);
	await expect(page.getByTestId('databricks-connected')).toBeVisible();

	await page.getByTestId('databricks-switch').click();
	await page.getByTestId('databricks-cluster').nth(1).click();

	// The picker is collapsed on the click, so a failure has to bring it back - it
	// carries the one error box AND the list to retry from.
	const err = page.getByTestId('databricks-connect-error');
	await expect(err).toBeVisible({ timeout: 10000 });
	await expect(err).toContainText('unreachable');
	await expect(page.getByTestId('databricks-cluster').first()).toBeVisible();

	// Still connected to the ORIGINAL cluster, with every card in place.
	await expect(page.getByTestId('databricks-connected')).toContainText(CLUSTER_A.name);
	await expect(page.getByTestId('databricks-connection-status')).toBeVisible();
	await expect(page.getByTestId('databricks-runtime-card')).toBeVisible();
	// The failure released the hold, so the connecting face is gone.
	await expect(page.getByTestId('databricks-connecting-badge')).toHaveCount(0);
});

test('a genuinely lost session is still reported as lost', async ({ page }) => {
	// The hold is scoped to an expected transition; nothing must let it mask a real
	// loss once the connect has settled.
	await page.route(/\/api\/databricks(\?.*)?$/, async (route) => {
		if (route.request().method() !== 'GET') return route.continue();
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				connection: { connected: false, lost: { clusterName: CLUSTER_A.name, clusterId: CLUSTER_A.id } },
				config: { profiles: [{ name: 'DEFAULT', host: 'https://dbc-demo.cloud.databricks.com', hasToken: true }] },
				install: { python: '/tmp/.venv/bin/python', sdk: true, connect: true },
				uv: true
			})
		});
	});
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	await openDatabricksSection(page);
	await expect(page.getByTestId('databricks-lost')).toBeVisible();
	await expect(page.getByTestId('databricks-lost')).toContainText(CLUSTER_A.name);
});
