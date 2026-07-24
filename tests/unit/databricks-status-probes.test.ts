import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `getStatus` is POLLED, so its workspace-level probes must be memoized.
 *
 * The sidebar re-reads `/api/databricks` every ~1.2s for as long as a kernel-restart
 * rebuild is in flight, and that window is unbounded (a cold-cluster reconnect takes
 * minutes). Each read used to spawn TWO subprocesses - `uv --version`, and a
 * project-venv python that imports databricks-sdk - on the same Node process that
 * streams kernel output, SSE and every MCP session, with a python import able to
 * outlast the interval so the spawns overlapped.
 *
 * These pin the three properties that bound it, and the one that keeps it honest:
 *   - repeated reads inside the TTL measure ONCE;
 *   - concurrent reads share ONE in-flight probe (they never overlap);
 *   - past the TTL a read re-measures, so the answer cannot go stale forever;
 *   - an install invalidates it, so the sidebar never serves a pre-install
 *     "packages missing" over a venv that now has the packages.
 *
 * `hasUv` is mocked as the counter. `isValidVenv` is mocked false so `projectPython()`
 * resolves to null and `checkInstall` short-circuits - the point here is the caching
 * seam, not the SDK import.
 */

const probes = vi.hoisted(() => ({ uvCalls: 0, gate: null as Promise<void> | null }));

vi.mock('../../src/lib/server/venv.js', () => ({
	hasUv: async () => {
		probes.uvCalls++;
		if (probes.gate) await probes.gate;
		return true;
	},
	installPackages: async () => {},
	isValidVenv: () => false,
	venvPython: (dir: string) => join(dir, 'bin', 'python')
}));

vi.mock('../../src/lib/server/kernel', () => ({
	execute: async () => ({}),
	currentSessionId: () => 1,
	kernelStatus: () => ({ status: 'idle', id: 'k1' }),
	liveDatabricksRuntime: () => ({ started: true, version: null })
}));

let dbx: typeof import('../../src/lib/server/databricks');
let dir: string;

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), 'cellar-dbx-probes-'));
	const cfg = join(dir, '.databrickscfg');
	writeFileSync(cfg, '[test]\nhost = https://test.databricks.com\ntoken = dummy-pat\n');
	process.env.DATABRICKS_CONFIG_FILE = cfg;
	process.env.CELLAR_WORKSPACE = dir;
	delete process.env.CELLAR_PROJECT_VENV;
	dbx = await import('../../src/lib/server/databricks');
});

let clockOffset = 0;
beforeEach(() => {
	const realNow = Date.now.bind(Date);
	clockOffset = 0;
	vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffset);
	probes.uvCalls = 0;
	probes.gate = null;
	dbx.invalidateWorkspaceProbes();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('getStatus workspace probes are memoized', () => {
	it('measures once for a burst of polls inside the TTL', async () => {
		const first = await dbx.getStatus(join(dir, 'a.ipynb'));
		expect(first.uv).toBe(true);
		for (let i = 0; i < 9; i++) {
			clockOffset += 400; // ~4s of the sidebar's restart re-check cadence
			const st = await dbx.getStatus(join(dir, 'a.ipynb'));
			expect(st.uv).toBe(true);
		}
		expect(probes.uvCalls).toBe(1);
	});

	it('never runs two probes at once', async () => {
		// Hold the probe open the way a real python import outlasting the poll does.
		let open!: () => void;
		probes.gate = new Promise<void>((r) => (open = r));
		const reads = [dbx.getStatus(), dbx.getStatus(), dbx.getStatus()];
		await new Promise((r) => setTimeout(r, 0));
		expect(probes.uvCalls).toBe(1);
		probes.gate = null;
		open();
		for (const st of await Promise.all(reads)) expect(st.uv).toBe(true);
		expect(probes.uvCalls).toBe(1);
	});

	it('re-measures once the TTL lapses, so the answer cannot go stale forever', async () => {
		await dbx.getStatus();
		clockOffset += 10_000;
		await dbx.getStatus();
		expect(probes.uvCalls).toBe(2);
	});

	it('re-measures immediately after an install invalidates it', async () => {
		await dbx.getStatus();
		expect(probes.uvCalls).toBe(1);
		dbx.invalidateWorkspaceProbes();
		await dbx.getStatus();
		expect(probes.uvCalls).toBe(2);
	});
});
