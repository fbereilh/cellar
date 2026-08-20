/**
 * What the agent surface CALLS a chat cell's state.
 *
 * The kernel `run_status` vocabulary answers one question - "does what this cell
 * defined still exist in the kernel?" - and a chat run touches no kernel and
 * stamps no session epoch, so every word of it is a false answer for a reply.
 * Concretely: a just-answered chat cell used to report `ok_persisted`, which
 * INSTRUCTIONS clause 3 defines as a leftover from a previous session and tells
 * agents to distrust and RE-RUN. Re-running a chat cell is a billed,
 * nondeterministic model turn that overwrites the reply the user is reading, so
 * the label itself is what has to change.
 *
 * Driven through the REAL read tools (which all funnel through the one
 * `runStatus` seam) against a real document, with the chat engine scripted so a
 * reply can be produced without a CLI and a kernel cell's status is unaffected.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ChatEngineResult } from '../../src/lib/server/chat/engine';

let WS: string;
let svc: typeof import('../../src/lib/server/mcp/service');
let nbmod: typeof import('../../src/lib/server/notebook');
let runmod: typeof import('../../src/lib/server/run');
let enginemod: typeof import('../../src/lib/server/chat/engine');
let authmod: typeof import('../../src/lib/server/chat/auth');

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-chat-status-'));
	process.env.CELLAR_WORKSPACE = WS;
	process.env.CELLAR_USER_SETTINGS = join(WS, 'user-settings.json');
	svc = await import('../../src/lib/server/mcp/service');
	nbmod = await import('../../src/lib/server/notebook');
	runmod = await import('../../src/lib/server/run');
	enginemod = await import('../../src/lib/server/chat/engine');
	authmod = await import('../../src/lib/server/chat/auth');
	authmod.__setChatAuthForTests({ kind: 'slot', slot: 'test', account: { loggedIn: true } });
});

afterEach(() => {
	enginemod.__setChatEngineForTests(null);
});

/** Script the engine to answer, or to fail with the given kind. */
function scriptEngine(failure: { kind: string; message: string } | null = null): void {
	enginemod.__setChatEngineForTests({
		async run(): Promise<ChatEngineResult> {
			if (failure) return { ok: false, failure: failure as never, engine: 'scripted', replyText: null };
			return { ok: true, failure: null, engine: 'scripted', replyText: 'It is **1**.' };
		}
	});
}

/** A notebook with one markdown cell, one python cell and one chat cell. */
function makeNotebook(name: string): string {
	const nb = join(WS, name);
	writeFileSync(
		nb,
		JSON.stringify({
			cells: [
				{ cell_type: 'markdown', source: ['# Report'], metadata: {}, id: 'mdcell' },
				{ cell_type: 'code', source: ['x = 1'], metadata: {}, outputs: [], execution_count: null, id: 'pycell' },
				{
					cell_type: 'code',
					source: ['What is x?'],
					metadata: { cellar: { language: 'chat' } },
					outputs: [],
					execution_count: null,
					id: 'chatcell'
				}
			],
			metadata: {},
			nbformat: 4,
			nbformat_minor: 5
		})
	);
	nbmod.listCells(nb);
	return nb;
}

/** The run_status every read tool reports for one cell, via the real tools. */
async function statuses(nb: string, cellId: string): Promise<string[]> {
	const map = await svc.getNotebookMap(nb);
	const read = (await svc.readCells([cellId], nb)) as Array<Record<string, unknown>>;
	const fromMap = flatten(map).find((c) => typeof c.id === 'string' && cellId.startsWith(c.id as string));
	return [String(fromMap?.run_status), String(read[0]?.run_status)];
}

/** get_notebook_map nests cells under sections; collect every leaf. */
function flatten(node: unknown): Array<Record<string, unknown>> {
	if (Array.isArray(node)) return node.flatMap(flatten);
	if (!node || typeof node !== 'object') return [];
	const o = node as Record<string, unknown>;
	const here = typeof o.run_status === 'string' ? [o] : [];
	return [...here, ...Object.values(o).flatMap(flatten)];
}

describe('a chat cell never answers in the kernel vocabulary', () => {
	it('a just-answered reply is ok_chat_reply, never ok_persisted', async () => {
		scriptEngine();
		const nb = makeNotebook('answered.ipynb');
		const res = await runmod.executeCellRun({ nb, cellId: 'chatcell', actor: 'user', source: 'What is x?' });
		expect(res.status).toBe('ok');

		const reported = await statuses(nb, 'chatcell');
		expect(reported).toEqual(['ok_chat_reply', 'ok_chat_reply']);
		// The label that used to come out here is the one the doctrine tells an
		// agent to distrust and re-run - a billed turn over the user's reply.
		expect(reported).not.toContain('ok_persisted');
		// And the kernel question is still answered honestly: nothing ran in a
		// session, which `search_cells` reports per row.
		const hits = svc.searchCells('What is x?', 'input', nb) as Array<{ id: string; ran_this_session: boolean }>;
		expect(hits.length).toBeGreaterThan(0);
		expect(hits.some((r) => r.ran_this_session)).toBe(false);
	});

	it('a failed chat run is error_chat_reply, not a success', async () => {
		scriptEngine({ kind: 'rate_limited', message: 'limit reached' });
		const nb = makeNotebook('failed.ipynb');
		const res = await runmod.executeCellRun({ nb, cellId: 'chatcell', actor: 'user', source: 'q' });
		expect(res.status).toBe('error');
		// A chat failure is a friendly display_data, not an nbformat error output, so
		// the old vocabulary called it ok_persisted - a failure reported as success.
		expect(res.outputs[0].output_type).toBe('display_data');
		expect(await statuses(nb, 'chatcell')).toEqual(['error_chat_reply', 'error_chat_reply']);
	});

	it('a reply RELOADED from disk is chat_reply_persisted (the run stamp is runtime-only)', async () => {
		scriptEngine();
		const nb = makeNotebook('reloaded.ipynb');
		await runmod.executeCellRun({ nb, cellId: 'chatcell', actor: 'user', source: 'What is x?' });
		// The stamp is stripped on save, so re-reading the document from disk is
		// exactly the state a new server process (or a reload) sees.
		const onDisk = JSON.parse(readFileSync(nb, 'utf8')) as {
			cells: Array<{ id: string; metadata?: { cellar?: Record<string, unknown> } }>;
		};
		expect(onDisk.cells.find((c) => c.id === 'chatcell')?.metadata?.cellar?.lastRun).toBeUndefined();

		nbmod.dropDocs(nb);
		const reported = await statuses(nb, 'chatcell');
		expect(reported).toEqual(['chat_reply_persisted', 'chat_reply_persisted']);
		expect(reported).not.toContain('ok_persisted');
	});

	it('a chat cell that has never answered is unrun', async () => {
		const nb = makeNotebook('never.ipynb');
		expect(await statuses(nb, 'chatcell')).toEqual(['unrun', 'unrun']);
	});
});

describe('the kernel vocabulary is untouched', () => {
	it('a python cell with saved outputs and no live session still reports ok_persisted', async () => {
		const nb = makeNotebook('kernelcell.ipynb');
		nbmod.setOutputs('pycell', [{ output_type: 'stream', name: 'stdout', text: '1\n' }], nb);
		expect(await statuses(nb, 'pycell')).toEqual(['ok_persisted', 'ok_persisted']);
	});

	it('a python cell with a saved error reports error_persisted, and markdown reports n/a', async () => {
		const nb = makeNotebook('kernelerr.ipynb');
		nbmod.setOutputs('pycell', [{ output_type: 'error', ename: 'ValueError', evalue: 'boom', traceback: ['tb'] }], nb);
		expect(await statuses(nb, 'pycell')).toEqual(['error_persisted', 'error_persisted']);
		// A markdown cell is a SECTION in the map rather than a leaf, so read_cells
		// is where its status shows.
		const md = (await svc.readCells(['mdcell'], nb)) as Array<Record<string, unknown>>;
		expect(md[0].run_status).toBe('n/a');
	});

	it('a python cell with no outputs is unrun (the shared word both vocabularies keep)', async () => {
		const nb = makeNotebook('kernelunrun.ipynb');
		expect(await statuses(nb, 'pycell')).toEqual(['unrun', 'unrun']);
	});
});

/**
 * The doctrine an agent is BILLED for and acts on, read off the interface it is
 * actually delivered through (the `cellar_notebook_style` prompt carries the
 * same INSTRUCTIONS string the server hands over at connect) rather than off the
 * module's source. Without the chat exception, clause 3's standing instruction -
 * "saved output NEVER means it ran; RE-RUN the upstream cells" - reads as an
 * instruction to re-run chat cells, which is the billed turn this whole rule
 * exists to prevent.
 */
describe('the delivered doctrine carries the chat exception', () => {
	async function instructions(): Promise<string> {
		const srv = await import('../../src/lib/server/mcp/server');
		const server = new McpServer({ name: 'cellar-test', version: '0.0.0' });
		srv.registerTools(server);
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: 'test-agent', version: '0.0.0' });
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
		const prompt = (await client.getPrompt({ name: 'cellar_notebook_style' })) as {
			messages: Array<{ content: { type: string; text?: string } }>;
		};
		return prompt.messages.map((m) => m.content.text ?? '').join('\n');
	}

	it('tells the agent never to re-run a chat cell to refresh state, and why', async () => {
		const doc = await instructions();
		expect(doc).toMatch(/CHAT CELLS ARE THE EXCEPTION/);
		expect(doc).toMatch(/never re-run a chat cell/i);
		// The two facts that make the rule stick rather than read as a style note.
		expect(doc).toMatch(/billed/i);
		expect(doc).toMatch(/nondeterministic/i);
	});

	it('names the chat vocabulary the read tools actually emit, so the two cannot drift', async () => {
		const doc = await instructions();
		for (const label of ['ok_chat_reply', 'error_chat_reply', 'chat_reply_persisted']) {
			expect(doc).toContain(label);
		}
	});
});
