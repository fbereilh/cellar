import { test, expect } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { runtimeAvailable, bootCellar, killCellar, REPO } from './harness';

/**
 * The nbdev-style export flow END TO END over the wire an agent really uses: a
 * `cellar mcp` stdio bridge into a live cellar, with the human's browser open on
 * the same notebook.
 *
 * The point of `set_cell_export` is that the agent-side flow had no MIDDLE - it
 * could name the target (`set_export_target`), which regenerates the module, but
 * WHICH cells go in it was settable only in the UI. So the check is
 * not "the setter returns ok" but: the agent names a target, marks cells, and a
 * real `.py` module appears on disk carrying exactly those cells - while the
 * human's open page shows the same marks with no reload.
 *
 * Like the other MCP specs here it boots the REAL launcher and SKIPS when the
 * kernel runtime is absent; the vitest suite is the must-pass gate.
 */

let launcher: ChildProcess | null = null;
let client: Client | null = null;
let workspace = '';
let baseURL = '';

/** Screenshots + JSON transcripts land here when an evidence dir is provided. */
const SHOTS = process.env.CELLAR_E2E_SHOTS || '';
const shot = async (page: import('@playwright/test').Page, name: string) => {
	if (!SHOTS) return;
	mkdirSync(SHOTS, { recursive: true });
	await page.screenshot({ path: join(SHOTS, name), fullPage: true });
};
/** The agent's side of the conversation, recorded verbatim for the reviewer. */
const transcript: Array<Record<string, unknown>> = [];
const record = (call: string, args: unknown, result: unknown) => transcript.push({ call, args, result });

/** A tool call's JSON payload, as the agent receives it. */
async function call(name: string, args: Record<string, unknown>): Promise<any> {
	const r = (await client!.callTool({ name, arguments: args })) as {
		content: Array<{ text: string }>;
		isError?: boolean;
	};
	const raw = r.content[0].text;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		// A refusal comes back as a plain sentence, not JSON - that IS the payload.
		parsed = raw;
	}
	record(name, args, r.isError ? { error: parsed } : parsed);
	return r.isError ? { __error: raw } : parsed;
}

const NOTEBOOK = {
	nbformat: 4,
	nbformat_minor: 5,
	metadata: { kernelspec: { name: 'python3', display_name: 'python3' } },
	cells: [
		{ id: 'title', cell_type: 'markdown', source: '# Circle analysis', metadata: {} },
		{ id: 'imports', cell_type: 'code', source: 'import math', metadata: {}, outputs: [], execution_count: null },
		{
			id: 'helper',
			cell_type: 'code',
			source: 'def area(radius):\n    """Area of a circle."""\n    return math.pi * radius**2',
			metadata: {},
			outputs: [],
			execution_count: null
		},
		{ id: 'scratch', cell_type: 'code', source: 'area(2)  # scratch, not library code', metadata: {}, outputs: [], execution_count: null },
		{
			id: 'sqlcell',
			cell_type: 'code',
			source: 'SELECT 1',
			metadata: { cellar: { language: 'sql' } },
			outputs: [],
			execution_count: null
		}
	]
};

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-e2e-export-'));
	writeFileSync(join(workspace, 'analysis.ipynb'), JSON.stringify(NOTEBOOK));
	const booted = await bootCellar(workspace);
	launcher = booted.proc;
	baseURL = booted.url;

	// Connect exactly as a configured agent does: the stdio bridge, from the
	// workspace, discovering the live instance through .cellar/runtime.json.
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
	if (SHOTS && transcript.length) {
		mkdirSync(SHOTS, { recursive: true });
		writeFileSync(join(SHOTS, 'agent-transcript.json'), JSON.stringify(transcript, null, 2));
	}
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

test('an agent names a target, marks cells, and a real .py module appears - the human sees the marks live', async ({ page }) => {
	const modulePath = join(workspace, 'lib', 'circles.py');

	// The human is already reading the notebook.
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await page.getByText('analysis.ipynb').first().dblclick();
	await expect(page.getByRole('heading', { name: 'Circle analysis' })).toBeVisible();
	// Nothing marked, no target: the export bar is PRESENT but unconfigured - it
	// is now the always-visible section a target is set in BEFORE marking cells.
	await expect(page.getByTestId('export-bar')).toBeVisible();
	await expect(page.getByTestId('export-target-input')).toHaveValue('');
	await expect(page.getByTestId('export-count')).toHaveText('0 cells marked');
	await shot(page, '01-before-no-export.png');

	// --- the agent's read: it can SEE there is no target and no marks ----------
	await call('use_notebook', { name: 'analysis.ipynb' });
	const before = await call('get_notebook_map', {});
	expect(before.display.export_target).toBeNull();
	const flagsOf = (map: any) => map.sections[0].children.filter((c: any) => c.export).map((c: any) => c.id);
	expect(flagsOf(before)).toEqual([]);

	// --- 1. name the module ----------------------------------------------------
	const target = await call('set_export_target', { path: 'lib/circles.py' });
	expect(target.export_target).toBe('lib/circles.py');

	// --- 2. choose its contents (the tool this change adds) --------------------
	const marked = await call('set_cell_export', { ids: ['imports', 'helper'], export: true });
	expect(marked).toMatchObject({ ok: true, cells: ['imports', 'helper'], count: 2, export_target: 'lib/circles.py' });
	// A regeneration really happened, so nothing is warned about.
	expect(marked.module).toBeUndefined();

	// --- 3. THE DELIVERABLE: a real module on disk, holding exactly those cells -
	expect(existsSync(modulePath)).toBe(true);
	const mod = readFileSync(modulePath, 'utf8');
	expect(mod).toContain('AUTOGENERATED BY CELLAR');
	expect(mod).toContain('import math');
	expect(mod).toContain('def area(radius):');
	expect(mod).toContain("__all__ = ['area']");
	// The unmarked cells stayed out of it.
	expect(mod).not.toContain('scratch');
	expect(mod).not.toContain('SELECT 1');
	if (SHOTS) {
		mkdirSync(SHOTS, { recursive: true });
		writeFileSync(join(SHOTS, 'generated-module.py'), mod);
	}

	// --- 4. the human's open page reflects it live, no reload ------------------
	await expect(page.locator('[data-testid="toggle-export"][aria-pressed="true"]')).toHaveCount(2);
	await expect(page.getByTestId('export-count')).toHaveText(/2 cells marked/);
	await expect(page.getByTestId('export-target-input')).toHaveValue('lib/circles.py');
	await shot(page, '02-after-agent-marked.png');

	// The flags round-trip through the committed .ipynb, in the cellar namespace.
	const onDisk = JSON.parse(readFileSync(join(workspace, 'analysis.ipynb'), 'utf8'));
	expect(onDisk.cells.filter((c: any) => c.metadata?.cellar?.export).map((c: any) => c.id)).toEqual(['imports', 'helper']);
	expect(onDisk.metadata.cellar.export_target).toBe('lib/circles.py');

	// --- 5. the agent can READ the marks back ----------------------------------
	const after = await call('get_notebook_map', {});
	expect(after.display.export_target).toBe('lib/circles.py');
	expect(flagsOf(after)).toEqual(['imports', 'helper']);
});

test('only a PYTHON code cell can be marked - SQL, markdown and hidden cells are refused by id', async () => {
	// A SQL cell IS an nbformat code cell, so a cell_type test would admit one and
	// concatenate raw SQL into a git-tracked .py. It is refused by NAME.
	const sql = await call('set_cell_export', { ids: ['sqlcell'], export: true });
	expect(sql.__error).toContain('cell sqlcell is not a Python code cell');

	const md = await call('set_cell_export', { ids: ['title'], export: true });
	expect(md.__error).toContain('cell title is not a Python code cell');

	// All-or-nothing: a bad cell in the batch leaves the good one untouched.
	const mixed = await call('set_cell_export', { ids: ['scratch', 'sqlcell'], export: true });
	expect(mixed.__error).toContain('is not a Python code cell');
	const map = await call('get_notebook_map', {});
	expect(map.sections[0].children.filter((c: any) => c.export).map((c: any) => c.id)).toEqual(['imports', 'helper']);

	// A cell hidden from the agent reads as NOT FOUND - marking would copy its
	// source into a .py the agent can open.
	await call('set_cell_visibility', { id: 'scratch', hidden: true });
	const hidden = await call('set_cell_export', { ids: ['scratch'], export: true });
	expect(hidden.__error).toContain('not found');
	await call('set_cell_visibility', { id: 'scratch', hidden: false });
});

test('unmarking the last cell does NOT delete the committed module - it says so instead', async () => {
	const modulePath = join(workspace, 'lib', 'circles.py');
	const beforeBytes = readFileSync(modulePath, 'utf8');
	const beforeMtime = statSync(modulePath).mtimeMs;

	const unmarked = await call('set_cell_export', { ids: ['imports', 'helper'], export: false });
	expect(unmarked).toMatchObject({ ok: true, cells: ['imports', 'helper'], count: 2 });
	// The honesty half: no unconditional "regenerated" claim.
	expect(unmarked.module.regenerated).toBe(false);
	expect(unmarked.module.reason).toContain('no cell is marked for export');
	expect(unmarked.module.reason).toContain('left on disk exactly as it was');

	// And the git-tracked module really is untouched - not truncated, not deleted.
	expect(existsSync(modulePath)).toBe(true);
	expect(readFileSync(modulePath, 'utf8')).toBe(beforeBytes);
	expect(statSync(modulePath).mtimeMs).toBe(beforeMtime);

	// Re-marking one cell regenerates it with only that cell.
	const remarked = await call('set_cell_export', { ids: ['helper'], export: true });
	expect(remarked.module).toBeUndefined();
	const mod = readFileSync(modulePath, 'utf8');
	expect(mod).toContain('def area(radius):');
	expect(mod).not.toContain('import math');
	if (SHOTS) writeFileSync(join(SHOTS, 'generated-module-after-unmark.py'), mod);
});

test('a .py text notebook is refused up front by BOTH halves of the flow', async () => {
	// A jupytext/Databricks source notebook stores no per-cell cellar metadata, so
	// a mark could never persist and no module could ever be generated.
	// Databricks source format - cellar's own converter reads it, so this needs no
	// jupytext install in the throwaway workspace venv.
	const PY_SOURCE = '# Databricks notebook source\nimport math\n\n# COMMAND ----------\n\nprint(math.pi)\n';
	writeFileSync(join(workspace, 'script.py'), PY_SOURCE);
	// Addressed as a one-off cross-notebook op, so the session's own notebook is
	// untouched (use_notebook would append .ipynb and create a different doc).
	const map = await call('get_notebook_map', { notebook: 'script.py' });
	const firstCode = map.sections[0].id;

	const target = await call('set_export_target', { path: 'lib/from_py.py', notebook: 'script.py' });
	expect(target.__error).toContain('.py text notebook');

	const mark = await call('set_cell_export', { ids: [firstCode], export: true, notebook: 'script.py' });
	expect(mark.__error).toContain('.py text notebook');

	expect(existsSync(join(workspace, 'lib', 'from_py.py'))).toBe(false);
	// Nothing leaked into the source file either.
	expect(readFileSync(join(workspace, 'script.py'), 'utf8')).toBe(PY_SOURCE);
});

test('the human half: a refused target is SAID, and the field goes back to what the server holds', async ({ page }) => {
	// The other side of the same rule the agent meets: the module is WRITTEN at
	// this path, so a non-.py target is refused - and the human must see why
	// rather than watch a field silently keep a value nothing stored.
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await page.getByText('analysis.ipynb').first().dblclick();
	const input = page.getByTestId('export-target-input');
	await expect(input).toHaveValue('lib/circles.py');

	await input.fill('lib/notes.txt');
	await input.blur();

	const notice = page.getByTestId('app-notice');
	await expect(notice).toBeVisible();
	await expect(notice).toContainText(/\.py/);
	await shot(page, '03-refused-target-notice.png');

	// The field shows what the notebook really holds, not the rejected path.
	await expect(input).toHaveValue('lib/circles.py');
	const onDisk = JSON.parse(readFileSync(join(workspace, 'analysis.ipynb'), 'utf8'));
	expect(onDisk.metadata.cellar.export_target).toBe('lib/circles.py');
	// And the agent reads the same thing.
	expect((await call('get_notebook_map', {})).display.export_target).toBe('lib/circles.py');
});
