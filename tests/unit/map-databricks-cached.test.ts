/**
 * Perf Tier 3, item 6: `get_notebook_map` reads the CACHED, epoch-reconciled
 * Databricks connection (`connectionStatus`) — it must NOT run the live `SELECT 1`
 * liveness probe (`agentStatus`) on every structural map read.
 *
 * The map is a plain structural read that fires on edits/opens; firing a live
 * workspace round-trip through the kernel each time was the waste. The live probe
 * still backs `databricks_status` / `get_kernel_state`, where verifying the
 * session is the point — this test also pins that those two DO use it.
 *
 * Drives the REAL service + notebook against a scratch workspace, faking Jupyter
 * and stubbing the Python staleness subprocess; the databricks module is mocked so
 * we can count which status function each tool calls.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const h = vi.hoisted(() => {
	function makeFakeKernel() {
		return {
			id: 'kernel-1',
			name: 'python3',
			status: 'idle' as const,
			registerCommTarget: vi.fn(),
			statusChanged: { connect: vi.fn(), disconnect: vi.fn() },
			iopubMessage: { connect: vi.fn() },
			requestExecute: () => ({ onIOPub: null, done: Promise.resolve({ content: { status: 'ok', execution_count: 1 } }) }),
			restart: vi.fn(async () => {}),
			interrupt: vi.fn(async () => {}),
			shutdown: vi.fn(async () => {})
		};
	}
	return { startNew: vi.fn(async () => makeFakeKernel()) };
});

vi.mock('@jupyterlab/services', () => ({
	KernelManager: class {
		ready = Promise.resolve();
		startNew = h.startNew;
		dispose = vi.fn();
	},
	ServerConnection: { makeSettings: (o: unknown) => o }
}));

vi.mock('../../src/lib/server/dataflow', async () => {
	const { currentSessionId } = await import('../../src/lib/server/kernel');
	return {
		getNotebookStaleness: async (nb?: string | null) => ({ sid: currentSessionId(nb), cells: {} }),
		analyzeDataflow: async () => ({})
	};
});

// The databricks module, mocked to COUNT which status path each tool takes.
const db = vi.hoisted(() => ({ agent: 0, conn: 0 }));
vi.mock('../../src/lib/server/databricks', () => ({
	// The LIVE-probe path — must NOT be hit by the map.
	agentStatus: async () => {
		db.agent++;
		return { connected: true };
	},
	// The CACHED, epoch-only path — what the map should use.
	connectionStatus: () => {
		db.conn++;
		return { connected: true };
	},
	forAgent: { catalogs: vi.fn(), schemas: vi.fn(), tables: vi.fn() },
	previewTable: vi.fn()
}));

vi.mock('../../src/lib/server/logs', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }));

let WS: string;
let svc: typeof import('../../src/lib/server/mcp/service');
let nbmod: typeof import('../../src/lib/server/notebook');
const NB = 'map-dbx.ipynb';
const abs = () => nbmod.resolveNotebookPath(NB);

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-map-dbx-'));
	process.env.CELLAR_WORKSPACE = WS;
	svc = await import('../../src/lib/server/mcp/service');
	nbmod = await import('../../src/lib/server/notebook');
	nbmod.createNotebook(NB, null, { focus: false });
	nbmod.setActiveNotebook(NB);
	await svc.addCells([{ cell_type: 'markdown', source: '# Section' }], null, { nb: abs(), routeImports: false });
	await svc.addCells([{ cell_type: 'code', source: 'x = 1' }], null, { nb: abs(), routeImports: false });
});

beforeEach(() => {
	db.agent = 0;
	db.conn = 0;
});

describe('get_notebook_map — cached databricks status', () => {
	it('uses connectionStatus (cached), NOT the live agentStatus probe', async () => {
		const map = (await svc.getNotebookMap(abs())) as { databricks: { connected: boolean } };
		expect(db.conn).toBeGreaterThanOrEqual(1); // read the cached connection
		expect(db.agent).toBe(0); // never fired the live SELECT 1 liveness probe
		expect(map.databricks).toEqual({ connected: true }); // field still meaningful
	});

	it('repeated structural map reads never trigger a live probe', async () => {
		await svc.getNotebookMap(abs());
		await svc.getNotebookMap(abs());
		await svc.getNotebookMap(abs());
		expect(db.agent).toBe(0);
	});

	it('kernel_state DOES still use the live probe (verification is its job)', async () => {
		await svc.getKernelState(abs());
		expect(db.agent).toBeGreaterThanOrEqual(1);
	});

	it('databricks_status DOES still use the live probe', async () => {
		await svc.databricks.status(abs());
		expect(db.agent).toBeGreaterThanOrEqual(1);
	});
});
