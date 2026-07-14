import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Databricks Spark Connect session-liveness + auto-reconnect, PER NOTEBOOK.
 *
 * The bug the liveness half guards: a session that expired SERVER-SIDE (idle
 * timeout / cluster GC) still lived in the kernel namespace under the SAME kernel
 * epoch, so the epoch-only status kept reporting connected:true while every
 * `spark.*` raised `[INVALID_HANDLE.SESSION_CLOSED]`. `agentStatus()` must probe
 * real liveness (cached), auto-reconnect on a session-closed error, and still
 * report a genuine kernel restart as disconnected (epoch rule intact).
 *
 * The per-notebook half guards Phase 4: `spark`/`w` live in each notebook's OWN
 * kernel, so the connection state is keyed by notebook. Notebook A connected must
 * not make B connected; restarting A's kernel (bumping A's epoch) drops only A's
 * session; two notebooks can hold independent sessions on different clusters.
 *
 * The kernel is fully mocked and PER-NOTEBOOK: `execute(nbPath, code, …)` answers
 * with the sentinel JSON the real kernel would print, tagged with THAT notebook's
 * epoch; `currentSessionId(nbPath)`/`kernelStatus(nbPath)` read per-notebook epoch
 * + busy. Fake timers drive the liveness-cache TTL. No live cluster, no subprocess.
 */

// The sentinel prefix both the PROBE subprocess and the kernel bootstrap print on
// (mirrors SENTINEL in databricks.ts; kept local so a change there fails loudly).
const SENTINEL = '__CELLAR_DBX__';
const TTL_MS = 15_000;

const state = vi.hoisted(() => ({
	/** Epoch per notebook absolute path; unknown paths fall back to `globalSession`. */
	sessions: new Map<string, number | null>(),
	globalSession: 1 as number | null,
	/** Notebook absolute paths whose kernel is currently busy. */
	busy: new Set<string>(),
	ping: { ok: true, alive: true, expired: false } as Record<string, unknown>,
	connect: { ok: true, host: 'https://test.databricks.com', spark_version: '3.5.0' } as Record<
		string,
		unknown
	>
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
			status: nbPath != null && state.busy.has(nbPath) ? 'busy' : 'idle',
			id: sess(nbPath) == null ? null : 'k1'
		})
	};
});

let dbx: typeof import('../../src/lib/server/databricks');
let dir: string;
/** Absolute path of the default (canonical) notebook every no-`nb` call resolves to. */
let NB: string;

/** Set a notebook's kernel epoch (simulate restart by bumping it). */
function setSession(nb: string, val: number | null) {
	state.sessions.set(nb, val);
}

async function freshConnect(nb?: string) {
	if (nb) setSession(nb, 1);
	else state.globalSession = 1;
	state.busy.clear();
	state.ping = { ok: true, alive: true, expired: false };
	state.connect = { ok: true, host: 'https://test.databricks.com', spark_version: '3.5.0' };
	await dbx.connect({ profile: 'test', clusterId: '0725-abc', clusterName: 'Test Cluster', nb });
}

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), 'cellar-dbx-'));
	const cfg = join(dir, '.databrickscfg');
	writeFileSync(cfg, '[test]\nhost = https://test.databricks.com\ntoken = dummy-pat\n');
	process.env.DATABRICKS_CONFIG_FILE = cfg;
	process.env.CELLAR_WORKSPACE = dir;
	NB = join(dir, 'notebook.ipynb'); // resolveNotebookPath(undefined) → canonical default
	vi.useFakeTimers();
	dbx = await import('../../src/lib/server/databricks');
});

beforeEach(async () => {
	// Clear any live connection + liveness cache between cases, on every notebook.
	state.globalSession = 1;
	state.sessions.clear();
	state.busy.clear();
	await dbx.disconnect();
});

describe('isSessionClosed classification', () => {
	it('matches the real Spark Connect expiry messages', () => {
		for (const m of [
			'SparkConnectGrpcException: [INVALID_HANDLE.SESSION_CLOSED] The handle 1234 is invalid. Session was closed.',
			'Spark Connect Session expired on the server.',
			'org.apache.spark.SparkSQLException: [INVALID_HANDLE.SESSION_CLOSED]',
			'the session is closed'
		]) {
			expect(dbx.isSessionClosed(m)).toBe(true);
		}
	});
	it('does not match unrelated errors', () => {
		for (const m of ['AnalysisException: table not found', 'ConnectionError: timed out', '', null, undefined]) {
			expect(dbx.isSessionClosed(m)).toBe(false);
		}
	});
});

describe('agentStatus liveness + auto-reconnect', () => {
	it('reports a healthy live session as connected (no probe needed right after connect)', async () => {
		await freshConnect();
		const s = (await dbx.agentStatus()) as Record<string, unknown>;
		expect(s.connected).toBe(true);
		expect(s.expired).toBeUndefined();
		expect((s.cluster as Record<string, unknown>).id).toBe('0725-abc');
	});

	it('detects a server-side expiry and AUTO-RECONNECTS (connected:true, reconnected:true)', async () => {
		await freshConnect();
		// The session dies server-side: same epoch, but the next probe raises
		// SESSION_CLOSED. The reconnect (still executed against the live kernel)
		// succeeds, so status must heal rather than trap the agent.
		state.ping = {
			ok: true,
			alive: false,
			expired: true,
			message: '[INVALID_HANDLE.SESSION_CLOSED] Session was closed.'
		};
		vi.advanceTimersByTime(TTL_MS + 1_000); // stale the liveness cache
		const s = (await dbx.agentStatus()) as Record<string, unknown>;
		expect(s.connected).toBe(true);
		expect(s.reconnected).toBe(true);
		// A subsequent status read is fast + healthy (reconnect seeded the cache alive).
		state.ping = { ok: true, alive: true, expired: false };
		const s2 = (await dbx.agentStatus()) as Record<string, unknown>;
		expect(s2.connected).toBe(true);
		expect(s2.reconnected).toBeUndefined();
	});

	it('reports connected:false + expired:true when auto-reconnect fails', async () => {
		await freshConnect();
		state.ping = { ok: true, alive: false, expired: true, message: 'Session was closed.' };
		state.connect = { ok: false, code: 'session_failed', message: 'cluster unreachable' };
		vi.advanceTimersByTime(TTL_MS + 1_000);
		const s = (await dbx.agentStatus()) as Record<string, unknown>;
		expect(s.connected).toBe(false);
		expect(s.expired).toBe(true);
		expect(s.stale).toBe(true);
		expect(String(s.note)).toMatch(/reconnect/i);
	});

	it('reports a genuine kernel restart as disconnected via the epoch rule (not expired)', async () => {
		await freshConnect();
		state.globalSession = 2; // kernel restarted: new epoch, spark is gone
		const s = (await dbx.agentStatus()) as Record<string, unknown>;
		expect(s.connected).toBe(false);
		expect(s.expired).toBeUndefined();
		expect(String(s.note)).toMatch(/kernel restart/i);
	});

	it('flags liveness_unverified on a non-session error rather than tearing down', async () => {
		await freshConnect();
		state.ping = { ok: true, alive: false, expired: false, message: 'ConnectionError: transient blip' };
		vi.advanceTimersByTime(TTL_MS + 1_000);
		const s = (await dbx.agentStatus()) as Record<string, unknown>;
		expect(s.connected).toBe(true);
		expect(s.liveness_unverified).toBe(true);
	});

	it('does not probe (or block) while the kernel is busy', async () => {
		await freshConnect();
		state.busy.add(NB);
		// Set the ping to expired; if the code wrongly probed while busy it would
		// flip to expired. Busy must fall back to the last-known (alive) reading.
		state.ping = { ok: true, alive: false, expired: true, message: 'Session was closed.' };
		vi.advanceTimersByTime(TTL_MS + 1_000);
		const s = (await dbx.agentStatus()) as Record<string, unknown>;
		expect(s.connected).toBe(true);
		expect(s.expired).toBeUndefined();
	});
});

describe('per-notebook connection isolation (Phase 4)', () => {
	const A = () => join(dir, 'a.ipynb');
	const B = () => join(dir, 'b.ipynb');

	beforeEach(async () => {
		// Independent per-notebook epochs; both start at 1.
		setSession(A(), 1);
		setSession(B(), 1);
		await dbx.disconnect(A());
		await dbx.disconnect(B());
	});

	it('connecting A does not bind spark in B; B reports not_connected', async () => {
		await freshConnect(A());
		expect(dbx.connectionStatus(A()).connected).toBe(true);
		expect(dbx.connectionStatus(B()).connected).toBe(false);

		const sa = (await dbx.agentStatus(A())) as Record<string, unknown>;
		expect(sa.connected).toBe(true);
		const sb = (await dbx.agentStatus(B())) as Record<string, unknown>;
		expect(sb.connected).toBe(false);
		expect(String(sb.note)).toMatch(/no databricks session/i);
	});

	it('two notebooks hold INDEPENDENT sessions on different clusters', async () => {
		await freshConnect(A());
		// B connects to a different cluster; A's connection must be untouched.
		state.connect = { ok: true, host: 'https://test.databricks.com', spark_version: '3.5.0' };
		await dbx.connect({ profile: 'test', clusterId: '0725-xyz', clusterName: 'Other Cluster', nb: B() });

		const a = dbx.connectionStatus(A());
		const b = dbx.connectionStatus(B());
		expect(a.connected).toBe(true);
		expect(b.connected).toBe(true);
		expect(a.connected && a.clusterId).toBe('0725-abc');
		expect(b.connected && b.clusterId).toBe('0725-xyz');
	});

	it('restarting A\'s kernel drops ONLY A\'s Databricks session (B stays connected)', async () => {
		await freshConnect(A());
		await dbx.connect({ profile: 'test', clusterId: '0725-xyz', clusterName: 'Other Cluster', nb: B() });
		expect(dbx.connectionStatus(A()).connected).toBe(true);
		expect(dbx.connectionStatus(B()).connected).toBe(true);

		// Restart ONLY A's kernel: bump A's epoch. B's epoch is unchanged.
		setSession(A(), 2);

		const a = dbx.connectionStatus(A());
		expect(a.connected).toBe(false);
		// A remembers what the restart took, keyed to A alone.
		expect(a.connected === false && a.lost?.clusterName).toBe('Test Cluster');
		// B is completely untouched.
		expect(dbx.connectionStatus(B()).connected).toBe(true);

		const sb = (await dbx.agentStatus(B())) as Record<string, unknown>;
		expect(sb.connected).toBe(true);
		const sa = (await dbx.agentStatus(A())) as Record<string, unknown>;
		expect(sa.connected).toBe(false);
		expect(String(sa.note)).toMatch(/kernel restart/i);
	});

	it('disconnecting A leaves B connected', async () => {
		await freshConnect(A());
		await dbx.connect({ profile: 'test', clusterId: '0725-xyz', clusterName: 'Other Cluster', nb: B() });
		await dbx.disconnect(A());
		expect(dbx.connectionStatus(A()).connected).toBe(false);
		expect(dbx.connectionStatus(B()).connected).toBe(true);
	});

	it('liveness expiry + auto-reconnect operate on ONE notebook without touching the other', async () => {
		await freshConnect(A());
		await dbx.connect({ profile: 'test', clusterId: '0725-xyz', clusterName: 'Other Cluster', nb: B() });
		// A's session expires server-side; B's stays alive.
		state.ping = {
			ok: true,
			alive: false,
			expired: true,
			message: '[INVALID_HANDLE.SESSION_CLOSED] Session was closed.'
		};
		vi.advanceTimersByTime(TTL_MS + 1_000);
		const sa = (await dbx.agentStatus(A())) as Record<string, unknown>;
		// A auto-reconnected (reconnect uses the alive `connect` response).
		expect(sa.connected).toBe(true);
		expect(sa.reconnected).toBe(true);
		// B never expired, and its cached liveness from connect is still fresh.
		const sb = (await dbx.agentStatus(B())) as Record<string, unknown>;
		expect(sb.connected).toBe(true);
	});
});
