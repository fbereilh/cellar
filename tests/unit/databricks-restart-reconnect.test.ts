import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Databricks auto-reconnect after a KERNEL restart, PER NOTEBOOK.
 *
 * A restart / autorestart / `%restart_python` wipes the kernel namespace, so
 * `spark`/`w` vanish and the epoch reconciliation reports the connection as lost.
 * `reconnectAfterKernelRestart(nb)` must re-establish the SAME session against the
 * profile+cluster it had before - reusing the ordinary `connect()` path - and must
 * do so ONLY when that notebook had a live session. Every edge degrades honestly
 * and never throws (the kernel calls it fire-and-forget).
 *
 * The kernel is fully mocked and PER-NOTEBOOK, mirroring databricks-liveness.test:
 * `execute(nb, code, …)` answers with the sentinel JSON the real kernel would
 * print, tagged with THAT notebook's epoch, and RECORDS every connect bootstrap so
 * the test can assert the reconnect target; `currentSessionId`/`kernelStatus` read
 * per-notebook epoch + status (incl. a `not_started` set). No live cluster.
 */

const SENTINEL = '__CELLAR_DBX__';

const state = vi.hoisted(() => ({
	/** Epoch per notebook absolute path; unknown paths fall back to `globalSession`. */
	sessions: new Map<string, number | null>(),
	globalSession: 1 as number | null,
	/** Notebook paths whose kernel is currently busy. */
	busy: new Set<string>(),
	/** Notebook paths whose kernel is torn down (no live kernel → `not_started`). */
	notStarted: new Set<string>(),
	connect: { ok: true, host: 'https://test.databricks.com', spark_version: '3.5.0' } as Record<string, unknown>,
	/** Every CONNECT_CODE bootstrap the kernel ran, for asserting the reconnect target. */
	connectCalls: [] as { nb: string; code: string }[]
}));

vi.mock('../../src/lib/server/kernel', () => {
	const sess = (nb?: string | null): number | null =>
		nb != null && state.sessions.has(nb) ? (state.sessions.get(nb) as number | null) : state.globalSession;
	return {
		execute: async (nbPath: string, code: string, onEvent: (e: unknown) => void) => {
			onEvent({ type: 'kernel', session: sess(nbPath) });
			let payload: Record<string, unknown>;
			if (code.includes('_cellar_dbx_ping')) payload = { ok: true, alive: true, expired: false };
			else if (code.includes('_cellar_dbx_connect')) {
				state.connectCalls.push({ nb: nbPath, code });
				payload = state.connect;
			} else if (code.includes('_cellar_dbx_disconnect')) payload = { ok: true, stopped: true };
			else payload = { ok: true };
			onEvent({
				type: 'output',
				output: { output_type: 'stream', name: 'stdout', text: SENTINEL + JSON.stringify(payload) + '\n' }
			});
			return {};
		},
		currentSessionId: (nbPath?: string | null) => sess(nbPath),
		kernelStatus: (nbPath?: string | null) => ({
			status:
				nbPath != null && state.notStarted.has(nbPath)
					? 'not_started'
					: nbPath != null && state.busy.has(nbPath)
						? 'busy'
						: 'idle',
			id: sess(nbPath) == null ? null : 'k1'
		})
	};
});

let dbx: typeof import('../../src/lib/server/databricks');
let dir: string;
const A = () => join(dir, 'a.ipynb');
const B = () => join(dir, 'b.ipynb');

/** Set a notebook's kernel epoch (simulate a restart by bumping it). */
function setSession(nb: string, val: number | null) {
	state.sessions.set(nb, val);
}

async function connectA(clusterId = '0725-abc', clusterName = 'Test Cluster') {
	setSession(A(), 1);
	state.notStarted.delete(A());
	state.busy.clear();
	state.connect = { ok: true, host: 'https://test.databricks.com', spark_version: '3.5.0' };
	await dbx.connect({ profile: 'test', clusterId, clusterName, nb: A() });
}

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), 'cellar-dbx-restart-'));
	const cfg = join(dir, '.databrickscfg');
	writeFileSync(cfg, '[test]\nhost = https://test.databricks.com\ntoken = dummy-pat\n');
	process.env.DATABRICKS_CONFIG_FILE = cfg;
	process.env.CELLAR_WORKSPACE = dir;
	dbx = await import('../../src/lib/server/databricks');
});

beforeEach(async () => {
	state.globalSession = 1;
	state.sessions.clear();
	state.busy.clear();
	state.notStarted.clear();
	state.connectCalls.length = 0;
	await dbx.disconnect(A());
	await dbx.disconnect(B());
	state.connectCalls.length = 0; // drop the disconnect-path noise
});

describe('reconnectAfterKernelRestart', () => {
	it('re-establishes the SAME profile+cluster after a restart (reconnected:true)', async () => {
		await connectA();
		expect(dbx.connectionStatus(A()).connected).toBe(true);

		// Kernel restart: the namespace is wiped and the epoch bumps.
		setSession(A(), 2);
		expect(dbx.connectionStatus(A()).connected).toBe(false); // reconciled to lost
		state.connectCalls.length = 0;

		const res = await dbx.reconnectAfterKernelRestart(A());
		expect(res.reconnected).toBe(true);

		// Exactly one reconnect, for A, against the SAME cluster.
		expect(state.connectCalls).toHaveLength(1);
		expect(state.connectCalls[0].nb).toBe(A());
		expect(state.connectCalls[0].code).toContain('0725-abc');

		// spark is live again, stamped with the NEW epoch.
		const st = dbx.connectionStatus(A());
		expect(st.connected).toBe(true);
		expect(st.connected && st.clusterId).toBe('0725-abc');
		expect(st.connected && st.profile).toBe('test');
		expect(st.connected && st.session).toBe(2);
	});

	it('does NOTHING for a notebook that never had a session (no reconnect)', async () => {
		setSession(B(), 1);
		state.connectCalls.length = 0;
		const res = await dbx.reconnectAfterKernelRestart(B());
		expect(res.reconnected).toBe(false);
		expect(res.reason).toBe('no_prior_session');
		expect(state.connectCalls).toHaveLength(0);
	});

	it('does NOTHING after an explicit disconnect cleared the intent', async () => {
		await connectA();
		await dbx.disconnect(A());
		setSession(A(), 2);
		state.connectCalls.length = 0;
		const res = await dbx.reconnectAfterKernelRestart(A());
		expect(res.reconnected).toBe(false);
		expect(res.reason).toBe('no_prior_session');
		expect(state.connectCalls).toHaveLength(0);
	});

	it('never boots a kernel just to reconnect (no_kernel when the kernel is gone)', async () => {
		await connectA();
		// The kernel was torn down (shutdown / cull), not restarted: no live kernel.
		state.notStarted.add(A());
		setSession(A(), null);
		state.connectCalls.length = 0;
		const res = await dbx.reconnectAfterKernelRestart(A());
		expect(res.reconnected).toBe(false);
		expect(res.reason).toBe('no_kernel');
		expect(state.connectCalls).toHaveLength(0); // never touched the kernel
	});

	it('degrades honestly (does not throw) when the reconnect fails', async () => {
		await connectA();
		setSession(A(), 2);
		// The cluster is unreachable now.
		state.connect = { ok: false, code: 'session_failed', message: 'cluster unreachable' };
		state.connectCalls.length = 0;

		const res = await dbx.reconnectAfterKernelRestart(A()); // must resolve, not throw
		expect(res.reconnected).toBe(false);
		expect(String(res.reason)).toMatch(/cluster unreachable/);

		// The connection reads as lost, telling the user/agent to reconnect by hand.
		const st = dbx.connectionStatus(A());
		expect(st.connected).toBe(false);
		expect(st.connected === false && st.lost?.clusterName).toBe('Test Cluster');

		const agent = (await dbx.agentStatus(A())) as Record<string, unknown>;
		expect(agent.connected).toBe(false);
		expect(String(agent.note)).toMatch(/reconnect/i);
	});

	it('retries on a LATER restart after a failed reconnect (intent is kept)', async () => {
		await connectA();
		setSession(A(), 2);
		state.connect = { ok: false, code: 'session_failed', message: 'cluster unreachable' };
		expect((await dbx.reconnectAfterKernelRestart(A())).reconnected).toBe(false);

		// The cluster comes back; a subsequent restart re-establishes the session.
		state.connect = { ok: true, host: 'https://test.databricks.com', spark_version: '3.5.0' };
		setSession(A(), 3);
		state.connectCalls.length = 0;
		const res = await dbx.reconnectAfterKernelRestart(A());
		expect(res.reconnected).toBe(true);
		expect(state.connectCalls[0].code).toContain('0725-abc');
		expect(dbx.connectionStatus(A()).connected).toBe(true);
	});

	it('reconnecting A never touches B (per-notebook isolation)', async () => {
		await connectA('0725-abc', 'Test Cluster');
		// B holds an independent session on a different cluster.
		setSession(B(), 1);
		await dbx.connect({ profile: 'test', clusterId: '0725-xyz', clusterName: 'Other Cluster', nb: B() });
		expect(dbx.connectionStatus(B()).connected).toBe(true);

		// Restart ONLY A's kernel and reconnect it.
		setSession(A(), 2);
		state.connectCalls.length = 0;
		const res = await dbx.reconnectAfterKernelRestart(A());
		expect(res.reconnected).toBe(true);

		// The reconnect used A's cluster, never B's.
		expect(state.connectCalls.every((c) => c.nb === A())).toBe(true);
		expect(state.connectCalls.some((c) => c.code.includes('0725-xyz'))).toBe(false);

		// B is completely untouched: still connected to its own cluster.
		const b = dbx.connectionStatus(B());
		expect(b.connected).toBe(true);
		expect(b.connected && b.clusterId).toBe('0725-xyz');
	});
});
