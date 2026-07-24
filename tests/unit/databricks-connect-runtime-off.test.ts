import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * THE connect-leaves-runtime-off invariant.
 *
 * Connecting a cluster used to auto-enable the Databricks runtime and restart the
 * kernel so the `dbutils.widgets` path was live immediately. That is deliberately
 * reversed: advertising a runtime changes what EVERY library believes about its
 * environment (mlflow's `is_in_databricks_runtime()` reads the same env var), and
 * engaging it costs the user their namespace - so it is an explicit opt-in via the
 * sidebar's Runtime toggle, which is now the ONLY thing that restarts the kernel for
 * it. A connect binds `spark`/`w` in the running kernel and stops there.
 *
 * This pins the invariant where it is actually decided - at the kernel-start gate
 * (`injectDatabricksRuntime`), reading the REAL preference store after a REAL
 * `connect()`. Asserting it on the toggle predicate alone would miss the thing that
 * used to break it: connect WRITING the preference. So the store is checked too.
 *
 * The kernel and the workspace root are mocked; nothing contacts a cluster.
 */

const SENTINEL = '__CELLAR_DBX__';

const hoisted = vi.hoisted(() => ({
	/** Filled in `beforeAll`; the fstree mock closes over it, so it must be hoisted. */
	dir: '',
	session: 1 as number | null,
	connect: { ok: true, host: 'https://test.databricks.com', spark_version: '3.5.0' } as Record<string, unknown>,
	/** What the LIVE kernel session was started with - the thing the sidebar reports. */
	liveRuntime: { started: true, version: null as string | null }
}));

vi.mock('../../src/lib/server/kernel', () => ({
	execute: async (_nb: string, code: string, onEvent: (e: unknown) => void) => {
		onEvent({ type: 'kernel', session: hoisted.session });
		let payload: Record<string, unknown>;
		if (code.includes('_cellar_dbx_ping')) payload = { ok: true, alive: true, expired: false };
		else if (code.includes('_cellar_dbx_connect')) payload = hoisted.connect;
		else if (code.includes('_cellar_dbx_disconnect')) payload = { ok: true, stopped: true };
		else payload = { ok: true };
		onEvent({
			type: 'output',
			output: { output_type: 'stream', name: 'stdout', text: SENTINEL + JSON.stringify(payload) + '\n' }
		});
		return {};
	},
	currentSessionId: () => hoisted.session,
	kernelStatus: () => ({ status: 'idle', id: 'k1' }),
	liveDatabricksRuntime: () => hoisted.liveRuntime
}));

// `ui-state` resolves its store under the workspace root; point it at the temp dir.
vi.mock('../../src/lib/server/fstree', () => ({ workspaceRoot: () => hoisted.dir }));

let dbx: typeof import('../../src/lib/server/databricks');
let ui: typeof import('../../src/lib/server/ui-state');
let keys: typeof import('../../src/lib/server/databricksRuntime');
const A = () => join(hoisted.dir, 'a.ipynb');

beforeAll(async () => {
	hoisted.dir = mkdtempSync(join(tmpdir(), 'cellar-dbx-runtime-off-'));
	const cfg = join(hoisted.dir, '.databrickscfg');
	writeFileSync(cfg, '[test]\nhost = https://test.databricks.com\ntoken = dummy-pat\n');
	process.env.DATABRICKS_CONFIG_FILE = cfg;
	process.env.CELLAR_WORKSPACE = hoisted.dir;
	delete process.env.CELLAR_DATABRICKS_RUNTIME;
	dbx = await import('../../src/lib/server/databricks');
	ui = await import('../../src/lib/server/ui-state');
	keys = await import('../../src/lib/server/databricksRuntime');
});

beforeEach(async () => {
	hoisted.session = 1;
	hoisted.connect = { ok: true, host: 'https://test.databricks.com', spark_version: '3.5.0' };
	hoisted.liveRuntime = { started: true, version: null };
	// A clean preference store for every case: the whole point is what a connect
	// leaves behind, so a leftover opt-in from a previous case would mask it.
	ui.setUiState({ [keys.DBX_RUNTIME_KEY]: null });
	await dbx.disconnect(A());
});

async function connectA() {
	await dbx.connect({ profile: 'test', clusterId: '0725-abc', clusterName: 'Test Cluster', nb: A() });
}

describe('connecting a cluster leaves the Databricks runtime OFF', () => {
	it('binds the notebook without advertising a runtime to its kernel', async () => {
		await connectA();
		// The connection is real, so the connection SCOPE is satisfied - the preference
		// is the only remaining gate, which is exactly what makes this test meaningful.
		expect(dbx.connectionStatus(A()).connected).toBe(true);
		expect(dbx.databricksBound(A())).toBe(true);
		expect(ui.injectDatabricksRuntime(true)).toBe(false);
	});

	it('writes NO runtime preference (the regression that used to auto-enable it)', async () => {
		await connectA();
		expect(keys.DBX_RUNTIME_KEY in ui.getUiState()).toBe(false);
	});

	it('the toggle is the opt-in: a stored true is what advertises the runtime', async () => {
		await connectA();
		expect(ui.injectDatabricksRuntime(true)).toBe(false);
		ui.setUiState({ [keys.DBX_RUNTIME_KEY]: true });
		expect(ui.injectDatabricksRuntime(true)).toBe(true);
		// ...and toggling back off is honored, as before.
		ui.setUiState({ [keys.DBX_RUNTIME_KEY]: false });
		expect(ui.injectDatabricksRuntime(true)).toBe(false);
	});

	it('a user opt-in survives a reconnect - connect never turns it back off either', async () => {
		await connectA();
		ui.setUiState({ [keys.DBX_RUNTIME_KEY]: true });
		// A kernel restart + the automatic re-establish: the preference is the user's,
		// so the connect path must leave it alone in BOTH directions.
		hoisted.session = 2;
		expect((await dbx.reconnectAfterKernelRestart(A())).reconnected).toBe(true);
		expect(ui.injectDatabricksRuntime(true)).toBe(true);
	});

	it('an unbound notebook is never told it is on Databricks, opt-in or not', async () => {
		ui.setUiState({ [keys.DBX_RUNTIME_KEY]: true });
		expect(ui.injectDatabricksRuntime(false)).toBe(false);
	});
});

/**
 * The sidebar's Runtime state must describe the RUNNING kernel, not the preference.
 *
 * Removing the connect-time restart is exactly what lets the two diverge: a stored
 * `true` (a prior toggle, or one carried over from the build whose connect wrote it)
 * over a kernel that started while the notebook was still unbound - the scope gate
 * skipped the injection - and connecting no longer restarts to reconcile them. A pill
 * derived from the preference would then claim "active" over a kernel whose
 * `DATABRICKS_RUNTIME_VERSION` is unset. So `getStatus` reports what the live session
 * actually carries, and the divergence is what tells the user to restart.
 */
describe('the reported runtime state is the KERNEL, not the preference', () => {
	it('reports no live runtime over a kernel started without it, even with the toggle ON', async () => {
		await connectA();
		ui.setUiState({ [keys.DBX_RUNTIME_KEY]: true });
		hoisted.liveRuntime = { started: true, version: null };

		const st = await dbx.getStatus(A());
		// The preference says on - the KERNEL says nothing is advertised, and that is
		// what the card renders: pending, never active.
		expect(ui.injectDatabricksRuntime(true)).toBe(true);
		expect(st.runtime).toEqual({ kernelStarted: true, liveVersion: null, envForced: null });
	});

	it('reports the version the live session was started with', async () => {
		await connectA();
		hoisted.liveRuntime = { started: true, version: '15.4' };
		expect((await dbx.getStatus(A())).runtime).toEqual({
			kernelStarted: true,
			liveVersion: '15.4',
			envForced: null
		});
	});

	it('reports no kernel at all as not started (nothing to be active in)', async () => {
		await connectA();
		ui.setUiState({ [keys.DBX_RUNTIME_KEY]: true });
		hoisted.liveRuntime = { started: false, version: null };
		expect((await dbx.getStatus(A())).runtime).toEqual({
			kernelStarted: false,
			liveVersion: null,
			envForced: null
		});
	});
});

/**
 * WHO decides is reported too, not just what was decided.
 *
 * `CELLAR_DATABRICKS_RUNTIME` forces the inject decision either way, and the browser
 * cannot see the server's environment. Without that fact on the wire the sidebar
 * reads a forced-OFF override over a stored `true` (the carried-over preference this
 * build deliberately does not migrate) as an ordinary "pending" the user can fix -
 * and its "Apply now" restart then clears the namespace and lands back on pending,
 * repeatably. So the card needs to know the decision is the operator's.
 */
describe('getStatus reports whether the runtime decision is env-FORCED', () => {
	beforeEach(() => {
		delete process.env.CELLAR_DATABRICKS_RUNTIME;
	});

	it('reports null when no override is set - the stored preference decides', async () => {
		await connectA();
		expect((await dbx.getStatus(A())).runtime.envForced).toBe(null);
	});

	it('reports the forced value, and it outranks the stored preference in both directions', async () => {
		await connectA();
		// Forced OFF over a stored ON: no injection, and the card must say so rather than
		// offer a restart that cannot change it.
		ui.setUiState({ [keys.DBX_RUNTIME_KEY]: true });
		process.env.CELLAR_DATABRICKS_RUNTIME = '0';
		expect((await dbx.getStatus(A())).runtime.envForced).toBe(false);
		expect(ui.injectDatabricksRuntime(true)).toBe(false);

		// Forced ON over a stored OFF: the toggle is equally not in control.
		ui.setUiState({ [keys.DBX_RUNTIME_KEY]: false });
		process.env.CELLAR_DATABRICKS_RUNTIME = '1';
		expect((await dbx.getStatus(A())).runtime.envForced).toBe(true);
		expect(ui.injectDatabricksRuntime(true)).toBe(true);
	});

	it('an unrecognized override is not a decision - the store still decides', async () => {
		await connectA();
		process.env.CELLAR_DATABRICKS_RUNTIME = 'maybe';
		expect((await dbx.getStatus(A())).runtime.envForced).toBe(null);
	});
});
