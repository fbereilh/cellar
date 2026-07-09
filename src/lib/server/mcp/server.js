/**
 * Cellar — MCP server (agent interface).
 *
 * Runs IN-PROCESS inside Cellar's backend over Streamable HTTP on its own port,
 * so it shares the live notebook document + kernel with the UI. Because the MCP
 * server, its sessions, and the document are all independent of the kernel
 * connection, restarting/replacing/killing the kernel never drops the MCP
 * connection or the agent session (spec §4, hard requirement #1).
 *
 * Connect an agent to:  http://127.0.0.1:<CELLAR_MCP_PORT>/mcp   (default 39587)
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import * as svc from './service.js';

const text = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const notFound = (msg) => ({ content: [{ type: 'text', text: msg }], isError: true });

/**
 * House-style doctrine handed to the agent once at connect (MCP server
 * `instructions`). Sets the frame — build ONE coherent notebook, not a pile of
 * snippets — before the first tool call. Advisory: the host injects it into the
 * model's context. Reference only tools that ship today.
 */
const INSTRUCTIONS = `You are authoring ONE coherent, human-readable Python notebook in Cellar — not a
pile of independent snippets. Notebooks here read top-to-bottom as a single
narrative where each cell builds on the last.

Follow this house style:

1. IMPORTS GO AT THE TOP, ONCE. By convention, keep all imports in the first
   code cell and do not repeat import lines inside narrative cells. Before adding
   an import, check kernel_state (below) to see whether the module is already
   loaded.

2. CHECK STATE BEFORE YOU WRITE. Call kernel_state to see what is already
   imported and which variables/functions/classes already exist in the live
   kernel. Do not re-import a module that is already loaded, and do not recompute
   or redefine a value that already exists — build on it.

3. CONTINUE THE STORY. Before adding a cell, call get_notebook_map to see the
   narrative so far. A new cell should advance it — reuse existing variables,
   reference earlier results, and add a short markdown header when you start a new
   section. Do not answer a question in isolation as if the notebook were empty.

4. STRUCTURE WITH MARKDOWN. Use markdown header cells to divide the notebook into
   sections (Setup, Load data, Explore, Model, Results). Keep code cells focused:
   one idea per cell.

5. PICK THE RIGHT NOTEBOOK. Your read/write/run tools target the active notebook.
   Call list_notebooks to discover the workspace's notebooks; open_notebook(name)
   to open and focus an EXISTING one (this makes it active and surfaces it in the
   UI); create_notebook(name) only for a genuinely NEW notebook. Do not reach for
   create_notebook to open something that already exists.

6. WRITE AND RUN TOGETHER. When you add a code cell you intend to execute, use
   add_and_run — it creates the cell and runs it in one call, returning the new
   cell id and the run result (outputs/errors) together, with fewer round-trips
   than add_cell followed by run_cell. Reserve add_cell for cells you are adding
   without running yet (e.g. markdown headers, or code you will run later).

The goal: a notebook a human would be happy to have written — imports up top,
shared state, a clean section outline, and a continuous line of reasoning from
first cell to last.`;

function registerTools(server) {
	// --- lifecycle ---
	server.registerTool('restart_kernel', { description: 'Restart the kernel (clears namespace). Does NOT affect the MCP connection or document.', inputSchema: {} }, async () => text(await svc.kernel.restart()));
	server.registerTool('interrupt_kernel', { description: 'Interrupt the running kernel.', inputSchema: {} }, async () => text(await svc.kernel.interrupt()));
	server.registerTool('kernel_status', { description: 'Current kernel status.', inputSchema: {} }, async () => text(svc.kernel.status()));
	server.registerTool('list_notebooks', { description: 'List every .ipynb in the workspace (workspace-relative paths) so you can discover notebook names to open, and which one is currently active. Use open_notebook to focus one of these.', inputSchema: {} }, async () => text(svc.listNotebooks()));
	server.registerTool('open_notebook', { description: 'Open and focus an existing workspace notebook by name; surfaces it live in the UI. Use create_notebook to make a new one.', inputSchema: { name: z.string() } }, async ({ name }) => { try { return text(svc.openNotebook(name)); } catch (e) { return notFound(String(e?.message ?? e)); } });
	server.registerTool('create_notebook', { description: 'Create a NEW workspace notebook by name (a .ipynb file), make it active, and surface it live in the open UI. Omit name for an untitled notebook. To open a notebook that already exists, use open_notebook instead.', inputSchema: { name: z.string().optional() } }, async ({ name }) => text(svc.createNotebook(name)));

	// --- read ---
	server.registerTool('get_notebook_map', { description: 'Compact hierarchical section tree (from markdown headers): id, type, header level/title, one-line summary, run status, has-output, visibility. Not full content.', inputSchema: {} }, async () => text(svc.getNotebookMap()));
	server.registerTool('kernel_state', { description: 'Live kernel namespace: imports already loaded, user-defined functions/classes, and variables (with types, shapes, dataframe columns). Returns {started:false} if no kernel is running (does not boot one). Call this BEFORE writing code so you do not re-import modules or redefine names that already exist.', inputSchema: {} }, async () => text(await svc.getKernelState()));
	server.registerTool('read_cell', { description: 'Read one cell by UUID (source + summarized outputs).', inputSchema: { id: z.string() } }, async ({ id }) => { const r = svc.readCell(id); return r ? text(r) : notFound(`cell ${id} not found or hidden`); });
	server.registerTool('read_cells', { description: 'Read multiple cells by UUID.', inputSchema: { ids: z.array(z.string()) } }, async ({ ids }) => text(svc.readCells(ids)));
	server.registerTool('read_by_location', { description: 'Read a cell by location: index (0-based over visible cells), position first/last, or next/prev of a cell.', inputSchema: { index: z.number().int().optional(), position: z.enum(['first', 'last']).optional(), relative_to: z.string().optional(), direction: z.enum(['next', 'prev']).optional() } }, async ({ index, position, relative_to, direction }) => { const r = svc.readByLocation({ index, position, relativeTo: relative_to, direction }); return r ? text(r) : notFound('no cell at that location'); });
	server.registerTool('read_section', { description: 'Read all cells under a markdown header (until the next same-or-higher header).', inputSchema: { header_id: z.string() } }, async ({ header_id }) => { const r = svc.readSection(header_id); return r ? text(r) : notFound(`${header_id} is not a visible header cell`); });
	server.registerTool('search_cells', { description: 'Search cells; returns ids + snippets.', inputSchema: { query: z.string(), in: z.enum(['input', 'output', 'both']).optional() } }, async ({ query, in: where }) => text(svc.searchCells(query, where ?? 'both')));
	server.registerTool('get_errors', { description: 'List cells whose latest output is an error (ename/evalue/traceback).', inputSchema: {} }, async () => text(svc.getErrors()));
	server.registerTool('get_full_output', { description: 'Fuller cell outputs. Medium-capped by default; size=full returns everything. Images passed through.', inputSchema: { id: z.string(), size: z.enum(['medium', 'full']).optional() } }, async ({ id, size }) => {
		const r = svc.getFullOutput(id, size ?? 'medium');
		if (!r) return notFound(`cell ${id} not found or hidden`);
		const content = [{ type: 'text', text: JSON.stringify({ id: r.id, size: r.size, outputs: r.outputs.map((o) => (o.data ? { type: o.type, image: o.image } : o)) }, null, 2) }];
		for (const o of r.outputs) if (o.data) content.push({ type: 'image', data: o.data, mimeType: o.image });
		return { content };
	});

	// --- write ---
	server.registerTool('add_cell', { description: 'Add a cell (optionally after a cell), of type code|markdown, with optional source.', inputSchema: { after_id: z.string().optional(), cell_type: z.enum(['code', 'markdown']).optional(), source: z.string().optional() } }, async ({ after_id, cell_type, source }) => text({ id: svc.addCells([{ cell_type, source }], after_id)[0] }));
	server.registerTool('add_cells', { description: 'Add multiple cells in order (optionally after a cell).', inputSchema: { cells: z.array(z.object({ cell_type: z.enum(['code', 'markdown']).optional(), source: z.string().optional() })), after_id: z.string().optional() } }, async ({ cells, after_id }) => text({ ids: svc.addCells(cells, after_id) }));
	server.registerTool('edit_cell', { description: 'Replace a cell source in place.', inputSchema: { id: z.string(), source: z.string() } }, async ({ id, source }) => (svc.editCell(id, source) ? text({ ok: true, id }) : notFound(`cell ${id} not found`)));
	server.registerTool('delete_cell', { description: 'Delete a cell.', inputSchema: { id: z.string() } }, async ({ id }) => (svc.removeCell(id) ? text({ ok: true }) : notFound(`cell ${id} not found`)));
	server.registerTool('move_cell', { description: 'Move a cell to an absolute index.', inputSchema: { id: z.string(), position: z.number().int() } }, async ({ id, position }) => (svc.moveCell(id, position) ? text({ ok: true }) : notFound(`cell ${id} not found`)));
	server.registerTool('set_cell_type', { description: 'Set a cell type to code or markdown.', inputSchema: { id: z.string(), cell_type: z.enum(['code', 'markdown']) } }, async ({ id, cell_type }) => (svc.setType(id, cell_type) ? text({ ok: true }) : notFound(`cell ${id} not found`)));
	server.registerTool('set_cell_visibility', { description: 'Show/hide a cell from the agent (cellar.hidden_from_agent).', inputSchema: { id: z.string(), hidden: z.boolean() } }, async ({ id, hidden }) => (svc.setCellVisibility(id, hidden) ? text({ ok: true, id, hidden }) : notFound(`cell ${id} not found`)));

	// --- execute ---
	server.registerTool('add_and_run', { description: 'PREFERRED write-and-execute: create a cell AND run it in one call (fewer round-trips than add_cell then run_cell). Adds a code|markdown cell (default code) with the given source, after a cell (after_id) or appended at the end, runs it, and returns run_cell\'s result (status + outputs) plus the new cell id. Code that raises returns the error as the result (does not fail — the cell still exists). A markdown cell_type is created but not run (status "skipped"), same as run_cell — for markdown use add_cell. Use add_cell (no run) only when you want to add a cell WITHOUT running it.', inputSchema: { source: z.string(), cell_type: z.enum(['code', 'markdown']).optional(), after_id: z.string().optional() } }, async ({ source, cell_type, after_id }) => text(await svc.addAndRun({ source, cellType: cell_type, afterId: after_id })));
	server.registerTool('run_cell', { description: 'Run one cell by UUID (markdown cells are skipped).', inputSchema: { id: z.string() } }, async ({ id }) => { const r = await svc.runCell(id); return r ? text(r) : notFound(`cell ${id} not found`); });
	server.registerTool('run_cells', { description: 'Run multiple cells in order.', inputSchema: { ids: z.array(z.string()) } }, async ({ ids }) => text(await svc.runCells(ids)));
	server.registerTool('run_all', { description: 'Run all code cells in document order.', inputSchema: {} }, async () => text(await svc.runAll()));
	server.registerTool('run_range', { description: 'Run code cells in the inclusive range from one cell to another.', inputSchema: { from_id: z.string(), to_id: z.string() } }, async ({ from_id, to_id }) => text(await svc.runRange(from_id, to_id)));

	// --- prompt: the house style as a surfaceable slash-command ---
	server.registerPrompt('cellar_notebook_style', { description: "Cellar's house style for building one coherent notebook." }, () => ({
		messages: [{ role: 'user', content: { type: 'text', text: INSTRUCTIONS } }]
	}));
}

/** Read and JSON-parse a Node request body. */
function readBody(req) {
	return new Promise((resolve, reject) => {
		let data = '';
		req.on('data', (c) => (data += c));
		req.on('end', () => {
			try {
				resolve(data ? JSON.parse(data) : undefined);
			} catch (e) {
				reject(e);
			}
		});
		req.on('error', reject);
	});
}

let started = false;

/** Start the in-process MCP HTTP server once. */
export function startMcpServer() {
	if (started || globalThis.__cellarMcpStarted) return;
	started = true;
	globalThis.__cellarMcpStarted = true;

	const port = Number(process.env.CELLAR_MCP_PORT || 39587);
	const transports = {}; // sessionId -> transport

	const httpServer = http.createServer(async (req, res) => {
		const url = new URL(req.url, 'http://localhost');
		if (url.pathname !== '/mcp') {
			res.writeHead(404).end('not found');
			return;
		}
		try {
			if (req.method === 'POST') {
				const body = await readBody(req);
				const sid = req.headers['mcp-session-id'];
				let transport = sid ? transports[sid] : undefined;
				if (!transport && isInitializeRequest(body)) {
					transport = new StreamableHTTPServerTransport({
						sessionIdGenerator: () => randomUUID(),
						onsessioninitialized: (id) => (transports[id] = transport)
					});
					transport.onclose = () => {
						if (transport.sessionId) delete transports[transport.sessionId];
					};
					const server = new McpServer({ name: 'cellar', version: '0.1.0' }, { instructions: INSTRUCTIONS });
					registerTools(server);
					await server.connect(transport);
				}
				if (!transport) {
					res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'No valid session; send an initialize request first.' }, id: null }));
					return;
				}
				await transport.handleRequest(req, res, body);
			} else if (req.method === 'GET' || req.method === 'DELETE') {
				const sid = req.headers['mcp-session-id'];
				const transport = sid ? transports[sid] : undefined;
				if (!transport) {
					res.writeHead(400).end('missing or unknown session');
					return;
				}
				await transport.handleRequest(req, res);
			} else {
				res.writeHead(405).end('method not allowed');
			}
		} catch (err) {
			if (!res.headersSent) res.writeHead(500).end('mcp error: ' + err);
		}
	});

	httpServer.on('error', (err) => console.error('[cellar-mcp] server error:', err));
	httpServer.listen(port, '127.0.0.1', () => {
		console.log(`[cellar-mcp] MCP agent interface on http://127.0.0.1:${port}/mcp`);
	});
}
