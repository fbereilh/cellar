import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Databricks Connect version-mismatch handling, exercised through the REAL
 * `connect()` (not just the pure helpers in `dbr-version.test.ts`).
 *
 * Databricks Connect requires the client version to be ≤ the target cluster's
 * runtime; a newer client hard-fails with "Unsupported combination of Databricks
 * Runtime & Databricks Connect versions". When Part A could not pre-pin (here the
 * project venv is unresolved, so the DBR probe / reinstall are no-ops), a genuine
 * mismatch must NOT surface as the raw SDK `session_failed` exception — Part B
 * catches it, and `connect()` throws a dedicated `version_mismatch` error whose
 * message is actionable (names both versions and the exact `==X.Y.*` pin).
 *
 * The kernel is fully mocked, like databricks-restart-reconnect.test: CONNECT_CODE
 * returns whatever sentinel payload the test set. No venv is bound
 * (`CELLAR_PROJECT_VENV` unset, workspace has no `.venv`), so `clusterDbr` /
 * `ensurePinnedConnect` short-circuit without spawning python — isolating the
 * detection + message wiring.
 */

const SENTINEL = '__CELLAR_DBX__';

const state = vi.hoisted(() => ({
	connect: { ok: true, host: 'https://test.databricks.com', spark_version: '3.5.0' } as Record<
		string,
		unknown
	>
}));

vi.mock('../../src/lib/server/kernel', () => ({
	execute: async (nbPath: string, code: string, onEvent: (e: unknown) => void) => {
		onEvent({ type: 'kernel', session: 1 });
		let payload: Record<string, unknown>;
		if (code.includes('_cellar_dbx_connect')) payload = state.connect;
		else if (code.includes('databricks.connect')) payload = { ok: true, imported: false };
		else payload = { ok: true };
		onEvent({
			type: 'output',
			output: { output_type: 'stream', name: 'stdout', text: SENTINEL + JSON.stringify(payload) + '\n' }
		});
		return {};
	},
	currentSessionId: () => 1,
	kernelStatus: () => ({ status: 'idle', id: 'k1' }),
	restartKernel: async () => ({ status: 'idle', id: 'k1', session_id: 1 })
}));

let dbx: typeof import('../../src/lib/server/databricks');
let dir: string;
const NB = () => join(dir, 'n.ipynb');

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), 'cellar-dbx-vpin-'));
	writeFileSync(join(dir, '.databrickscfg'), '[test]\nhost = https://test.databricks.com\ntoken = dummy-pat\n');
	process.env.DATABRICKS_CONFIG_FILE = join(dir, '.databrickscfg');
	process.env.CELLAR_WORKSPACE = dir;
	// No project venv bound → the DBR probe + version pin are inert no-ops here, so
	// the test isolates Part B's mismatch detection/message from the reinstall path.
	delete process.env.CELLAR_PROJECT_VENV;
	dbx = await import('../../src/lib/server/databricks');
});

beforeEach(async () => {
	await dbx.disconnect(NB());
});

describe('connect() version-mismatch safety net (Part B)', () => {
	it('turns the raw session_failed mismatch into an actionable version_mismatch error', async () => {
		state.connect = {
			ok: false,
			code: 'session_failed',
			message:
				'Exception: Unsupported combination of Databricks Runtime & Databricks Connect versions: ' +
				'17.3 (Databricks Runtime) < 18.3.2 (Databricks Connect).'
		};

		await expect(dbx.connect({ profile: 'test', clusterId: '0725-abc', clusterName: 'C', nb: NB() }))
			.rejects.toMatchObject({
				code: 'version_mismatch',
				// Names the offending client, the cluster runtime, and the exact pin.
				message: expect.stringContaining('databricks-connect==17.3.*')
			});

		// The connection is left cleanly disconnected, not half-open.
		expect(dbx.connectionStatus(NB()).connected).toBe(false);
	});

	it('leaves an unrelated session_failed error untouched (still session_failed)', async () => {
		state.connect = {
			ok: false,
			code: 'session_failed',
			message: 'Exception: cluster is TERMINATED and cannot be started by this account'
		};

		await expect(dbx.connect({ profile: 'test', clusterId: '0725-abc', clusterName: 'C', nb: NB() }))
			.rejects.toMatchObject({ code: 'session_failed' });
	});

	it('connects normally when there is no mismatch', async () => {
		state.connect = { ok: true, host: 'https://test.databricks.com', spark_version: '3.5.0' };
		const res = await dbx.connect({ profile: 'test', clusterId: '0725-abc', clusterName: 'C', nb: NB() });
		expect(res.ok).toBe(true);
		expect(dbx.connectionStatus(NB()).connected).toBe(true);
	});
});
