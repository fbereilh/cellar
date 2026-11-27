/**
 * `edit_cell` on the imports cell itself never routes, over the real MCP
 * registration.
 *
 * The defect: a notebook whose first cell holds only imports but carries no
 * imports role yet. Routing adopted that very cell as the imports cell, merged the
 * edit's import lines into it, found them all present, and stripped them from the
 * edit - so the cell lost its own imports and the agent got back "already present
 * in the imports cell; removed from your code". The tool description promises
 * that editing the imports cell never routes, and that includes the cell routing
 * would adopt.
 *
 * Every import here is already in the target cell, so routing (where it does
 * happen) adds nothing and never runs the kernel.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

let WS: string;
let nbmod: typeof import('../../src/lib/server/notebook');
let srv: typeof import('../../src/lib/server/mcp/server');

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-edit-imports-cell-'));
	process.env.CELLAR_WORKSPACE = WS;
	nbmod = await import('../../src/lib/server/notebook');
	srv = await import('../../src/lib/server/mcp/server');
});

const IMPORTS = 'import os\nimport sys';
const ROLE = { cellar: { role: 'imports' } };

/** Write a notebook straight to disk, so the first cell's role is exactly as given. */
function writeNotebook(name: string, cells: { source: string; metadata?: object }[]): string {
	const nb = {
		nbformat: 4,
		nbformat_minor: 5,
		metadata: {},
		cells: cells.map((c, i) => ({
			id: `${'abcdef'[i]}0000000-0000-4000-8000-00000000000${i}`,
			cell_type: 'code',
			source: c.source,
			metadata: c.metadata ?? {},
			outputs: [],
			execution_count: null
		}))
	};
	writeFileSync(join(WS, name), JSON.stringify(nb));
	return nbmod.resolveNotebookPath(name);
}

type CallResult = { content: { type: string; text?: string }[]; isError?: boolean };

/** A real MCP client talking to the real registrations over an in-memory pair. */
async function connect(sessionId: string) {
	const server = new McpServer({ name: 'cellar-test', version: '0.0.0' });
	srv.registerTools(server);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	(serverTransport as { sessionId?: string }).sessionId = sessionId;
	const client = new Client({ name: 'test-agent', version: '0.0.0' });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return client;
}

async function editCell(name: string, id: string, source: string) {
	const client = await connect(`sess-${name}`);
	const r = (await client.callTool({
		name: 'edit_cell',
		arguments: { id: id.slice(0, 8), source, notebook: name }
	})) as CallResult;
	expect(r.isError).toBeFalsy();
	return JSON.parse(r.content.find((c) => c.type === 'text')?.text ?? '{}');
}

const sources = (nb: string) => nbmod.listCells(nb).map((c) => c.source);

describe('edit_cell on the imports cell keeps its import lines', () => {
	it('an imports-only first cell with no role yet: the edit lands verbatim', async () => {
		const name = 'adoptable.ipynb';
		const nb = writeNotebook(name, [{ source: IMPORTS }, { source: 'x = 1' }]);
		const first = nbmod.listCells(nb)[0];

		const r = await editCell(name, first.id, `${IMPORTS}\n# kept`);

		expect(r.imports).toBeUndefined();
		expect(sources(nb)).toEqual([`${IMPORTS}\n# kept`, 'x = 1']);
		// The edit did not adopt the cell behind the agent's back.
		expect(nbmod.getImportsCell(nb)).toBeNull();
	});

	it('an imports-only first cell edited to hold code too: nothing is lost', async () => {
		const name = 'adoptable-mixed.ipynb';
		const nb = writeNotebook(name, [{ source: IMPORTS }, { source: 'x = 1' }]);
		const first = nbmod.listCells(nb)[0];

		const r = await editCell(name, first.id, `${IMPORTS}\ny = 2`);

		expect(r.imports).toBeUndefined();
		expect(sources(nb)).toEqual([`${IMPORTS}\ny = 2`, 'x = 1']);
	});

	it('the designated imports cell, wherever it sits: the edit lands verbatim', async () => {
		const name = 'designated.ipynb';
		const nb = writeNotebook(name, [{ source: 'x = 1' }, { source: IMPORTS, metadata: ROLE }]);
		const imports = nbmod.listCells(nb)[1];

		const r = await editCell(name, imports.id, `${IMPORTS}\n# kept`);

		expect(r.imports).toBeUndefined();
		expect(sources(nb)).toEqual(['x = 1', `${IMPORTS}\n# kept`]);
	});

	it('control: editing another cell still routes its duplicate import away', async () => {
		const name = 'other-cell.ipynb';
		const nb = writeNotebook(name, [{ source: IMPORTS }, { source: 'x = 1' }]);
		const second = nbmod.listCells(nb)[1];

		const r = await editCell(name, second.id, 'import os\nx = 2');

		expect(r.imports?.note).toBe('already present in the imports cell; removed from your code');
		expect(sources(nb)).toEqual([IMPORTS, 'x = 2']);
	});
});
