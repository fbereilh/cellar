import { describe, it, expect, afterAll, beforeAll, beforeEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * **Upload the open notebook to the user's Databricks workspace folder.**
 *
 * The Databricks section's upload button copies the notebook the user has open
 * into `/Users/<them>/` as a real, cells-intact Databricks notebook. What this
 * file pins:
 *
 *   1. It runs through the EXISTING authenticated path - a live connection's own
 *      selection - so no second auth mechanism exists to drift. Not connected is
 *      an actionable `not_connected`, and an expired profile keeps the exact
 *      `profile_reauth_required` (+ its profile name) every other op reports.
 *   2. The bytes uploaded are the LIVE notebook, base64 on stdin (never argv - a
 *      notebook with outputs is routinely megabytes), and the workspace name is
 *      the basename with its extension dropped.
 *   3. **No silent clobber**: without an explicit overwrite the probe writes
 *      NOTHING when something is already at that path - it reports `exists` so
 *      the UI can confirm - and only a second, deliberate `overwrite:true` call
 *      replaces it.
 *   4. It is a workspace-FILES operation: it never touches compute.
 *
 * Two levels, deliberately. The Node half drives the real `uploadNotebook`
 * against a recording stub interpreter, so it runs anywhere. The python half
 * runs the SHIPPED `PROBE` source through the SHIPPED spawn path against a FAKE
 * `databricks` SDK - which is what actually proves `/Users/<user>` comes from
 * `current_user.me()`, that the format is JUPYTER, and that the exists check
 * gates `import_`. Neither needs a workspace, a cluster or a real SDK.
 */

const SENTINEL = '__CELLAR_DBX__';
const HOST = 'https://upload-me.example.com';
const USER = 'me@corp.example.com';

/** The kernel is mocked per the databricks-test convention: no cluster, no sidecar. */
const state = vi.hoisted(() => ({ session: 1 as number | null }));

vi.mock('../../src/lib/server/kernel', () => ({
	execute: async (_nb: string, code: string, onEvent: (e: unknown) => void) => {
		onEvent({ type: 'kernel', session: state.session });
		const out = code.includes('_cellar_dbx_ping')
			? { ok: true, alive: true, expired: false }
			: code.includes('_cellar_dbx_connect')
				? { ok: true, host: HOST, spark_version: '3.5.0' }
				: { ok: true };
		onEvent({
			type: 'output',
			output: { output_type: 'stream', name: 'stdout', text: SENTINEL + JSON.stringify(out) + '\n' }
		});
		return {};
	},
	currentSessionId: () => state.session,
	kernelStatus: () => ({ status: 'idle', id: state.session == null ? null : 'k1' }),
	restartKernel: async () => ({ status: 'idle', id: 'k1', session_id: 1 }),
	refreshKernelConnection: async () => ({ refreshed: true, reason: 'reconnected' }),
	liveDatabricksRuntime: () => ({ started: true, version: null })
}));

let dbx: typeof import('../../src/lib/server/databricks');
let dir = '';
let NB = '';
let OAUTH_NB = '';
/** Where the recording stub writes what it was asked (argv request) and fed (stdin). */
let reqFile = '';
let stdinFile = '';
/** Where the fake SDK appends one JSON line per call it received. */
let callLog = '';

const REDIRECTED_ENV = [
	'DATABRICKS_CONFIG_FILE',
	'CELLAR_WORKSPACE',
	'CELLAR_PROJECT_VENV',
	'CELLAR_FAKE_DBX_LOG',
	'CELLAR_FAKE_DBX_EXISTS',
	'CELLAR_FAKE_DBX_HOST',
	'CELLAR_FAKE_DBX_USER'
] as const;
const savedEnv = new Map<string, string | undefined>();

/** Any python3 will do - the SDK is faked - so this only skips where there is none. */
const python: string | null = (() => {
	const venv = resolve(process.cwd(), '.venv', 'bin', 'python');
	if (existsSync(venv)) return venv;
	const which = spawnSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' });
	const found = which.stdout.trim();
	return which.status === 0 && found ? found : null;
})();
const NO_PYTHON = 'no python3 available - the shipped PROBE source cannot be exercised here';

/** The notebook the tests upload: two cells, so the payload is provably the real document. */
const FIXTURE = {
	nbformat: 4,
	nbformat_minor: 5,
	metadata: { kernelspec: { name: 'python3', display_name: 'python3', language: 'python' } },
	cells: [
		{ cell_type: 'markdown', id: 'c-md', metadata: {}, source: ['# Upload me\n'] },
		{
			cell_type: 'code',
			id: 'c-code',
			metadata: {},
			execution_count: null,
			outputs: [],
			source: ['print("hello workspace")\n']
		}
	]
};

/**
 * A stub interpreter that RECORDS the probe request (argv) and its stdin payload,
 * then prints one canned sentinel line. This is what lets the Node half assert the
 * request shape - op, name, overwrite - and the uploaded bytes without an SDK.
 */
function writeRecordingStub(name: string, result: Record<string, unknown>): string {
	const path = join(dir, name);
	writeFileSync(
		path,
		[
			'#!/bin/sh',
			`printf '%s' "$3" > "${reqFile}"`,
			`cat > "${stdinFile}"`,
			"cat <<'EOF'",
			SENTINEL + JSON.stringify(result),
			'EOF',
			''
		].join('\n'),
		{ mode: 0o755 }
	);
	return path;
}

/** The recorded request the last probe run was handed. */
function lastRequest(): Record<string, unknown> {
	return JSON.parse(readFileSync(reqFile, 'utf8'));
}
/** The notebook JSON the last probe run was fed on stdin (base64 in, text out). */
function lastUploadedJson(): string {
	return Buffer.from(readFileSync(stdinFile, 'utf8').trim(), 'base64').toString('utf8');
}

/** Point the probe at a stub, or back at "no interpreter at all". */
function useStub(path: string) {
	process.env.CELLAR_PROJECT_VENV = path;
}
function useNoPython() {
	delete process.env.CELLAR_PROJECT_VENV;
}

/**
 * Write the fake `databricks` SDK the python half runs against, plus the wrapper
 * that makes `probe()` reach it. The wrapper is handed the SHIPPED `-c <PROBE>
 * <request>` argv, so it pops the source out of argv (leaving `sys.argv[1]` as the
 * request, exactly as the real interpreter sees it) and execs it with the fake on
 * `sys.path` - i.e. the code under test is the real probe, unedited.
 */
function writeFakeSdkInterpreter(): string {
	const root = join(dir, 'fake-sdk');
	const pkg = join(root, 'databricks', 'sdk', 'service');
	mkdirSync(pkg, { recursive: true });
	writeFileSync(join(root, 'databricks', '__init__.py'), '');
	writeFileSync(join(root, 'databricks', 'sdk', 'service', '__init__.py'), '');
	writeFileSync(
		join(root, 'databricks', 'sdk', 'core.py'),
		[
			'import os',
			'',
			'class Config:',
			'    def __init__(self, profile=None, host=None, auth_type=None, **kw):',
			'        self.profile = profile',
			"        self.host = host or os.environ.get('CELLAR_FAKE_DBX_HOST')",
			// Kept so a test can read WHICH per-request timeout an op asked for: the
			// upload's request is the only large one, so it is the only one widened.
			// The retry budget rides along because the upload is also the only op that
			// bounds it - the real SDK defaults it to the parent's whole kill window.
			"        self.http_timeout_seconds = kw.get('http_timeout_seconds')",
			"        self.retry_timeout_seconds = kw.get('retry_timeout_seconds')",
			''
		].join('\n')
	);
	writeFileSync(
		join(root, 'databricks', 'sdk', 'service', 'workspace.py'),
		[
			'class _Value:',
			'    def __init__(self, value): self.value = value',
			'',
			'class ImportFormat:',
			"    JUPYTER = _Value('JUPYTER')",
			"    SOURCE = _Value('SOURCE')",
			''
		].join('\n')
	);
	writeFileSync(
		join(root, 'databricks', 'sdk', '__init__.py'),
		[
			'import json, os',
			'from .core import Config',
			'',
			'def _record(entry):',
			"    path = os.environ.get('CELLAR_FAKE_DBX_LOG')",
			'    if not path: return',
			"    with open(path, 'a') as fh:",
			"        fh.write(json.dumps(entry) + '\\n')",
			'',
			'class _Value:',
			'    def __init__(self, value): self.value = value',
			'',
			'# The SDK error a missing workspace path raises. The probe keys off the TYPE',
			"# NAME, so the name is the contract - not this module's identity.",
			'class ResourceDoesNotExist(Exception):',
			'    pass',
			'',
			'class PermissionDenied(Exception):',
			'    pass',
			'',
			'class _ObjectInfo:',
			'    def __init__(self, object_type): self.object_type = _Value(object_type)',
			'',
			'class _Workspace:',
			'    def get_status(self, path):',
			"        _record({'call': 'get_status', 'path': path})",
			"        kind = os.environ.get('CELLAR_FAKE_DBX_EXISTS', 'none')",
			"        if kind == 'denied':",
			"            raise PermissionDenied('PERMISSION_DENIED: cannot read ' + path)",
			"        if kind == 'none':",
			// The real workspace not-found message names the path it looked up, which is
			// what lets a notebook NAME collide with `classify()`'s message rules.
			"            raise ResourceDoesNotExist('RESOURCE_DOES_NOT_EXIST: ' + path)",
			'        return _ObjectInfo(kind)',
			'',
			'    def import_(self, path=None, format=None, content=None, overwrite=False, **kw):',
			"        _record({'call': 'import_', 'path': path,",
			"                 'format': getattr(format, 'value', str(format)),",
			"                 'content': content, 'overwrite': bool(overwrite),",
			"                 'extra': sorted(kw)})",
			'',
			'class _User:',
			'    def __init__(self, user_name): self.user_name = user_name',
			'',
			'class _CurrentUser:',
			'    def me(self):',
			"        _record({'call': 'me'})",
			"        return _User(os.environ.get('CELLAR_FAKE_DBX_USER'))",
			'',
			'class WorkspaceClient:',
			'    def __init__(self, config=None, **kw):',
			"        _record({'call': 'client',",
			"                 'http_timeout_seconds': getattr(config, 'http_timeout_seconds', None),",
			"                 'retry_timeout_seconds': getattr(config, 'retry_timeout_seconds', None)})",
			'        self.config = config',
			'        self.workspace = _Workspace()',
			'        self.current_user = _CurrentUser()',
			''
		].join('\n')
	);

	const boot = `import sys; sys.path.insert(0, ${JSON.stringify(root)}); exec(sys.argv.pop(1))`;
	const path = join(dir, 'fake-sdk-python');
	writeFileSync(path, `#!/bin/sh\nexec ${JSON.stringify(python)} -c ${JSON.stringify(boot)} "$2" "$3"\n`, {
		mode: 0o755
	});
	return path;
}

/** Every call the fake SDK saw during the last upload, in order. */
function sdkCalls(): Record<string, unknown>[] {
	if (!existsSync(callLog)) return [];
	return readFileSync(callLog, 'utf8')
		.split('\n')
		.filter(Boolean)
		.map((l) => JSON.parse(l));
}

/** Connect the notebook the only way the module allows, with no interpreter in play. */
async function freshConnect(profile = 'pat') {
	useNoPython(); // the connect's cluster-DBR probe degrades to null, as it does with no venv
	state.session = 1;
	await dbx.connect({ profile, clusterId: '0725-abc', clusterName: 'Test Cluster', nb: NB });
}

beforeAll(async () => {
	for (const key of REDIRECTED_ENV) savedEnv.set(key, process.env[key]);
	dir = mkdtempSync(join(tmpdir(), 'cellar-dbx-upload-'));
	const cfg = join(dir, '.databrickscfg');
	writeFileSync(
		cfg,
		['[pat]', `host = ${HOST}`, 'token = dummy-pat', '', '[browser]', `host = ${HOST}`, 'auth_type = external-browser', ''].join('\n')
	);
	process.env.DATABRICKS_CONFIG_FILE = cfg;
	process.env.CELLAR_WORKSPACE = dir;
	process.env.CELLAR_FAKE_DBX_HOST = HOST;
	process.env.CELLAR_FAKE_DBX_USER = USER;
	reqFile = join(dir, 'probe-request.json');
	stdinFile = join(dir, 'probe-stdin.txt');
	callLog = join(dir, 'sdk-calls.jsonl');
	NB = join(dir, 'analysis.ipynb');
	writeFileSync(NB, JSON.stringify(FIXTURE, null, 1));
	// A name that is ORDINARY to a user and a landmine to `classify()`: the workspace
	// not-found message embeds the path, so 'oauth' in the filename reads as an OAuth
	// failure to a message-matching check.
	OAUTH_NB = join(dir, 'oauth-notes.ipynb');
	writeFileSync(OAUTH_NB, JSON.stringify(FIXTURE, null, 1));
	dbx = await import('../../src/lib/server/databricks');
});

afterAll(() => {
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
	rmSync(reqFile, { force: true });
	rmSync(stdinFile, { force: true });
	rmSync(callLog, { force: true });
	delete process.env.CELLAR_FAKE_DBX_LOG;
	delete process.env.CELLAR_FAKE_DBX_EXISTS;
	useNoPython();
	await dbx.disconnect().catch(() => {});
});

describe('uploadNotebook — the server op', () => {
	it('asks the workspace to import the notebook by NAME (extension dropped) with no overwrite', async () => {
		await freshConnect();
		useStub(writeRecordingStub('stub-uploaded', { ok: true, status: 'uploaded', path: `/Users/${USER}/analysis`, host: HOST }));

		const out = await dbx.uploadNotebook({ nb: NB });

		const req = lastRequest();
		expect(req.op).toBe('workspace_upload');
		// The basename with `.ipynb` dropped: Databricks names a workspace notebook by
		// its path segment, so a kept suffix shows up in the workspace UI.
		expect(req.name).toBe('analysis');
		expect(req.overwrite).toBe(false);
		// The connected selection's own auth - never a second mechanism.
		expect((req.auth as Record<string, unknown>).mode).toBe('profile');
		expect((req.auth as Record<string, unknown>).profile).toBe('pat');

		expect(out.status).toBe('uploaded');
		expect(out.overwritten).toBe(false);
		expect(out.path).toBe(`/Users/${USER}/analysis`);
		expect(out.url).toBe(`${HOST}/#workspace/Users/${USER}/analysis`);
	});

	it('uploads the LIVE notebook, base64 on STDIN (never argv — a notebook is far too big)', async () => {
		await freshConnect();
		useStub(writeRecordingStub('stub-uploaded2', { ok: true, status: 'uploaded', path: `/Users/${USER}/analysis`, host: HOST }));
		await dbx.uploadNotebook({ nb: NB });

		// argv carries the command only. The notebook must not be in it: a payload
		// that size is refused by the OS (E2BIG) long before the SDK sees it.
		expect(JSON.stringify(lastRequest())).not.toContain('hello workspace');

		const uploaded = JSON.parse(lastUploadedJson());
		expect(uploaded.nbformat).toBe(4);
		expect(uploaded.cells.map((c: { cell_type: string }) => c.cell_type)).toEqual(['markdown', 'code']);
		expect(uploaded.cells[1].source.join('')).toContain('hello workspace');
	});

	it('an edit made in Cellar is what gets uploaded (the live document, not the last read of disk)', async () => {
		const { setSource, listCells } = await import('../../src/lib/server/notebook');
		await freshConnect();
		const codeId = listCells(NB)[1].id;
		setSource(codeId, 'print("edited in cellar")\n', NB);
		useStub(writeRecordingStub('stub-uploaded3', { ok: true, status: 'uploaded', path: `/Users/${USER}/analysis`, host: HOST }));
		try {
			await dbx.uploadNotebook({ nb: NB });
			expect(lastUploadedJson()).toContain('edited in cellar');
		} finally {
			// The live doc outlives this test (it is the module's own document map), so
			// put the fixture back or every later assertion reads THIS edit.
			setSource(codeId, 'print("hello workspace")\n', NB);
		}
	});

	it('reports `exists` — nothing written — so the UI can confirm before replacing', async () => {
		await freshConnect();
		useStub(writeRecordingStub('stub-exists', { ok: true, status: 'exists', path: `/Users/${USER}/analysis`, host: HOST, overwritten: false }));

		const out = await dbx.uploadNotebook({ nb: NB });
		expect(out.status).toBe('exists');
		expect(out.overwritten).toBe(false);
		expect(out.path).toBe(`/Users/${USER}/analysis`);
	});

	it('replacing is a second, deliberate call that carries overwrite:true', async () => {
		await freshConnect();
		useStub(writeRecordingStub('stub-replaced', { ok: true, status: 'uploaded', path: `/Users/${USER}/analysis`, host: HOST, overwritten: true }));

		const out = await dbx.uploadNotebook({ nb: NB, overwrite: true });
		expect(lastRequest().overwrite).toBe(true);
		expect(out.status).toBe('uploaded');
		expect(out.overwritten).toBe(true);
	});

	it('NOT connected is an actionable `not_connected`, never a crash — and runs no probe', async () => {
		useStub(writeRecordingStub('stub-unused', { ok: true, status: 'uploaded', path: '/Users/x/y', host: HOST }));
		await expect(dbx.uploadNotebook({ nb: NB })).rejects.toMatchObject({ code: 'not_connected' });
		// The gate is BEFORE the subprocess: nothing was asked of the workspace.
		expect(existsSync(reqFile)).toBe(false);
	});

	it('an expired profile keeps the exact `profile_reauth_required` verdict (and its name)', async () => {
		await freshConnect();
		useStub(
			writeRecordingStub('stub-reauth', {
				ok: false,
				code: 'error',
				// The real SDK text: the CLI-managed refresh token died. Only the resolved
				// auth knows WHICH profile, so the relabel happens in Node.
				message:
					'ValueError: default auth: databricks-cli: cannot get access token: ... the refresh token is invalid. To reauthenticate, run: $ databricks auth login --profile pat'
			})
		);
		await expect(dbx.uploadNotebook({ nb: NB })).rejects.toMatchObject({
			code: 'profile_reauth_required',
			profile: 'pat'
		});
	});

	it('a workspace failure surfaces its own code, unwrapped', async () => {
		await freshConnect();
		useStub(writeRecordingStub('stub-denied', { ok: false, code: 'permission_denied', message: 'PermissionDenied: nope' }));
		await expect(dbx.uploadNotebook({ nb: NB })).rejects.toMatchObject({ code: 'permission_denied' });
	});

	it('a name Databricks cannot give a workspace notebook is refused before any upload', async () => {
		// A `/` in the segment would silently land the notebook somewhere else in the
		// workspace tree, so the name is validated rather than escaped.
		const odd = join(dir, '.ipynb');
		writeFileSync(odd, JSON.stringify(FIXTURE, null, 1));
		useNoPython();
		await dbx.connect({ profile: 'pat', clusterId: '0725-abc', clusterName: 'Test Cluster', nb: odd });
		useStub(writeRecordingStub('stub-unused2', { ok: true, status: 'uploaded', path: '/Users/x/y', host: HOST }));
		await expect(dbx.uploadNotebook({ nb: odd })).rejects.toMatchObject({ code: 'bad_request' });
		expect(existsSync(reqFile)).toBe(false);
	});

	it('refuses a notebook past what a workspace import accepts - before anything is spawned', async () => {
		// Big because of its OUTPUTS, which is the only way a notebook gets this large
		// and the reason the remedy is "clear them", not "split the notebook".
		const huge = join(dir, 'huge.ipynb');
		writeFileSync(
			huge,
			JSON.stringify({
				...FIXTURE,
				cells: [
					{
						cell_type: 'code',
						id: 'c-huge',
						metadata: {},
						execution_count: null,
						source: ['print("big")\n'],
						outputs: [{ output_type: 'stream', name: 'stdout', text: ['y'.repeat(9 * 1024 * 1024)] }]
					}
				]
			})
		);
		useNoPython();
		await dbx.connect({ profile: 'pat', clusterId: '0725-abc', clusterName: 'Test Cluster', nb: huge });
		useStub(writeRecordingStub('stub-unused-huge', { ok: true, status: 'uploaded', path: '/Users/x/y', host: HOST }));

		const err = await dbx.uploadNotebook({ nb: huge }).catch((e) => e);
		// Its OWN code, not the shared `bad_request`: the sidebar's remedy for this
		// (clear the outputs) would be wrong copy for every other `bad_request` caller.
		expect(err).toMatchObject({ code: 'notebook_too_large' });
		// Actionable: it names the size, the limit and what to do about it.
		expect(err.message).toMatch(/\d+\.\d MB/);
		expect(err.message).toContain('outputs');
		// The whole point of a PRE-flight check is not paying for the payload: the
		// refusal happens before the subprocess (and so before the base64 copy).
		expect(existsSync(reqFile)).toBe(false);
		expect(existsSync(stdinFile)).toBe(false);
	});
});

describe('the workspace_upload op — the SHIPPED probe against a fake databricks SDK', () => {
	it.skipIf(!python)(`resolves /Users/<me> from the connected identity and imports JUPYTER format [${python ? 'ok' : NO_PYTHON}]`, async () => {
		await freshConnect();
		process.env.CELLAR_FAKE_DBX_LOG = callLog;
		useStub(writeFakeSdkInterpreter());

		const out = await dbx.uploadNotebook({ nb: NB });

		expect(out.status).toBe('uploaded');
		// The home folder comes from `current_user.me()`, never a guess: it is the very
		// first thing asked of the workspace, before any path is built.
		expect(sdkCalls().filter((c) => c.call !== 'client')[0]).toMatchObject({ call: 'me' });
		expect(out.path).toBe(`/Users/${USER}/analysis`);

		const imported = sdkCalls().find((c) => c.call === 'import_')!;
		expect(imported).toBeTruthy();
		expect(imported.path).toBe(`/Users/${USER}/analysis`);
		// JUPYTER, not SOURCE: SOURCE would flatten the notebook into one .py script,
		// losing every cell boundary - the whole point of the button.
		expect(imported.format).toBe('JUPYTER');
		expect(imported.overwrite).toBe(false);
		expect(Buffer.from(String(imported.content), 'base64').toString('utf8')).toContain('hello workspace');
	});

	it.skipIf(!python)(`checks first and writes NOTHING when a notebook is already there [${python ? 'ok' : NO_PYTHON}]`, async () => {
		await freshConnect();
		process.env.CELLAR_FAKE_DBX_LOG = callLog;
		process.env.CELLAR_FAKE_DBX_EXISTS = 'NOTEBOOK';
		useStub(writeFakeSdkInterpreter());

		const out = await dbx.uploadNotebook({ nb: NB });

		expect(out.status).toBe('exists');
		expect(out.path).toBe(`/Users/${USER}/analysis`);
		// The no-silent-clobber invariant, asserted where it lives: the existence check
		// ran and `import_` did NOT.
		expect(sdkCalls().map((c) => c.call)).toContain('get_status');
		expect(sdkCalls().map((c) => c.call)).not.toContain('import_');
	});

	it.skipIf(!python)(`replaces only when the caller asked to — and then skips the check [${python ? 'ok' : NO_PYTHON}]`, async () => {
		await freshConnect();
		process.env.CELLAR_FAKE_DBX_LOG = callLog;
		process.env.CELLAR_FAKE_DBX_EXISTS = 'NOTEBOOK';
		useStub(writeFakeSdkInterpreter());

		const out = await dbx.uploadNotebook({ nb: NB, overwrite: true });

		expect(out.status).toBe('uploaded');
		expect(out.overwritten).toBe(true);
		const imported = sdkCalls().find((c) => c.call === 'import_')!;
		expect(imported.overwrite).toBe(true);
		expect(imported.format).toBe('JUPYTER');
	});

	it.skipIf(!python)(`reads a FREE path off the exception TYPE, so a notebook name classify() mistakes for an auth failure still uploads [${python ? 'ok' : NO_PYTHON}]`, async () => {
		useNoPython();
		state.session = 1;
		await dbx.connect({ profile: 'pat', clusterId: '0725-abc', clusterName: 'Test Cluster', nb: OAUTH_NB });
		process.env.CELLAR_FAKE_DBX_LOG = callLog;
		process.env.CELLAR_FAKE_DBX_EXISTS = 'none';
		useStub(writeFakeSdkInterpreter());

		const out = await dbx.uploadNotebook({ nb: OAUTH_NB });

		// `classify()` matches the MESSAGE first, and the not-found message names the
		// path - so a message-keyed check read this ordinary name as
		// `oauth_login_required` and failed the very FIRST upload of it, permanently,
		// with a sign-in prompt for a path that simply did not exist.
		expect(out.status).toBe('uploaded');
		expect(out.path).toBe(`/Users/${USER}/oauth-notes`);
		expect(sdkCalls().map((c) => c.call)).toContain('import_');
	});

	it.skipIf(!python)(`re-raises anything that is NOT a not-found rather than reading it as a free path [${python ? 'ok' : NO_PYTHON}]`, async () => {
		await freshConnect();
		process.env.CELLAR_FAKE_DBX_LOG = callLog;
		process.env.CELLAR_FAKE_DBX_EXISTS = 'denied';
		useStub(writeFakeSdkInterpreter());

		// The other half of keying off the type: a genuine permission/auth/network
		// failure must surface honestly, never be taken for "nothing is there" and
		// overwrite whatever the check could not see.
		await expect(dbx.uploadNotebook({ nb: NB })).rejects.toMatchObject({ code: 'permission_denied' });
		expect(sdkCalls().map((c) => c.call)).not.toContain('import_');
	});

	it.skipIf(!python)(`refuses a path occupied by something that is not a notebook [${python ? 'ok' : NO_PYTHON}]`, async () => {
		await freshConnect();
		process.env.CELLAR_FAKE_DBX_LOG = callLog;
		process.env.CELLAR_FAKE_DBX_EXISTS = 'DIRECTORY';
		useStub(writeFakeSdkInterpreter());

		// Not offered as a replace: an import over a directory fails, and over a file it
		// would destroy something this button was never pointed at.
		await expect(dbx.uploadNotebook({ nb: NB })).rejects.toMatchObject({ code: 'workspace_conflict' });
		expect(sdkCalls().map((c) => c.call)).not.toContain('import_');
	});

	it.skipIf(!python)(`touches workspace files only — nothing in it reaches compute [${python ? 'ok' : NO_PYTHON}]`, async () => {
		await freshConnect();
		process.env.CELLAR_FAKE_DBX_LOG = callLog;
		useStub(writeFakeSdkInterpreter());

		await dbx.uploadNotebook({ nb: NB });

		// The fake exposes `workspace` and `current_user` and nothing else, so a call to
		// `clusters.*` would have raised; assert the intent positively too.
		expect(sdkCalls().map((c) => c.call).sort()).toEqual(['client', 'get_status', 'import_', 'me']);
		expect(dbx.connectionStatus(NB).connected).toBe(true); // the session is untouched
	});

	it.skipIf(!python)(`gives the upload its OWN wider request timeout and a bounded retry budget, leaving the listings' alone [${python ? 'ok' : NO_PYTHON}]`, async () => {
		await freshConnect();
		process.env.CELLAR_FAKE_DBX_LOG = callLog;
		useStub(writeFakeSdkInterpreter());

		await dbx.uploadNotebook({ nb: NB });
		// The upload PUTs the whole notebook: on a slow uplink the listing-sized window
		// would cut a healthy transfer short and blame the workspace for it.
		const upload = sdkCalls().find((c) => c.call === 'client')!;
		expect(upload.http_timeout_seconds).toBe(120);
		// And its retry budget is bounded BELOW the parent's kill window, so the SDK's
		// own message - not a SIGKILL - is what reports a wedged upload. Asserted as a
		// relation, not a magic number: retries plus one full in-flight request must
		// still fit inside UPLOAD_TIMEOUT_MS.
		const retry = upload.retry_timeout_seconds as number;
		expect(retry).toBeGreaterThan(0);
		expect(retry + (upload.http_timeout_seconds as number)).toBeLessThan(300 - 30);

		// The small metadata reads are NOT widened - a wedged socket must still fail
		// fast there - and they keep the SDK's own retry default. The fake has no
		// `clusters`, so the op fails after building the client, which is all this
		// needs to read.
		rmSync(callLog, { force: true });
		await dbx.listClusters({ profile: 'pat', host: null }).catch(() => {});
		const listing = sdkCalls().find((c) => c.call === 'client')!;
		expect(listing.http_timeout_seconds).toBe(30);
		expect(listing.retry_timeout_seconds).toBe(null);
	});
});
