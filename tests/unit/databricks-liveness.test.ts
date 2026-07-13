import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Databricks Spark Connect session-liveness + auto-reconnect.
 *
 * The bug this guards: a session that expired SERVER-SIDE (idle timeout / cluster
 * GC) still lived in the kernel namespace under the SAME kernel epoch, so the
 * epoch-only status kept reporting connected:true while every `spark.*` raised
 * `[INVALID_HANDLE.SESSION_CLOSED]`. `agentStatus()` must now probe real liveness
 * (cached), auto-reconnect on a session-closed error, and still report a genuine
 * kernel restart as disconnected (epoch rule intact).
 *
 * The kernel is fully mocked: `execute` inspects the bootstrap code and answers
 * with the sentinel JSON line the real kernel would print, `currentSessionId`
 * drives the epoch, and `kernelStatus` drives busy/idle. Fake timers drive the
 * liveness-cache TTL. No live cluster, no subprocess.
 */

// The sentinel prefix both the PROBE subprocess and the kernel bootstrap print on
// (mirrors SENTINEL in databricks.ts; kept local so a change there fails loudly).
const SENTINEL = '__CELLAR_DBX__';
const TTL_MS = 15_000;

const state = vi.hoisted(() => ({
	session: 1 as number | null,
	busy: false,
	ping: { ok: true, alive: true, expired: false } as Record<string, unknown>,
	connect: { ok: true, host: 'https://test.databricks.com', spark_version: '3.5.0' } as Record<
		string,
		unknown
	>
}));

vi.mock('../../src/lib/server/kernel', () => ({
	execute: async (code: string, onEvent: (e: unknown) => void) => {
		onEvent({ type: 'kernel', session: state.session });
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
	currentSessionId: () => state.session,
	kernelStatus: () => ({ status: state.busy ? 'busy' : 'idle', id: state.session == null ? null : 'k1' })
}));

let dbx: typeof import('../../src/lib/server/databricks');

async function freshConnect() {
	state.session = 1;
	state.busy = false;
	state.ping = { ok: true, alive: true, expired: false };
	state.connect = { ok: true, host: 'https://test.databricks.com', spark_version: '3.5.0' };
	await dbx.connect({ profile: 'test', clusterId: '0725-abc', clusterName: 'Test Cluster' });
}

beforeAll(async () => {
	const dir = mkdtempSync(join(tmpdir(), 'cellar-dbx-'));
	const cfg = join(dir, '.databrickscfg');
	writeFileSync(cfg, '[test]\nhost = https://test.databricks.com\ntoken = dummy-pat\n');
	process.env.DATABRICKS_CONFIG_FILE = cfg;
	process.env.CELLAR_WORKSPACE = dir;
	vi.useFakeTimers();
	dbx = await import('../../src/lib/server/databricks');
});

beforeEach(async () => {
	// Clear any live connection + liveness cache between cases.
	state.session = 1;
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
		state.session = 2; // kernel restarted: new epoch, spark is gone
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
		state.busy = true;
		// Set the ping to expired; if the code wrongly probed while busy it would
		// flip to expired. Busy must fall back to the last-known (alive) reading.
		state.ping = { ok: true, alive: false, expired: true, message: 'Session was closed.' };
		vi.advanceTimersByTime(TTL_MS + 1_000);
		const s = (await dbx.agentStatus()) as Record<string, unknown>;
		expect(s.connected).toBe(true);
		expect(s.expired).toBeUndefined();
	});
});
