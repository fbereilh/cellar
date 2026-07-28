/**
 * The MCP agent surface reports CHANGE, not only STATE.
 *
 * Two halves, one event tap (`mcp/userActivity.ts`):
 *
 *   (B) a failed handle that names a RECENTLY DELETED cell says so ("the user
 *       deleted it ~8s ago in the Cellar UI") instead of returning the same bare
 *       not-found string a typo gets - and an id that never existed still gets
 *       the generic one. Both directions matter, or the feature degenerates into
 *       always claiming a deletion.
 *
 *   (A) a tool result carries an optional extra text block naming what changed
 *       outside this session since its last call, and NOTHING when the user was
 *       idle or when the only changes were the agent's own.
 *
 * The tests come in two layers. The module-level ones drive the real service +
 * notebook singletons against a scratch workspace (plain non-import sources, so
 * nothing touches the kernel or the python dataflow subprocess). The wire-level
 * ones stand up the REAL `registerTools` registration over an in-memory MCP
 * transport and call tools as a client, which is the only level that proves the
 * wrapper is actually in the path for every registered tool rather than for one
 * hand-called handler.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

let WS: string;
let svc: typeof import('../../src/lib/server/mcp/service');
let nbmod: typeof import('../../src/lib/server/notebook');
let ua: typeof import('../../src/lib/server/mcp/userActivity');
let srv: typeof import('../../src/lib/server/mcp/server');

const abs = (rel: string) => nbmod.resolveNotebookPath(rel);
/** A browser tab's originId - what marks an event as a USER action. */
const TAB = 'tab-1';

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-user-activity-'));
	process.env.CELLAR_WORKSPACE = WS;
	svc = await import('../../src/lib/server/mcp/service');
	nbmod = await import('../../src/lib/server/notebook');
	ua = await import('../../src/lib/server/mcp/userActivity');
	srv = await import('../../src/lib/server/mcp/server');
});

beforeEach(() => ua.__resetUserActivity());

/** A notebook with `n` plain code cells; returns its absolute path. */
async function seed(rel: string, n = 3): Promise<string> {
	svc.useNotebook('seed-session', rel);
	const nb = abs(rel);
	for (let i = 0; i < n; i++) {
		await svc.addCells([{ cell_type: 'code', source: `x${i} = ${i}` }], null, { nb, routeImports: false });
	}
	// Seeding ran outside any agent context, so it looks like user activity; drop
	// it so each test starts from a quiet notebook.
	ua.__resetUserActivity();
	return nb;
}

const ids = (nb: string) => nbmod.listCells(nb).map((c) => c.id);
/** The digest a session would receive right now (and advance its cursor). */
const digest = (session: string, nb: string) => ua.digestFor(session, nb, ua.currentSeq(nb));

describe('(B) a deleted cell fails legibly', () => {
	it('a USER delete names what happened, who did it, and where', async () => {
		const nb = await seed('b-user.ipynb');
		const gone = ids(nb)[0];
		nbmod.deleteCells([gone], nb, TAB);

		const note = ua.deletionNote(nb, gone.slice(0, 8));
		expect(note).toBeTruthy();
		// It must state a CAUSE, not merely name a remedy - that is the whole defect.
		// Recency reads as a phrase because the sub-second case is the common one:
		// the agent's very next call after the user's click, where "0s ago" would
		// read as a defect in the message itself.
		expect(note).toContain('the user deleted it just now in the Cellar UI');
		// And say the tool is fine, since "flaky tool" is the reading being retired.
		expect(note).toContain('the tool is working');
		expect(note).toContain('get_notebook_map');
	});

	it('an id that NEVER existed still gets nothing (the distinction is the point)', async () => {
		const nb = await seed('b-unknown.ipynb');
		nbmod.deleteCells([ids(nb)[0]], nb, TAB);
		expect(ua.deletionNote(nb, 'ffffffff')).toBeNull();
	});

	it('the full UUID resolves the tombstone too, not just the 8-char handle', async () => {
		const nb = await seed('b-full.ipynb');
		const gone = ids(nb)[0];
		nbmod.deleteCells([gone], nb, TAB);
		expect(ua.deletionNote(nb, gone)).toContain('the user deleted it');
	});

	it('an AGENT delete is attributed to an agent, never to the user', async () => {
		const nb = await seed('b-agent.ipynb');
		const gone = ids(nb)[0];
		// An MCP mutation carries no browser originId, and runs tagged with its session.
		ua.runAsAgent('sess-A', () => nbmod.deleteCells([gone], nb));
		const note = ua.deletionNote(nb, gone.slice(0, 8));
		expect(note).toContain('an agent deleted it');
		expect(note).not.toContain('the user');
	});

	it('a hidden_from_agent cell leaves NO tombstone (its deletion is not disclosed)', async () => {
		const nb = await seed('b-hidden.ipynb');
		const [hidden, visible] = ids(nb);
		nbmod.setVisibility(hidden, true, nb);
		nbmod.deleteCells([hidden, visible], nb, TAB);

		expect(ua.deletionNote(nb, hidden.slice(0, 8))).toBeNull();
		// The visible cell deleted in the SAME batch is still legible, so the filter
		// is per cell rather than "a batch containing a hidden cell says nothing".
		expect(ua.deletionNote(nb, visible.slice(0, 8))).toContain('the user deleted it');
	});

	it('a tombstone expires, and an old deletion falls back to the generic message', async () => {
		const nb = await seed('b-ttl.ipynb');
		const gone = ids(nb)[0];
		nbmod.deleteCells([gone], nb, TAB);
		expect(ua.deletionNote(nb, gone.slice(0, 8))).toBeTruthy();

		// After the TTL, "no cell matches this id" really is the whole truth.
		const realNow = Date.now;
		Date.now = () => realNow() + ua.TOMBSTONE_TTL_MS + 1000;
		try {
			expect(ua.deletionNote(nb, gone.slice(0, 8))).toBeNull();
		} finally {
			Date.now = realNow;
		}
	});
});

describe('(A) the user-activity digest', () => {
	it('says nothing on the FIRST call (there is no "last call" to be since)', async () => {
		const nb = await seed('a-first.ipynb');
		nbmod.setSource(ids(nb)[0], 'x0 = 999', nb, TAB); // happened before this session ever called
		expect(digest('sess-first', nb)).toBeNull();
	});

	it('names a user edit, add and move - once, then goes quiet', async () => {
		const nb = await seed('a-changes.ipynb');
		expect(digest('sess-1', nb)).toBeNull(); // seed the cursor

		const [first, , third] = ids(nb);
		nbmod.setSource(first, 'x0 = 999', nb, TAB);
		nbmod.addCell(first, 'code', nb, TAB, 'brand_new = 1');
		nbmod.moveCellTo(third, 0, nb, TAB);

		const note = digest('sess-1', nb)!;
		expect(note).toContain(ua.DIGEST_PREFIX);
		expect(note).toContain('since your last call the user');
		expect(note).toContain('edited cell');
		expect(note).toContain('added cell');
		expect(note).toContain('moved cell');
		expect(note).toContain(first.slice(0, 8));
		expect(note).toContain(third.slice(0, 8));

		// Reported once: the cursor advanced past them.
		expect(digest('sess-1', nb)).toBeNull();
	});

	it('reports a user DELETE by the handle the agent was holding', async () => {
		const nb = await seed('a-delete.ipynb');
		expect(digest('sess-2', nb)).toBeNull();
		const gone = ids(nb)[0];
		nbmod.deleteCells([gone], nb, TAB);
		expect(digest('sess-2', nb)).toContain(`deleted cell ${gone.slice(0, 8)}`);
	});

	it('says NOTHING when nothing changed', async () => {
		const nb = await seed('a-quiet.ipynb');
		expect(digest('sess-3', nb)).toBeNull();
		expect(digest('sess-3', nb)).toBeNull();
		expect(digest('sess-3', nb)).toBeNull();
	});

	it("NEVER reports the agent's OWN actions back to it", async () => {
		const nb = await seed('a-own.ipynb');
		expect(digest('sess-A', nb)).toBeNull();

		// Several agent writes, exactly as a tool handler runs them.
		await ua.runAsAgent('sess-A', async () => {
			const cur = ids(nb);
			await svc.editCell(cur[0], 'agent_edit = 1', { nb, routeImports: false });
			await svc.addCells([{ cell_type: 'code', source: 'agent_added = 2' }], null, { nb, routeImports: false });
			svc.removeCells([cur[2]], nb);
		});

		expect(digest('sess-A', nb)).toBeNull();
	});

	it("reports ONLY the user's half of a mixed agent + user burst", async () => {
		const nb = await seed('a-mixed.ipynb');
		expect(digest('sess-A', nb)).toBeNull();

		const [agentCell, userCell] = ids(nb);
		await ua.runAsAgent('sess-A', () => svc.editCell(agentCell, 'agent_touched = 1', { nb, routeImports: false }));
		nbmod.setSource(userCell, 'user_touched = 1', nb, TAB);

		const note = digest('sess-A', nb)!;
		expect(note).toContain(userCell.slice(0, 8));
		expect(note).not.toContain(agentCell.slice(0, 8));
		expect(note).toContain('the user');
	});

	it("one agent's edits ARE visible to a DIFFERENT agent's session", async () => {
		const nb = await seed('a-two-agents.ipynb');
		expect(digest('sess-A', nb)).toBeNull();
		expect(digest('sess-B', nb)).toBeNull();

		const target = ids(nb)[0];
		await ua.runAsAgent('sess-A', () => svc.editCell(target, 'a_wrote_this = 1', { nb, routeImports: false }));

		expect(digest('sess-A', nb)).toBeNull(); // its own action
		const seen = digest('sess-B', nb)!;
		expect(seen).toContain(target.slice(0, 8));
		expect(seen).toContain('another agent');
	});

	it('never discloses a hidden_from_agent cell', async () => {
		const nb = await seed('a-hidden.ipynb');
		const [hidden, visible] = ids(nb);
		nbmod.setVisibility(hidden, true, nb);
		expect(digest('sess-4', nb)).toBeNull();

		nbmod.setSource(hidden, 'secret = 1', nb, TAB);
		expect(digest('sess-4', nb)).toBeNull(); // the ONLY change was hidden: no block at all

		nbmod.setSource(hidden, 'secret = 2', nb, TAB);
		nbmod.setSource(visible, 'shown = 1', nb, TAB);
		const note = digest('sess-4', nb)!;
		expect(note).toContain(visible.slice(0, 8));
		expect(note).not.toContain(hidden.slice(0, 8));
	});

	it('collapses a burst into a count rather than listing every id', async () => {
		const nb = await seed('a-burst.ipynb', 30);
		expect(digest('sess-5', nb)).toBeNull();
		const all = ids(nb);
		expect(all.length).toBeGreaterThan(10);
		for (const id of all) nbmod.setSource(id, `v = "${id}"`, nb, TAB);

		const note = digest('sess-5', nb)!;
		expect(note).toContain(`edited ${all.length} cells`);
		expect(note).toContain(`+${all.length - 4} more`);
		// Terse: a 30-cell burst must not become a 30-handle sentence.
		expect(note.length).toBeLessThan(300);
	});

	it('collapses repeated edits of ONE cell (a debounced typing burst) to one mention', async () => {
		const nb = await seed('a-debounce.ipynb');
		expect(digest('sess-6', nb)).toBeNull();
		const id = ids(nb)[0];
		for (let i = 0; i < 12; i++) nbmod.setSource(id, `typing = ${i}`, nb, TAB);

		const note = digest('sess-6', nb)!;
		expect(note).toContain(`edited cell ${id.slice(0, 8)}`);
		expect(note.split(id.slice(0, 8)).length - 1).toBe(1);
	});

	it('reports a checkpoint RESTORE as a wholesale revert, not as a list of cells', async () => {
		const nb = await seed('a-restore.ipynb');
		expect(digest('sess-7', nb)).toBeNull();
		nbmod.replaceCells(nb, [{ id: ids(nb)[0], cell_type: 'code', source: 'reverted = 1' }], TAB);

		const note = digest('sess-7', nb)!;
		expect(note).toContain('restored a checkpoint');
		expect(note).toContain('get_notebook_map');
	});

	it('scopes a digest to the notebook a call targets', async () => {
		const one = await seed('a-scope-1.ipynb');
		const two = await seed('a-scope-2.ipynb');
		expect(digest('sess-8', one)).toBeNull();
		expect(digest('sess-8', two)).toBeNull();

		nbmod.setSource(ids(two)[0], 'other_notebook = 1', two, TAB);
		expect(digest('sess-8', one)).toBeNull();
		expect(digest('sess-8', two)).toBeTruthy();
	});

	it('advances past FILTERED-OUT changes so they cannot resurface later', async () => {
		const nb = await seed('a-filtered.ipynb');
		expect(digest('sess-9', nb)).toBeNull();

		// An output clear is deliberately not reportable (v1).
		nbmod.clearOutputs(ids(nb)[0], nb, TAB);
		expect(digest('sess-9', nb)).toBeNull();

		// A later real change reports ONLY itself, never the skipped one alongside it.
		const target = ids(nb)[1];
		nbmod.setSource(target, 'now_real = 1', nb, TAB);
		const note = digest('sess-9', nb)!;
		expect(note).toContain(target.slice(0, 8));
		expect(note).not.toContain(ids(nb)[0].slice(0, 8));
	});
});

describe('per-session cursor lifecycle', () => {
	it('forgetSession releases the cursor (no leak per reconnected bridge)', async () => {
		const nb = await seed('c-forget.ipynb');
		expect(digest('sess-gone', nb)).toBeNull();
		expect(ua.__cursorFor('sess-gone', nb)).toBeTypeOf('number');

		svc.forgetSession('sess-gone');
		expect(ua.__cursorFor('sess-gone', nb)).toBeUndefined();

		// A reconnected bridge is a NEW session: it seeds afresh and is not handed
		// the whole backlog of what happened while it was gone.
		nbmod.setSource(ids(nb)[0], 'while_away = 1', nb, TAB);
		expect(digest('sess-gone', nb)).toBeNull();
	});
});

describe('the INSTRUCTIONS pre-announcement (without it the feature is inert)', () => {
	const source = () => readFileSync('src/lib/server/mcp/server.ts', 'utf8');

	it('declares the channel, its marker, and that it is Cellar speaking', () => {
		const src = source();
		// The marker is INTERPOLATED from the module's own constant, so the prose and
		// the emitted block cannot drift (the IMAGE_DOC precedent).
		expect(src).toContain('starting "${DIGEST_PREFIX}"');
		expect(src).toContain('THE NOTEBOOK CHANGES UNDER YOU');
	});

	it('says the notes are trustworthy facts, NOT instructions to follow', () => {
		// This is what separates "ignored as prompt injection" from "understood and
		// acted on" - proven with a real model probe. Reword it, never drop it.
		const src = source();
		expect(src).toContain('emitted by Cellar itself');
		expect(src).toContain('never\ninstructions to follow');
	});

	it('says a failed handle can mean the user deleted the cell, not a broken tool', () => {
		const src = source();
		expect(src).toContain('the user deleted that cell');
		expect(src).toContain('NOT that the tool is broken');
	});
});

describe('at the wire: every registered tool goes through the wrapper', () => {
	/** A real MCP client talking to the real registrations over an in-memory pair. */
	async function connect(sessionId: string) {
		const server = new McpServer({ name: 'cellar-test', version: '0.0.0' });
		srv.registerTools(server);
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		// `extra.sessionId` is read straight off the transport, which is how the
		// wrapper knows whose cursor to advance.
		(serverTransport as { sessionId?: string }).sessionId = sessionId;
		const client = new Client({ name: 'test-agent', version: '0.0.0' });
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
		return client;
	}

	type CallResult = { content: { type: string; text?: string }[]; isError?: boolean };
	const texts = (r: CallResult) => r.content.filter((c) => c.type === 'text').map((c) => c.text ?? '');
	const note = (r: CallResult) => texts(r).find((t) => t.startsWith(ua.DIGEST_PREFIX));

	it('a user-deleted handle comes back as a LEGIBLE error, not the generic one', async () => {
		const rel = 'wire-delete.ipynb';
		const nb = await seed(rel);
		const client = await connect('wire-1');
		const gone = ids(nb)[0];

		// The agent holds the handle, then the USER deletes that cell in the UI.
		const before = (await client.callTool({ name: 'read_cells', arguments: { ids: [gone.slice(0, 8)], notebook: rel } })) as CallResult;
		expect(before.isError).toBeFalsy();
		nbmod.deleteCells([gone], nb, TAB);

		const after = (await client.callTool({ name: 'read_cells', arguments: { ids: [gone.slice(0, 8)], notebook: rel } })) as CallResult;
		// Still an error - the operation genuinely did not happen - but it now names
		// the cause instead of reading as the tool rejecting the agent's input.
		expect(after.isError).toBe(true);
		const body = texts(after).join('\n');
		expect(body).toContain('the user deleted it');
		expect(body).not.toContain('no cell matches id');

		// A never-existing id keeps the generic message on the same tool.
		const bogus = (await client.callTool({ name: 'read_cells', arguments: { ids: ['ffffffff'], notebook: rel } })) as CallResult;
		expect(bogus.isError).toBe(true);
		expect(texts(bogus).join('\n')).toContain('no cell matches id');
	});

	it('appends the digest as an EXTRA block, leaving the tool payload untouched', async () => {
		const rel = 'wire-digest.ipynb';
		const nb = await seed(rel);
		const client = await connect('wire-2');

		const first = (await client.callTool({ name: 'get_notebook_map', arguments: { notebook: rel } })) as CallResult;
		expect(note(first)).toBeUndefined(); // nothing to say yet

		const target = ids(nb)[0];
		nbmod.setSource(target, 'user_typed = 1', nb, TAB);

		const second = (await client.callTool({ name: 'get_notebook_map', arguments: { notebook: rel } })) as CallResult;
		const digestBlock = note(second)!;
		expect(digestBlock).toContain('the user');
		expect(digestBlock).toContain(target.slice(0, 8));
		// Additive: the ordinary JSON payload is still there and still parses.
		const payload = texts(second).find((t) => !t.startsWith(ua.DIGEST_PREFIX))!;
		expect(() => JSON.parse(payload)).not.toThrow();
		expect(JSON.parse(payload)).toHaveProperty('kernel');

		// And it is reported once.
		const third = (await client.callTool({ name: 'get_notebook_map', arguments: { notebook: rel } })) as CallResult;
		expect(note(third)).toBeUndefined();
	});

	it("a WRITE tool's own effect never comes back in its own next result", async () => {
		const rel = 'wire-own.ipynb';
		const nb = await seed(rel);
		const client = await connect('wire-3');
		await client.callTool({ name: 'get_notebook_map', arguments: { notebook: rel } }); // seed the cursor

		await client.callTool({ name: 'add_cell', arguments: { source: 'agent_wrote = 1', route_imports: false, notebook: rel } });
		const after = (await client.callTool({ name: 'get_notebook_map', arguments: { notebook: rel } })) as CallResult;
		expect(note(after)).toBeUndefined();

		// But a user change immediately after IS reported, so silence above was the
		// origin filter doing its job rather than the channel being dead.
		nbmod.setSource(ids(nb)[0], 'user_after = 1', nb, TAB);
		const next = (await client.callTool({ name: 'get_notebook_map', arguments: { notebook: rel } })) as CallResult;
		expect(note(next)).toBeTruthy();
	});

	it('rides an ERROR result too (the moment the agent most needs it)', async () => {
		const rel = 'wire-error.ipynb';
		const nb = await seed(rel);
		const client = await connect('wire-4');
		await client.callTool({ name: 'read_cells', arguments: { ids: [ids(nb)[1].slice(0, 8)], notebook: rel } });

		const gone = ids(nb)[0];
		nbmod.deleteCells([gone], nb, TAB);
		const r = (await client.callTool({ name: 'read_cells', arguments: { ids: [gone.slice(0, 8)], notebook: rel } })) as CallResult;
		expect(r.isError).toBe(true);
		expect(texts(r).join('\n')).toContain('the user deleted it');
		expect(note(r)).toContain('deleted cell');
	});
});
