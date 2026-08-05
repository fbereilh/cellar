import { test, expect } from '@playwright/test';
import { spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { runtimeAvailable, bootCellar, killCellar, REPO } from './harness';

/**
 * The shell refreshes its panels after a FOREIGN action, not only after its own.
 *
 * Both bugs this pins had the same shape: the shell refreshed a sidebar panel on
 * the path it drives itself and forgot the identical path when an AGENT (or
 * another tab) drove it. That asymmetry is invisible to any test that performs
 * the action ITSELF - a self-run goes through `onRunEnd`, which refreshes
 * variables, so it masks Bug 1 completely. So every assertion here is driven by a
 * REAL `cellar mcp` agent over the stdio bridge, and the observing page never
 * runs a cell of its own until the dedicated own-path regression check.
 *
 *   Bug 1 - a run this tab did not initiate refreshed the kernel badge but NOT
 *           the variable inspector, so on a page that loaded before any kernel
 *           existed (the mount-time inspect is skipped when there is none) the
 *           Variables panel stayed empty for the whole session.
 *   Bug 2 - `notebook:opened` surfaced the agent's notebook as a tab but never
 *           bumped `fsRefreshSignal`, so the file tree (and its git decorations)
 *           never showed the file the agent had just created.
 *
 * Every test sets up everything it needs: Playwright starts a FRESH worker after
 * a failure, which re-runs `beforeAll` against a brand-new empty workspace - so a
 * test leaning on a predecessor's notebook reports a setup miss rather than the
 * defect it is meant to pin.
 *
 * Boots the REAL launcher (Node app + Jupyter sidecar + python3 kernel), so it
 * SKIPS when the runtime (uv + python3 + host-venv) is missing; the vitest suite
 * is the must-pass gate (`tests/unit/shell-refresh-handlers.test.ts` guards the
 * same two call sites at source level, where CI can see them).
 */

let launcher: ChildProcess | null = null;
let client: Client | null = null;
let workspace = '';
let baseURL = '';

/** The notebook the human works in - the one the Variables panel reflects. */
const NB = 'notebook.ipynb';
/** The notebook the AGENT creates mid-session - Bug 2's subject. */
const AGENT_NB = 'agent-notes.ipynb';

type Raw = { content: Array<{ type: string; text?: string }>; isError?: boolean };
const call = async (name: string, args: Record<string, unknown> = {}) => {
	const r = (await client!.callTool({ name, arguments: args })) as Raw;
	const payload = r.content
		.filter((c) => c.type === 'text' && !(c.text ?? '').startsWith('[cellar] user activity:'))
		.map((c) => c.text ?? '')
		.join('\n');
	return JSON.parse(payload);
};

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-e2e-foreign-refresh-'));
	// A git repo, so the tree carries decorations: Bug 2 costs the untracked
	// badge as well as the row itself.
	spawnSync('git', ['init', '-q'], { cwd: workspace });

	const booted = await bootCellar(workspace);
	launcher = booted.proc;
	baseURL = booted.url;

	client = new Client({ name: 'e2e-foreign-agent', version: '0' });
	await client.connect(
		new StdioClientTransport({
			command: 'node',
			args: [join(REPO, 'bin', 'cellar.js'), 'mcp'],
			cwd: workspace,
			env: { ...process.env } as Record<string, string>
		})
	);
});

test.afterAll(async () => {
	try {
		await client?.close();
	} catch {
		/* best effort */
	}
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

test('an AGENT run populates the Variables panel of a page that never ran a cell', async ({ page }) => {
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);

	// The human opens the notebook - and ONLY opens it. This is also the
	// own-action regression guard for `fsRefreshSignal`: startup writes no
	// notebook, so the tree row can only appear because this create bumped it.
	await page.getByTestId('empty-open-notebook').click();
	await expect(page.locator('[data-testid="cell"]:visible').first()).toBeVisible();
	await expect(page.getByTestId('tree-file').filter({ hasText: NB })).toBeVisible({ timeout: 15_000 });

	// The premise: a COLD page. No kernel exists yet, so the mount-time inspect
	// had nothing to read and the panel is empty.
	await expect(page.getByTestId('vars-body')).toContainText('no variables');
	await expect(page.getByTestId('kernel-not-started').first()).toBeVisible();

	// The AGENT boots the kernel and defines a variable. The page does nothing.
	await call('use_notebook', { name: NB });
	const ran = await call('add_and_run', { source: 'foreign_answer = 42', route_imports: false });
	expect(ran.run_status ?? ran.status).toBeTruthy();

	// Bug 1: without the fix this stays "no variables" forever - the foreign
	// `run:end` refreshed the kernel badge only, and the cold mount already
	// passed. The badge half (which always worked) must keep working too.
	await expect(page.getByTestId('var-row').filter({ hasText: 'foreign_answer' })).toBeVisible({ timeout: 45_000 });
	await expect(page.getByTestId('kernel-not-started')).toHaveCount(0);
});

test('a page loading into an AGENT-booted kernel inspects variables on mount', async ({ page }) => {
	// The other half of the cold-page path: the agent's run lands with NO page
	// open, so this page's mount-time inspect is its only chance to see the
	// variable - nothing after the load touches the panel. Guards the ungated
	// initial inspect (the server short-circuits a not-started kernel, so an
	// unconditional inspect can never boot one).
	await call('use_notebook', { name: NB });
	await call('add_and_run', { source: 'mounted_answer = 42', route_imports: false });

	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await expect(page.getByTestId('var-row').filter({ hasText: 'mounted_answer' })).toBeVisible({ timeout: 45_000 });
});

test('a notebook the AGENT creates appears in the file tree with its git decoration', async ({ page }) => {
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await expect(page.getByTestId('files-body')).toBeVisible();
	await expect(page.getByTestId('tree-file').filter({ hasText: AGENT_NB })).toHaveCount(0);

	// The agent declares a NEW working notebook: the server writes the file and
	// broadcasts `notebook:opened` (focus:false - it must not steal the tab).
	await call('use_notebook', { name: AGENT_NB });

	// Bug 2: the tab surfaces, but without the `fsRefreshSignal` bump the tree
	// never re-reads, so neither the row nor its untracked badge ever appears.
	const row = page.getByTestId('tree-file').filter({ hasText: AGENT_NB });
	await expect(row).toBeVisible({ timeout: 20_000 });
	await expect(row.getByTestId('tree-git-letter')).toHaveText('U');
});

/**
 * Count the page's OWN requests to a path, by EXACT pathname: `/api/kernel` is a
 * prefix of `/api/kernel/variables`, and the whole point of these two tests is
 * telling the cheap status READ apart from the real kernel PROBE.
 */
function countRequests(page: import('@playwright/test').Page) {
	const counts = {
		status: 0,
		probe: 0,
		/** Zero the counters once the page has settled, so setup traffic is excluded. */
		reset() {
			this.status = 0;
			this.probe = 0;
		}
	};
	page.on('request', (req) => {
		let path = '';
		try {
			path = new URL(req.url()).pathname;
		} catch {
			return;
		}
		if (path === '/api/kernel') counts.status++;
		else if (path === '/api/kernel/variables') counts.probe++;
	});
	return counts;
}

test('an AGENT batch costs ONE inspector probe, not one per cell', async ({ page }) => {
	// The inspector is a real kernel execution, and a foreign `run:end` arrives once
	// per CELL - so mirroring the own-run refresh naively made an agent's `run_all`
	// cost N probes per open tab, each serializing on the kernel the agent is using.
	const BATCH_NB = 'batch-run.ipynb';
	const CELLS = 8;
	await call('use_notebook', { name: BATCH_NB });
	for (let i = 0; i < CELLS; i++)
		await call('add_cell', { source: `batch_var_${i} = ${i}`, route_imports: false });

	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await page.getByTestId('tree-file').filter({ hasText: BATCH_NB }).dblclick();
	await expect(page.locator('[data-testid="cell"]:visible').first()).toBeVisible();
	await expect(page.getByTestId('vars-body')).toBeVisible();

	const counts = countRequests(page);
	// The mount-time inspect is setup, not the batch: settle, then start counting.
	await page.waitForTimeout(1_000);
	counts.reset();
	await call('run_all');

	// The batch really did reach the inspector...
	await expect(page.getByTestId('var-row').filter({ hasText: `batch_var_${CELLS - 1}` })).toBeVisible({
		timeout: 45_000
	});
	// ...but coalesced. Without the debounce this is one probe per cell; the margin
	// is generous so a slow cell that outruns the window is not a flake.
	expect(counts.probe).toBeGreaterThan(0);
	expect(counts.probe).toBeLessThanOrEqual(3);
});

test('an AGENT run in a notebook the user is NOT viewing never probes the kernel', async ({ page }) => {
	// `inspectVariables` probes the ACTIVE notebook's kernel, so a run anywhere else
	// can only ever probe the wrong one - wasted work on the kernel the user IS
	// using. The badge half still refreshes: it belongs to no single notebook.
	const OTHER_NB = 'agent-only.ipynb';
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await page.getByTestId('tree-file').filter({ hasText: NB }).dblclick();
	await expect(page.locator('[data-testid="cell"]:visible').first()).toBeVisible();
	await expect(page.getByTestId('vars-body')).toBeVisible();

	const counts = countRequests(page);
	// The mount-time inspect is setup, not the agent's run: settle, then count.
	await page.waitForTimeout(1_000);
	counts.reset();
	await call('use_notebook', { name: OTHER_NB });
	await call('add_and_run', { source: 'unrelated_var = 1', route_imports: false });

	// The foreign `run:end` DID reach this tab - the ungated badge refresh proves
	// the branch ran, so a zero probe count is the gate, not a missing event.
	await expect
		.poll(() => counts.status, { timeout: 45_000 })
		.toBeGreaterThan(0);
	await expect(page.getByTestId('kernel-notebook').filter({ hasText: OTHER_NB })).toBeVisible({
		timeout: 20_000
	});
	// Well past the debounce window, so a probe that was merely late would show up.
	await page.waitForTimeout(2_000);
	expect(counts.probe).toBe(0);
	await expect(page.getByTestId('var-row').filter({ hasText: 'unrelated_var' })).toHaveCount(0);
});

test("the page's OWN run still refreshes the Variables panel", async ({ page }) => {
	// No-regression guard for the path that always worked (`onRunEnd`). The tab
	// session is server-owned (`.cellar/`, not localStorage), so a fresh browser
	// context still restores earlier tabs - hence its own notebook, opened from
	// the tree, and a locator scoped to the VISIBLE pane (every open notebook
	// stays mounted and hidden).
	const OWN_NB = 'own-run.ipynb';
	await fetch(`${baseURL}/api/notebooks`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ path: OWN_NB, create: true })
	});
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await page.getByTestId('tree-file').filter({ hasText: OWN_NB }).dblclick();
	const cell = page.locator('[data-testid="cell"]:visible').first();
	await expect(cell).toBeVisible();
	await cell.getByTestId('editor-scroll').click();
	const editor = cell.locator('.cm-content');
	await editor.click();
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.type('own_var = 7');
	await cell.getByTestId('run').click();
	await expect(page.getByTestId('var-row').filter({ hasText: 'own_var' })).toBeVisible({ timeout: 60_000 });
});
