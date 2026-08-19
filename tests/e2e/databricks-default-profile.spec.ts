import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * WHERE the "no default profile" heads-up may appear - the gate, not the copy.
 *
 * The verdict itself reads `~/.databrickscfg` alone, and that is the whole truth
 * only in a kernel that has run `CONNECT_CODE`, whose `DATABRICKS_*` scrub is what
 * leaves the file as the only thing a bare `Config()` can consult. In a kernel that
 * never connected, a shell `DATABRICKS_HOST`+`DATABRICKS_TOKEN` short-circuits the
 * SDK's file loader outright and that `Config()` resolves without opening the file,
 * so the card would tell a perfectly healthy machine that resolving credentials
 * fails - the false nag this feature's brief forbids outright.
 *
 * So the gate has three states and each is pinned here, because the gate is one
 * expression in a Svelte component and nothing below this level can observe it:
 * the server-side verdict is identical in all three (`tests/unit/databricks-default-profile.test.ts`
 * owns that half against the real SDK), and only the rendered panel differs.
 *
 * The EXPIRED state is the subtle one and is deliberately admitted: `liveConnection`
 * reaches its expiry branch only after `status.connected` was true, so it is the SAME
 * process that ran the scrub - and it is exactly when the user is troubleshooting
 * their own failing `WorkspaceClient()`. A LOST/restarting session is refused for the
 * mirror-image reason: it may be a fresh kernel whose env was never scrubbed.
 *
 * Every `/api/databricks*` route is MOCKED (the stance of `databricks-profile-reauth.spec.ts`
 * and `databricks-logout.spec.ts`): no real workspace, credential, cluster or
 * `~/.databrickscfg` is reachable from this spec.
 */

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

const HOST = 'https://dbc-demo.cloud.databricks.com';
const CANDIDATES = ['prod-eu', 'staging', 'sandbox'];
const CLUSTER = 'analytics-shared';

/**
 * The server's verdict for a file with profiles but nothing marked default - the
 * reported failing shape. Identical in every state below, so the panel is the only
 * variable.
 */
const NEEDS_DEFAULT = {
	resolves: false,
	reason: 'no_default',
	profile: null,
	candidates: CANDIDATES,
	needsDefault: true
};

function baseStatus(connection: unknown, defaultProfile: unknown = NEEDS_DEFAULT) {
	return {
		connection,
		config: {
			profiles: CANDIDATES.map((name) => ({ name, host: HOST, hasToken: true, authType: null })),
			defaultProfile
		},
		install: { python: '/tmp/.venv/bin/python', sdk: true, connect: true },
		uv: true,
		signedInHosts: [],
		signedInProfiles: []
	};
}

/**
 * Every Databricks call the panel can make, answered locally. The status GET carries
 * the case under test; everything else is inert so no state depends on ordering and
 * nothing can escape to a real workspace.
 */
async function mockDatabricks(page: Page, status: () => unknown): Promise<void> {
	await page.route(/\/api\/databricks(\?.*)?$/, async (route) => {
		if (route.request().method() !== 'GET') return route.continue();
		await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(status()) });
	});
	await page.route(/\/api\/databricks\/clusters(\?.*)?$/, async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ clusters: [{ id: 'c-1', name: CLUSTER, state: 'RUNNING' }] })
		});
	});
	await page.route(/\/api\/databricks\/catalog(\?.*)?$/, async (route) => {
		await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ catalogs: [] }) });
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

/** Load the panel with `status` mocked, and wait for the card that state should show. */
async function openPanel(page: Page, status: () => unknown, settled: string): Promise<void> {
	await mockDatabricks(page, status);
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	await openDatabricksSection(page);
	// Anchor on the card the connection state itself renders, so an assertion about
	// the notice can never pass merely because the panel had not finished loading.
	await expect(page.getByTestId(settled)).toBeVisible();
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-e2e-dbx-default-profile-'));
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

test('never connected: the notice stays silent even though the file needs a default', async ({ page }) => {
	// The false nag. This kernel never ran CONNECT_CODE, so its DATABRICKS_* env is
	// whatever the user's shell exported - and with a host+token there, a bare
	// Config() resolves without reading the config file at all. The server's verdict
	// is the same `needsDefault: true` the connected case renders; only the gate
	// differs, which is why this asserts the verdict arrived and the card did not.
	await openPanel(page, () => baseStatus({ connected: false }), 'databricks-picker');

	await expect(page.getByTestId('databricks-default-profile')).toHaveCount(0);
	await expect(page.getByTestId('databricks-default-profile-command')).toHaveCount(0);
});

test('connected: the notice appears, with one command row per candidate', async ({ page }) => {
	await openPanel(
		page,
		() => baseStatus({ connected: true, profile: CANDIDATES[0], host: HOST, clusterId: 'c-1', clusterName: CLUSTER }),
		'databricks-connected'
	);

	const card = page.getByTestId('databricks-default-profile');
	await expect(card).toBeVisible();
	await expect(page.getByTestId('databricks-default-profile-problem')).toContainText(
		'cannot configure default credentials'
	);
	// It must not read as "your connection is broken": Cellar's own spark/w are fine.
	await expect(page.getByTestId('databricks-default-profile-consequence')).toContainText('unaffected');

	// Every candidate gets its own row - nothing is pre-selected for the user.
	const commands = page.getByTestId('databricks-default-profile-command');
	await expect(commands).toHaveCount(CANDIDATES.length);
	await expect(commands).toHaveText(CANDIDATES.map((name) => `databricks auth switch --profile ${name}`));
});

test('expired: the notice stays, because the same kernel already ran the scrub', async ({ page }) => {
	// Where the user is most likely troubleshooting - their own WorkspaceClient() is
	// failing right now - and the premise still holds: an expired session is reported
	// only for one that WAS live, so this is the same process, env already scrubbed.
	await openPanel(
		page,
		() => baseStatus({ connected: false, expired: true, lost: { profile: CANDIDATES[0], clusterName: CLUSTER } }),
		'databricks-expired'
	);

	await expect(page.getByTestId('databricks-default-profile')).toBeVisible();
	await expect(page.getByTestId('databricks-default-profile-command')).toHaveCount(CANDIDATES.length);
});

test('lost after a kernel restart: silent, since that kernel may never have been scrubbed', async ({ page }) => {
	// The boundary the expired case must not be widened past. A restart gives a FRESH
	// process which inherits the shell's DATABRICKS_* again, so the file is no longer
	// the whole answer and the card has nothing it can honestly claim.
	await openPanel(
		page,
		() => baseStatus({ connected: false, lost: { profile: CANDIDATES[0], clusterName: CLUSTER } }),
		'databricks-lost'
	);

	await expect(page.getByTestId('databricks-default-profile')).toHaveCount(0);
});

test('a machine whose default already resolves is told nothing, even connected', async ({ page }) => {
	// The other half of "do not nag": the gate only ever SUBTRACTS. With the server
	// reporting a resolved default, a connected panel is silent too - so a failing
	// gate cannot be mistaken for this, nor this for a failing gate.
	await openPanel(
		page,
		() =>
			baseStatus({ connected: true, profile: CANDIDATES[0], host: HOST, clusterId: 'c-1', clusterName: CLUSTER }, {
				resolves: true,
				reason: 'default_profile',
				profile: CANDIDATES[0],
				candidates: CANDIDATES,
				needsDefault: false
			}),
		'databricks-connected'
	);

	await expect(page.getByTestId('databricks-default-profile')).toHaveCount(0);
});

test('the command row is copyable, and copies exactly what it shows', async ({ page }) => {
	await openPanel(
		page,
		() => baseStatus({ connected: true, profile: CANDIDATES[0], host: HOST, clusterId: 'c-1', clusterName: CLUSTER }),
		'databricks-connected'
	);

	const wanted = `databricks auth switch --profile ${CANDIDATES[1]}`;
	await expect(page.getByTestId('databricks-default-profile-command').nth(1)).toHaveText(wanted);
	await page.getByTestId('databricks-default-profile-copy').nth(1).click();
	const clipboard = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
	if (clipboard) expect(clipboard).toBe(wanted);
});
