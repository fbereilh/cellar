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
	connect: { ok: true, host: 'https://test.databricks.com', spark_version: '3.5.0' } as Record<string, unknown>
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
	kernelStatus: () => ({ status: 'idle', id: 'k1' })
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
