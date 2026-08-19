import { test, expect, type Page } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { runtimeAvailable, bootCellar, killCellar, REPO } from './harness';

/**
 * The agent-facing Databricks-runtime surface and `.py` notebook pinning, over the
 * wire an agent really uses: a `cellar mcp` stdio bridge into a live cellar.
 *
 * Both halves are only truly exercised at this layer. The `.py` half is a
 * data-integrity fix - `use_notebook` is the ONLY way an MCP SESSION pins its
 * working notebook, and a session id exists only when the real
 * `StreamableHTTPServerTransport` supplies one, so a service-level test cannot show
 * that the pin actually took. The runtime half is a claim that THREE tools report
 * one fact, which is a property of the registered tools rather than of the builder.
 *
 * The last test is the UI half: the sidebar's Runtime toggle re-seeding from the
 * server after an AGENT writes the same preference over MCP. The connection itself
 * is patched into the status response (a live cluster is out of scope here, exactly
 * as in databricks-two-card-redesign), but the `runtime` block is passed through
 * VERBATIM from the server - that block is the thing under test.
 *
 * Like the other specs here it boots the REAL launcher and SKIPS when the kernel
 * runtime is absent - the vitest suite is the must-pass gate.
 */

const EVIDENCE_DIR =
	process.env.CELLAR_EVIDENCE_DIR ||
	'/var/folders/ds/m71hq5ln637g23x6xmrwqg080000gn/T/no-mistakes-evidence/01KZR9KRY38Q7YMDTWN611GD4Q';

const TRANSCRIPT = join(EVIDENCE_DIR, 'mcp-agent-transcript.md');

let launcher: ChildProcess | null = null;
let client: Client | null = null;
let workspace = '';
let baseURL = '';

/** A tool call's JSON payload, as the agent receives it. */
async function call(name: string, args: Record<string, unknown>): Promise<any> {
	const r = (await client!.callTool({ name, arguments: args })) as {
		content: Array<{ text: string }>;
		isError?: boolean;
	};
	const parsed = JSON.parse(r.content[0].text);
	log(name, args, parsed);
	return parsed;
}

/** A tool call expected to FAIL: its text is the error message, not JSON. */
async function callRaw(name: string, args: Record<string, unknown>) {
	const r = (await client!.callTool({ name, arguments: args })) as {
		content: Array<{ text: string }>;
		isError?: boolean;
	};
	log(name, args, r.content[0].text, r.isError === true);
	return r;
}

/** Append one call to the reviewer-visible transcript. */
function log(name: string, args: unknown, result: unknown, isError = false): void {
	const body = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
	appendFileSync(
		TRANSCRIPT,
		`\n### \`${name}(${JSON.stringify(args)})\`${isError ? '  → **isError: true**' : ''}\n\n\`\`\`\n${body}\n\`\`\`\n`
	);
}

function section(title: string, why: string): void {
	appendFileSync(TRANSCRIPT, `\n---\n\n## ${title}\n\n${why}\n`);
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-e2e-mcp-runtime-'));

	// A Databricks-source `.py` notebook (the reported case), a jupytext-percent
	// one, and a PLAIN module that must be neither listed nor openable.
	mkdirSync(join(workspace, 'scripts'), { recursive: true });
	writeFileSync(
		join(workspace, 'scripts', 'parity.py'),
		'# Databricks notebook source\nprint("parity check")\n\n# COMMAND ----------\n\nx = 41 + 1\nprint(x)\n'
	);
	writeFileSync(join(workspace, 'percent_nb.py'), '# %%\nprint("from a percent notebook")\n');
	writeFileSync(join(workspace, 'scripts', 'plain_module.py'), 'def helper(n):\n    return n * 2\n');
	writeFileSync(
		join(workspace, 'notebook.ipynb'),
		JSON.stringify({
			cells: [
				{
					cell_type: 'code',
					execution_count: null,
					id: 'a1b2c3d4-0000-4000-8000-000000000001',
					metadata: {},
					outputs: [],
					source: ['print("hello from the ipynb")\n']
				}
			],
			metadata: { kernelspec: { display_name: 'python3', language: 'python', name: 'python3' } },
			nbformat: 4,
			nbformat_minor: 5
		})
	);

	try {
		mkdirSync(EVIDENCE_DIR, { recursive: true });
	} catch {
		/* best effort */
	}
	writeFileSync(
		TRANSCRIPT,
		`# Cellar MCP agent transcript\n\nA real agent (\`@modelcontextprotocol/sdk\` client) talking to a live \`cellar\` through the\n\`cellar mcp\` stdio bridge. Every block below is the payload the agent received.\n\nWorkspace files: \`scripts/parity.py\` (Databricks-source notebook), \`percent_nb.py\`\n(jupytext percent notebook), \`scripts/plain_module.py\` (plain module, NOT a notebook),\n\`notebook.ipynb\`.\n`
	);

	const booted = await bootCellar(workspace);
	launcher = booted.proc;
	baseURL = booted.url;

	client = new Client({ name: 'e2e-agent', version: '0' });
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
	client = null;
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

test('an agent can DISCOVER and PIN a .py notebook, and a plain module is refused', async () => {
	section(
		'1. `.py` notebooks are listable and pinnable',
		'`use_notebook` is the only way an MCP session pins its working notebook; unpinned, the\ntarget silently follows the USER\'S focused tab, so writes land in the wrong file.'
	);

	// Discovery: both `.py` notebooks are offered, the plain module is not.
	const list = await call('list_notebooks', {});
	const names = (list.notebooks as Array<{ path: string }>).map((n) => n.path);
	expect(names).toContain('scripts/parity.py');
	expect(names).toContain('percent_nb.py');
	expect(names).toContain('notebook.ipynb');
	expect(names).not.toContain('scripts/plain_module.py');

	// Pinning: the path is taken LITERALLY - no `.ipynb` appended.
	const pinned = await call('use_notebook', { name: 'scripts/parity.py' });
	expect(pinned.working_notebook).toBe('scripts/parity.py');
	expect(pinned.created).toBe(false);
	expect(pinned.pinned).toBe(true);
	expect(pinned.cells).toBeGreaterThan(0);
	expect(existsSync(join(workspace, 'scripts', 'parity.py.ipynb'))).toBe(false);

	// The pin is REAL: an unqualified read answers about the `.py`, not the ipynb.
	// (`get_notebook_map` reports the ABSOLUTE path, so match its tail.)
	const map = await call('get_notebook_map', {});
	expect(String(map.notebook).endsWith('/scripts/parity.py')).toBe(true);
	const sources = (await call('read_cells', { ids: (map.sections as Array<{ id: string }>).map((s) => s.id) })).map(
		(c: { source: string }) => c.source
	);
	expect(sources.join('\n')).toContain('parity check');

	// ...and the agent can WRITE to the notebook it pinned.
	const added = await call('add_cell', { source: 'print("written by the agent")', route_imports: false });
	expect(added.id).toBeTruthy();
	const afterWrite = await call('get_notebook_map', {});
	expect(String(afterWrite.notebook).endsWith('/scripts/parity.py')).toBe(true);
	expect((afterWrite.sections as unknown[]).length).toBeGreaterThan((map.sections as unknown[]).length);

	// ...and the file on disk is STILL a Databricks-source `.py`, not nbformat JSON
	// (the corruption the "cannot create a .py" refusal exists to prevent).
	const onDisk = readFileSync(join(workspace, 'scripts', 'parity.py'), 'utf8');
	expect(onDisk.split('\n')[0]).toBe('# Databricks notebook source');
	expect(onDisk).toContain('written by the agent');
	appendFileSync(TRANSCRIPT, `\n### \`scripts/parity.py\` on disk after the agent's \`add_cell\`\n\n\`\`\`python\n${onDisk}\`\`\`\n`);

	section(
		'2. The two refusals (no silent rewrite, no plain module)',
		'A missing `.py` is an ERROR, never a rewrite to `.py.ipynb`: Cellar cannot CREATE a `.py`\nnotebook (its format is read from the file), so an invented doc would persist nbformat JSON\ninto it. A marker-less module is refused through the SAME sniff `list_notebooks` filters on.'
	);

	const missing = await callRaw('use_notebook', { name: 'no_such_notebook.py' });
	expect(missing.isError).toBe(true);
	expect(missing.content[0].text).toMatch(/cannot create a \.py notebook/i);
	expect(existsSync(join(workspace, 'no_such_notebook.py.ipynb'))).toBe(false);
	expect(existsSync(join(workspace, 'no_such_notebook.py'))).toBe(false);

	const plain = await callRaw('use_notebook', { name: 'scripts/plain_module.py' });
	expect(plain.isError).toBe(true);
	expect(plain.content[0].text).toMatch(/plain Python file, not a notebook/i);

	// Regression: a BARE name still gets `.ipynb`, and is still created on demand.
	const bare = await call('use_notebook', { name: 'scratch' });
	expect(bare.working_notebook).toBe('scratch.ipynb');
	expect(bare.created).toBe(true);
});

test('the runtime block is reported by databricks_status, kernel_state AND get_notebook_map', async () => {
	section(
		'3. One runtime fact, three read tools',
		'Nothing on the agent surface said whether a Databricks runtime was advertised, so a\nnotebook full of `dbutils.widgets` looked identical whether or not `DATABRICKS_RUNTIME_VERSION`\nwas set. `runtime:{advertised, version, forced_by_env}` is built by ONE shared builder and\nread LIVE from the kernel, never from the stored preference.'
	);
	await call('use_notebook', { name: 'notebook.ipynb' });

	const status = await call('databricks_status', {});
	expect(status.runtime).toEqual({ advertised: false, version: null, forced_by_env: false });

	const state = await call('kernel_state', {});
	expect(state.databricks.runtime).toEqual(status.runtime);

	const map = await call('get_notebook_map', {});
	expect(map.databricks.runtime).toEqual(status.runtime);
});

test('databricks_runtime stores the preference and does NOT restart when nothing changes', async () => {
	section(
		'4. `databricks_runtime` - the setter, and its conditional restart',
		'Applying costs the user their whole namespace, so the restart fires ONLY when the version\nthe kernel WOULD start with differs from the one it carries. Enabling on a notebook with no\nDatabricks session stores the preference and SAYS nothing is advertised, rather than\nrestarting to change nothing.'
	);
	await call('use_notebook', { name: 'notebook.ipynb' });

	// Boot a real kernel so "no restart" is a real observation, not a vacuous one.
	await call('add_and_run', { source: 'runtime_probe = 123', route_imports: false });
	const vars = await call('list_variables', {});
	expect((vars.variables as Array<{ name: string }>).map((v) => v.name)).toContain('runtime_probe');

	const enabled = await call('databricks_runtime', { enable: true });
	expect(enabled.enabled).toBe(true);
	// Unconnected notebook: the injection is scoped to a connected one, so nothing is
	// advertised and the namespace is untouched.
	expect(enabled.runtime.advertised).toBe(false);
	expect(enabled.kernel_restarted).toBe(false);
	expect(enabled.namespace_cleared).toBe(false);
	expect(String(enabled.note)).toMatch(/Databricks/i);

	// The proof the restart really did not happen: the variable survives.
	const after = await call('list_variables', {});
	expect((after.variables as Array<{ name: string }>).map((v) => v.name)).toContain('runtime_probe');

	// Re-enabling what is already stored is a no-op too.
	const again = await call('databricks_runtime', { enable: true, version: '15.4' });
	expect(again.kernel_restarted).toBe(false);
	expect(again.namespace_cleared).toBe(false);

	section(
		'5. The tool descriptions an agent is billed for',
		'The rationale that previously lived only in a source header now rides the tool description,\nand `databricks_connect` names the deliberate reversal (connecting does NOT advertise a runtime).'
	);
	const tools = await client!.listTools();
	const runtimeTool = tools.tools.find((t) => t.name === 'databricks_runtime');
	expect(runtimeTool).toBeTruthy();
	const desc = runtimeTool!.description!;
	// The rationale a caller acts on, not a word count: what it flips, why that
	// matters beyond the notebook's own gate, and what applying it costs.
	expect(desc).toMatch(/IS_DATABRICKS/);
	expect(desc).toMatch(/dbutils\.widgets/);
	expect(desc).toMatch(/mlflow/);
	expect(desc).toMatch(/RESTARTS the kernel/);
	appendFileSync(
		TRANSCRIPT,
		`\n### \`tools/list\` → \`databricks_runtime\` (${desc.length} chars)\n\n\`\`\`\n${desc}\n\`\`\`\n`
	);

	const connectTool = tools.tools.find((t) => t.name === 'databricks_connect');
	expect(connectTool!.description).toMatch(/does NOT (advertise|start)/i);
});

test('the sidebar Runtime toggle re-seeds after an AGENT writes the preference', async ({ page }) => {
	section(
		'6. The sidebar toggle follows an agent-set preference (UI)',
		'Making the preference agent-settable let the sidebar toggle go stale, which is destructive\nrather than cosmetic: `toggleRuntime` applies the NEGATION, so a toggle still showing OFF over\nan already-ON preference restarts the kernel and clears every variable to change nothing. The\ncalls below are the agent half of the screenshots (`runtime-card-before-agent.png` /\n`runtime-card-after-agent.png`); the user touches nothing in between.'
	);
	// The connection is patched in (a live cluster is out of scope), but the `runtime`
	// block - the thing under test - is the SERVER'S, passed through verbatim.
	await page.route(/\/api\/databricks(\?.*)?$/, async (route) => {
		if (route.request().method() !== 'GET') return route.continue();
		const real = await route.fetch();
		const body = await real.json();
		body.connection = {
			connected: true,
			profile: 'DEFAULT',
			host: 'https://dbc-demo.cloud.databricks.com',
			clusterId: '0710-abc123-xyz',
			clusterName: 'analytics-prod',
			sparkVersion: '15.4.x-scala2.12'
		};
		body.config = { profiles: [{ name: 'DEFAULT', host: 'https://dbc-demo.cloud.databricks.com', hasToken: true }] };
		body.install = { python: join(workspace, '.venv/bin/python'), sdk: true, connect: true };
		await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
	});

	// Start from OFF, written the same way an agent would.
	await call('use_notebook', { name: 'notebook.ipynb' });
	await call('databricks_runtime', { enable: false });

	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	const openBtn = page.getByTestId('empty-open-notebook');
	// Settle on whichever the shell paints - the empty state, or a notebook that is
	// already open - BEFORE probing. Probed earlier, a slow first paint reports the
	// button invisible, the click becomes a no-op, and the wait below then times out
	// on a notebook nothing ever opened (a real flake under `workers: 2`).
	await expect(openBtn.or(page.getByTestId('cell').first())).toBeVisible();
	if (await openBtn.isVisible().catch(() => false)) await openBtn.click();
	await expect(page.getByTestId('cell').first()).toBeVisible();

	const header = page.getByTestId('section-databricks');
	await expect(header).toBeVisible();
	if (!(await page.getByTestId('databricks-body').isVisible().catch(() => false))) await header.click();
	await expect(page.getByTestId('databricks-body')).toBeVisible();

	const toggle = page.getByTestId('databricks-runtime-toggle');
	await expect(toggle).toBeVisible();
	await expect(toggle).not.toBeChecked();

	const card = page.getByTestId('databricks-runtime-card');
	await card.screenshot({ path: join(EVIDENCE_DIR, 'runtime-card-before-agent.png') });

	// The agent flips it. The user touches NOTHING: `setRuntimeAdvertisement`
	// publishes `databricks:changed`, the panel re-reads, and the toggle re-seeds
	// from the server's stored preference.
	await call('databricks_runtime', { enable: true });

	await expect(toggle).toBeChecked({ timeout: 15_000 });
	await card.screenshot({ path: join(EVIDENCE_DIR, 'runtime-card-after-agent.png') });
	const sidebar = page.getByTestId('section-databricks').locator('xpath=ancestor::*[1]/parent::*');
	await sidebar.screenshot({ path: join(EVIDENCE_DIR, 'runtime-sidebar-after-agent.png') });
	await page.screenshot({ path: join(EVIDENCE_DIR, 'runtime-app-after-agent.png') });

	// ...and back off again, so the re-seed is shown to track BOTH directions.
	await call('databricks_runtime', { enable: false });
	await expect(toggle).not.toBeChecked({ timeout: 15_000 });
});

/**
 * The ADVERTISED state, reached the one way that needs no live cluster: the
 * `CELLAR_DATABRICKS_RUNTIME` override, which bypasses both the stored preference
 * and the connected-notebook scope. It is also the one state where the setter must
 * REFUSE - nothing it does could move an env-held decision, and restarting to prove
 * that would clear the namespace for nothing.
 */
test.describe('with CELLAR_DATABRICKS_RUNTIME=1 forcing the runtime on', () => {
	let envLauncher: ChildProcess | null = null;
	let envClient: Client | null = null;
	let envWorkspace = '';

	test.beforeAll(async () => {
		test.skip(!runtimeAvailable(), 'kernel runtime not available — E2E is local-only');
		envWorkspace = mkdtempSync(join(tmpdir(), 'cellar-e2e-mcp-runtime-env-'));
		const booted = await bootCellar(envWorkspace, { CELLAR_DATABRICKS_RUNTIME: '1' });
		envLauncher = booted.proc;
		envClient = new Client({ name: 'e2e-agent-env', version: '0' });
		await envClient.connect(
			new StdioClientTransport({
				command: 'node',
				args: [join(REPO, 'bin', 'cellar.js'), 'mcp'],
				cwd: envWorkspace,
				env: { ...process.env } as Record<string, string>
			})
		);
	});

	test.afterAll(async () => {
		try {
			await envClient?.close();
		} catch {
			/* best effort */
		}
		envClient = null;
		if (envLauncher) killCellar(envLauncher);
		envLauncher = null;
		if (envWorkspace && existsSync(envWorkspace)) {
			try {
				rmSync(envWorkspace, { recursive: true, force: true });
			} catch {
				/* best effort */
			}
		}
	});

	test('the runtime reads ADVERTISED + forced_by_env, and the setter refuses', async () => {
		section(
			'7. The advertised state, and the refusal that protects the namespace',
			'`CELLAR_DATABRICKS_RUNTIME=1` bypasses the stored preference and the connection scope, so\nthis kernel really does carry `DATABRICKS_RUNTIME_VERSION`. This is the state a notebook full\nof `dbutils.widgets` needs the agent to be able to SEE - and the state where the setter must\nrefuse rather than restart to change nothing.'
		);
		const prev = client;
		client = envClient; // reuse the logging `call` helpers
		try {
			await call('use_notebook', { name: 'forced' });
			// Boot the kernel so the LIVE reading has something to report.
			const ran = await call('add_and_run', {
				source: 'import os\nprint(os.getenv("DATABRICKS_RUNTIME_VERSION"))',
				route_imports: false
			});
			expect(JSON.stringify(ran.outputs)).toContain('15.4');

			const status = await call('databricks_status', {});
			expect(status.runtime).toEqual({ advertised: true, version: '15.4', forced_by_env: true });
			const state = await call('kernel_state', {});
			expect(state.databricks.runtime).toEqual(status.runtime);
			const map = await call('get_notebook_map', {});
			expect(map.databricks.runtime).toEqual(status.runtime);

			// Refused, and the namespace is untouched.
			const refused = await callRaw('databricks_runtime', { enable: false });
			expect(refused.isError).toBe(true);
			expect(refused.content[0].text).toMatch(/CELLAR_DATABRICKS_RUNTIME/);
			const after = await call('databricks_status', {});
			expect(after.runtime.advertised).toBe(true);
		} finally {
			client = prev;
		}
	});
});
