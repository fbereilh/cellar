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
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

vi.mock('../../src/lib/server/dataflow', () => ({
	getNotebookStaleness: async () => ({ sid: null, cells: {} }),
	analyzeDataflow: async () => ({})
}));

let OUTER: string;
let WS: string;
let SIBLING: string;
let svc: typeof import('../../src/lib/server/mcp/service');
let nbmod: typeof import('../../src/lib/server/notebook');
let srv: typeof import('../../src/lib/server/mcp/server');

beforeAll(async () => {
	OUTER = mkdtempSync(join(tmpdir(), 'cellar-mcp-root-'));
	WS = join(OUTER, 'workspace');
	SIBLING = join(OUTER, 'pr-398');
	mkdirSync(WS, { recursive: true });
	process.env.CELLAR_WORKSPACE = WS;
	mkdirSync(join(WS, 'roots', 'pr-482'), { recursive: true });
	mkdirSync(join(WS, 'roots', 'baseline'), { recursive: true });
	// A registered SIBLING worktree, so the agent surface can be exercised on a root
	// OUTSIDE the workspace — the shape `git worktree add ../name <branch>` makes.
	const git = (...args: string[]) =>
		execFileSync('git', ['-C', WS, ...args], {
			stdio: 'pipe',
			env: { ...process.env, GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@b.c', GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@b.c' }
		});
	git('init', '-q', '-b', 'main');
	writeFileSync(join(WS, 'f.txt'), 'x\n');
	git('add', 'f.txt');
	git('commit', '-q', '-m', 'init');
	git('worktree', 'add', '-q', SIBLING, '-b', 'under-review');
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
		// Workspace-internal roots first, then the DETECTED sibling worktree — offered
		// by default, which is the ergonomic payload of the whole feature.
		expect(res.roots.map((r) => r.path)).toEqual(['roots/baseline', 'roots/pr-482', '../pr-398']);
		const pr = res.roots.find((r) => r.path === 'roots/pr-482');
		expect(pr?.exists).toBe(true);
		expect(pr?.notebooks).toEqual(['reviewer.ipynb']);
		expect(pr?.external).toBe(false);

		// …and the external one is LABELLED, so an agent cannot adopt a sibling
		// checkout believing it sits inside the workspace.
		const sibling = res.roots.find((r) => r.path === '../pr-398');
		expect(sibling).toMatchObject({ external: true, source: 'worktree', branch: 'under-review' });
		// The note must say what `external` costs it: a kernel runs there, but every
		// file path it reads or writes is still workspace-relative.
		expect(res.note).toMatch(/external:true/i);
		expect(res.note).toMatch(/cannot reach into it/i);
		await svc.setNotebookRoot(null, nb);
	});

	it('declares an EXTERNAL worktree root, storing the ..-relative form', async () => {
		// The agent may paste the absolute path `git worktree add` printed; what lands
		// in the committed `.ipynb` must be portable and leak no home directory.
		const opened = svc.useNotebook('sessExternal', 'external.ipynb');
		const change = await svc.setNotebookRoot(SIBLING, opened.path);
		expect(change).toMatchObject({ root: '../pr-398', root_changed: true });
		expect((await svc.getNotebookMap(opened.path)).root).toBe('../pr-398');
		await svc.setNotebookRoot('', opened.path);
	});

	it('REPORTS what adopting the worktree did about agent config', async () => {
		// Writing `.mcp.json` into an adopted worktree is caught and REPORTED rather
		// than thrown (agent wiring may never abort a root change) — which only means
		// anything if it reaches a caller. Rebuilding the result field by field used to
		// drop it, so a `skipped` write, an EACCES, and above all "written, but the
		// ignore entry could not be arranged, so this checkout is now dirty" were all
		// discarded silently, on the one surface with no other channel to say it.
		const opened = svc.useNotebook('sessAgentCfg', 'agentcfg.ipynb');
		const change = await svc.setNotebookRoot(SIBLING, opened.path);
		expect(change.agent_config).toMatchObject({ status: expect.stringMatching(/^(created|updated|already|skipped)$/) });
		await svc.setNotebookRoot('', opened.path);
	});

	it('carries NO agent_config for an internal root — the field is for adopted worktrees only', async () => {
		const opened = svc.useNotebook('sessInternalCfg', 'internalcfg.ipynb');
		const change = await svc.setNotebookRoot('roots/pr-482', opened.path);
		expect(change.root_changed).toBe(true);
		expect(change).not.toHaveProperty('agent_config');
		await svc.setNotebookRoot('', opened.path);
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
		// Out-of-workspace paths are refused by the WORKTREE gate rather than by shape.
		// This workspace IS a repo with a registered sibling, so these two prove the
		// gate is narrow: neither is one of ITS worktrees, so neither is admitted.
		await expect(svc.setNotebookRoot('../escape', opened.path)).rejects.toThrow(/not a registered git worktree/i);
		await expect(svc.setNotebookRoot('/etc', opened.path)).rejects.toThrow(/not a registered git worktree/i);
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

/**
 * The one thing adopting an EXTERNAL root writes outside the workspace, disclosed
 * on every surface an agent reads BEFORE it chooses one.
 *
 * All three of these emphasise that an external root grants no file reach — which
 * is true of the kernel and of every file API, and is load-bearing — but adoption
 * DOES write Cellar's agent config into that checkout and adds a repo-common ignore
 * entry for it. The human path states that cost twice before the click (the root
 * bar's copy and the Settings toggle); the agent path had only the post-hoc
 * `agent_config` field on the result, so an agent picking a root on the strength of
 * "this touches nothing" was being misinformed by us. Pinned as source guards
 * because these are STRINGS an agent is billed for and a reword is exactly how an
 * honesty clause quietly goes missing.
 */
describe('the agent is told what adopting an external root writes', () => {
	const src = () => readFileSync(new URL('../../src/lib/server/mcp/server.ts', import.meta.url), 'utf8');

	/** One registered tool's description literal. */
	function descriptionOf(name: string): string {
		const line = src()
			.split('\n')
			.find((l) => l.includes(`server.registerTool('${name}'`));
		expect(line, `${name} is registered on one line`).toBeTruthy();
		const m = line!.match(/description: '(.*?)', inputSchema/);
		expect(m, `${name}'s description is a single-quoted one-line literal`).toBeTruthy();
		return m![1].replace(/\\(.)/g, '$1');
	}

	it('use_notebook says it, where the root is actually chosen', () => {
		const d = descriptionOf('use_notebook');
		expect(d).toMatch(/EXTERNAL worktree root also writes Cellar's agent config/);
		// Never committed, and reversible — the two facts that make it acceptable.
		expect(d).toMatch(/git-excluded and never committed/);
		expect(d).toMatch(/Settings toggle/);
		expect(d).toMatch(/agent_config/);
	});

	it('list_roots says it too, and KEEPS the no-file-reach claim rather than replacing it', () => {
		const d = descriptionOf('list_roots');
		// The exception is added TO the invariant, not swapped for it: the invariant is
		// true and is what stops an agent expecting to read files through a root.
		expect(d).toMatch(/an external root grants no file access/);
		expect(d).toMatch(/ADOPTING one writes there is Cellar's agent config/);
		expect(d).toMatch(/never committed/);
		expect(d).toMatch(/Settings toggle turns it off/);
	});

	it('INSTRUCTIONS clause 8 says it — it frames both descriptions and lands first', () => {
		const all = src();
		const clause = all.slice(all.indexOf('A notebook may declare a CODE ROOT'), all.indexOf('9. DATABRICKS'));
		expect(clause).toBeTruthy();
		expect(clause).toMatch(/CANNOT reach inside an external worktree/);
		expect(clause).toMatch(/SETTING an external root does write there is Cellar's own\s+agent\s+config/);
		expect(clause).toMatch(/git-excluded, never committed/);
		expect(clause).toMatch(/Settings toggle turns it off/);
	});
});
