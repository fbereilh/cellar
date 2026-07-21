import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * The "Databricks runtime" toggle survives a kernel restart of a CONNECTED
 * notebook. This is the fix for the bug where, with the toggle ON and the notebook
 * bound to a cluster, a kernel restart left `DATABRICKS_RUNTIME_VERSION` unset (so
 * a notebook's import-time `IS_DATABRICKS` gate read False and its parser took the
 * local `tyro` path instead of the `dbutils.widgets` path).
 *
 * Two layers, because the root cause was subtle:
 *
 *  1. The GATE is durable. `kernel.ts`'s `initKernel` injects the runtime env when
 *     `databricksBound(nb)` is true, and `databricksBound` reads the DURABLE
 *     `reconnectTarget` (set on connect, kept across a kernel restart) - NOT the
 *     live connection, which `connectionStatus()` nulls the moment the epoch bumps.
 *     So a bound notebook that just restarted (connection null, reconnect pending)
 *     still injects the env. Guarded below by asserting `databricksBound` stays
 *     true while `connectionStatus().connected` reads false post-restart.
 *
 *  2. The real bug was the SCRUB. The auto-reconnect that runs right after
 *     `initKernel` executes `CONNECT_CODE` in the SAME kernel, and that code scrubs
 *     every `DATABRICKS_*` var from `os.environ` - popping the runtime version
 *     `initKernel` had just injected. The scrub is required (databricks-connect
 *     refuses to build a REMOTE session while it believes it is on a runtime), so
 *     the fix preserves `DATABRICKS_RUNTIME_VERSION` across the scrub + session
 *     build and restores it afterward. Guarded below by running the REAL generated
 *     `CONNECT_CODE` in a plain Python interpreter and asserting the runtime var
 *     survives while a stale auth var (`DATABRICKS_HOST`) is still scrubbed.
 *
 * The kernel is mocked (per-notebook epoch, sentinel JSON), so no live cluster is
 * needed. The mock also CAPTURES the connect code so layer (2) can run it for real.
 */

const SENTINEL = '__CELLAR_DBX__';

const state = vi.hoisted(() => ({
	/** Epoch per notebook absolute path (bump to simulate a kernel restart). */
	sessions: new Map<string, number | null>(),
	globalSession: 1 as number | null,
	/** The most recent code string the mocked kernel was asked to execute for connect. */
	lastConnectCode: '' as string
}));

vi.mock('../../src/lib/server/kernel', () => {
	const sess = (nb?: string | null): number | null =>
		nb != null && state.sessions.has(nb) ? (state.sessions.get(nb) as number | null) : state.globalSession;
	return {
		execute: async (nbPath: string, code: string, onEvent: (e: unknown) => void) => {
			if (code.includes('_cellar_dbx_connect')) state.lastConnectCode = code;
			onEvent({ type: 'kernel', session: sess(nbPath) });
			let payload: Record<string, unknown>;
			if (code.includes('_cellar_dbx_ping')) payload = { ok: true, alive: true, expired: false };
			else if (code.includes('_cellar_dbx_connect'))
				payload = { ok: true, host: 'https://test.databricks.com', spark_version: '3.5.0' };
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
			status: 'idle',
			id: sess(nbPath) == null ? null : 'k1'
		}),
		restartKernel: async () => ({ status: 'idle', id: 'k1', session_id: 1 })
	};
});

let dbx: typeof import('../../src/lib/server/databricks');
let NB: string;

beforeAll(async () => {
	const dir = mkdtempSync(join(tmpdir(), 'cellar-dbx-rt-'));
	const cfg = join(dir, '.databrickscfg');
	writeFileSync(cfg, '[test]\nhost = https://test.databricks.com\ntoken = dummy-pat\n');
	process.env.DATABRICKS_CONFIG_FILE = cfg;
	process.env.CELLAR_WORKSPACE = dir;
	NB = join(dir, 'notebook.ipynb'); // resolveNotebookPath(undefined) → canonical default
	dbx = await import('../../src/lib/server/databricks');
});

beforeEach(async () => {
	state.globalSession = 1;
	state.sessions.clear();
	state.lastConnectCode = '';
	await dbx.disconnect();
});

describe('the injection gate is durable (databricksBound survives a restart)', () => {
	it('databricksBound stays true after a restart while the live connection reads false', async () => {
		await dbx.connect({ profile: 'test', clusterId: '0725-abc', clusterName: 'Test Cluster' });
		expect(dbx.connectionStatus().connected).toBe(true);
		expect(dbx.databricksBound()).toBe(true);

		// Simulate a kernel restart: the epoch bumps. `connectionStatus()` reconciles
		// the live connection to disconnected, but the durable reconnect intent stays -
		// which is exactly the state `initKernel` reads when it decides to inject the
		// runtime env on a bound restart.
		state.globalSession = 2;
		expect(dbx.connectionStatus().connected).toBe(false);
		expect(dbx.databricksBound()).toBe(true);
	});

	it('databricksBound is false for a notebook that never connected (local kernel not spoofed)', () => {
		expect(dbx.databricksBound()).toBe(false);
	});
});

describe('CONNECT_CODE preserves DATABRICKS_RUNTIME_VERSION across the env scrub', () => {
	it('restores the injected runtime var while still scrubbing stale auth vars', async () => {
		// Capture the REAL generated connect code the kernel would run.
		await dbx.connect({ profile: 'test', clusterId: '0725-abc', clusterName: 'Test Cluster' });
		const connectCode = state.lastConnectCode;
		expect(connectCode).toContain('_cellar_dbx_connect');

		const py = spawnSync('python3', ['--version'], { encoding: 'utf8' });
		if (py.status !== 0) {
			// No python3 available (should not happen in CI); the structural guard below
			// still asserts the fix is present in the generated code.
			expect(connectCode).toContain("os.environ.get('DATABRICKS_RUNTIME_VERSION')");
			expect(connectCode).toContain("os.environ['DATABRICKS_RUNTIME_VERSION'] = _cellar_saved_runtime");
			return;
		}

		// Run the actual CONNECT_CODE in a plain interpreter (no databricks SDK needed:
		// the scrub runs before the SDK import, and the restore runs in the finally
		// regardless of how connect fails), then report which DATABRICKS_* vars remain.
		const script =
			connectCode +
			'\nimport os as _chk\nprint("__ENVCHECK__" + repr(sorted(k for k in _chk.environ if k.startswith("DATABRICKS_"))))\n';
		const run = spawnSync('python3', ['-c', script], {
			encoding: 'utf8',
			env: {
				...process.env,
				DATABRICKS_RUNTIME_VERSION: '15.4', // what initKernel injected
				DATABRICKS_HOST: 'https://stale.example.com' // a stale auth var that MUST be scrubbed
			}
		});
		expect(run.error).toBeUndefined();
		const line = (run.stdout || '').split('\n').find((l) => l.startsWith('__ENVCHECK__'));
		expect(line, `no ENVCHECK line; stderr:\n${run.stderr}`).toBeTruthy();
		const remaining = line!.slice('__ENVCHECK__'.length);
		// The runtime advertisement survives (so IS_DATABRICKS stays True) ...
		expect(remaining).toContain('DATABRICKS_RUNTIME_VERSION');
		// ... while a stale auth var is still removed by the scrub.
		expect(remaining).not.toContain('DATABRICKS_HOST');
	});
});
