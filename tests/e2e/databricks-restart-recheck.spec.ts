import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * The restart re-check must be SELF-DRIVING.
 *
 * While the server reports `restarting` the panel holds the calm "Reconnecting…"
 * card instead of the warning-toned lost card, and re-reads the status until that
 * flag clears. A reconnect that SUCCEEDS publishes `databricks:changed` and re-reads
 * on its own, but one that fails - or is never dispatched - publishes nothing, so the
 * re-check is the only thing that gets the panel off the spinner.
 *
 * The trap this pins: a FAILED read leaves the shared status untouched (the loader's
 * catch only writes `statusError`), so a re-check that re-armed solely off a status
 * CHANGE broke its own chain on the first flaky GET and sat on "Reconnecting…"
 * forever - the exact stuck state it exists to prevent.
 *
 * Routes are MOCKED (same stance as `databricks-profile-reauth.spec.ts`): no real
 * workspace, credential or cluster. The server's side of the grace is proven in
 * `tests/unit/databricks-restart-grace.test.ts`.
 */

let launcher: ChildProcess | null = null;
let workspace = '';
let baseURL = '';

const CLUSTER = 'Test Cluster';

function statusBody(connection: unknown) {
	return {
		connection,
		config: { profiles: [{ name: 'test', host: 'https://test.databricks.com', hasToken: true }] },
		install: { python: '/tmp/.venv/bin/python', sdk: true, connect: true },
		uv: true,
		signedInHosts: [],
		signedInProfiles: [],
		runtime: { kernelStarted: true, liveVersion: null }
	};
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

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-e2e-dbx-recheck-'));
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

test('a failed status read never strands the panel on "Reconnecting…"', async ({ page }) => {
	const lost = { connected: false, lost: { profile: 'test', clusterName: CLUSTER } };
	const restarting = { ...lost, restarting: true };

	// Phased, not counted: a mount issues more than one read (the loader and the SSE
	// open race), so "fail the Nth read" would sometimes fail one whose result was
	// superseded anyway. Every read is `restarting` until the test flips the phase;
	// then exactly ONE fails - and by then the re-check is the only reader, so that
	// failure is unambiguously the newest word on the status.
	let phase: 'restarting' | 'fail' | 'lost' = 'restarting';
	let reads = 0;
	await page.route(/\/api\/databricks(\?.*)?$/, async (route) => {
		if (route.request().method() !== 'GET') return route.continue();
		reads++;
		if (phase === 'fail') {
			phase = 'lost';
			return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
		}
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(statusBody(phase === 'restarting' ? restarting : lost))
		});
	});

	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	await openDatabricksSection(page);

	// The restart window: the calm card, never the warning-toned loss.
	await expect(page.getByTestId('databricks-connecting')).toBeVisible();
	await expect(page.getByTestId('databricks-lost')).toHaveCount(0);

	// One flaky GET, which the panel really does observe (it renders the read error).
	phase = 'fail';
	await expect(page.getByTestId('databricks-status-error')).toBeVisible({ timeout: 20_000 });
	const readsAtFailure = reads;

	// A failed read leaves the status untouched, so only a SELF-DRIVING re-check can
	// get the panel off the spinner. It does: the next read lands and tells the truth.
	await expect(page.getByTestId('databricks-lost')).toBeVisible({ timeout: 20_000 });
	await expect(page.getByTestId('databricks-connecting')).toHaveCount(0);
	expect(reads).toBeGreaterThan(readsAtFailure);
});

test('the re-check stops once the panel is no longer restarting', async ({ page }) => {
	// A settled panel must not keep polling: the re-check is armed by the restarting
	// shape alone, so a connected read ends it rather than leaving a timer running.
	let reads = 0;
	await page.route(/\/api\/databricks(\?.*)?$/, async (route) => {
		if (route.request().method() !== 'GET') return route.continue();
		reads++;
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(
				statusBody({ connected: true, profile: 'test', clusterId: '0725-abc', clusterName: CLUSTER, host: 'https://test.databricks.com' })
			)
		});
	});

	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await openNotebook(page);
	await openDatabricksSection(page);
	await expect(page.getByTestId('databricks-connected')).toBeVisible();

	const settled = reads;
	await page.waitForTimeout(6000);
	expect(reads).toBe(settled);
});
