import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The AGENT's view of the Databricks runtime: reading it (`agentRuntimeBlock`) and
 * setting it (`setRuntimeAdvertisement`, the `databricks_runtime` tool).
 *
 * Two rules carry the weight here.
 *
 * 1. The block is read LIVE, never from the stored preference. The env is read at
 *    import time, so the two honestly diverge; reporting the preference would claim
 *    a runtime the running kernel does not have - the same reason the sidebar's
 *    Runtime card is live-derived.
 * 2. The restart is CONDITIONAL. Applying costs the user their whole namespace, so
 *    it may only happen where it changes something. Every no-op case below is a
 *    namespace that must survive.
 *
 * The kernel is mocked (a restart flips the epoch and what the session carries, as
 * a real one does) and the probe subprocess is mocked at `execute`; nothing contacts
 * a cluster. The preference store, the connect path and the inject decision are REAL
 * - the point is that what this predicts and what `initKernel` would do agree.
 */

const SENTINEL = '__CELLAR_DBX__';

const hoisted = vi.hoisted(() => ({
	dir: '',
	session: 1 as number | null,
	/** What the LIVE kernel session was started with - the one fact only a kernel knows. */
	liveRuntime: { started: true, version: null as string | null },
	restarts: 0
}));

vi.mock('../../src/lib/server/kernel', () => ({
	execute: async (_nb: string, code: string, onEvent: (e: unknown) => void) => {
		onEvent({ type: 'kernel', session: hoisted.session });
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
	currentSessionId: () => hoisted.session,
	kernelStatus: () => ({ status: 'idle', id: 'k1' }),
	liveDatabricksRuntime: () => hoisted.liveRuntime,
	// A restart re-reads the preference through the SAME gate `initKernel` uses, and
	// bumps the epoch. That is what makes "did it restart" observable here exactly as
	// the production code observes it.
	restartKernel: async () => {
		hoisted.restarts++;
		hoisted.session = (hoisted.session ?? 0) + 1;
		const inject = await import('../../src/lib/server/ui-state');
		const bound = (await import('../../src/lib/server/databricks')).databricksBound(A());
		hoisted.liveRuntime = {
			started: true,
			version: inject.injectDatabricksRuntime(bound) ? inject.databricksRuntimeVersion() : null
		};
		return { status: 'idle', id: 'k1', session_id: hoisted.session };
	},
	refreshKernelConnection: async () => ({ refreshed: false, reason: 'no_kernel' })
}));

vi.mock('../../src/lib/server/fstree', () => ({ workspaceRoot: () => hoisted.dir }));

let dbx: typeof import('../../src/lib/server/databricks');
let ui: typeof import('../../src/lib/server/ui-state');
let keys: typeof import('../../src/lib/server/databricksRuntime');
const A = () => join(hoisted.dir, 'a.ipynb');

beforeAll(async () => {
	hoisted.dir = mkdtempSync(join(tmpdir(), 'cellar-dbx-runtime-agent-'));
	const cfg = join(hoisted.dir, '.databrickscfg');
	writeFileSync(cfg, '[test]\nhost = https://test.databricks.com\ntoken = dummy-pat\n');
	process.env.DATABRICKS_CONFIG_FILE = cfg;
	process.env.CELLAR_WORKSPACE = hoisted.dir;
	delete process.env.CELLAR_DATABRICKS_RUNTIME;
	delete process.env.CELLAR_DATABRICKS_RUNTIME_VERSION;
	dbx = await import('../../src/lib/server/databricks');
	ui = await import('../../src/lib/server/ui-state');
	keys = await import('../../src/lib/server/databricksRuntime');
});

beforeEach(async () => {
	hoisted.session = 1;
	hoisted.liveRuntime = { started: true, version: null };
	hoisted.restarts = 0;
	delete process.env.CELLAR_DATABRICKS_RUNTIME;
	delete process.env.CELLAR_DATABRICKS_RUNTIME_VERSION;
	ui.setUiState({ [keys.DBX_RUNTIME_KEY]: null, [keys.DBX_RUNTIME_VERSION_KEY]: null });
	await dbx.disconnect(A());
});

const connectA = () =>
	dbx.connect({ profile: 'test', clusterId: '0725-abc', clusterName: 'Test Cluster', nb: A() });

describe('the runtime block an agent reads', () => {
	it('reports advertised:false when the kernel carries no runtime', async () => {
		expect(dbx.agentRuntimeBlock(A())).toEqual({ advertised: false, version: null, forced_by_env: false });
		// And it rides databricks_status even with NO session - the case it exists for:
		// a notebook gating on IS_DATABRICKS looks identical either way.
		const status = (await dbx.agentStatus(A())) as Record<string, unknown>;
		expect(status.connected).toBe(false);
		expect(status.runtime).toEqual({ advertised: false, version: null, forced_by_env: false });
	});

	it('reports the version the LIVE kernel carries, not the stored preference', async () => {
		// The preference says ON, but this kernel started before it was set. The honest
		// answer is what the running namespace has: nothing.
		ui.setUiState({ [keys.DBX_RUNTIME_KEY]: true });
		expect(dbx.agentRuntimeBlock(A()).advertised).toBe(false);

		hoisted.liveRuntime = { started: true, version: '15.4' };
		expect(dbx.agentRuntimeBlock(A())).toEqual({ advertised: true, version: '15.4', forced_by_env: false });
	});

	it('a kernel that has not started advertises nothing', () => {
		hoisted.liveRuntime = { started: false, version: null };
		expect(dbx.agentRuntimeBlock(A()).advertised).toBe(false);
	});

	it('flags an on/off decision held by the environment', () => {
		process.env.CELLAR_DATABRICKS_RUNTIME = '1';
		expect(dbx.agentRuntimeBlock(A()).forced_by_env).toBe(true);
		// The INDEPENDENT version override is not collapsed into that flag.
		delete process.env.CELLAR_DATABRICKS_RUNTIME;
		process.env.CELLAR_DATABRICKS_RUNTIME_VERSION = '14.3';
		expect(dbx.agentRuntimeBlock(A()).forced_by_env).toBe(false);
	});
});

describe('databricks_runtime applies the advertisement', () => {
	it('turns it on for a connected notebook, restarting the kernel and saying so', async () => {
		await connectA();
		// Connecting alone advertises nothing (the deliberate reversal).
		expect(dbx.agentRuntimeBlock(A()).advertised).toBe(false);

		const r = await dbx.setRuntimeAdvertisement({ enable: true, nb: A() });
		expect(hoisted.restarts).toBe(1);
		expect(r.kernel_restarted).toBe(true);
		expect(r.namespace_cleared).toBe(true);
		expect(r.runtime).toEqual({ advertised: true, version: '15.4', forced_by_env: false });
		expect(r.note).toMatch(/IS_DATABRICKS/);
		// The preference really is what a future kernel start would read.
		expect(ui.injectDatabricksRuntime(true)).toBe(true);
	});

	it('accepts a version and advertises it', async () => {
		await connectA();
		const r = await dbx.setRuntimeAdvertisement({ enable: true, version: '14.3', nb: A() });
		expect(r.runtime).toEqual({ advertised: true, version: '14.3', forced_by_env: false });
		expect(ui.databricksRuntimeVersion()).toBe('14.3');
	});

	it('turns it off, restarting the kernel', async () => {
		await connectA();
		await dbx.setRuntimeAdvertisement({ enable: true, nb: A() });
		hoisted.restarts = 0;

		const r = await dbx.setRuntimeAdvertisement({ enable: false, nb: A() });
		expect(hoisted.restarts).toBe(1);
		expect(r.kernel_restarted).toBe(true);
		expect(r.runtime.advertised).toBe(false);
	});

	// Every case below is a namespace the user keeps.
	it('is a NO-OP when the kernel already carries the requested state', async () => {
		await connectA();
		await dbx.setRuntimeAdvertisement({ enable: true, nb: A() });
		hoisted.restarts = 0;

		const again = await dbx.setRuntimeAdvertisement({ enable: true, nb: A() });
		expect(hoisted.restarts).toBe(0);
		expect(again.kernel_restarted).toBe(false);
		expect(again.namespace_cleared).toBe(false);
		expect(again.runtime.advertised).toBe(true);
		expect(again.note).toMatch(/nothing to apply/i);
	});

	it('does not restart when disabling something that was never advertised', async () => {
		await connectA();
		const r = await dbx.setRuntimeAdvertisement({ enable: false, nb: A() });
		expect(hoisted.restarts).toBe(0);
		expect(r.kernel_restarted).toBe(false);
	});

	it('stores but does not apply (or restart) on a notebook with no Databricks session', async () => {
		const r = await dbx.setRuntimeAdvertisement({ enable: true, nb: A() });
		expect(hoisted.restarts).toBe(0);
		expect(r.kernel_restarted).toBe(false);
		expect(r.runtime.advertised).toBe(false);
		// It must SAY the preference did not take effect, not report a bare success.
		expect(r.note).toMatch(/not connected/i);
		// …and the preference is genuinely stored, so connecting + applying picks it up.
		expect(ui.injectDatabricksRuntime(true)).toBe(true);
	});

	it('does not restart a notebook whose kernel has not started', async () => {
		await connectA();
		hoisted.liveRuntime = { started: false, version: null };
		const r = await dbx.setRuntimeAdvertisement({ enable: true, nb: A() });
		expect(hoisted.restarts).toBe(0);
		expect(r.kernel_restarted).toBe(false);
		expect(r.note).toMatch(/next time/i);
	});

	it('refuses when the environment holds the decision, restarting nothing', async () => {
		await connectA();
		process.env.CELLAR_DATABRICKS_RUNTIME = '0';
		await expect(dbx.setRuntimeAdvertisement({ enable: true, nb: A() })).rejects.toMatchObject({
			code: 'runtime_env_forced'
		});
		expect(hoisted.restarts).toBe(0);
	});

	it('reports a version the environment overrides rather than silently dropping it', async () => {
		await connectA();
		process.env.CELLAR_DATABRICKS_RUNTIME_VERSION = '13.3';
		const r = await dbx.setRuntimeAdvertisement({ enable: true, version: '14.3', nb: A() });
		expect(r.version_forced_by_env).toBe('13.3');
		expect(r.runtime.version).toBe('13.3');
		expect(r.note).toMatch(/CELLAR_DATABRICKS_RUNTIME_VERSION/);
	});
});

describe('databricks_connect names the runtime it does NOT set', () => {
	it('cross-references the separate toggle in its note', async () => {
		const r = (await dbx.connectCluster({
			clusterId: '0725-abc',
			clusterName: 'Test Cluster',
			profile: 'test',
			nb: A()
		})) as Record<string, unknown>;
		expect(String(r.note)).toMatch(/does NOT advertise a Databricks runtime/);
		expect(String(r.note)).toMatch(/databricks_runtime/);
	});
});

/**
 * The description is the ONLY place a model meets the reasoning that lives in
 * `databricksRuntime.ts`'s header, so the four claims it turns on are pinned here.
 * A source guard, because e2e is deliberately absent from CI and the no-mistakes
 * gate - a wire-only assertion would let a lost claim merge green.
 */
describe('the databricks_runtime description carries its rationale', () => {
	it('states the mechanism, the branch it changes, the mlflow reach, and the cost', async () => {
		const { readFileSync } = await import('node:fs');
		const src = readFileSync(new URL('../../src/lib/server/mcp/server.ts', import.meta.url), 'utf8');
		const line = src.slice(src.indexOf("registerTool('databricks_runtime'")).split('\n')[0];

		expect(line).toMatch(/DATABRICKS_RUNTIME_VERSION/); // 1. what it sets
		expect(line).toMatch(/IS_DATABRICKS/); //             …and the gate that reads it
		expect(line).toMatch(/dbutils\.widgets/); //          2. the branch that changes
		expect(line).toMatch(/cannot work inside a kernel/); //   …and why the other one is unusable
		expect(line).toMatch(/is_in_databricks_runtime/); //  3. it is not only your own gate
		expect(line).toMatch(/RESTARTS the kernel/); //       4. the cost of applying
		expect(line).toMatch(/namespace_cleared/); //             …reported the way connect reports it

		// Paid on every session, so a correction has to be bought by cutting words.
		// Sits with its databricks siblings (~1.1-1.7k), not above them.
		const desc = line.match(/description: '(.*?)', inputSchema/);
		expect(desc, 'the description stays a single-quoted one-line literal').toBeTruthy();
		expect(desc![1].length).toBeLessThan(1800);
	});

	it('INSTRUCTIONS tells an agent that connected is not the same as on Databricks', async () => {
		const { readFileSync } = await import('node:fs');
		const src = readFileSync(new URL('../../src/lib/server/mcp/server.ts', import.meta.url), 'utf8');
		const clause = src.slice(src.indexOf('CONNECTED IS NOT THE SAME'), src.indexOf('RECONNECT CAN RESTART'));
		expect(clause).toMatch(/runtime:\{advertised, version, forced_by_env\}/);
		expect(clause).toMatch(/Connecting a cluster deliberately does NOT set it/);
		expect(clause).toMatch(/databricks_runtime\(enable:true\)/);
	});
});

/**
 * The human's Runtime toggle must be able to see what the agent just wrote. It seeds
 * from the SERVER's copy of the preference (`getStatus().runtime.preference`), not a
 * one-shot browser read, because a stale toggle here is destructive: clicking it
 * applies the NEGATION, so an OFF toggle over an ON preference restarts the kernel
 * and clears the namespace to change nothing.
 */
describe('the sidebar can re-seed its toggle after an agent writes the preference', () => {
	it('getStatus reports the stored preference, and the tool moves it', async () => {
		expect((await dbx.getStatus(A())).runtime.preference).toBe(false);
		await connectA();
		await dbx.setRuntimeAdvertisement({ enable: true, nb: A() });
		expect((await dbx.getStatus(A())).runtime.preference).toBe(true);
		await dbx.setRuntimeAdvertisement({ enable: false, nb: A() });
		expect((await dbx.getStatus(A())).runtime.preference).toBe(false);
	});

	it('reports the STORED preference, not the env override (which the card states separately)', async () => {
		ui.setUiState({ [keys.DBX_RUNTIME_KEY]: false });
		process.env.CELLAR_DATABRICKS_RUNTIME = '1';
		const r = (await dbx.getStatus(A())).runtime;
		expect(r.preference).toBe(false); // what the toggle reflects
		expect(r.envForced).toBe(true); // what is actually in force
	});

	it('the panel re-seeds from it, and only while nothing is in flight', async () => {
		const { readFileSync } = await import('node:fs');
		const src = readFileSync(new URL('../../src/lib/Databricks.svelte', import.meta.url), 'utf8');
		const effect = src.slice(src.indexOf('const stored = status?.runtime?.preference'));
		expect(effect.slice(0, 260)).toMatch(/runtimeApplying \|\| busy/); // no bounce mid-apply
		expect(effect.slice(0, 260)).toMatch(/runtimeOn = stored/);
	});
});
