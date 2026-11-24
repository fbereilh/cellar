/**
 * The two non-browser surfaces of a Rust notebook's main cell mark: the
 * `PATCH /api/cells/[id] {exportMain}` route the row toggle drives, and the MCP
 * `set_export_main_cell` tool plus the `export_main` leaf `get_notebook_map`
 * reports. Both reach the real `setCellExportMain` over a scratch workspace.
 *
 * The rules themselves (one main per notebook, the refusals, the module text) are
 * pinned in `rust-notebook-document.test.ts`; here the question is only whether
 * each surface reports the setter's answer honestly.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
let nbmod: typeof import('../../src/lib/server/notebook');
let srv: typeof import('../../src/lib/server/mcp/server');

function makeNotebook(name: string, sources: string[], cellar?: Record<string, unknown>): string {
	const nb = join(WS, name);
	writeFileSync(
		nb,
		JSON.stringify({
			cells: sources.map((source, i) => ({
				cell_type: 'code',
				source: [source],
				metadata: {},
				outputs: [],
				execution_count: null,
				id: `cell${i}-aaaaaaaa`
			})),
			metadata: cellar ? { cellar } : {},
			nbformat: 4,
			nbformat_minor: 5
		})
	);
	return nb;
}

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-rust-main-surface-'));
	process.env.CELLAR_WORKSPACE = WS;
	nbmod = await import('../../src/lib/server/notebook');
	srv = await import('../../src/lib/server/mcp/server');
});

afterAll(() => rmSync(WS, { recursive: true, force: true }));

async function patch(id: string, body: Record<string, unknown>): Promise<Response> {
	const { PATCH } = await import('../../src/routes/api/cells/[id]/+server.js');
	return (await (PATCH as unknown as (e: unknown) => Promise<Response>)({
		params: { id },
		request: new Request('http://x/api/cells/' + id, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		})
	})) as Response;
}

describe('PATCH /api/cells/[id] {exportMain}', () => {
	it('marks the main cell and answers ok', async () => {
		const nb = makeNotebook('route-ok.ipynb', ['let a = 1;'], { language: 'rust' });
		const res = await patch('cell0-aaaaaaaa', { exportMain: true, nb });
		expect(res.status).toBe(200);
		expect(nbmod.getCell('cell0-aaaaaaaa', nb)?.metadata?.cellar).toEqual({ export: true, export_main: true });
	});

	it('answers 404 for a cell the notebook does not have', async () => {
		const nb = makeNotebook('route-missing.ipynb', ['let a = 1;'], { language: 'rust' });
		const res = await patch('nope', { exportMain: true, nb });
		expect(res.status).toBe(404);
		expect(await res.json()).toMatchObject({ ok: false, reason: 'no-such-cell' });
	});

	it('answers 409 with a reason on a Python notebook, and stores nothing', async () => {
		const nb = makeNotebook('route-python.ipynb', ['x = 1']);
		const res = await patch('cell0-aaaaaaaa', { exportMain: true, nb });
		expect(res.status).toBe(409);
		const body = await res.json();
		expect(body).toMatchObject({ ok: false, reason: 'not-rust' });
		expect(typeof body.message).toBe('string');
		expect(nbmod.getCell('cell0-aaaaaaaa', nb)?.metadata?.cellar).toBeUndefined();
	});
});

describe('MCP set_export_main_cell', () => {
	async function connect() {
		const server = new McpServer({ name: 'cellar-test', version: '0.0.0' });
		srv.registerTools(server);
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		(serverTransport as { sessionId?: string }).sessionId = 'wire-export-main';
		const client = new Client({ name: 'test-agent', version: '0.0.0' });
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
		return client;
	}
	type CallResult = { content: { type: string; text?: string }[]; isError?: boolean };
	const body = (r: CallResult) => r.content.find((c) => c.type === 'text')?.text ?? '';

	it('marks by short handle, writes fn main(), and the map reports the mark', async () => {
		const rel = 'wire-main.ipynb';
		makeNotebook(rel, ['fn add(a: i32, b: i32) -> i32 { a + b }', 'let x = add(1, 2);\nprintln!("{x}");'], {
			language: 'rust',
			export_target: 'wire.rs'
		});
		const client = await connect();
		const ok = (await client.callTool({
			name: 'set_export_main_cell',
			arguments: { id: 'cell1-aa', main: true, notebook: rel }
		})) as CallResult;
		expect(ok.isError).toBeFalsy();
		expect(JSON.parse(body(ok))).toMatchObject({ ok: true, main: true, export_target: 'wire.rs' });

		// The main cell alone writes a module: the definitions cell is not marked yet,
		// so `add` is missing, but fn main() already holds the statements.
		expect(readFileSync(join(WS, 'wire.rs'), 'utf8')).toMatch(/fn main\(\) \{\n\s+let x = add\(1, 2\);/);

		const map = (await client.callTool({ name: 'get_notebook_map', arguments: { notebook: rel } })) as CallResult;
		const leaves = body(map).replace(/\s+/g, '');
		expect(leaves).toContain('"export_main":true');
		expect(leaves.match(/"export_main":true/g)).toHaveLength(1);
	});

	it('refuses a Python notebook with the setter\'s reason', async () => {
		const rel = 'wire-python.ipynb';
		makeNotebook(rel, ['x = 1']);
		const client = await connect();
		const bad = (await client.callTool({
			name: 'set_export_main_cell',
			arguments: { id: 'cell0-aa', main: true, notebook: rel }
		})) as CallResult;
		expect(bad.isError).toBe(true);
		expect(body(bad)).toMatch(/Rust/);
	});
});
