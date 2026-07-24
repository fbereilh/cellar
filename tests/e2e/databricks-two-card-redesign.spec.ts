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
		// The kernel is running but was NOT started with the runtime env - the shape a
		// connect leaves behind now that it no longer restarts. The Runtime card's state
		// pill must report THIS, never the stored preference.
		runtime: { kernelStarted: true, liveVersion: null },
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
	// Exactly one of active/pending/off/restarting is shown.
	const statusCount =
		(await page.getByTestId('databricks-runtime-active').count()) +
		(await page.getByTestId('databricks-runtime-pending').count()) +
		(await page.getByTestId('databricks-runtime-inactive').count()) +
		(await page.getByTestId('databricks-runtime-applying').count());
	expect(statusCount).toBe(1);
	// ...and it is never "active" over a kernel the server says carries no runtime,
	// whatever the stored preference asks for.
	await expect(page.getByTestId('databricks-runtime-active')).toHaveCount(0);

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
	// "Apply now" belongs ONLY to the pending state (asserted in the pill test below).
	// Here the preference is off, so there is nothing to apply and offering a restart
	// would be a namespace wipe nobody asked for.
	await expect(page.getByTestId('databricks-runtime-apply')).toHaveCount(0);

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
	// What connecting will actually do is surfaced inline: it binds spark/w in the
	// running kernel and no longer auto-enables the runtime. The variables-kept claim
	// is QUALIFIED, not absolute - a databricks-connect re-pin still restarts - so the
	// note must name that exception rather than promise something connect can break.
	const note = page.getByTestId('databricks-connect-note');
	await expect(note).toBeVisible();
	await expect(note).toContainText(/variables are kept/i);
	await expect(note).toContainText(/re-pinned/i);
	await expect(note).not.toContainText(/enables the Databricks runtime/i);
	await expect(page.getByTestId('databricks-runtime-card')).toHaveCount(0);
	await expect(page.getByTestId('databricks-runtime-hint')).toHaveCount(0);

	const section = page.getByTestId('section-databricks').locator('xpath=ancestor::*[1]/parent::*');
	await section.screenshot({ path: join(EVIDENCE_DIR, 'databricks-disconnected-picker.png') });
});

/**
 * The state pill reports the RUNNING KERNEL, never the stored preference.
 *
 * Now that connecting no longer restarts, the two genuinely diverge: a stored `true`
 * (a prior toggle, or one carried over from the build whose connect wrote it) over a
 * kernel that started while the notebook was still unbound - so the scope gate
 * skipped the injection. A preference-derived pill claims "active" there while the
 * kernel's `DATABRICKS_RUNTIME_VERSION` is unset. This seeds exactly that state (the
 * preference ON via its own API, the mocked status reporting no live runtime) and
 * pins that the card says "pending" instead. Runs LAST: it writes the workspace's
 * preference store.
 */
test('the Runtime pill never claims "active" over a kernel without the runtime', async ({ page }) => {
	await page.request.put(`${baseURL}/api/ui-state`, { data: { 'cellar-databricks-runtime': true } });
	await mockDatabricksStatus(page, connectedStatus()); // runtime: liveVersion null
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	await openDatabricksSection(page);

	// The toggle reflects the PREFERENCE (that is what the user set)...
	await expect(page.getByTestId('databricks-runtime-toggle')).toBeChecked();
	// ...while the pill reports REALITY, and names the divergence.
	await expect(page.getByTestId('databricks-runtime-pending')).toBeVisible();
	await expect(page.getByTestId('databricks-runtime-active')).toHaveCount(0);
	await expect(page.getByTestId('databricks-runtime-card')).toContainText(/restart the kernel to apply/i);

	// ...and the state that says "restart the kernel to apply" offers a way to do it,
	// so the only route is not the toggle's off-then-on double restart.
	const apply = page.getByTestId('databricks-runtime-apply');
	await expect(apply).toBeVisible();
	await expect(apply).toBeEnabled();
	await expect(apply).toContainText(/restarts kernel/i);

	await page.request.put(`${baseURL}/api/ui-state`, { data: { 'cellar-databricks-runtime': null } });
});

/**
 * "Apply now" may only appear where clicking it can actually do something.
 *
 * Every click costs the user their namespace (a kernel restart, the Databricks
 * session rebuilt), so a state where the restart cannot change the outcome must not
 * offer it at all. Two such states, both proven here:
 *
 *   - the decision is FORCED by `CELLAR_DATABRICKS_RUNTIME` (`runtime.envForced`):
 *     no toggle and no restart can move it, so the card says the environment is in
 *     control and offers nothing. Without this the carried-over stored `true` this
 *     build deliberately does not migrate would sit in "pending" forever, wiping the
 *     namespace on every click and landing back on pending.
 *   - there is no active NOTEBOOK to restart: `applyRuntime`'s restart is guarded on
 *     the notebook path, so the click would spin and change nothing.
 *
 * Both run with the preference stored ON, so the ordinary pending case (proven
 * enabled above) is the only difference.
 */
test('an env-FORCED runtime says the environment controls it and offers no Apply now', async ({ page }) => {
	await page.request.put(`${baseURL}/api/ui-state`, { data: { 'cellar-databricks-runtime': true } });
	// Forced OFF over a stored ON - the exact shape that used to loop.
	await mockDatabricksStatus(page, {
		...connectedStatus(),
		runtime: { kernelStarted: true, liveVersion: null, envForced: false }
	});
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	await openDatabricksSection(page);

	const card = page.getByTestId('databricks-runtime-card');
	await expect(card).toBeVisible();
	// The override is what is in force, so the toggle shows OFF and is not in control.
	const toggle = page.getByTestId('databricks-runtime-toggle');
	await expect(toggle).not.toBeChecked();
	await expect(toggle).toBeDisabled();
	await expect(card).toContainText(/CELLAR_DATABRICKS_RUNTIME/);
	await expect(card).toContainText(/not by this\s+toggle/i);
	// Nothing to apply, and no restart on offer.
	await expect(page.getByTestId('databricks-runtime-apply')).toHaveCount(0);
	await expect(card).not.toContainText(/restart the kernel to apply/i);

	// Forced ON over a kernel started without it is still the environment's call: the
	// pill is honest ("pending"), but a restart is not something the card asks for.
	await mockDatabricksStatus(page, {
		...connectedStatus(),
		runtime: { kernelStarted: true, liveVersion: null, envForced: true }
	});
	await page.reload();
	await openDatabricksSection(page);
	await expect(page.getByTestId('databricks-runtime-toggle')).toBeChecked();
	await expect(page.getByTestId('databricks-runtime-toggle')).toBeDisabled();
	await expect(page.getByTestId('databricks-runtime-pending')).toBeVisible();
	await expect(page.getByTestId('databricks-runtime-apply')).toHaveCount(0);

	await page.request.put(`${baseURL}/api/ui-state`, { data: { 'cellar-databricks-runtime': null } });
});

test('with no notebook open, Apply now is disabled and says so - never a silent no-op', async ({ page }) => {
	await page.request.put(`${baseURL}/api/ui-state`, { data: { 'cellar-databricks-runtime': true } });
	await mockDatabricksStatus(page, connectedStatus()); // pending: kernel started, no live runtime
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	// Deliberately leave NO notebook open: the sidebar then has no active notebook
	// path, which is what makes the restart a no-op. The tab session is persisted
	// per workspace SERVER-side, so an earlier test's notebook can be restored here -
	// close whatever came back rather than assuming a clean slate.
	const closers = page.getByTestId('tab-close');
	for (let i = 0; i < 8 && (await closers.count()) > 0; i++) await closers.first().click();
	await expect(page.getByTestId('empty-state')).toBeVisible();
	await openDatabricksSection(page);

	await expect(page.getByTestId('databricks-runtime-pending')).toBeVisible();
	const apply = page.getByTestId('databricks-runtime-apply');
	await expect(apply).toBeVisible();
	await expect(apply).toBeDisabled();
	await expect(apply).toContainText(/open a notebook/i);

	await page.request.put(`${baseURL}/api/ui-state`, { data: { 'cellar-databricks-runtime': null } });
});
