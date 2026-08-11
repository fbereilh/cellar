/**
 * The runtime block reads IDENTICALLY on all three agent surfaces.
 *
 * `databricks_status`, `kernel_state` and `get_notebook_map` each carry a
 * `databricks` block, and the map's is deliberately built DIFFERENTLY from the
 * other two: it is a hot structural read that must not run `agentStatus`'s live
 * `SELECT 1`. That split is exactly how three surfaces come to describe one kernel
 * three ways, so the runtime fact is built by ONE shared builder and this pins that
 * the three answers agree - in both directions, since a block that were merely
 * always-false everywhere would pass a one-sided check.
 *
 * The whole kernel module is real except `liveDatabricksRuntime`: what a running
 * session was started with is the one fact a unit test cannot produce, and it is
 * precisely what the block must report (never the stored preference).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const hoisted = vi.hoisted(() => ({ liveRuntime: { started: false, version: null as string | null } }));

vi.mock('../../src/lib/server/kernel', async () => {
	const actual = await vi.importActual<typeof import('../../src/lib/server/kernel')>(
		'../../src/lib/server/kernel'
	);
	return { ...actual, liveDatabricksRuntime: () => hoisted.liveRuntime };
});

let WS: string;
let svc: typeof import('../../src/lib/server/mcp/service');
let srv: typeof import('../../src/lib/server/mcp/server');

/** The `databricks` block each of the three surfaces reports for `nb`. */
async function blocks(nb: string) {
	const [status, state, map] = await Promise.all([
		svc.databricks.status(nb) as Promise<Record<string, unknown>>,
		svc.getKernelState(nb) as Promise<Record<string, unknown>>,
		svc.getNotebookMap(nb) as Promise<Record<string, unknown>>
	]);
	return {
		status: status.runtime,
		kernelState: (state.databricks as Record<string, unknown>).runtime,
		map: (map.databricks as Record<string, unknown>).runtime
	};
}

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-runtime-surfaces-'));
	process.env.CELLAR_WORKSPACE = WS;
	delete process.env.CELLAR_DATABRICKS_RUNTIME;
	svc = await import('../../src/lib/server/mcp/service');
	srv = await import('../../src/lib/server/mcp/server');
	svc.useNotebook(undefined, 'nb.ipynb');
});

describe('runtime block across databricks_status / kernel_state / get_notebook_map', () => {
	it('reports advertised:false identically when no runtime is set', async () => {
		hoisted.liveRuntime = { started: false, version: null };
		const b = await blocks(svc.targetFor(undefined, 'nb.ipynb'));
		const expected = { advertised: false, version: null, forced_by_env: false };
		expect(b.status).toEqual(expected);
		expect(b.kernelState).toEqual(expected);
		expect(b.map).toEqual(expected);
	});

	it('reports the advertised version identically when one IS set', async () => {
		hoisted.liveRuntime = { started: true, version: '15.4' };
		const b = await blocks(svc.targetFor(undefined, 'nb.ipynb'));
		const expected = { advertised: true, version: '15.4', forced_by_env: false };
		expect(b.status).toEqual(expected);
		expect(b.kernelState).toEqual(expected);
		expect(b.map).toEqual(expected);
	});

	it('carries the env-forced flag on all three', async () => {
		process.env.CELLAR_DATABRICKS_RUNTIME = '1';
		try {
			const b = await blocks(svc.targetFor(undefined, 'nb.ipynb'));
			expect(b.status).toMatchObject({ forced_by_env: true });
			expect(b.kernelState).toMatchObject({ forced_by_env: true });
			expect(b.map).toMatchObject({ forced_by_env: true });
		} finally {
			delete process.env.CELLAR_DATABRICKS_RUNTIME;
		}
	});
});

/**
 * The tool is really REGISTERED and reachable, over the real `registerTools`. The
 * service-level tests above cover what it does; this covers that an agent can call
 * it at all - a typo in the handler wiring is invisible to every other layer.
 */
describe('databricks_runtime at the wire', () => {
	it('is registered, and reports its side effects like databricks_connect does', async () => {
		hoisted.liveRuntime = { started: false, version: null };
		const server = new McpServer({ name: 'cellar-test', version: '0.0.0' });
		srv.registerTools(server);
		const [ct, st] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: 'test-agent', version: '0.0.0' });
		await Promise.all([server.connect(st), client.connect(ct)]);

		const names = (await client.listTools()).tools.map((t) => t.name);
		expect(names).toContain('databricks_runtime');

		const r = (await client.callTool({
			name: 'databricks_runtime',
			arguments: { enable: true, notebook: 'nb.ipynb' }
		})) as { content: { type: string; text?: string }[]; isError?: boolean };
		expect(r.isError).toBeFalsy();
		const payload = JSON.parse(r.content.find((c) => c.type === 'text')!.text!);
		// The same honest side-effect pair `databricks_connect` returns. This notebook
		// has no Databricks session, so nothing is applied and nothing is restarted -
		// and the result SAYS so rather than reporting a bare success.
		expect(payload).toMatchObject({ kernel_restarted: false, namespace_cleared: false });
		expect(payload.runtime).toEqual({ advertised: false, version: null, forced_by_env: false });
		expect(payload.note).toMatch(/not connected/i);
	});
});
