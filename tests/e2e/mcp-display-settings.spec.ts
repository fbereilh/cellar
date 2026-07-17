import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { runtimeAvailable, bootCellar, killCellar, REPO } from './harness';

/**
 * The agent-facing notebook DISPLAY settings, end to end over the real wire an
 * agent uses: a `cellar mcp` stdio bridge into a live cellar, with a human's
 * browser open on the same notebook.
 *
 * This is the whole point of the feature. Agents hand-numbered their headers
 * ("## 1. Setup") because nothing in the MCP surface told them cellar already
 * numbers headings at render time. So the check is not "the setter returns ok"
 * but: the agent can SEE the setting (get_notebook_map's display block), it can
 * SET it, the human's UI reflects it live over SSE, and no number ever reaches a
 * cell's source on disk.
 *
 * Like the other specs here it boots the REAL launcher and SKIPS when the kernel
 * runtime (uv + python3 + host-venv) is absent — the vitest suite is the gate.
 */

let launcher: ChildProcess | null = null;
let client: Client | null = null;
let workspace = '';
let baseURL = '';

/** Screenshots land beside the spec run when an evidence dir is provided. */
const SHOTS = process.env.CELLAR_E2E_SHOTS || '';
const shot = async (page: import('@playwright/test').Page, name: string) => {
	if (!SHOTS) return;
	mkdirSync(SHOTS, { recursive: true });
	await page.screenshot({ path: join(SHOTS, name), fullPage: true });
};

/** A tool call's JSON payload, as the agent receives it. */
async function call(name: string, args: Record<string, unknown>): Promise<any> {
	const r = (await client!.callTool({ name, arguments: args })) as { content: Array<{ text: string }> };
	return JSON.parse(r.content[0].text);
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-e2e-display-'));
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

test('the connect handshake tells the agent the numbering convention', async () => {
	// The whole point of the feature: an agent that never reads a tool description
	// still learns, at connect, that numbering is Cellar's job and not its own.
	const instructions = client!.getInstructions() || '';
	expect(instructions).toContain('NEVER NUMBER A HEADER BY HAND');
	expect(instructions).toContain('set_header_numbering');
	expect(instructions).toContain('REPORT VIEW');
	// Every tool it needs is actually advertised.
	const tools = (await client!.listTools()).tools.map((t) => t.name);
	expect(tools).toEqual(expect.arrayContaining(['set_header_numbering', 'set_report_view']));

	if (SHOTS) {
		mkdirSync(SHOTS, { recursive: true });
		const clause = instructions.slice(instructions.indexOf('NEVER NUMBER A HEADER BY HAND'));
		writeFileSync(join(SHOTS, 'agent-instructions.txt'), clause.slice(0, clause.indexOf('6. DECLARE')).trimEnd());
	}
});

test('an agent reads and sets header numbering; the human sees numbered headings live', async ({ page }) => {
	// A notebook the human is already reading, headings written the RIGHT way —
	// no hand-typed numbers in any source.
	writeFileSync(
		join(workspace, 'report.ipynb'),
		JSON.stringify({
			nbformat: 4,
			nbformat_minor: 5,
			metadata: { kernelspec: { name: 'python3', display_name: 'python3' } },
			cells: [
				{ id: 'h1', cell_type: 'markdown', source: '# Sales Analysis', metadata: {} },
				{ id: 'h2a', cell_type: 'markdown', source: '## Load data', metadata: {} },
				{ id: 'c1', cell_type: 'code', source: 'rows = 128', metadata: {}, outputs: [], execution_count: null },
				{ id: 'h2b', cell_type: 'markdown', source: '## Clean data', metadata: {} },
				{ id: 'h3', cell_type: 'markdown', source: '### Drop nulls', metadata: {} },
				{ id: 'h2c', cell_type: 'markdown', source: '## Results', metadata: {} }
			]
		})
	);

	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await page.getByText('report.ipynb').first().dblclick();
	await expect(page.getByRole('heading', { name: 'Sales Analysis' })).toBeVisible();
	await shot(page, '01-before-plain-headings.png');

	// --- the agent's read: numbering is OFF and it can tell -------------------
	await call('use_notebook', { name: 'report.ipynb' });
	const before = await call('get_notebook_map', {});
	expect(before.display).toEqual({ header_numbering: [], report_view: false });

	// --- the agent turns it on ------------------------------------------------
	const set = await call('set_header_numbering', { levels: [2, 1, 2] });
	// Sanitized: deduped, ascending — what actually took effect.
	expect(set).toEqual({ levels: [1, 2], numbered_headings: 4 });

	// --- the agent reads back the numbers the HUMAN sees -----------------------
	const after = (await call('get_notebook_map', {})) as { display: unknown; sections: any[] };
	expect(after.display).toEqual({ header_numbering: [1, 2], report_view: false });
	const h1 = after.sections[0];
	expect({ title: h1.title, number: h1.number }).toEqual({ title: 'Sales Analysis', number: '1' });
	expect(h1.children.filter((c: any) => c.type === 'markdown').map((c: any) => [c.number, c.title])).toEqual([
		['1.1', 'Load data'],
		['1.2', 'Clean data'],
		['1.3', 'Results']
	]);
	// H3 is not a numbered level, so it carries no number.
	const h3 = h1.children.find((c: any) => c.title === 'Clean data').children[0];
	expect(h3.number).toBeUndefined();

	// read_section presents the heading AS a heading, so it carries the number.
	const section = (await call('read_section', { header_id: 'h2a' })) as { header: Record<string, unknown> };
	expect(section.header).toMatchObject({ level: 2, title: 'Load data', number: '1.1' });

	if (SHOTS) {
		mkdirSync(SHOTS, { recursive: true });
		writeFileSync(
			join(SHOTS, 'agent-view.json'),
			JSON.stringify({ get_notebook_map_before: before, set_header_numbering: set, get_notebook_map_after: after, read_section: section }, null, 2)
		);
	}

	// --- the human's open page reflects it live, no reload ---------------------
	await expect(page.getByRole('heading', { name: '1. Sales Analysis' })).toBeVisible();
	await expect(page.getByRole('heading', { name: '1.1 Load data' })).toBeVisible();
	await expect(page.getByRole('heading', { name: '1.3 Results' })).toBeVisible();
	await shot(page, '02-after-agent-numbered.png');

	// --- nothing reached any cell's source ------------------------------------
	const cells = (await call('read_cells', { ids: ['h1', 'h2a', 'h2b'] })) as Array<{ source: string }>;
	expect(cells.map((c) => c.source)).toEqual(['# Sales Analysis', '## Load data', '## Clean data']);
	const onDisk = JSON.parse(readFileSync(join(workspace, 'report.ipynb'), 'utf8'));
	expect(onDisk.metadata.cellar).toEqual({ header_numbering: [1, 2] });
	for (const c of onDisk.cells) expect(String(c.source)).not.toMatch(/^#+\s*\d/);

	// --- the agent turns it off again ------------------------------------------
	expect(await call('set_header_numbering', { levels: [] })).toEqual({ levels: [], numbered_headings: 0 });
	await expect(page.getByRole('heading', { name: 'Sales Analysis', exact: true })).toBeVisible();
});

test('an agent turns report view on; the human reads results without code', async ({ page }) => {
	await page.goto(`${baseURL}/?ws=${encodeURIComponent(workspace)}`);
	await page.getByText('report.ipynb').first().dblclick();
	const cell = page.getByTestId('cell').filter({ hasText: 'rows = 128' });
	await expect(cell).toBeVisible();

	expect(await call('set_report_view', { enabled: true })).toEqual({ report_view: true });

	// The code input is hidden for the human, behind a "show code" affordance.
	await expect(page.getByTestId('show-code').first()).toBeVisible();
	await expect(page.getByText('rows = 128')).toBeHidden();
	await shot(page, '03-report-view-on.png');

	const map = (await call('get_notebook_map', {})) as { display: { report_view: boolean } };
	expect(map.display.report_view).toBe(true);

	expect(await call('set_report_view', { enabled: false })).toEqual({ report_view: false });
	await expect(page.getByTestId('show-code')).toHaveCount(0);
});
