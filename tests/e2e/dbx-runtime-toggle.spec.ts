import { test, expect, type Page, type Locator } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeAvailable, bootCellar, killCellar } from './harness';

/**
 * E2E for the "Databricks runtime" toggle (advertise DATABRICKS_RUNTIME_VERSION),
 * driven through the real UI on a PLAIN local Python kernel - NO Databricks
 * cluster. It uses the `CELLAR_DATABRICKS_RUNTIME` env override, which forces the
 * inject decision and bypasses the connection scope - exactly the cluster-free
 * path the feature exposes for headless / CI.
 *
 * The end-user intent: with the runtime advertised at kernel start, a notebook's
 * import-time gate `IS_DATABRICKS = os.getenv("DATABRICKS_RUNTIME_VERSION") is not
 * None` reads True (so Databricks-notebook code takes its dbutils.widgets path).
 *
 * Two boots demonstrate both directions:
 *   - override ON  → env == the advertised version, IS_DATABRICKS == True
 *   - no override + unbound notebook → env unset, IS_DATABRICKS == False
 *
 * SKIPS when the kernel runtime is absent (local-only, like the other specs).
 */

let onProc: ChildProcess | null = null;
let offProc: ChildProcess | null = null;
let onWorkspace = '';
let offWorkspace = '';
let onURL = '';
let offURL = '';

/** A distinct non-default version so the test proves the version accessor is honored. */
const ADVERTISED_VERSION = '14.3';

/** Where reviewer-visible screenshots land, when the runner asks for them. */
const EVIDENCE = process.env.CELLAR_EVIDENCE_DIR || '';

const PROBE_SRC = [
	'import os',
	'print("DATABRICKS_RUNTIME_VERSION ->", repr(os.getenv("DATABRICKS_RUNTIME_VERSION")))',
	'IS_DATABRICKS = os.getenv("DATABRICKS_RUNTIME_VERSION") is not None',
	'print("IS_DATABRICKS ->", IS_DATABRICKS)'
].join('\n');

/** A code cell for the seeded notebook. */
function cell(id: string, source: string) {
	return {
		id,
		cell_type: 'code',
		metadata: {},
		execution_count: null,
		outputs: [],
		source: source.split('\n').map((l, i, a) => (i === a.length - 1 ? l : l + '\n'))
	};
}

/** Seed a throwaway workspace with a project venv + a notebook that probes the env. */
function seedWorkspace(prefix: string): string {
	const ws = mkdtempSync(join(tmpdir(), prefix));
	const venv = join(ws, '.venv');
	expect(spawnSync('uv', ['venv', venv], { stdio: 'inherit' }).status).toBe(0);
	expect(
		spawnSync('uv', ['pip', 'install', '--python', join(venv, 'bin', 'python'), 'ipykernel'], {
			stdio: 'inherit'
		}).status
	).toBe(0);
	mkdirSync(ws, { recursive: true });
	writeFileSync(
		join(ws, 'notebook.ipynb'),
		JSON.stringify(
			{
				cells: [cell('c-probe', PROBE_SRC)],
				metadata: { kernelspec: { name: 'python3', display_name: 'python3', language: 'python' } },
				nbformat: 4,
				nbformat_minor: 5
			},
			null,
			1
		)
	);
	return ws;
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only');

	onWorkspace = seedWorkspace('cellar-e2e-dbxrt-on-');
	offWorkspace = seedWorkspace('cellar-e2e-dbxrt-off-');

	// Boot #1: force the runtime ON via the env override (cluster-free path) with a
	// non-default version so the version accessor is exercised too.
	process.env.CELLAR_DATABRICKS_RUNTIME = '1';
	process.env.CELLAR_DATABRICKS_RUNTIME_VERSION = ADVERTISED_VERSION;
	const on = await bootCellar(onWorkspace);
	onProc = on.proc;
	onURL = on.url;

	// Boot #2: no override, notebook not bound to a cluster → env must stay unset.
	delete process.env.CELLAR_DATABRICKS_RUNTIME;
	delete process.env.CELLAR_DATABRICKS_RUNTIME_VERSION;
	const off = await bootCellar(offWorkspace);
	offProc = off.proc;
	offURL = off.url;
});

test.afterAll(async () => {
	if (onProc) killCellar(onProc);
	if (offProc) killCellar(offProc);
	onProc = offProc = null;
	for (const ws of [onWorkspace, offWorkspace]) {
		if (ws && existsSync(ws)) {
			try {
				rmSync(ws, { recursive: true, force: true });
			} catch {
				/* best effort */
			}
		}
	}
});

/** Open the seeded notebook from the empty state if no tab is restored yet. */
async function openNotebook(page: Page): Promise<void> {
	const openBtn = page.getByTestId('empty-open-notebook');
	if (await openBtn.isVisible().catch(() => false)) await openBtn.click();
	await expect(page.getByTestId('cell').first()).toBeVisible();
}

/** Run cell `c` and wait for its run indicator to clear. */
async function runCell(page: Page, c: Locator): Promise<void> {
	await c.getByTestId('run').click();
	await expect(c.getByTestId('running-indicator')).toHaveCount(0, { timeout: 90_000 });
}

async function shot(page: Page, name: string): Promise<void> {
	if (!EVIDENCE) return;
	mkdirSync(EVIDENCE, { recursive: true });
	await page.screenshot({ path: join(EVIDENCE, name), fullPage: true });
}

test('runtime advertised (override ON): env is set at kernel start and IS_DATABRICKS reads True', async ({
	page
}) => {
	await page.goto(`${onURL}/?ws=${encodeURIComponent(onWorkspace)}`);
	await openNotebook(page);
	const probe = page.getByTestId('cell').first();

	await runCell(page, probe);
	const out = probe.getByTestId('output');
	await expect(out).toContainText(`DATABRICKS_RUNTIME_VERSION -> '${ADVERTISED_VERSION}'`, { timeout: 90_000 });
	await expect(out).toContainText('IS_DATABRICKS -> True');
	await shot(page, 'dbx-runtime-on.png');
});

test('no override + unbound notebook: env stays unset and IS_DATABRICKS reads False', async ({ page }) => {
	await page.goto(`${offURL}/?ws=${encodeURIComponent(offWorkspace)}`);
	await openNotebook(page);
	const probe = page.getByTestId('cell').first();

	await runCell(page, probe);
	const out = probe.getByTestId('output');
	await expect(out).toContainText('DATABRICKS_RUNTIME_VERSION -> None', { timeout: 90_000 });
	await expect(out).toContainText('IS_DATABRICKS -> False');
	await shot(page, 'dbx-runtime-off.png');
});
