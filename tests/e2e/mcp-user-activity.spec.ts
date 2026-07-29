import { test, expect } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { runtimeAvailable, bootCellar, killCellar, REPO } from './harness';

/**
 * The agent learns what the HUMAN changed - over the wire an agent really uses.
 *
 * The scout's reproduction, promoted to a spec: a `cellar mcp` stdio bridge into
 * a live cellar, with the USER's actions driven through the exact REST routes the
 * browser calls (carrying a tab `originId`). Two things are only genuinely proven
 * at this layer:
 *
 *   - the digest hangs off `extra.sessionId`, which the REAL
 *     StreamableHTTPServerTransport supplies. A unit test sets that by hand, so
 *     it cannot notice a transport that stopped providing it - and the whole
 *     feature would then be silently inert in production.
 *   - the `registerTool` wrapper is in the path for tools as REGISTERED, not for
 *     one hand-called handler.
 *
 * Like the other MCP specs here it boots the REAL launcher and SKIPS when the
 * kernel runtime is absent; the vitest suite is the must-pass gate.
 */

let launcher: ChildProcess | null = null;
let client: Client | null = null;
let workspace = '';
let appUrl = '';

/** A browser tab's id - what marks a REST mutation as the USER's action. */
const TAB = 'tab-e2e';
const NB = 'story.ipynb';

type Raw = { content: Array<{ type: string; text?: string }>; isError?: boolean };

const callRaw = (name: string, args: Record<string, unknown>) =>
	client!.callTool({ name, arguments: args }) as Promise<Raw>;

const blocks = (r: Raw) => r.content.filter((c) => c.type === 'text').map((c) => c.text ?? '');
/** The user-activity block, when the result carries one. */
const digestOf = (r: Raw) => blocks(r).find((t) => t.startsWith('[cellar] user activity:'));
/** Everything that is NOT the digest - the tool's own payload. */
const payloadOf = (r: Raw) => blocks(r).filter((t) => !t.startsWith('[cellar] user activity:')).join('\n');

const call = async (name: string, args: Record<string, unknown> = {}) => JSON.parse(payloadOf(await callRaw(name, args)));

// --- USER actions: the exact REST calls the browser makes --------------------

async function liveCells(): Promise<Array<{ id: string; source: string }>> {
	const r = await fetch(`${appUrl}/api/notebooks?path=${encodeURIComponent(NB)}`);
	return (await r.json()).notebook.cells;
}
const userJson = (path: string, method: string, body: Record<string, unknown>) =>
	fetch(`${appUrl}${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, nb: NB, originId: TAB }) });
const userDelete = (id: string) =>
	fetch(`${appUrl}/api/cells/${id}?nb=${encodeURIComponent(NB)}&originId=${TAB}`, { method: 'DELETE' });
const userEdit = (id: string, source: string) => userJson(`/api/cells/${id}`, 'PATCH', { source });
const userAdd = (afterId: string) => userJson('/api/cells', 'POST', { afterId, cell_type: 'code' });
const userMove = (id: string, toIndex: number) => userJson(`/api/cells/${id}/move`, 'POST', { toIndex });

test.beforeAll(async () => {
	test.skip(!runtimeAvailable(), 'kernel runtime (uv + python3 + host-venv) not available — E2E is local-only');
	workspace = mkdtempSync(join(tmpdir(), 'cellar-e2e-activity-'));
	const booted = await bootCellar(workspace);
	launcher = booted.proc;
	appUrl = booted.url;

	client = new Client({ name: 'e2e-agent', version: '0' });
	await client.connect(
		new StdioClientTransport({
			command: 'node',
			args: [join(REPO, 'bin', 'cellar.js'), 'mcp'],
			cwd: workspace,
			env: { ...process.env } as Record<string, string>
		})
	);
	await call('use_notebook', { name: NB });
	for (const source of ['a = 1', 'b = 2', 'c = 3']) await call('add_cell', { source, route_imports: false });
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

test('a cell the USER deleted fails legibly, while a bogus id keeps the generic error', async () => {
	const cells = await liveCells();
	const doomed = cells.find((c) => c.source === 'b = 2')!;
	const handle = doomed.id.slice(0, 8);

	// The agent holds a working handle...
	expect((await callRaw('read_cells', { ids: [handle] })).isError).toBeFalsy();
	// ...and then the human deletes that cell in the browser.
	expect((await userDelete(doomed.id)).ok).toBe(true);

	const r = await callRaw('read_cells', { ids: [handle] });
	// Still an error (the read genuinely did not happen), but it now names the
	// CAUSE. Before this, seven different tools answered with one byte-identical
	// string and the model concluded the tool was broken.
	expect(r.isError).toBe(true);
	const msg = payloadOf(r);
	expect(msg).toContain('the user deleted it');
	expect(msg).toContain('in the Cellar UI');
	expect(msg).not.toContain('no cell matches id');

	// The distinction is the whole point: an id that never existed is unchanged.
	const bogus = await callRaw('read_cells', { ids: ['ffffffff'] });
	expect(bogus.isError).toBe(true);
	expect(payloadOf(bogus)).toContain('no cell matches id');
});

test('a user edit/add/move surfaces as a digest on the next tool result, exactly once', async () => {
	const before = await liveCells();
	const edited = before[0];
	const moved = before[before.length - 1];

	await userEdit(edited.id, 'a = 999  # user changed this');
	await userAdd(edited.id);
	await userMove(moved.id, 0);

	const r = await callRaw('get_notebook_map', {});
	const note = digestOf(r);
	expect(note).toBeTruthy();
	expect(note).toContain('since your last call the user');
	expect(note).toContain('edited cell');
	expect(note).toContain('added cell');
	expect(note).toContain('moved cell');
	expect(note).toContain(edited.id.slice(0, 8));

	// Additive: the tool's own payload is untouched and still parses.
	expect(JSON.parse(payloadOf(r))).toHaveProperty('sections');

	// And reported once - a call with no intervening user change carries nothing.
	expect(digestOf(await callRaw('get_notebook_map', {}))).toBeUndefined();
});

test("the agent's OWN writes never come back to it as user activity", async () => {
	await callRaw('get_notebook_map', {}); // settle the cursor

	const mine = (await liveCells())[0];
	await call('edit_cell', { id: mine.id.slice(0, 8), source: 'agent_wrote = 1', route_imports: false });
	await call('add_cell', { source: 'agent_added = 2', route_imports: false });
	expect(digestOf(await callRaw('get_notebook_map', {}))).toBeUndefined();

	// A user change straight after IS reported, so the silence above was the origin
	// filter working rather than the channel being dead.
	await userEdit(mine.id, 'user_wrote = 1');
	const note = digestOf(await callRaw('get_notebook_map', {}));
	expect(note).toContain('the user');
	expect(note).toContain(mine.id.slice(0, 8));
});

test('a cell hidden from the agent never appears in a digest or a deletion note', async () => {
	const secret = (await call('add_cell', { source: 'secret = 1', route_imports: false })).id as string;
	await call('set_cell_visibility', { id: secret, hidden: true });
	const shown = (await call('add_cell', { source: 'shown = 1', route_imports: false })).id as string;
	await callRaw('get_notebook_map', {}); // settle the cursor

	const cells = await liveCells();
	const secretFull = cells.find((c) => c.id.startsWith(secret))!;
	const shownFull = cells.find((c) => c.id.startsWith(shown))!;

	// The USER edits the hidden cell: nothing is disclosed, not even that it changed.
	await userEdit(secretFull.id, 'secret = 2');
	expect(digestOf(await callRaw('get_notebook_map', {}))).toBeUndefined();

	// The USER deletes both. Only the visible one is reported, in the digest AND
	// in the failed-handle message.
	await userEdit(secretFull.id, 'secret = 3');
	await userEdit(shownFull.id, 'shown = 2');
	const note = digestOf(await callRaw('get_notebook_map', {}));
	expect(note).toContain(shown);
	expect(note).not.toContain(secret);

	await userDelete(secretFull.id);
	const gone = await callRaw('read_cells', { ids: [secret] });
	expect(gone.isError).toBe(true);
	expect(payloadOf(gone)).toContain('no cell matches id');
	expect(payloadOf(gone)).not.toContain('deleted');
});
