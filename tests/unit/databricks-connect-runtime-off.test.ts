import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SDK_DBUTILS_FOREIGN_WARNING } from '../../src/lib/dbutilsShim';

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
	liveRuntime: { started: true, version: null as string | null },
	/**
	 * What the kernel answers the `dbutils` binding probe with. Default: the shim is
	 * installed and no cell has imported `databricks.sdk.runtime` yet.
	 */
	binding: { ok: true, sdk_imported: false, sdk_is_shim: null } as Record<string, unknown>,
	/** How many times the kernel was asked that question - the probe must stay bounded. */
	bindingProbes: 0,
	/** Makes the binding probe FAIL, so the failure path can be exercised too. */
	bindingThrows: false,
	/** The live kernel's status, so a BUSY kernel can be exercised. */
	kernelStatus: 'idle' as string
}));

vi.mock('../../src/lib/server/kernel', () => ({
	execute: async (_nb: string, code: string, onEvent: (e: unknown) => void) => {
		onEvent({ type: 'kernel', session: hoisted.session });
		let payload: Record<string, unknown>;
		if (code.includes('_cellar_dbx_ping')) payload = { ok: true, alive: true, expired: false };
		else if (code.includes('_cellar_dbx_connect')) payload = hoisted.connect;
		else if (code.includes('_cellar_dbx_disconnect')) payload = { ok: true, stopped: true };
		else if (code.includes('_cellar_dbutils_binding')) {
			hoisted.bindingProbes++;
			if (hoisted.bindingThrows) throw new Error('kernel unreachable');
			payload = hoisted.binding;
		}
		else payload = { ok: true };
		onEvent({
			type: 'output',
			output: { output_type: 'stream', name: 'stdout', text: SENTINEL + JSON.stringify(payload) + '\n' }
		});
		return {};
	},
	currentSessionId: () => hoisted.session,
	kernelStatus: () => ({ status: hoisted.kernelStatus, id: 'k1' }),
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
	hoisted.binding = { ok: true, sdk_imported: false, sdk_is_shim: null };
	hoisted.bindingProbes = 0;
	hoisted.bindingThrows = false;
	hoisted.kernelStatus = 'idle';
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
		expect(st.runtime).toEqual({
			kernelStarted: true,
			liveVersion: null,
			// The stored preference rides ALONGSIDE the live fact (it is what the toggle
			// shows) - the point of this suite is that it never becomes `liveVersion`.
			preference: true,
			envForced: null,
			versionEnvForced: null,
			// Nothing advertised, so the SDK-import binding is deliberately NOT probed.
			sdkDbutils: 'unknown'
		});
	});

	it('reports the version the live session was started with', async () => {
		await connectA();
		hoisted.liveRuntime = { started: true, version: '15.4' };
		expect((await dbx.getStatus(A())).runtime).toEqual({
			kernelStarted: true,
			liveVersion: '15.4',
			// …and it reports the live version even though nothing opted in.
			preference: false,
			envForced: null,
			versionEnvForced: null,
			sdkDbutils: 'not_imported'
		});
	});

	it('reports no kernel at all as not started (nothing to be active in)', async () => {
		await connectA();
		ui.setUiState({ [keys.DBX_RUNTIME_KEY]: true });
		hoisted.liveRuntime = { started: false, version: null };
		expect((await dbx.getStatus(A())).runtime).toEqual({
			kernelStarted: false,
			liveVersion: null,
			preference: true,
			envForced: null,
			versionEnvForced: null,
			sdkDbutils: 'unknown'
		});
	});
});

/**
 * The `dbutils` SDK-import bypass, as the two surfaces report it.
 *
 * `from databricks.sdk.runtime import dbutils` must reach Cellar's shim; when it
 * does not, the SDK's own object renders the parameter widgets and then discards
 * every entered value on re-declaration. Nothing on screen says so - which is why
 * both the Runtime card (`getStatus().runtime.sdkDbutils`) and the agent surface
 * (`databricks_status`) have to say it instead. The rebind itself is proven
 * against real Python in `dbutils-sdk-import.test.ts`; this pins the WIRING: what
 * each surface reports, and that asking costs a bounded, kernel-safe probe.
 *
 * Each case picks its own kernel SESSION before connecting, because the reading is
 * cached per (notebook, session) - a restart re-runs the shim installer, so a
 * reading from another epoch says nothing about this one.
 */
describe('the SDK-import dbutils binding is reported, never left silent', () => {
	const FOREIGN = { ok: true, sdk_imported: true, sdk_is_shim: false };
	const BOUND = { ok: true, sdk_imported: true, sdk_is_shim: true };

	async function connectWith(session: number, binding: Record<string, unknown>, version = '15.4') {
		hoisted.session = session;
		hoisted.binding = binding;
		await connectA();
		hoisted.liveRuntime = { started: true, version };
	}

	it('warns on both surfaces when the module holds something other than the shim', async () => {
		await connectWith(11, FOREIGN);
		expect((await dbx.getStatus(A())).runtime.sdkDbutils).toBe('foreign');
		const agent = (await dbx.agentStatus(A())) as Record<string, unknown>;
		// Same sentence for the human and the agent - one source, so they cannot drift.
		expect(agent.dbutils_widgets_warning).toBe(SDK_DBUTILS_FOREIGN_WARNING);
		// ...and the connection answer it decorates is still intact.
		expect(agent.connected).toBe(true);
	});

	it('says nothing when the import path really does reach the shim', async () => {
		await connectWith(12, BOUND);
		expect((await dbx.getStatus(A())).runtime.sdkDbutils).toBe('shim');
		expect((await dbx.agentStatus(A())) as Record<string, unknown>).not.toHaveProperty(
			'dbutils_widgets_warning'
		);
	});

	it('does not ask - and never warns - when no runtime is advertised', async () => {
		// Without the runtime the rebind is deliberately not installed, so the SDK
		// holding its own `dbutils` is expected, not a defect. This is also what keeps
		// the probe off every ordinary status read.
		await connectWith(13, FOREIGN, null as unknown as string);
		hoisted.liveRuntime = { started: true, version: null };
		expect((await dbx.getStatus(A())).runtime.sdkDbutils).toBe('unknown');
		expect((await dbx.agentStatus(A())) as Record<string, unknown>).not.toHaveProperty(
			'dbutils_widgets_warning'
		);
		expect(hoisted.bindingProbes).toBe(0);
	});

	it('never queues behind a running cell: a BUSY kernel is skipped, not warned about', async () => {
		await connectWith(14, FOREIGN);
		hoisted.kernelStatus = 'busy';
		expect((await dbx.getStatus(A())).runtime.sdkDbutils).toBe('unknown');
		expect(hoisted.bindingProbes).toBe(0);
	});

	it('is skipped by the run QUEUE too, before jupyter has flipped to busy', async () => {
		// The check-then-act window `kernelState`/`inspectVariables` already close: a
		// run claims the kernel synchronously at dequeue while jupyter's idle->busy
		// flip lands a beat later. Reading only the status let the probe dispatch into
		// the kernel's exec lock and block for the WHOLE cell - and since this is
		// single-flight and awaited inside `getStatus`, a multi-minute Spark cell would
		// strand the Databricks panel and `databricks_status` with it. Driven through
		// the REAL queue, so it cannot pass against a re-stated rule that has drifted.
		const { enqueueRun } = await import('../../src/lib/server/run-queue');
		await connectWith(17, FOREIGN);
		const ticket = enqueueRun({ nb: A(), cellId: 'cell-1' });
		try {
			// jupyter still says idle - the queue is the only thing that knows.
			expect(hoisted.kernelStatus).toBe('idle');
			expect((await dbx.getStatus(A())).runtime.sdkDbutils).toBe('unknown');
			expect((await dbx.agentStatus(A())) as Record<string, unknown>).not.toHaveProperty(
				'dbutils_widgets_warning'
			);
			expect(hoisted.bindingProbes).toBe(0);
		} finally {
			if (!ticket.duplicate) ticket.done();
		}
		// ...and the moment the run releases the kernel, the reading is taken again.
		expect((await dbx.getStatus(A())).runtime.sdkDbutils).toBe('foreign');
		expect(hoisted.bindingProbes).toBe(1);
	});

	it('caches the reading, so a burst of status reads costs one probe', async () => {
		await connectWith(15, FOREIGN);
		await Promise.all([dbx.getStatus(A()), dbx.getStatus(A())]);
		await dbx.getStatus(A());
		expect(hoisted.bindingProbes).toBe(1);
	});

	it('bounds a FAILING probe the same way, so a wedged kernel is asked once per window', async () => {
		// The round-trip is unbounded from `sdkDbutilsState`'s point of view: a wedged
		// kernel settles only via the watchdog's probe/strike path (~90-210s), and this
		// is awaited inside `getStatus`. Single-flight collapses concurrent readers but
		// not sequential ones, so an uncached failure made EVERY later status read pay
		// that again. The cached failure still reads `unknown` and still never warns.
		hoisted.bindingThrows = true;
		await connectWith(18, FOREIGN);
		expect((await dbx.getStatus(A())).runtime.sdkDbutils).toBe('unknown');
		expect((await dbx.getStatus(A())).runtime.sdkDbutils).toBe('unknown');
		expect((await dbx.agentStatus(A())) as Record<string, unknown>).not.toHaveProperty(
			'dbutils_widgets_warning'
		);
		expect(hoisted.bindingProbes).toBe(1);
	});

	it('a cached failure never shadows the next genuine reading in a new session', async () => {
		hoisted.bindingThrows = true;
		await connectWith(19, FOREIGN);
		expect((await dbx.getStatus(A())).runtime.sdkDbutils).toBe('unknown');
		// A restart re-runs the shim installer, so the epoch moves and the cached
		// failure - which was about the previous namespace - cannot answer for it.
		hoisted.bindingThrows = false;
		hoisted.session = 20;
		expect((await dbx.getStatus(A())).runtime.sdkDbutils).toBe('foreign');
		expect(hoisted.bindingProbes).toBe(2);
	});

	it('reads an unusable answer as unknown rather than as a defect', async () => {
		// Over-reporting is the one direction this must not fail in: a warning over a
		// reading nobody obtained sends the user restarting a healthy kernel.
		await connectWith(16, { ok: false, message: 'boom' });
		expect((await dbx.getStatus(A())).runtime.sdkDbutils).toBe('unknown');
		expect((await dbx.agentStatus(A())) as Record<string, unknown>).not.toHaveProperty(
			'dbutils_widgets_warning'
		);
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

/**
 * The VERSION override rides the same wire, as its OWN fact.
 *
 * `CELLAR_DATABRICKS_RUNTIME_VERSION` resolves ahead of the stored version, so with it
 * set a version edit's apply-restart clears the user's namespace to advertise a value
 * the override discards - the same namespace-wiping no-op the on/off flag exists to
 * prevent, one control over. The two are INDEPENDENT (either can be set alone), so they
 * are reported separately and the card names whichever is actually in force.
 */
describe('getStatus reports whether the runtime VERSION is env-FORCED', () => {
	beforeEach(() => {
		delete process.env.CELLAR_DATABRICKS_RUNTIME;
		delete process.env.CELLAR_DATABRICKS_RUNTIME_VERSION;
	});

	it('reports null when no override is set - the stored version decides', async () => {
		await connectA();
		ui.setUiState({ [keys.DBX_RUNTIME_VERSION_KEY]: '14.3' });
		expect((await dbx.getStatus(A())).runtime.versionEnvForced).toBe(null);
		expect(ui.databricksRuntimeVersion()).toBe('14.3');
	});

	it('reports the forced version, and it outranks the stored one', async () => {
		await connectA();
		ui.setUiState({ [keys.DBX_RUNTIME_VERSION_KEY]: '14.3' });
		process.env.CELLAR_DATABRICKS_RUNTIME_VERSION = ' 17.0 ';
		expect((await dbx.getStatus(A())).runtime.versionEnvForced).toBe('17.0');
		// What the kernel would actually advertise is the override, so an edit of the
		// stored value can only ever be discarded - which is why the card must say so.
		expect(ui.databricksRuntimeVersion()).toBe('17.0');
	});

	it('is independent of the on/off override - either can be in force alone', async () => {
		await connectA();
		// Version forced, on/off left to the store.
		process.env.CELLAR_DATABRICKS_RUNTIME_VERSION = '13.3';
		let rt = (await dbx.getStatus(A())).runtime;
		expect(rt.versionEnvForced).toBe('13.3');
		expect(rt.envForced).toBe(null);

		// On/off forced, version left to the store.
		delete process.env.CELLAR_DATABRICKS_RUNTIME_VERSION;
		process.env.CELLAR_DATABRICKS_RUNTIME = '1';
		rt = (await dbx.getStatus(A())).runtime;
		expect(rt.versionEnvForced).toBe(null);
		expect(rt.envForced).toBe(true);
	});

	it('an empty override is not a decision - the store still decides', async () => {
		await connectA();
		process.env.CELLAR_DATABRICKS_RUNTIME_VERSION = '   ';
		expect((await dbx.getStatus(A())).runtime.versionEnvForced).toBe(null);
	});
});
