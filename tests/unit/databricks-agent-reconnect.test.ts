import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Agent-driven Databricks reconnect + gated connect over MCP (task
 * cellar-mcp-dbx-cluster-connect-n6).
 *
 * The invariant under test: `reconnectSession` (the `databricks_reconnect` tool)
 * and `connectCluster` (the `databricks_connect` tool) are THIN orchestration over
 * the ONE existing recovery machinery — rung 1 `refreshKernelConnection` (kernel.ts),
 * rung 2 `autoReconnect` (via `agentStatus`), rung 3 `reconnectAfterKernelRestart`,
 * all funnelling through `connect()`. There is no second reconnect path.
 *
 * Each rung branch is exercised, plus the honest side-effect flags
 * (`kernel_restarted` / `namespace_cleared`) and the connect auth gate
 * (PAT proceeds; un-signed-in OAuth → oauth_login_required).
 *
 * The kernel is fully mocked and PER-NOTEBOOK, mirroring databricks-liveness.test:
 * `execute(nbPath, code, …)` answers with the sentinel JSON the real kernel would
 * print, tagged with that notebook's epoch; `refreshKernelConnection` returns a
 * scriptable `{refreshed, reason}`. Fake timers drive the liveness-cache TTL. No
 * live cluster, no subprocess (the metadata `probe` fails fast on no project venv
 * and every caller degrades to null — so a terminated-cluster gate is not asserted
 * here; that path needs a live workspace).
 */

const SENTINEL = '__CELLAR_DBX__';
const TTL_MS = 15_000;

const state = vi.hoisted(() => ({
	sessions: new Map<string, number | null>(),
	globalSession: 1 as number | null,
	busy: new Set<string>(),
	/** Scriptable return of the mocked rung-1 `refreshKernelConnection`. */
	refresh: { refreshed: true, reason: 'reconnected' } as { refreshed: boolean; reason: string },
	ping: { ok: true, alive: true, expired: false } as Record<string, unknown>,
	connect: { ok: true, host: 'https://test.databricks.com', spark_version: '3.5.0' } as Record<string, unknown>,
	restarts: 0
}));

vi.mock('../../src/lib/server/kernel', () => {
	const sess = (nb?: string | null): number | null =>
		nb != null && state.sessions.has(nb) ? (state.sessions.get(nb) as number | null) : state.globalSession;
	return {
		execute: async (nbPath: string, code: string, onEvent: (e: unknown) => void) => {
			onEvent({ type: 'kernel', session: sess(nbPath) });
			let payload: Record<string, unknown>;
			if (code.includes('_cellar_dbx_ping')) payload = state.ping;
			else if (code.includes('_cellar_dbx_connect')) payload = state.connect;
			else if (code.includes('_cellar_dbx_disconnect')) payload = { ok: true, stopped: true };
			else payload = { ok: true };
			onEvent({
				type: 'output',
				output: { output_type: 'stream', name: 'stdout', text: SENTINEL + JSON.stringify(payload) + '\n' }
			});
			return {};
		},
		currentSessionId: (nbPath?: string | null) => sess(nbPath),
		kernelStatus: (nbPath?: string | null) => ({
			status: nbPath != null && state.busy.has(nbPath) ? 'busy' : sess(nbPath) == null ? 'not_started' : 'idle',
			id: sess(nbPath) == null ? null : 'k1'
		}),
		refreshKernelConnection: async () => state.refresh,
		restartKernel: async () => {
			state.restarts += 1;
		}
	};
});

let dbx: typeof import('../../src/lib/server/databricks');
let dir: string;
let NB: string;

function setSession(nb: string, val: number | null) {
	state.sessions.set(nb, val);
}

async function freshConnect(nb?: string) {
	if (nb) setSession(nb, 1);
	else state.globalSession = 1;
	state.busy.clear();
	state.refresh = { refreshed: true, reason: 'reconnected' };
	state.ping = { ok: true, alive: true, expired: false };
	state.connect = { ok: true, host: 'https://test.databricks.com', spark_version: '3.5.0' };
	await dbx.connect({ profile: 'test', clusterId: '0725-abc', clusterName: 'Test Cluster', nb });
}

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), 'cellar-dbx-recon-'));
	const cfg = join(dir, '.databrickscfg');
	writeFileSync(cfg, '[test]\nhost = https://test.databricks.com\ntoken = dummy-pat\n');
	process.env.DATABRICKS_CONFIG_FILE = cfg;
	process.env.CELLAR_WORKSPACE = dir;
	NB = join(dir, 'notebook.ipynb');
	vi.useFakeTimers();
	dbx = await import('../../src/lib/server/databricks');
});

beforeEach(async () => {
	state.globalSession = 1;
	state.sessions.clear();
	state.busy.clear();
	state.refresh = { refreshed: true, reason: 'reconnected' };
	state.restarts = 0;
	await dbx.disconnect();
});

describe('reconnectSession — the recovery ladder', () => {
	it('rung 1: a dropped kernel SOCKET is refreshed in place — namespace preserved', async () => {
		await freshConnect();
		state.refresh = { refreshed: true, reason: 'reconnected' };
		const r = (await dbx.reconnectSession()) as Record<string, unknown>;
		expect(r.connected).toBe(true);
		expect(r.reconnected).toBe(true);
		expect(r.socket_refreshed).toBe(true);
		expect(r.kernel_restarted).toBe(false);
		expect(r.namespace_cleared).toBe(false);
		expect((r.cluster as Record<string, unknown>).id).toBe('0725-abc');
	});

	it('rung 2: a server-side EXPIRY is rebuilt via autoReconnect (same epoch, namespace kept)', async () => {
		await freshConnect();
		// Session dies server-side: same epoch, next probe raises SESSION_CLOSED; the
		// rebuild (still on the live kernel) succeeds.
		state.ping = { ok: true, alive: false, expired: true, message: '[INVALID_HANDLE.SESSION_CLOSED] Session was closed.' };
		vi.advanceTimersByTime(TTL_MS + 1_000); // stale the liveness cache so the probe runs
		const r = (await dbx.reconnectSession()) as Record<string, unknown>;
		expect(r.connected).toBe(true);
		expect(r.reconnected).toBe(true);
		expect(r.kernel_restarted).toBe(false);
		expect(r.namespace_cleared).toBe(false);
	});

	it('rung 3: a KERNEL RESTART re-establishes the same cluster — namespace_cleared:true', async () => {
		await freshConnect();
		state.globalSession = 2; // kernel restarted: new epoch, spark is gone
		const r = (await dbx.reconnectSession()) as Record<string, unknown>;
		expect(r.connected).toBe(true);
		expect(r.reconnected).toBe(true);
		expect(r.kernel_restarted).toBe(true);
		expect(r.namespace_cleared).toBe(true);
		expect(String(r.note)).toMatch(/re-run/i);
	});

	it('already live: reports connected against the same cluster (reconnect is idempotent)', async () => {
		await freshConnect();
		const r = (await dbx.reconnectSession()) as Record<string, unknown>;
		expect(r.connected).toBe(true);
		expect(r.reconnected).toBe(true);
		expect((r.cluster as Record<string, unknown>).name).toBe('Test Cluster');
	});

	it('no prior connection → not_connected (the agent cannot choose a cluster to restore)', async () => {
		// beforeEach already disconnected, clearing reconnectTarget.
		await expect(dbx.reconnectSession()).rejects.toMatchObject({ code: 'not_connected' });
	});

	it('a proven-dead kernel process → kernel_unavailable (never boots one to reconnect)', async () => {
		await freshConnect();
		state.refresh = { refreshed: false, reason: 'kernel_gone' };
		await expect(dbx.reconnectSession()).rejects.toMatchObject({ code: 'kernel_unavailable' });
	});

	it('an expiry that cannot be healed → reconnect_failed', async () => {
		await freshConnect();
		state.ping = { ok: true, alive: false, expired: true, message: 'Session was closed.' };
		state.connect = { ok: false, code: 'session_failed', message: 'cluster unreachable' };
		vi.advanceTimersByTime(TTL_MS + 1_000);
		await expect(dbx.reconnectSession()).rejects.toMatchObject({ code: 'reconnect_failed' });
	});
});

describe('reconnectSession — per notebook', () => {
	it('reconnecting notebook A does not touch notebook B', async () => {
		const A = join(dir, 'a.ipynb');
		const B = join(dir, 'b.ipynb');
		await freshConnect(A);
		// B never connected: its reconnect has no target.
		await expect(dbx.reconnectSession(B)).rejects.toMatchObject({ code: 'not_connected' });
		// A is still fine.
		const r = (await dbx.reconnectSession(A)) as Record<string, unknown>;
		expect(r.connected).toBe(true);
	});
});

describe('connectCluster — gated connect to a chosen cluster', () => {
	it('a PAT profile proceeds and binds the cluster (kernel_restarted:false)', async () => {
		state.globalSession = 1;
		state.connect = { ok: true, host: 'https://test.databricks.com', spark_version: '3.5.0' };
		const r = (await dbx.connectCluster({ clusterId: '0801-xyz', clusterName: 'Chosen', profile: 'test' })) as Record<string, unknown>;
		expect(r.connected).toBe(true);
		expect((r.cluster as Record<string, unknown>).id).toBe('0801-xyz');
		expect(r.kernel_restarted).toBe(false);
		expect(r.namespace_cleared).toBe(false);
	});

	it('an un-signed-in OAuth host is refused with oauth_login_required (browser is human-only)', async () => {
		await expect(
			dbx.connectCluster({ clusterId: '0801-xyz', host: 'https://oauth.databricks.com' })
		).rejects.toMatchObject({ code: 'oauth_login_required' });
	});

	it('a bare/invalid cluster id is rejected before any connect', async () => {
		await expect(dbx.connectCluster({ clusterId: 'bad id!', profile: 'test' })).rejects.toBeTruthy();
	});
});
