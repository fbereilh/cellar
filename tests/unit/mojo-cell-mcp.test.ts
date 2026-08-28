/**
 * The `mojo` cell type on the AGENT surface.
 *
 * An agent that cannot SEE a cell is Mojo will write Python into it, and one that
 * cannot CREATE one has to leave every Mojo cell to the human - so unlike `chat`
 * (absent from every write enum, because a billed model turn is the human's call)
 * `mojo` is fully agent-writable. What an agent must be TOLD instead is the one
 * fact that makes Mojo different from every other cell type here: each `%%mojo`
 * cell is a separate `mojo run` subprocess, so a "define here, use there" pair
 * across two Mojo cells cannot work. That is doctrine clause 12, delivered at
 * connect, before any tool schema is read.
 *
 * Driven over the REAL `registerTools` registration through an in-memory MCP
 * client - the only level that exercises the tool HANDLERS and the schemas an
 * agent is actually billed for.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

vi.mock('../../src/lib/server/dataflow', () => ({
	getNotebookStaleness: async () => ({ sid: null, cells: {} }),
	analyzeDataflow: async () => ({})
}));

let WS: string;
let nbmod: typeof import('../../src/lib/server/notebook');
let srv: typeof import('../../src/lib/server/mcp/server');

const MOJO_SOURCE = 'def main():\n    print("Hello from Mojo!")';

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-mojo-mcp-'));
	process.env.CELLAR_WORKSPACE = WS;
	nbmod = await import('../../src/lib/server/notebook');
	srv = await import('../../src/lib/server/mcp/server');
});

type CallResult = { content: { type: string; text?: string }[]; isError?: boolean };
const bodyOf = (r: CallResult) =>
	r.content
		.filter((c) => c.type === 'text')
		.map((c) => c.text ?? '')
		.join('\n');

async function connect(sessionId: string) {
	// The SHIPPED factory, so the instructions and schemas asserted below are the
	// ones an agent is really delivered at connect.
	const server = srv.createCellarMcpServer();
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	(serverTransport as { sessionId?: string }).sessionId = sessionId;
	const client = new Client({ name: 'test-agent', version: '0.0.0' });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return client;
}

describe('an agent can create a mojo cell and SEE that a cell is Mojo', () => {
	it('add_cell(cell_type:"mojo") really tags the cell, and the map reports it', async () => {
		const client = await connect('s-add');
		const nb = nbmod.createNotebook('agent.ipynb').path;
		await client.callTool({ name: 'use_notebook', arguments: { name: 'agent.ipynb' } });
		const added = (await client.callTool({ name: 'add_cell', arguments: { cell_type: 'mojo', source: MOJO_SOURCE } })) as CallResult;
		expect(added.isError).toBeFalsy();

		const cell = nbmod.listCells(nb).find((c) => (c.source ?? '').includes('Hello from Mojo'));
		expect(cell?.cell_type).toBe('code');
		expect(cell?.metadata?.cellar?.language).toBe('mojo');

		// The read surface must SAY mojo, or an agent writes Python into it.
		const map = bodyOf((await client.callTool({ name: 'get_notebook_map', arguments: {} })) as CallResult);
		expect(map).toContain('"language":"mojo"');
		const read = bodyOf((await client.callTool({ name: 'read_cells', arguments: { ids: [cell!.id] } })) as CallResult);
		expect(read).toContain('"language":"mojo"');
	});

	it('set_cell_type converts to and from mojo', async () => {
		const client = await connect('s-type');
		const nb = nbmod.createNotebook('convert.ipynb').path;
		await client.callTool({ name: 'use_notebook', arguments: { name: 'convert.ipynb' } });
		const id = nbmod.listCells(nb)[0].id;
		await client.callTool({ name: 'set_cell_type', arguments: { id, cell_type: 'mojo' } });
		expect(nbmod.listCells(nb)[0].metadata?.cellar?.language).toBe('mojo');
		await client.callTool({ name: 'set_cell_type', arguments: { id, cell_type: 'code' } });
		expect(nbmod.listCells(nb)[0].metadata?.cellar?.language).toBeUndefined();
	});

	it('add_cells accepts mojo in a batch', async () => {
		const client = await connect('s-batch');
		const nb = nbmod.createNotebook('batch.ipynb').path;
		await client.callTool({ name: 'use_notebook', arguments: { name: 'batch.ipynb' } });
		const res = (await client.callTool({
			name: 'add_cells',
			arguments: { cells: [{ cell_type: 'mojo', source: MOJO_SOURCE }, { cell_type: 'code', source: 'x = 1' }] }
		})) as CallResult;
		expect(res.isError).toBeFalsy();
		const langs = nbmod.listCells(nb).map((c) => c.metadata?.cellar?.language ?? null);
		expect(langs).toContain('mojo');
	});

	it('a plain code cell still reports NO language field, so nothing else moved', async () => {
		const client = await connect('s-plain');
		const nb = nbmod.createNotebook('plain.ipynb').path;
		await client.callTool({ name: 'use_notebook', arguments: { name: 'plain.ipynb' } });
		await client.callTool({ name: 'add_cell', arguments: { cell_type: 'code', source: 'x = 1' } });
		const map = bodyOf((await client.callTool({ name: 'get_notebook_map', arguments: {} })) as CallResult);
		expect(map).not.toContain('"language":');
		expect(nbmod.listCells(nb).every((c) => !c.metadata?.cellar?.language)).toBe(true);
	});
});

describe('the schemas and the doctrine an agent is billed for', () => {
	/** Every `cell_type` enum in the EMITTED JSON Schema an agent is handed. */
	function cellTypeEnums(schema: unknown, found: string[][] = []): string[][] {
		if (!schema || typeof schema !== 'object') return found;
		const node = schema as Record<string, unknown>;
		if (Array.isArray(node.enum) && node.enum.every((v) => typeof v === 'string')) found.push(node.enum as string[]);
		for (const v of Object.values(node)) {
			if (Array.isArray(v)) v.forEach((e) => cellTypeEnums(e, found));
			else if (v && typeof v === 'object') cellTypeEnums(v, found);
		}
		return found;
	}

	it('offers mojo in EVERY cell_type enum - three of four is a silent hole', async () => {
		const client = await connect('s-enums');
		const tools = (await client.listTools()).tools;
		// The four WRITE tools that let an agent name a cell type.
		const writers = ['add_cell', 'add_cells', 'add_and_run', 'set_cell_type'];
		const seen: string[] = [];
		for (const name of writers) {
			const tool = tools.find((t) => t.name === name);
			expect(tool, `${name} must be registered`).toBeTruthy();
			const enums = cellTypeEnums(tool!.inputSchema).filter((e) => e.includes('code') && e.includes('markdown'));
			expect(enums.length, `${name} must expose one cell_type enum`).toBe(1);
			seen.push(name);
			// The type is offered...
			expect(enums[0], `${name} must offer mojo`).toContain('mojo');
			// ...while `chat` stays withheld: a billed model turn is the human's call.
			expect(enums[0], `${name} must NOT offer chat`).not.toContain('chat');
		}
		expect(seen.length).toBe(4);
	});

	it('states the no-state-between-cells rule BEFORE any tool schema is read', async () => {
		// An agent that does not know this writes a define/use pair across two Mojo
		// cells and cannot understand why the second one fails to compile. Read off
		// the instructions the SERVER really delivered at connect, which the SDK hands
		// the client before any tool is listed.
		const client = await connect('s-doctrine');
		// The clause is hard-wrapped, so read it as the prose it is rather than as
		// the lines it happens to be laid out on.
		const instructions = (client.getInstructions() ?? '').replace(/\s+/g, ' ');
		expect(instructions).toContain('12. EVERY MOJO CELL IS A SEPARATE PROGRAM.');
		expect(instructions).toContain('NOTHING carries from one Mojo cell to the next');
		expect(instructions).toContain('complete program with its own');
		// And the two facts about what a Mojo cell is NOT.
		expect(instructions).toContain('never shows a staleness verdict');
		expect(instructions).toContain('cannot be exported to');
		// Detect-and-instruct reaches the agent too: it must relay the command.
		expect(instructions).toContain('Cellar never installs it for the user');
	});

	it('the tool descriptions name mojo, so an agent can find the type at all', async () => {
		const client = await connect('s-schemas');
		const tools = (await client.listTools()).tools;
		const byName = Object.fromEntries(tools.map((t) => [t.name, t.description ?? '']));
		for (const name of ['add_cell', 'set_cell_type', 'add_and_run']) {
			expect(byName[name], `${name} description must name mojo`).toMatch(/mojo/);
		}
	});
});
