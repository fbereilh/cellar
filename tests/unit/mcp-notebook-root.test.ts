/**
 * CODE ROOTS on the MCP surface: `list_roots`, `use_notebook(root)`, and the
 * `root` the notebook map reports.
 *
 * The governing rule is that an agent that never mentions a root sees exactly
 * today's behavior, so the "no roots anywhere" and "never declared" cases are
 * asserted as carefully as the feature itself. Everything runs against the REAL
 * service + notebook singletons on a scratch workspace; only the Python
 * staleness subprocess is stubbed (the map awaits it).
 *
 * No kernel exists in these tests, so a root change frees none — which is the
 * honest result to report. The teardown pairing itself is
 * `notebook-root-restart.test.ts`.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

vi.mock('../../src/lib/server/dataflow', () => ({
	getNotebookStaleness: async () => ({ sid: null, cells: {} }),
	analyzeDataflow: async () => ({})
}));

let WS: string;
let svc: typeof import('../../src/lib/server/mcp/service');
let nbmod: typeof import('../../src/lib/server/notebook');
let srv: typeof import('../../src/lib/server/mcp/server');

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-mcp-root-'));
	process.env.CELLAR_WORKSPACE = WS;
	mkdirSync(join(WS, 'roots', 'pr-482'), { recursive: true });
	mkdirSync(join(WS, 'roots', 'baseline'), { recursive: true });
	svc = await import('../../src/lib/server/mcp/service');
	nbmod = await import('../../src/lib/server/notebook');
	srv = await import('../../src/lib/server/mcp/server');
});

type CallResult = { content: { type: string; text?: string }[]; isError?: boolean };
const bodyOf = (r: CallResult) =>
	r.content
		.filter((c) => c.type === 'text')
		.map((c) => c.text ?? '')
		.join('\n');

/**
 * A real MCP client over the REAL `registerTools` registration — the only level
 * that exercises the tool HANDLER, which is where `use_notebook` composes the
 * open-or-create with the root (and therefore where the ordering matters).
 */
async function connect(sessionId: string) {
	const server = new McpServer({ name: 'cellar-test', version: '0.0.0' });
	srv.registerTools(server);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	(serverTransport as { sessionId?: string }).sessionId = sessionId;
	const client = new Client({ name: 'test-agent', version: '0.0.0' });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return client;
}

describe('list_roots', () => {
	it('enumerates the workspace roots with the notebooks pointing at them', async () => {
		svc.useNotebook('sessList', 'reviewer.ipynb');
		const nb = svc.targetFor('sessList');
		await svc.setNotebookRoot('roots/pr-482', nb);
		const res = await svc.listRoots('sessList');
		expect(res.workspace).toBe(WS);
		expect(res.working_notebook).toBe('reviewer.ipynb');
		expect(res.working_root).toBe('roots/pr-482');
		expect(res.roots.map((r) => r.path)).toEqual(['roots/baseline', 'roots/pr-482']);
		const pr = res.roots.find((r) => r.path === 'roots/pr-482');
		expect(pr?.exists).toBe(true);
		expect(pr?.notebooks).toEqual(['reviewer.ipynb']);
		await svc.setNotebookRoot(null, nb);
	});

	it('a workspace with no roots reports an empty list and says so', async () => {
		const bare = mkdtempSync(join(tmpdir(), 'cellar-mcp-noroots-'));
		const prev = process.env.CELLAR_WORKSPACE;
		process.env.CELLAR_WORKSPACE = bare;
		try {
			// Pin a notebook IN the bare workspace: `list_roots` reports the working
			// notebook's own root, so it must be one this workspace actually holds.
			svc.useNotebook('sessBare', 'lonely.ipynb');
			const res = await svc.listRoots('sessBare');
			expect(res.working_root).toBeNull();
			expect(res.roots).toEqual([]);
			// The note must state the default, not merely be empty: an agent reading
			// "no roots" has to know that means every notebook runs at the workspace.
			expect(res.note).toMatch(/every notebook runs at the workspace root/i);
		} finally {
			process.env.CELLAR_WORKSPACE = prev;
		}
	});
});

describe('use_notebook + root', () => {
	it('omitting root leaves the declaration alone (today’s behavior)', async () => {
		const opened = svc.useNotebook('sessPlain', 'plain.ipynb');
		expect(opened.root).toBeNull();
		const map = await svc.getNotebookMap(svc.targetFor('sessPlain'));
		expect(map.root).toBeNull();
	});

	it('declares a root, and get_notebook_map reports it', async () => {
		const opened = svc.useNotebook('sessRoot', 'rooted.ipynb');
		const change = await svc.setNotebookRoot('roots/pr-482', opened.path);
		expect(change).toMatchObject({ root: 'roots/pr-482', root_changed: true });
		const map = await svc.getNotebookMap(opened.path);
		expect(map.root).toBe('roots/pr-482');
		// The declaration lives in the notebook, so re-opening reports the same root.
		expect(svc.useNotebook('sessRoot2', 'rooted.ipynb').root).toBe('roots/pr-482');
	});

	it('clearing with "" returns the notebook to the workspace root', async () => {
		const opened = svc.useNotebook('sessClear', 'rooted.ipynb');
		await svc.setNotebookRoot('roots/baseline', opened.path);
		const change = await svc.setNotebookRoot('', opened.path);
		expect(change).toMatchObject({ root: null, root_changed: true });
		expect((await svc.getNotebookMap(opened.path)).root).toBeNull();
	});

	it('re-declaring the same root reports no change (no namespace cost)', async () => {
		const opened = svc.useNotebook('sessSame', 'same.ipynb');
		await svc.setNotebookRoot('roots/pr-482', opened.path);
		const again = await svc.setNotebookRoot('roots/pr-482', opened.path);
		expect(again).toEqual({ root: 'roots/pr-482', root_changed: false });
		await svc.setNotebookRoot('', opened.path);
	});

	it('REFUSES a root outside the workspace, naming the rule', async () => {
		const opened = svc.useNotebook('sessBad', 'bad.ipynb');
		await expect(svc.setNotebookRoot('../escape', opened.path)).rejects.toThrow(/inside the workspace/i);
		await expect(svc.setNotebookRoot('/etc', opened.path)).rejects.toThrow(/workspace-relative/i);
		await expect(svc.setNotebookRoot('roots/nope', opened.path)).rejects.toThrow(/does not exist/i);
		expect(nbmod.getNotebookRoot(opened.path)).toBeNull();
	});

	it('a REFUSED root creates and pins nothing — the resolve runs first', async () => {
		// The open-or-create and the pin are irreversible by the time the write could
		// throw, so an agent typing a bad root used to be left pinned to a notebook it
		// never meant to make.
		const client = await connect('sessAtomic');
		const res = (await client.callTool({
			name: 'use_notebook',
			arguments: { name: 'never-made', root: 'roots/typo' }
		})) as CallResult;
		expect(res.isError).toBe(true);
		expect(bodyOf(res)).toMatch(/does not exist/i);
		expect(existsSync(join(WS, 'never-made.ipynb'))).toBe(false);
		expect(svc.currentNotebook('sessAtomic').pinned).toBe(false);
	});

	it('a root a .py notebook cannot HOLD is refused before the pin too', async () => {
		// Same ordering rule, second refusal: a `.py` stores no notebook metadata, so a
		// root declared on one could not survive a reload. That refusal came only from
		// `setNotebookRoot`, i.e. AFTER the open and the pin, so the agent read an error
		// while its session had silently moved to the `.py`. Newly reachable, since a
		// `.py` name used to resolve to a nonexistent `.py.ipynb`.
		writeFileSync(join(WS, 'parity.py'), '# Databricks notebook source\nx = 1\n');
		const client = await connect('sessPyRoot');
		const res = (await client.callTool({
			name: 'use_notebook',
			arguments: { name: 'parity.py', root: 'roots/pr-482' }
		})) as CallResult;
		expect(res.isError).toBe(true);
		// The write path's OWN message, not a second rule.
		expect(bodyOf(res)).toMatch(/Cannot set a code root on a \.py notebook/);
		expect(svc.currentNotebook('sessPyRoot').pinned).toBe(false);
		expect(existsSync(join(WS, 'parity.py.ipynb'))).toBe(false);
	});

	it('clearing a root is still allowed on a .py (it can only remove state)', async () => {
		const client = await connect('sessPyClear');
		const res = (await client.callTool({
			name: 'use_notebook',
			arguments: { name: 'parity.py', root: '' }
		})) as CallResult;
		// It gets past the up-front refusal; whether the open succeeds is the `.py`
		// reader's business (no python here), not this rule's.
		expect(bodyOf(res)).not.toMatch(/Cannot set a code root/);
	});

	it('two sessions work two roots in one instance, independently', async () => {
		const a = svc.useNotebook('sessA', 'a.ipynb');
		const b = svc.useNotebook('sessB', 'b.ipynb');
		await svc.setNotebookRoot('roots/pr-482', a.path);
		await svc.setNotebookRoot('roots/baseline', b.path);
		expect((await svc.getNotebookMap(a.path)).root).toBe('roots/pr-482');
		expect((await svc.getNotebookMap(b.path)).root).toBe('roots/baseline');
		const listed = await svc.listRoots('sessA');
		expect(listed.working_root).toBe('roots/pr-482');
		expect(listed.roots.find((r) => r.path === 'roots/baseline')?.notebooks).toContain('b.ipynb');
	});
});

/**
 * `use_notebook` with a `root` but NO `name`. Over the real registration, because
 * the composition of open-or-create with the root lives in the tool handler.
 */
describe('use_notebook(root) with no name re-roots the notebook you are working in', () => {
	it('applies the root to the PINNED notebook, creating no untitled one', async () => {
		const client = await connect('sessReroot');
		await client.callTool({ name: 'use_notebook', arguments: { name: 'working.ipynb' } });
		const res = (await client.callTool({ name: 'use_notebook', arguments: { root: 'roots/pr-482' } })) as CallResult;
		expect(res.isError).toBeFalsy();
		const body = JSON.parse(bodyOf(res));
		expect(body).toMatchObject({ working_notebook: 'working.ipynb', root: 'roots/pr-482', root_changed: true, created: false });
		// The session still points where it did, and no untitled notebook appeared.
		expect(svc.currentNotebook('sessReroot').working_notebook).toBe('working.ipynb');
		expect(existsSync(join(WS, 'untitled.ipynb'))).toBe(false);
		expect(nbmod.getNotebookRoot(join(WS, 'working.ipynb'))).toBe('roots/pr-482');
	});

	it('with NOTHING pinned it is an error naming the ambiguity, not an untitled notebook', async () => {
		const client = await connect('sessNoPin');
		const res = (await client.callTool({ name: 'use_notebook', arguments: { root: 'roots/baseline' } })) as CallResult;
		expect(res.isError).toBe(true);
		expect(bodyOf(res)).toMatch(/has not pinned one yet/i);
		expect(existsSync(join(WS, 'untitled.ipynb'))).toBe(false);
		expect(svc.currentNotebook('sessNoPin').pinned).toBe(false);
	});
});
