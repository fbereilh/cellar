import { test, expect } from '@playwright/test';
import { spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { runtimeAvailable, bootCellar, killCellar, REPO } from './harness';

/**
 * The three agent-ergonomics fixes, over the wire an agent really uses: a
 * `cellar mcp` stdio bridge into a live cellar with a live kernel.
 *
 * Each one came from an agent hitting it in real work, and each is only truly
 * fixed at this layer — the round-trip count and the token bill are properties
 * of the CALL, not of the service function:
 *   - move_cell by handle: "put this after that" with no map fetch first,
 *   - delete_cells: eight cells dropped in ONE call after a pivot,
 *   - inspect_variable: an array-heavy frame answered in a bounded reply
 *     instead of thousands of tokens of floats.
 *
 * Like the other specs here it boots the REAL launcher and SKIPS when the kernel
 * runtime is absent — the vitest suite is the must-pass gate.
 */

let launcher: ChildProcess | null = null;
let client: Client | null = null;
let workspace = '';
/** Whether pandas could be installed into the workspace venv (the reported case). */
let hasPandas = false;

/** A tool call's JSON payload, as the agent receives it. */
async function call(name: string, args: Record<string, unknown>): Promise<any> {
	const r = (await client!.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
	return JSON.parse(r.content[0].text);
}

/** Cell sources in DOCUMENT order (the map is the order; reads carry the text). */
async function orderedSources(): Promise<string[]> {
	const map = await call('get_notebook_map', {});
	const ids = (map.sections as Array<{ id: string }>).map((s) => s.id);
	return (await call('read_cells', { ids })).map((c: { source: string }) => c.source);
}

/** A tool call expected to FAIL: its text is the error message, not JSON. */
async function callRaw(name: string, args: Record<string, unknown>) {
	return (await client!.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
}

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-e2e-ergo-'));
	const booted = await bootCellar(workspace);
	launcher = booted.proc;

	// The reported inspect_variable case is a pandas frame, so put pandas in the
	// workspace venv the kernel runs on. Best-effort: a machine that cannot fetch
	// it skips that one test rather than failing the suite.
	const venvPython = join(workspace, '.venv', 'bin', 'python');
	if (existsSync(venvPython)) {
		hasPandas = spawnSync('uv', ['pip', 'install', '--python', venvPython, '--quiet', 'pandas', 'numpy'], { stdio: 'ignore' }).status === 0;
	}

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

test('move_cell takes a cell handle, so no map fetch is needed to move one cell', async () => {
	await call('use_notebook', { name: 'moves' });
	const added = await call('add_cells', {
		cells: [0, 1, 2, 3].map((i) => ({ cell_type: 'code', source: `step_${i} = ${i}` })),
		route_imports: false
	});
	const [c0, c1, , c3] = added.ids as string[];

	// The whole point: the destination is another cell's HANDLE — the same kind of
	// id every other tool takes — and nothing had to be read first to learn it.
	const moved = await call('move_cell', { id: c0, after_id: c3 });
	expect(moved).toMatchObject({ ok: true, id: c0 });

	// It really moved, in the document the human sees.
	expect(await orderedSources()).toEqual(['', 'step_1 = 1', 'step_2 = 2', 'step_3 = 3', 'step_0 = 0']);

	// before_id works too, and a bad destination is refused rather than guessed at.
	expect(await call('move_cell', { id: c0, before_id: c1 })).toMatchObject({ ok: true });
	expect(await orderedSources()).toEqual(['', 'step_0 = 0', 'step_1 = 1', 'step_2 = 2', 'step_3 = 3']);
	const bad = await callRaw('move_cell', { id: c0, after_id: c0 });
	expect(bad.isError).toBe(true);
	expect(bad.content[0].text).toMatch(/different cell/i);
	const none = await callRaw('move_cell', { id: c0 });
	expect(none.isError).toBe(true);
	expect(none.content[0].text).toMatch(/after_id, before_id, or position/);
});

test('delete_cells drops many cells in ONE call, leaving the rest intact', async () => {
	await call('use_notebook', { name: 'pivot' });
	const added = await call('add_cells', {
		cells: Array.from({ length: 8 }, (_, i) => ({ cell_type: 'code', source: `probe_${i} = ${i}` })),
		route_imports: false
	});
	const ids = added.ids as string[];

	// The pivot the feedback describes: eight cells, one round trip.
	const del = await call('delete_cells', { ids });
	expect(del).toMatchObject({ ok: true, count: 8 });

	// Every deleted cell is gone, and nothing else was touched.
	const remaining = ((await call('get_notebook_map', {})).sections as Array<{ id: string }>).map((s) => s.id);
	for (const id of ids) expect(remaining).not.toContain(id);

	// Single-cell delete still works through the same tool.
	const one = await call('add_and_run', { source: 'lone = 1', route_imports: false });
	expect(await call('delete_cells', { ids: [one.id] })).toMatchObject({ ok: true, count: 1 });

	// A typo in a batch deletes NOTHING rather than half-applying.
	const keep = await call('add_cells', { cells: [{ cell_type: 'code', source: 'kept = 1' }], route_imports: false });
	const failed = await callRaw('delete_cells', { ids: [keep.ids[0], 'zzzzzzzz'] });
	expect(failed.isError).toBe(true);
	expect((await call('read_cells', { ids: [keep.ids[0]] }))[0].source).toBe('kept = 1');
});

test('inspect_variable answers an array-heavy frame in a bounded reply', async () => {
	test.skip(!hasPandas, 'pandas could not be installed into the workspace venv');
	await call('use_notebook', { name: 'arrays' });

	// The reported shape: a frame whose cells are 1024-float embeddings. Ten full
	// rows of this is what cost the agent thousands of tokens.
	const ran = await call('add_and_run', {
		source: [
			'import numpy as np, pandas as pd',
			'raw = pd.DataFrame({"id": range(50),',
			'                    "label": ["row-%d" % i for i in range(50)],',
			'                    "embedding": [list(np.arange(1024, dtype=float)) for _ in range(50)]})',
			'raw.shape'
		].join('\n')
	});
	expect(ran).toMatchObject({ status: 'ok', ran_this_session: true });

	const d = await call('inspect_variable', { name: 'raw' });
	expect(d).toMatchObject({ found: true, kind: 'dataframe', shape: [50, 3] });

	// Bounded, and it SAYS it is bounded — a truncated sample an agent cannot
	// recognise as truncated is worse than a long one.
	expect(d.head_truncated).toBe(true);
	expect(String(d.head_note)).toMatch(/capped/);
	expect(d.head.length).toBe(3);
	for (const row of d.head) {
		expect(Object.keys(row).sort()).toEqual(['embedding', 'id', 'label']); // no column lost
		expect(row.embedding.length).toBe(9); // 8 values + the "… N more" marker
		expect(String(row.embedding.at(-1))).toBe('… 1016 more (1024 total)');
	}
	// The reply is now a look at the data rather than a dump of it.
	expect(JSON.stringify(d).length).toBeLessThan(4000);

	// A scalar frame is untouched by all of this: still the full ten-row sample.
	await call('add_and_run', { source: 'plain = pd.DataFrame({"a": range(100), "b": ["x"] * 100})' });
	const p = await call('inspect_variable', { name: 'plain' });
	expect(p.head_rows).toBe(10);
	expect(p.head_truncated).toBeUndefined();
});
