import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * `DATABRICKS_CLUSTER_ID` - the second half of "a connected notebook exposes what
 * it connected to".
 *
 * Cellar passes its cluster inside its own `Config`, which lives nowhere a SECOND
 * resolution can look. So even once a user's library resolves credentials, its
 * `DatabricksSession.builder.getOrCreate()` had nothing to attach to and failed
 * with "Cluster id or serverless are required but were not specified." - which is
 * why `databricks.sdk.runtime.spark` is `None` in a Cellar kernel. Publishing the
 * id closes that, and makes `getOrCreate()` hand back THIS session rather than
 * building a second one.
 *
 * The ordering constraint is the whole risk, so it is what this pins hardest: the
 * var may only appear AFTER the session is built. The scrub at the top of
 * `CONNECT_CODE` is load-bearing - databricks-connect refuses to build a REMOTE
 * session while a `DATABRICKS_*` runtime advertisement is in the env - so setting
 * it any earlier (or via a `KEEP_ENV` entry) would re-break connect. A structural
 * assertion cannot see that; only running the code and asking the session builder
 * what it saw can.
 *
 * The REAL generated `CONNECT_CODE` / `DISCONNECT_CODE` is executed in a plain
 * interpreter against a FAKE `databricks` package that records the env at each
 * step. No cluster, no workspace, no credentials.
 */

const SENTINEL = '__CELLAR_DBX__';

const state = vi.hoisted(() => ({
	lastConnectCode: '' as string,
	lastDisconnectCode: '' as string
}));

vi.mock('../../src/lib/server/kernel', () => ({
	execute: async (nbPath: string, code: string, onEvent: (e: unknown) => void) => {
		if (code.includes('_cellar_dbx_connect')) state.lastConnectCode = code;
		if (code.includes('_cellar_dbx_disconnect')) state.lastDisconnectCode = code;
		onEvent({ type: 'kernel', session: 1 });
		let payload: Record<string, unknown> = { ok: true };
		if (code.includes('_cellar_dbx_connect'))
			payload = { ok: true, host: 'https://test.databricks.com', spark_version: '3.5.0' };
		else if (code.includes('_cellar_dbx_disconnect')) payload = { ok: true, stopped: true };
		else if (code.includes('_cellar_dbx_ping')) payload = { ok: true, alive: true, expired: false };
		onEvent({
			type: 'output',
			output: { output_type: 'stream', name: 'stdout', text: SENTINEL + JSON.stringify(payload) + '\n' }
		});
		return {};
	},
	currentSessionId: () => 1,
	kernelStatus: () => ({ status: 'idle', id: 'k1' }),
	restartKernel: async () => ({ status: 'idle', id: 'k1', session_id: 1 }),
	refreshKernelConnection: vi.fn(),
	liveDatabricksRuntime: () => ({ started: true, version: null })
}));

let dbx: typeof import('../../src/lib/server/databricks');
let dir: string;
let fakeRoot: string;
/** Where the fake package writes what it observed. */
let recordPath: string;

const CLUSTER_A = '0725-111111-aaaaaaaa';
const CLUSTER_B = '0930-222222-bbbbbbbb';

/**
 * A fake `databricks` package good enough for `CONNECT_CODE` to run end to end.
 *
 * `DatabricksSession.builder...getOrCreate()` is the point of it: it records
 * whether `DATABRICKS_CLUSTER_ID` was in the environment AT BUILD TIME, which is
 * the only way to prove the var is published after the build rather than before.
 * `CELLAR_FAKE_FAIL_BUILD` makes that step raise, so the failure path can be
 * checked too.
 */
function writeFakePackage(root: string, record: string) {
	const pkg = join(root, 'databricks');
	mkdirSync(join(pkg, 'sdk'), { recursive: true });
	mkdirSync(join(pkg, 'connect'), { recursive: true });
	const note = [
		'import json, os',
		`RECORD = ${JSON.stringify(record)}`,
		'def note(event):',
		'    try:',
		'        data = json.load(open(RECORD))',
		'    except Exception:',
		'        data = []',
		'    data.append({"event": event, "cluster_id_env": os.environ.get("DATABRICKS_CLUSTER_ID")})',
		'    json.dump(data, open(RECORD, "w"))',
		''
	].join('\n');
	writeFileSync(join(pkg, '__init__.py'), '');
	writeFileSync(join(pkg, '_rec.py'), note);
	writeFileSync(
		join(pkg, 'sdk', '__init__.py'),
		[
			'from databricks._rec import note',
			'class _Cfg:',
			'    def __init__(self, host):',
			'        self.host = host',
			'class WorkspaceClient:',
			'    def __init__(self, config=None):',
			'        note("workspace_client")',
			'        self.config = _Cfg("https://fake.cloud.databricks.com")',
			''
		].join('\n')
	);
	writeFileSync(
		join(pkg, 'sdk', 'core.py'),
		[
			'from databricks._rec import note',
			'class Config:',
			'    def __init__(self, **kw):',
			'        note("config")',
			'        self.kw = kw',
			''
		].join('\n')
	);
	writeFileSync(
		join(pkg, 'connect', '__init__.py'),
		[
			'import os',
			'from databricks._rec import note',
			'class _Session:',
			'    version = "3.5.0"',
			'    def clearProgressHandlers(self): pass',
			'    def registerProgressHandler(self, cb): pass',
			'    def stop(self): note("stop")',
			'class _Builder:',
			'    def sdkConfig(self, cfg): return self',
			'    def getOrCreate(self):',
			'        # The load-bearing observation: what did the env look like while the',
			'        # remote session was being constructed?',
			'        note("build")',
			'        if os.environ.get("CELLAR_FAKE_FAIL_BUILD"):',
			'            raise RuntimeError("fake build failure")',
			'        return _Session()',
			'class DatabricksSession:',
			'    builder = _Builder()',
			''
		].join('\n')
	);
}

/** Run generated kernel code in a plain interpreter and report the resulting env. */
function runKernelCode(code: string, env: Record<string, string> = {}) {
	if (existsSync(recordPath)) rmSync(recordPath);
	const script =
		code +
		'\nimport os as _chk, json as _cj' +
		'\nprint("__ENV__" + _cj.dumps({k: v for k, v in _chk.environ.items() if k.startswith("DATABRICKS_")}))\n';
	const run = spawnSync('python3', ['-c', script], {
		encoding: 'utf8',
		env: {
			...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('DATABRICKS_'))),
			PYTHONPATH: fakeRoot,
			...env
		} as NodeJS.ProcessEnv
	});
	expect(run.error).toBeUndefined();
	const line = (run.stdout || '').split('\n').find((l) => l.startsWith('__ENV__'));
	expect(line, `no __ENV__ line; stdout:\n${run.stdout}\nstderr:\n${run.stderr}`).toBeTruthy();
	const sentinel = (run.stdout || '').split('\n').find((l) => l.includes(SENTINEL));
	return {
		env: JSON.parse(line!.slice('__ENV__'.length)) as Record<string, string>,
		/** What the kernel code reported back to Cellar. */
		result: sentinel ? JSON.parse(sentinel.slice(sentinel.indexOf(SENTINEL) + SENTINEL.length)) : null,
		/** Ordered observations from the fake package. */
		steps: existsSync(recordPath)
			? (JSON.parse(readFileSync(recordPath, 'utf8')) as Array<{ event: string; cluster_id_env: string | null }>)
			: []
	};
}

/** Generate a real CONNECT_CODE by driving the real `connect()` past the mocked kernel. */
async function connectCode(clusterId: string, opts: { host?: boolean } = {}) {
	state.lastConnectCode = '';
	await dbx.disconnect();
	await dbx.connect(
		opts.host
			? { host: 'https://typed.cloud.databricks.com', clusterId, clusterName: 'Typed' }
			: { profile: 'test', clusterId, clusterName: 'Test Cluster' }
	);
	expect(state.lastConnectCode).toContain('_cellar_dbx_connect');
	return state.lastConnectCode;
}

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), 'cellar-dbx-cluster-'));
	const cfg = join(dir, '.databrickscfg');
	writeFileSync(cfg, '[test]\nhost = https://test.databricks.com\ntoken = dummy-pat\n');
	process.env.DATABRICKS_CONFIG_FILE = cfg;
	process.env.CELLAR_WORKSPACE = dir;
	fakeRoot = join(dir, 'fakepkgs');
	recordPath = join(dir, 'record.json');
	writeFakePackage(fakeRoot, recordPath);
	dbx = await import('../../src/lib/server/databricks');

	// A python3 that can run the generated code is a hard requirement here: the
	// ordering claim is only observable by executing it.
	const py = spawnSync('python3', ['-c', 'import sys; print(sys.version)'], { encoding: 'utf8' });
	expect(py.status, 'python3 is required to exercise the generated kernel code').toBe(0);
});

beforeEach(async () => {
	await dbx.disconnect();
});

describe('connect publishes the cluster id, and only after the session is built', () => {
	it('sets DATABRICKS_CLUSTER_ID to the connected cluster', async () => {
		const { env, result } = runKernelCode(await connectCode(CLUSTER_A));
		expect(result).toMatchObject({ ok: true });
		expect(env.DATABRICKS_CLUSTER_ID).toBe(CLUSTER_A);
	});

	it('the session is built with the var ABSENT - the scrub still owns the build', async () => {
		// The constraint the whole placement exists for. Setting the id any earlier -
		// or keeping one through `KEEP_ENV` - would put a DATABRICKS_* var in the env
		// while databricks-connect constructs a REMOTE session, which is what the scrub
		// is there to prevent. Asserted from inside the builder, not from the source.
		const { steps, env } = runKernelCode(await connectCode(CLUSTER_A), {
			// A stale value in the kernel's env before connect: the scrub must remove it
			// so the build cannot see it either.
			DATABRICKS_CLUSTER_ID: 'stale-0000-cccccccc'
		});
		const build = steps.find((s) => s.event === 'build');
		expect(build, `no build step recorded; steps: ${JSON.stringify(steps)}`).toBeTruthy();
		expect(build!.cluster_id_env).toBeNull();
		// ... and every earlier step too, so nothing can creep in above the build.
		for (const s of steps.slice(0, steps.indexOf(build!) + 1)) expect(s.cluster_id_env).toBeNull();
		// The stale value is gone, replaced by the one actually connected.
		expect(env.DATABRICKS_CLUSTER_ID).toBe(CLUSTER_A);
	});

	it('reconnecting to a different cluster rewrites it', async () => {
		expect(runKernelCode(await connectCode(CLUSTER_A)).env.DATABRICKS_CLUSTER_ID).toBe(CLUSTER_A);
		// The kernel keeps its env across cells, so the second connect starts with the
		// first one's value present - exactly the stale-id case.
		const second = runKernelCode(await connectCode(CLUSTER_B), { DATABRICKS_CLUSTER_ID: CLUSTER_A });
		expect(second.env.DATABRICKS_CLUSTER_ID).toBe(CLUSTER_B);
	});

	it('a FAILED session build leaves no cluster id behind', async () => {
		// Nothing is connected, so a leftover id would silently point a later bare
		// getOrCreate() at a cluster this kernel never reached.
		const { env, result } = runKernelCode(await connectCode(CLUSTER_A), {
			DATABRICKS_CLUSTER_ID: 'stale-0000-cccccccc',
			CELLAR_FAKE_FAIL_BUILD: '1'
		});
		expect(result).toMatchObject({ ok: false, code: 'session_failed' });
		expect(env.DATABRICKS_CLUSTER_ID).toBeUndefined();
	});

	it('host mode publishes it too - a cluster id has no profile dependency', async () => {
		// A typed host is held behind `assertSignedIn`, and Cellar's sign-in opens a
		// browser. So the sign-in is satisfied by pointing the metadata subprocess at a
		// STUB interpreter that answers the `login` op - the same device
		// `databricks-logout.test.ts` uses - which records the host and opens nothing.
		// Scoped to this call: it is restored immediately, so every other test still
		// runs with no project interpreter at all.
		const stub = join(dir, 'stub-python');
		writeFileSync(
			stub,
			`#!/bin/sh\nprintf '${SENTINEL}{"ok":true,"host":"https://typed.cloud.databricks.com","user":"tester"}\\n'\n`,
			{ mode: 0o755 }
		);
		const saved = process.env.CELLAR_PROJECT_VENV;
		process.env.CELLAR_PROJECT_VENV = stub;
		try {
			await dbx.login({ host: 'https://typed.cloud.databricks.com' });
		} finally {
			if (saved === undefined) delete process.env.CELLAR_PROJECT_VENV;
			else process.env.CELLAR_PROJECT_VENV = saved;
		}

		const { env, result, steps } = runKernelCode(await connectCode(CLUSTER_B, { host: true }));
		expect(result).toMatchObject({ ok: true });
		expect(env.DATABRICKS_CLUSTER_ID).toBe(CLUSTER_B);
		// The ordering rule holds on this branch too: the id is published below the
		// `if _auth['mode']` split, not inside either arm of it.
		expect(steps.find((s) => s.event === 'build')!.cluster_id_env).toBeNull();
	});

	it('the sibling DATABRICKS_RUNTIME_VERSION restore is unaffected, and other vars are still scrubbed', async () => {
		const { env } = runKernelCode(await connectCode(CLUSTER_A), {
			DATABRICKS_RUNTIME_VERSION: '15.4',
			DATABRICKS_HOST: 'https://stale.example.com'
		});
		expect(env.DATABRICKS_RUNTIME_VERSION).toBe('15.4');
		expect(env.DATABRICKS_HOST).toBeUndefined();
		expect(env.DATABRICKS_CLUSTER_ID).toBe(CLUSTER_A);
	});
});

describe('disconnect removes it', () => {
	/** The real generated DISCONNECT_CODE, captured off the real `disconnect()`. */
	async function disconnectCode() {
		state.lastDisconnectCode = '';
		await dbx.connect({ profile: 'test', clusterId: CLUSTER_A, clusterName: 'Test Cluster' });
		await dbx.disconnect();
		expect(state.lastDisconnectCode).toContain('_cellar_dbx_disconnect');
		return state.lastDisconnectCode;
	}

	it('drops DATABRICKS_CLUSTER_ID', async () => {
		const { env, result } = runKernelCode(await disconnectCode(), { DATABRICKS_CLUSTER_ID: CLUSTER_A });
		expect(result).toMatchObject({ ok: true });
		expect(env.DATABRICKS_CLUSTER_ID).toBeUndefined();
	});

	it('drops it even when there was no session to stop', async () => {
		// The removal is about the ENV, not about this call: a kernel whose `spark` is
		// already gone (a restart, a prior disconnect) must not keep an id pointing at a
		// cluster nothing is connected to. `_cellar_dbx_disconnect` returns early on a
		// missing `spark`, so the pop has to happen above that return.
		const { env, result } = runKernelCode(await disconnectCode(), { DATABRICKS_CLUSTER_ID: CLUSTER_A });
		expect(result).toMatchObject({ ok: true, stopped: false }); // no `spark` in a fresh interpreter
		expect(env.DATABRICKS_CLUSTER_ID).toBeUndefined();
	});

	it('is a no-op when none was set', async () => {
		const { env, result } = runKernelCode(await disconnectCode());
		expect(result).toMatchObject({ ok: true });
		expect(env.DATABRICKS_CLUSTER_ID).toBeUndefined();
	});
});
