import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The kernel-restart GRACE: a fast restart must never flash the "session lost" card.
 *
 * A kernel restart wipes the namespace, so `spark`/`w` vanish and the epoch
 * reconciliation honestly reports "not connected, here is what you lost" for the
 * moment before `reconnectAfterKernelRestart` rebuilds the session. A sidebar poll
 * landing inside that moment rendered the warning-toned lost card for a fraction of
 * a second and then went healthy again - a papercut, and a scary one.
 *
 * So the UI-facing connection view (`liveConnection`, read through `getStatus`)
 * holds that shape back for `RESTART_LOST_GRACE_MS` (~1s), reporting `restarting`
 * instead. These pin BOTH directions of that contract, because a grace that hid a
 * real loss would be strictly worse than the flash it prevents:
 *   - a restart that heals inside the window is never reported as lost;
 *   - a loss that outlasts the window IS - and a PROVEN failure (the reconnect gave
 *     up) is reported at once, without waiting the grace out;
 *   - a loss that is not a restart at all never claims to be restarting.
 *
 * The kernel is fully mocked PER NOTEBOOK, mirroring `databricks-restart-reconnect`:
 * `execute(nb, code, …)` answers with the sentinel JSON the real kernel would print,
 * tagged with THAT notebook's epoch. No live cluster. The clock is driven through a
 * `Date.now` spy so the grace can be stepped over without sleeping.
 */

const SENTINEL = '__CELLAR_DBX__';

const state = vi.hoisted(() => ({
	/** Epoch per notebook absolute path; unknown paths fall back to `globalSession`. */
	sessions: new Map<string, number | null>(),
	globalSession: 1 as number | null,
	/** Notebook paths whose kernel is torn down (no live kernel → `not_started`). */
	notStarted: new Set<string>(),
	connect: { ok: true, host: 'https://test.databricks.com', spark_version: '3.5.0' } as Record<string, unknown>
}));

vi.mock('../../src/lib/server/kernel', () => {
	const sess = (nb?: string | null): number | null =>
		nb != null && state.sessions.has(nb) ? (state.sessions.get(nb) as number | null) : state.globalSession;
	return {
		execute: async (nbPath: string, code: string, onEvent: (e: unknown) => void) => {
			onEvent({ type: 'kernel', session: sess(nbPath) });
			let payload: Record<string, unknown>;
			if (code.includes('_cellar_dbx_ping')) payload = { ok: true, alive: true, expired: false };
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
			status: nbPath != null && state.notStarted.has(nbPath) ? 'not_started' : 'idle',
			id: sess(nbPath) == null ? null : 'k1'
		})
	};
});

let dbx: typeof import('../../src/lib/server/databricks');
let dir: string;
const A = () => join(dir, 'a.ipynb');

/** The panel's view of the connection - exactly what the sidebar renders from. */
type PanelConnection = {
	connected: boolean;
	restarting?: boolean;
	expired?: boolean;
	lost?: { clusterName?: string };
};
async function panel(): Promise<PanelConnection> {
	const st = (await dbx.getStatus(A())) as { connection: PanelConnection };
	return st.connection;
}

/**
 * Step the clock forward for everything that reads `Date.now()`. The grace is a
 * wall-clock window, so this is what lets the test cross it without sleeping - and
 * it moves every other timestamp (liveness `checkedAt` & co.) consistently with it.
 */
let clockOffset = 0;
function advanceClock(ms: number) {
	clockOffset += ms;
}

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), 'cellar-dbx-grace-'));
	const cfg = join(dir, '.databrickscfg');
	writeFileSync(cfg, '[test]\nhost = https://test.databricks.com\ntoken = dummy-pat\n');
	process.env.DATABRICKS_CONFIG_FILE = cfg;
	process.env.CELLAR_WORKSPACE = dir;
	dbx = await import('../../src/lib/server/databricks');
});

beforeEach(async () => {
	const realNow = Date.now.bind(Date);
	clockOffset = 0;
	vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffset);
	state.globalSession = 1;
	state.sessions.clear();
	state.notStarted.clear();
	state.connect = { ok: true, host: 'https://test.databricks.com', spark_version: '3.5.0' };
	await dbx.disconnect(A());
});

afterEach(() => {
	vi.restoreAllMocks();
});

/** A live session on A, bound to a cluster (so a restart has an intent to restore). */
async function connectA() {
	state.sessions.set(A(), 1);
	await dbx.connect({ profile: 'test', clusterId: '0725-abc', clusterName: 'Test Cluster', nb: A() });
	expect(dbx.connectionStatus(A()).connected).toBe(true);
}

/** Simulate the kernel restart itself: the namespace is gone and the epoch bumps. */
function restartKernel(epoch: number) {
	state.sessions.set(A(), epoch);
}

describe('kernel-restart grace (no "lost" flash)', () => {
	it('reports the restart window as restarting, not as a lost session', async () => {
		await connectA();
		restartKernel(2);

		const during = await panel();
		expect(during.connected).toBe(false);
		expect(during.restarting).toBe(true);
		// The cluster name still rides along, so the panel keeps naming what it is
		// reconnecting to - the loss is FLAGGED as transient, not hidden.
		expect(during.lost?.clusterName).toBe('Test Cluster');
		expect(during.expired).toBeUndefined();
	});

	it('a restart that heals inside the window is never reported as lost', async () => {
		await connectA();
		restartKernel(2);

		// Every read taken between the restart and the heal - the window a sidebar poll
		// can land in - must be the restarting shape, never a bare lost.
		for (let i = 0; i < 3; i++) {
			advanceClock(200);
			const c = await panel();
			expect(c.restarting).toBe(true);
		}

		expect((await dbx.reconnectAfterKernelRestart(A())).reconnected).toBe(true);
		const after = await panel();
		expect(after.connected).toBe(true);
		expect(after.restarting).toBeUndefined();
		expect(after.lost).toBeUndefined();
	});

	it('surfaces the real lost state once the grace lapses (a slow/absent reconnect)', async () => {
		await connectA();
		restartKernel(2);
		// The window opens at the first observed read, so start it explicitly.
		expect((await panel()).restarting).toBe(true);

		// Nothing rebuilt the session; past the window the user must be told the truth.
		advanceClock(1200);
		const after = await panel();
		expect(after.connected).toBe(false);
		expect(after.restarting).toBeUndefined();
		expect(after.lost?.clusterName).toBe('Test Cluster');
	});

	it('reports a PROVEN reconnect failure immediately, without waiting out the grace', async () => {
		await connectA();
		restartKernel(2);
		state.connect = { ok: false, code: 'session_failed', message: 'cluster unreachable' };

		expect((await dbx.reconnectAfterKernelRestart(A())).reconnected).toBe(false);
		// The outcome is known and it is a loss: the grace debounces the transient
		// window, never a failure we have already observed.
		const after = await panel();
		expect(after.connected).toBe(false);
		expect(after.restarting).toBeUndefined();
		expect(after.lost?.clusterName).toBe('Test Cluster');
	});

	it('reports a torn-down kernel as lost at once (no reconnect is coming)', async () => {
		await connectA();
		// A shutdown / cull, not a restart: there is no kernel to rebuild the session in.
		state.notStarted.add(A());
		restartKernel(3);
		expect((await dbx.reconnectAfterKernelRestart(A())).reason).toBe('no_kernel');

		const after = await panel();
		expect(after.connected).toBe(false);
		expect(after.restarting).toBeUndefined();
	});

	it('never claims to be restarting for a loss that is not a restart', async () => {
		await connectA();
		await dbx.disconnect(A());
		// An explicit disconnect drops the reconnect intent, so a later epoch change is
		// not an expected restart of anything.
		restartKernel(2);

		const after = await panel();
		expect(after.connected).toBe(false);
		expect(after.restarting).toBeUndefined();
		expect(after.lost).toBeUndefined();
	});

	it('re-arms for a SECOND restart after an earlier one lapsed into lost', async () => {
		await connectA();
		restartKernel(2);
		// The grace runs from the first OBSERVATION of the loss (the sidebar poll), so
		// take that read before stepping past the window.
		expect((await panel()).restarting).toBe(true);
		advanceClock(1200);
		expect((await panel()).restarting).toBeUndefined();

		// The session comes back, then the kernel restarts again: the fresh restart gets
		// its own grace rather than inheriting the stale, already-expired stamp.
		expect((await dbx.reconnectAfterKernelRestart(A())).reconnected).toBe(true);
		restartKernel(3);
		expect((await panel()).restarting).toBe(true);
	});
});
