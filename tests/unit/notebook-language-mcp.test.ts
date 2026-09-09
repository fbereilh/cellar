/**
 * The MOJO NOTEBOOK LANGUAGE on the AGENT surface.
 *
 * An agent that cannot SEE that a notebook is Mojo will write Python into it, and
 * one that cannot SET the language has to leave every Mojo notebook to the human -
 * so `set_notebook_language` is fully agent-writable, and `get_notebook_map`
 * reports the language it is about to write in.
 *
 * There is deliberately NO `mojo` cell TYPE for it to reach for: the language is
 * the notebook's, so a per-cell type would be a second way to set it and would let
 * an agent build the mixed-language notebook the model rules out. What an agent
 * must be TOLD instead is the one fact that makes Mojo different: each cell is a
 * separate `mojo run` subprocess, so a "define here, use there" pair across two
 * cells cannot work. That is doctrine clause 12, delivered at connect, before any
 * tool schema is read.
 *
 * Driven over the REAL `registerTools` registration through an in-memory MCP
 * client - the only level that exercises the tool HANDLERS and the schemas an
 * agent is actually billed for.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

vi.mock('../../src/lib/server/dataflow', () => ({
	getNotebookStaleness: async () => ({ sid: null, cells: {} }),
	analyzeDataflow: async () => ({})
}));

const { writeGate } = vi.hoisted(() => ({ writeGate: { failAt: null as string | null } }));

/**
 * The one thing that can throw out of the doc-layer setter AFTER it has mutated
 * the live document: the `persist`. Induced at the atomic writer rather than by
 * chmod'ing a directory, which is silently a no-op for root and so would report a
 * safety that does not exist in a container.
 */
vi.mock('../../src/lib/server/atomic-write', async () => {
	const actual = await vi.importActual<typeof import('../../src/lib/server/atomic-write')>(
		'../../src/lib/server/atomic-write'
	);
	return {
		...actual,
		atomicWriteFileSync: (path: string, data: string) => {
			if (writeGate.failAt && path === writeGate.failAt)
				throw new Error("EACCES: permission denied, open '" + path + "'");
			return actual.atomicWriteFileSync(path, data);
		}
	};
});

const PY_BYTES = '# Databricks notebook source\nprint(1)\n';

/** The real helper spawns python; only its FORMAT coercion matters here. */
vi.mock('../../src/lib/server/jupytext', async () => {
	const actual = await vi.importActual<typeof import('../../src/lib/server/jupytext')>(
		'../../src/lib/server/jupytext'
	);
	return {
		...actual,
		readPyNotebook: () => ({
			format: 'databricks',
			cells: [{ id: null, cell_type: 'code', source: 'print(1)', outputs: [], metadata: {} }]
		}),
		writePyNotebook: (path: string, cells: { source: string }[]) => {
			writeFileSync(path, cells.map((c) => c.source).join('\n\n# COMMAND ----------\n\n') + '\n');
		}
	};
});

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

describe('an agent can set the notebook language and SEE what it is writing', () => {
	it('set_notebook_language persists it, and the map reports it', async () => {
		const client = await connect('s-set');
		const nb = nbmod.createNotebook('agent.ipynb').path;
		await client.callTool({ name: 'use_notebook', arguments: { name: 'agent.ipynb' } });

		// Before: the map says python, and NO cell carries a language tag.
		const before = bodyOf((await client.callTool({ name: 'get_notebook_map', arguments: {} })) as CallResult);
		expect(before).toContain('"language":"python"');

		const res = (await client.callTool({ name: 'set_notebook_language', arguments: { language: 'mojo' } })) as CallResult;
		expect(res.isError).toBeFalsy();
		expect(bodyOf(res)).toContain('"language":"mojo"');
		expect(nbmod.getNotebookLanguage(nb)).toBe('mojo');

		// The read surface must SAY mojo, or an agent writes Python into it.
		const map = bodyOf((await client.callTool({ name: 'get_notebook_map', arguments: {} })) as CallResult);
		expect(map).toContain('"language":"mojo"');
	});

	it('touches NO cell - the language is read from the notebook, never copied down', async () => {
		const client = await connect('s-cells');
		const nb = nbmod.createNotebook('cells.ipynb').path;
		await client.callTool({ name: 'use_notebook', arguments: { name: 'cells.ipynb' } });
		await client.callTool({ name: 'add_cell', arguments: { cell_type: 'code', source: MOJO_SOURCE } });
		await client.callTool({ name: 'add_cell', arguments: { cell_type: 'markdown', source: '# Notes' } });
		const before = JSON.stringify(nbmod.listCells(nb).map((c) => [c.cell_type, c.source, c.metadata]));
		await client.callTool({ name: 'set_notebook_language', arguments: { language: 'mojo' } });
		expect(JSON.stringify(nbmod.listCells(nb).map((c) => [c.cell_type, c.source, c.metadata]))).toBe(before);
		// ...so no cell reports a language of its own, in either direction.
		expect(nbmod.listCells(nb).every((c) => !c.metadata?.cellar?.language)).toBe(true);
	});

	it('switching back to python is accepted and leaves the notebook python', async () => {
		const client = await connect('s-back');
		const nb = nbmod.createNotebook('back.ipynb').path;
		await client.callTool({ name: 'use_notebook', arguments: { name: 'back.ipynb' } });
		await client.callTool({ name: 'set_notebook_language', arguments: { language: 'mojo' } });
		const res = (await client.callTool({ name: 'set_notebook_language', arguments: { language: 'python' } })) as CallResult;
		expect(res.isError).toBeFalsy();
		expect(nbmod.getNotebookLanguage(nb)).toBe('python');
		const map = bodyOf((await client.callTool({ name: 'get_notebook_map', arguments: {} })) as CallResult);
		expect(map).toContain('"language":"python"');
	});

	it('reports the export target BACK, because the switch may have moved it', async () => {
		// An agent holding `utils.py` has to learn it is now `utils.mojo` before it
		// names the target again - otherwise its next set_export_target is refused.
		const client = await connect('s-target');
		const nb = nbmod.createNotebook('target.ipynb').path;
		await client.callTool({ name: 'use_notebook', arguments: { name: 'target.ipynb' } });
		await client.callTool({ name: 'set_export_target', arguments: { path: 'lib/utils.py' } });
		const res = (await client.callTool({ name: 'set_notebook_language', arguments: { language: 'mojo' } })) as CallResult;
		expect(bodyOf(res)).toContain('lib/utils.mojo');
		expect(nbmod.getExportTarget(nb)).toBe('lib/utils.mojo');
	});
});

/**
 * A REFUSAL and a FAILED WRITE are the two ways this tool does not return the
 * ordinary result, and they are OPPOSITE facts about the document: one leaves it
 * Python, the other leaves it holding Mojo with `run.ts` already compiling every
 * plain code cell as `%%mojo`. Collapsed into one "it failed", an agent told the
 * switch did not happen keeps writing Python into a notebook that has switched -
 * so the split is pinned in BOTH directions, at the real MCP wire.
 */
describe('a refusal and a failed save are different outcomes, not one failure', () => {
	it('a .py text notebook is REFUSED, and stays python', async () => {
		const client = await connect('s-py');
		const py = join(WS, 'text.py');
		writeFileSync(py, PY_BYTES);
		await client.callTool({ name: 'use_notebook', arguments: { name: 'text.py' } });

		const res = (await client.callTool({
			name: 'set_notebook_language',
			arguments: { language: 'mojo' }
		})) as CallResult;

		expect(res.isError).toBe(true);
		const body = bodyOf(res);
		expect(body).toMatch(/refused/i);
		expect(body).toMatch(/\.py text notebook/i);
		// The document really did NOT take it - which is what makes this the other case.
		expect(nbmod.getNotebookLanguage(py)).toBe('python');
	});

	it('a failed SAVE reports the language as APPLIED, never as a refusal', async () => {
		const client = await connect('s-writefail');
		const nb = nbmod.createNotebook('writefail.ipynb').path;
		await client.callTool({ name: 'use_notebook', arguments: { name: 'writefail.ipynb' } });
		await client.callTool({ name: 'add_cell', arguments: { cell_type: 'code', source: 'x = 1' } });
		const onDisk = readFileSync(nb, 'utf8');

		writeGate.failAt = nb;
		let res: CallResult;
		try {
			res = (await client.callTool({
				name: 'set_notebook_language',
				arguments: { language: 'mojo' }
			})) as CallResult;
		} finally {
			writeGate.failAt = null;
		}

		const body = bodyOf(res);
		// It says what IS true: the language took, in memory, and every code cell runs
		// as it now. It must NOT read as the `.py` refusal above, whose remedy (convert
		// the notebook) would send the agent to fix something that is not wrong.
		expect(body).toMatch(/applied in memory/i);
		expect(body).toMatch(/could not be saved/i);
		expect(body).toContain('"mojo"');
		expect(body).not.toMatch(/\.py text notebook/i);
		expect(body).not.toMatch(/^refused/i);
		// And the document really DID take it, which is the fact the wording turns on.
		expect(nbmod.getNotebookLanguage(nb)).toBe('mojo');
		expect(readFileSync(nb, 'utf8')).toBe(onDisk);
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

	it('offers mojo in NO cell_type enum - one hole is a mixed-language notebook', async () => {
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
			// The language is the NOTEBOOK's, so no per-cell way to it may exist...
			expect(enums[0], `${name} must NOT offer mojo`).not.toContain('mojo');
			// ...while `chat` stays withheld for its own reason: a billed model turn is
			// the human's call.
			expect(enums[0], `${name} must NOT offer chat`).not.toContain('chat');
			// ...and everything an agent may still write is there.
			for (const t of ['code', 'sql', 'markdown', 'raw']) expect(enums[0]).toContain(t);
		}
		expect(seen.length).toBe(4);
	});

	it('offers the language as a NOTEBOOK-level tool, with exactly the two values', async () => {
		const client = await connect('s-lang-enum');
		const tool = (await client.listTools()).tools.find((t) => t.name === 'set_notebook_language');
		expect(tool, 'set_notebook_language must be registered').toBeTruthy();
		const enums = cellTypeEnums(tool!.inputSchema).filter((e) => e.includes('python'));
		expect(enums.length).toBe(1);
		expect([...enums[0]].sort()).toEqual(['mojo', 'python']);
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
		expect(instructions).toContain('12. LANGUAGE IS THE NOTEBOOK\'S, AND EVERY MOJO CELL IS A SEPARATE PROGRAM.');
		expect(instructions).toContain('NOTHING carries from one cell to the next');
		expect(instructions).toContain('complete program with its own');
		// The notebook-level model itself, and the tool that reaches it.
		expect(instructions).toContain('A notebook is Python or Mojo, never both');
		expect(instructions).toContain('there is NO mojo cell_type');
		expect(instructions).toContain('set_notebook_language');
		// And the facts about what a Mojo notebook is NOT - narrowed to its CODE cells,
		// because `hasPythonDataflow` is `isPythonCodeCell || isSqlCell` and `isSqlCell`
		// is language-independent, so a SQL cell in a Mojo notebook really does keep a
		// fresh/stale verdict (pinned behaviourally in `notebook-language.test.ts`). The
		// unqualified claim told an agent the opposite of what the code does.
		expect(instructions).toContain(
			'Its CODE cells have no Python dataflow: none shows a staleness verdict (a SQL cell still does)'
		);
		expect(instructions).toContain('none can be the imports cell');
		// The EXPORT claim, which must agree with clause 5 rather than reading as an
		// enumeration of Mojo limitations: such a notebook's cells ARE exportable, to a
		// `.mojo` module. Worded the other way an agent in a Mojo notebook concludes the
		// export path is unavailable, which is the opposite of what Cellar ships.
		expect(instructions).toContain('its cells ARE exportable, to the .mojo module');
		expect(instructions).not.toContain('cannot be exported to');
		// ...and clause 5 is where the rule itself lives, so the two agree.
		expect(instructions).toContain("The module's language is the NOTEBOOK's");
		// Detect-and-instruct reaches the agent too: it must relay the command.
		expect(instructions).toContain('Cellar never installs it for the user');
	});

	it('the tool descriptions name the language, so an agent can find it at all', async () => {
		const client = await connect('s-schemas');
		const tools = (await client.listTools()).tools;
		const byName = Object.fromEntries(tools.map((t) => [t.name, t.description ?? '']));
		expect(byName['set_notebook_language']).toMatch(/mojo/i);
		// The cell-type writers point at it rather than offering a type of their own.
		for (const name of ['add_cell', 'set_cell_type']) {
			expect(byName[name], `${name} description must name the notebook's language`).toMatch(/NOTEBOOK/);
		}
	});
});
