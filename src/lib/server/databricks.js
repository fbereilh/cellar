/**
 * Cellar - native Databricks integration.
 *
 * Replaces the connection boilerplate a user would otherwise paste into a cell
 * (scrub stale `DATABRICKS_*` / `SPARK_CONNECT_*` env vars, pin a config
 * profile, build a `WorkspaceClient`, find a cluster by name, build a
 * `DatabricksSession`) with a one-click sidebar flow.
 *
 * ## Auth
 * Profile auth through the **databricks SDK**, nothing else. `WorkspaceClient(
 * profile=…)` and `DatabricksSession.builder.profile(…)` read `~/.databrickscfg`
 * directly (PAT or OAuth/U2M), so Cellar never needs the `databricks` CLI on
 * PATH and never goes looking for the VS Code extension's bundled binary. The
 * profile list below is parsed from that same file so the picker works before
 * anything is installed.
 *
 * ## The server / kernel split
 * Two very different jobs, so two runtimes:
 *
 *   - **Listing** (profiles, clusters, catalogs, schemas, tables) runs
 *     *server-side*, in a short-lived subprocess of the project venv's python
 *     (`projectPython()`), one process per request. Read-only metadata calls
 *     have no business occupying the single shared kernel, and the browser stays
 *     responsive while a Unity Catalog page loads.
 *   - **The session** (`spark`, `w`) is created *inside the kernel*, because
 *     that is the only place a user's cells can reach it. `connect()` executes
 *     the bootstrap through the ordinary `execute()` bridge and leaves `spark`
 *     and `w` bound in the user namespace.
 *
 * Both halves scrub the environment the same way (`scrubEnv` / the same rule in
 * `CONNECT_CODE`) so the subprocess and the kernel resolve the *same* profile.
 * One deliberate divergence from the boilerplate: `DATABRICKS_CONFIG_FILE` is
 * preserved rather than deleted, since it is what tells the SDK where the config
 * we just read the profiles from actually lives.
 *
 * ## Connection state is epoch-scoped
 * `spark` lives in the kernel namespace, so a kernel restart destroys it. This
 * module records the kernel-session epoch (`kernel.js`'s monotonic
 * `currentSessionId()`) the session was created in and reports `connected:false`
 * the moment that epoch is no longer current - the same rule `service.js` uses
 * to tell a live run from a persisted one. Never report a connection from a
 * dead namespace: the user's next `spark.read…` would `NameError`.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execute, currentSessionId } from './kernel.js';
import { publishGlobal } from './events.js';
import { hasUv, installPackages, isValidVenv, venvPython } from './venv.js';

/** Line prefix both the subprocess and the kernel bootstrap print their JSON result on. */
const SENTINEL = '__CELLAR_DBX__';

/** How long a metadata subprocess may run before it is killed. */
const PROBE_TIMEOUT_MS = 60_000;

/** Env vars the boilerplate clears. `DATABRICKS_CONFIG_FILE` is deliberately kept. */
const KEEP_ENV = new Set(['DATABRICKS_CONFIG_FILE']);
const isStaleEnv = (k) =>
	(k.startsWith('DATABRICKS_') || k.startsWith('SPARK_CONNECT_')) && !KEEP_ENV.has(k);

/** A profile name as `~/.databrickscfg` and the SDK accept it. */
const PROFILE_RE = /^[A-Za-z0-9._-]+$/;
/** A Databricks cluster id, e.g. `0725-123456-abcd1234`. */
const CLUSTER_RE = /^[A-Za-z0-9-]+$/;
/** A Unity Catalog identifier part. */
const UC_NAME_RE = /^[A-Za-z0-9_$-]+$/;

function workspace() {
	return process.env.CELLAR_WORKSPACE || process.cwd();
}

/**
 * The interpreter the kernel runs in, which is also the one the metadata
 * subprocess must use: whatever `databricks-sdk` the kernel can import is
 * exactly what our listing calls should import, or the two would disagree about
 * whether the feature is installed at all.
 */
export function projectPython() {
	const bound = process.env.CELLAR_PROJECT_VENV;
	if (bound && existsSync(bound)) return bound;
	// `vite dev` without the launcher: fall back to the conventional project venv.
	const local = join(workspace(), '.venv');
	return isValidVenv(local) ? venvPython(local) : null;
}

/** Where the SDK reads profiles from (`DATABRICKS_CONFIG_FILE` wins, as in the SDK). */
export function configPath() {
	return process.env.DATABRICKS_CONFIG_FILE || join(homedir(), '.databrickscfg');
}

/**
 * Parse the profile names (and their hosts) out of `~/.databrickscfg`.
 *
 * Done in Node rather than through the SDK on purpose: the profile picker must
 * render - and must be able to say "no profiles configured" - before
 * `databricks-sdk` is installed in the project venv. The file is a plain INI, so
 * this needs no dependency.
 *
 * A section is only a *profile* if it declares a `host`. The Databricks CLI
 * writes bookkeeping sections into this same file (`[__settings__]`), and a
 * profile with no host is not one the SDK could authenticate with anyway - so
 * host-less sections are dropped rather than offered as something to connect to.
 */
export function readProfiles() {
	const path = configPath();
	if (!existsSync(path)) return { configPath: path, exists: false, profiles: [] };
	let text;
	try {
		text = readFileSync(path, 'utf8');
	} catch (err) {
		return { configPath: path, exists: true, error: String(err?.message ?? err), profiles: [] };
	}
	const sections = [];
	let current = null;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith('#') || line.startsWith(';')) continue;
		const section = /^\[(.+)]$/.exec(line);
		if (section) {
			current = { name: section[1].trim(), host: '' };
			sections.push(current);
			continue;
		}
		if (!current) continue;
		const eq = line.indexOf('=');
		if (eq === -1) continue;
		const key = line.slice(0, eq).trim().toLowerCase();
		if (key === 'host') current.host = line.slice(eq + 1).trim();
	}
	// Also drop anything the SDK could not accept as a `profile=` value.
	const profiles = sections.filter((s) => s.host && PROFILE_RE.test(s.name));
	return { configPath: path, exists: true, profiles };
}

/** The process env with the stale Databricks/Spark vars removed and the profile pinned. */
function scrubEnv(profile) {
	const env = { ...process.env };
	for (const key of Object.keys(env)) if (isStaleEnv(key)) delete env[key];
	if (profile) env.DATABRICKS_CONFIG_PROFILE = profile;
	return env;
}

// ---------------------------------------------------------------------------
// Metadata subprocess (server-side SDK calls)
// ---------------------------------------------------------------------------

/**
 * The whole server-side SDK surface, as one python script driven by a JSON
 * command in `argv[1]`. It always prints exactly one `SENTINEL`-prefixed JSON
 * line and never raises, so a missing package, a bad profile, and an unreachable
 * workspace all arrive as a structured `{ok:false, code, message}` instead of a
 * non-zero exit and a traceback we would have to guess at.
 *
 * Kept as a string (rather than a `.py` beside this file) because `$lib/server`
 * modules are bundled into `build/` by vite - a sibling data file would not ship.
 * `inspect.js` embeds its probe the same way.
 */
const PROBE = `
import json, sys

MAX_ROWS = 500

def classify(e):
    n = type(e).__name__
    m = str(e)
    low = m.lower()
    if n in ('ImportError', 'ModuleNotFoundError'):
        return 'sdk_missing'
    if 'profile' in low and 'not found' in low:
        return 'profile_missing'
    if n == 'Unauthenticated' or 'cannot configure default credentials' in low or 'authenticate' in low:
        return 'auth_failed'
    if n == 'PermissionDenied':
        return 'permission_denied'
    if n in ('NotFound', 'ResourceDoesNotExist'):
        return 'not_found'
    return 'error'

def fail(e, code=None):
    return {'ok': False, 'code': code or classify(e), 'message': '%s: %s' % (type(e).__name__, e)}

def version_of(mod):
    try:
        import importlib.metadata as md
        return md.version(mod)
    except Exception:
        return None

def check():
    out = {'sdk': False, 'connect': False, 'sdk_version': None, 'connect_version': None}
    try:
        import databricks.sdk  # noqa: F401
        out['sdk'] = True
        out['sdk_version'] = version_of('databricks-sdk')
    except Exception:
        pass
    try:
        import databricks.connect  # noqa: F401
        out['connect'] = True
        out['connect_version'] = version_of('databricks-connect')
    except Exception:
        pass
    return {'ok': True, **out}

def enum_value(v):
    if v is None:
        return None
    return getattr(v, 'value', None) or str(v)

def clusters(w):
    # Job / pipeline clusters are transient and cannot be attached to, so they
    # would only ever be dead rows in the picker.
    skip = ('JOB', 'PIPELINE', 'MODELS', 'SQL')
    rows = []
    for c in w.clusters.list():
        source = (enum_value(getattr(c, 'cluster_source', None)) or '').upper()
        if any(s in source for s in skip):
            continue
        rows.append({
            'cluster_id': c.cluster_id,
            'name': c.cluster_name or c.cluster_id,
            'state': enum_value(getattr(c, 'state', None)) or 'UNKNOWN',
            'spark_version': getattr(c, 'spark_version', None),
            'node_type': getattr(c, 'node_type_id', None),
        })
        if len(rows) >= MAX_ROWS:
            break
    running = lambda r: 0 if r['state'] == 'RUNNING' else 1
    rows.sort(key=lambda r: (running(r), r['name'].lower()))
    return {'ok': True, 'clusters': rows}

def catalogs(w):
    rows = [{'name': c.name, 'comment': getattr(c, 'comment', None)}
            for c in w.catalogs.list() if c.name]
    rows.sort(key=lambda r: r['name'].lower())
    return {'ok': True, 'catalogs': rows[:MAX_ROWS], 'truncated': len(rows) > MAX_ROWS}

def schemas(w, catalog):
    rows = [{'name': s.name, 'comment': getattr(s, 'comment', None)}
            for s in w.schemas.list(catalog_name=catalog) if s.name]
    rows.sort(key=lambda r: r['name'].lower())
    return {'ok': True, 'schemas': rows[:MAX_ROWS], 'truncated': len(rows) > MAX_ROWS}

def tables(w, catalog, schema):
    # Skip the column/property payloads when the installed SDK supports it: a
    # schema of wide tables is otherwise megabytes we immediately throw away.
    try:
        it = w.tables.list(catalog_name=catalog, schema_name=schema,
                           omit_columns=True, omit_properties=True)
    except TypeError:
        it = w.tables.list(catalog_name=catalog, schema_name=schema)
    rows = []
    for t in it:
        if not t.name:
            continue
        rows.append({
            'name': t.name,
            'full_name': t.full_name or '%s.%s.%s' % (catalog, schema, t.name),
            'table_type': enum_value(getattr(t, 'table_type', None)),
            'format': enum_value(getattr(t, 'data_source_format', None)),
        })
        if len(rows) > MAX_ROWS:
            break
    truncated = len(rows) > MAX_ROWS
    rows = rows[:MAX_ROWS]
    rows.sort(key=lambda r: r['name'].lower())
    return {'ok': True, 'tables': rows, 'truncated': truncated}

def main():
    req = json.loads(sys.argv[1])
    op = req.get('op')
    if op == 'check':
        return check()
    try:
        from databricks.sdk import WorkspaceClient
    except Exception as e:
        return fail(e, 'sdk_missing')
    profile = req.get('profile') or 'DEFAULT'
    try:
        w = WorkspaceClient(profile=profile)
    except Exception as e:
        return fail(e)
    try:
        if op == 'clusters':
            return clusters(w)
        if op == 'catalogs':
            return catalogs(w)
        if op == 'schemas':
            return schemas(w, req['catalog'])
        if op == 'tables':
            return tables(w, req['catalog'], req['schema'])
    except Exception as e:
        return fail(e)
    return {'ok': False, 'code': 'error', 'message': 'unknown op: %r' % (op,)}

try:
    result = main()
except Exception as e:  # never let a traceback be the only answer
    result = {'ok': False, 'code': 'error', 'message': '%s: %s' % (type(e).__name__, e)}
sys.stdout.write('${SENTINEL}' + json.dumps(result) + '\\n')
`;

/** A structured failure both API routes and the UI understand. `code` drives the UI's copy. */
export class DatabricksError extends Error {
	constructor(code, message) {
		super(message);
		this.name = 'DatabricksError';
		this.code = code;
	}
}

/**
 * HTTP status for a `DatabricksError.code`. The UI keys its copy off `code`, not
 * the status, so this only has to be honest enough for the network tab.
 */
export function statusFor(code) {
	switch (code) {
		case 'bad_request':
			return 400;
		case 'auth_failed':
		case 'profile_missing':
			return 401;
		case 'permission_denied':
			return 403;
		case 'not_found':
			return 404;
		case 'not_connected':
		case 'busy':
			return 409;
		case 'sdk_missing':
		case 'connect_missing':
		case 'no_python':
		case 'no_uv':
			return 412; // precondition: the environment is not ready
		case 'kernel_unavailable':
			return 503;
		case 'timeout':
			return 504;
		default:
			return 500;
	}
}

/** No project interpreter bound at all - nothing can import the SDK. */
function requirePython() {
	const python = projectPython();
	if (!python) {
		throw new DatabricksError(
			'no_python',
			'No Python environment is bound to this workspace. Launch Cellar with `cellar`, or set one in Settings → Python environment.'
		);
	}
	return python;
}

/** Run one `PROBE` command in the project venv and return its parsed result. */
function probe(request) {
	const python = requirePython();
	return new Promise((resolve, reject) => {
		const child = spawn(python, ['-c', PROBE, JSON.stringify(request)], {
			env: scrubEnv(request.profile),
			cwd: workspace(),
			stdio: ['ignore', 'pipe', 'pipe']
		});
		let stdout = '';
		let stderr = '';
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			reject(
				new DatabricksError(
					'timeout',
					`Databricks did not respond within ${PROBE_TIMEOUT_MS / 1000}s. Check that the workspace host in your \`${request.profile}\` profile is reachable.`
				)
			);
		}, PROBE_TIMEOUT_MS);

		child.stdout.on('data', (d) => (stdout += d));
		child.stderr.on('data', (d) => (stderr += d));
		child.on('error', (err) => {
			clearTimeout(timer);
			reject(new DatabricksError('no_python', `could not run ${python}: ${err.message}`));
		});
		child.on('exit', () => {
			clearTimeout(timer);
			const line = stdout.split('\n').find((l) => l.startsWith(SENTINEL));
			if (!line) {
				// The script always prints one; getting here means python itself died.
				reject(new DatabricksError('error', stderr.trim() || 'the Databricks probe produced no result'));
				return;
			}
			try {
				resolve(JSON.parse(line.slice(SENTINEL.length)));
			} catch (err) {
				reject(new DatabricksError('error', `unparseable probe result: ${err.message}`));
			}
		});
	});
}

/** Throw a `DatabricksError` for a `{ok:false}` probe/kernel result; else return it. */
function unwrap(result) {
	if (result?.ok) return result;
	throw new DatabricksError(result?.code || 'error', result?.message || 'Databricks call failed');
}

function assertMatches(value, re, label) {
	if (typeof value !== 'string' || !re.test(value)) {
		throw new DatabricksError('bad_request', `invalid ${label}: ${JSON.stringify(value)}`);
	}
	return value;
}

// ---------------------------------------------------------------------------
// Read APIs (server-side)
// ---------------------------------------------------------------------------

/** Are `databricks-sdk` / `databricks-connect` importable by the kernel's interpreter? */
export async function checkInstall() {
	const python = projectPython();
	if (!python) return { python: null, sdk: false, connect: false };
	const result = await probe({ op: 'check' });
	return { python, sdk: !!result.sdk, connect: !!result.connect, sdkVersion: result.sdk_version, connectVersion: result.connect_version };
}

/** Everything the sidebar needs to render before a connection exists. */
export async function getStatus() {
	const { configPath: path, exists, profiles, error } = readProfiles();
	let install = { python: projectPython(), sdk: false, connect: false };
	let installError = null;
	try {
		install = await checkInstall();
	} catch (err) {
		installError = err.message;
	}
	return {
		config: { path, exists, profiles, error: error ?? null },
		install,
		installError,
		uv: await hasUv(),
		connection: connectionStatus()
	};
}

export async function listClusters(profile) {
	assertMatches(profile, PROFILE_RE, 'profile');
	return unwrap(await probe({ op: 'clusters', profile })).clusters;
}

export async function listCatalogs(profile) {
	assertMatches(profile, PROFILE_RE, 'profile');
	return unwrap(await probe({ op: 'catalogs', profile }));
}

export async function listSchemas(profile, catalog) {
	assertMatches(profile, PROFILE_RE, 'profile');
	assertMatches(catalog, UC_NAME_RE, 'catalog');
	return unwrap(await probe({ op: 'schemas', profile, catalog }));
}

export async function listTables(profile, catalog, schema) {
	assertMatches(profile, PROFILE_RE, 'profile');
	assertMatches(catalog, UC_NAME_RE, 'catalog');
	assertMatches(schema, UC_NAME_RE, 'schema');
	return unwrap(await probe({ op: 'tables', profile, catalog, schema }));
}

// ---------------------------------------------------------------------------
// The session (in the kernel)
// ---------------------------------------------------------------------------

/**
 * Embed `cfg` as a python literal. `JSON.stringify` of a JSON string yields a
 * double-quoted literal whose escapes (`\\"`, `\\\\`, `\\n`, `\\uXXXX`) are all
 * valid python - so the kernel parses exactly the bytes we sent, whatever the
 * profile name contains. The regex validation above is the real guard; this is
 * the belt to its braces.
 */
const pyLiteral = (cfg) => JSON.stringify(JSON.stringify(cfg));

/**
 * The boilerplate, run once inside the kernel. Everything is underscore-prefixed
 * or deleted afterwards, so the only names it leaves behind are the two the user
 * asked for: `spark` and `w`.
 *
 * An existing session is stopped first - `getOrCreate()` would otherwise hand
 * back the *old* cluster's session and silently ignore the cluster just picked.
 */
const CONNECT_CODE = (cfg) => `
import json as _cellar_json

def _cellar_dbx_connect(_cfg):
    import os
    _keep = {${[...KEEP_ENV].map((k) => `'${k}'`).join(', ')}}
    for _k in [_k for _k in list(os.environ)
               if (_k.startswith('DATABRICKS_') or _k.startswith('SPARK_CONNECT_')) and _k not in _keep]:
        os.environ.pop(_k, None)
    os.environ['DATABRICKS_CONFIG_PROFILE'] = _cfg['profile']
    _g = globals()
    _old = _g.pop('spark', None)
    if _old is not None:
        try:
            _old.stop()
        except Exception:
            pass
    try:
        from databricks.sdk import WorkspaceClient
    except Exception as _e:
        return {'ok': False, 'code': 'sdk_missing', 'message': '%s: %s' % (type(_e).__name__, _e)}
    try:
        from databricks.connect import DatabricksSession
    except Exception as _e:
        return {'ok': False, 'code': 'connect_missing', 'message': '%s: %s' % (type(_e).__name__, _e)}
    try:
        _w = WorkspaceClient(profile=_cfg['profile'])
        _host = _w.config.host
    except Exception as _e:
        return {'ok': False, 'code': 'auth_failed', 'message': '%s: %s' % (type(_e).__name__, _e)}
    try:
        _spark = (DatabricksSession.builder
                  .profile(_cfg['profile'])
                  .clusterId(_cfg['cluster_id'])
                  .getOrCreate())
    except Exception as _e:
        return {'ok': False, 'code': 'session_failed', 'message': '%s: %s' % (type(_e).__name__, _e)}
    _g['spark'] = _spark
    _g['w'] = _w
    try:
        _version = _spark.version
    except Exception:
        _version = None
    return {'ok': True, 'host': _host, 'spark_version': _version}

try:
    print('${SENTINEL}' + _cellar_json.dumps(_cellar_dbx_connect(_cellar_json.loads(${pyLiteral(cfg)}))))
except Exception as _e:
    print('${SENTINEL}' + _cellar_json.dumps(
        {'ok': False, 'code': 'error', 'message': '%s: %s' % (type(_e).__name__, _e)}))
finally:
    del _cellar_dbx_connect, _cellar_json
`;

/** Stop the session and unbind both names. Idempotent: a missing `spark` is fine. */
const DISCONNECT_CODE = `
import json as _cellar_json

def _cellar_dbx_disconnect():
    _g = globals()
    _old = _g.pop('spark', None)
    _g.pop('w', None)
    if _old is None:
        return {'ok': True, 'stopped': False}
    try:
        _old.stop()
    except Exception as _e:
        return {'ok': True, 'stopped': False, 'message': '%s: %s' % (type(_e).__name__, _e)}
    return {'ok': True, 'stopped': True}

try:
    print('${SENTINEL}' + _cellar_json.dumps(_cellar_dbx_disconnect()))
except Exception as _e:
    print('${SENTINEL}' + _cellar_json.dumps(
        {'ok': False, 'code': 'error', 'message': '%s: %s' % (type(_e).__name__, _e)}))
finally:
    del _cellar_dbx_disconnect, _cellar_json
`;

/**
 * Run a bootstrap script in the kernel and read back its sentinel line.
 *
 * `internal: true` - this is Cellar's own bookkeeping, not a cell the user or an
 * agent ran, so it must not inflate `execs_this_session`. The session epoch is
 * taken from `execute()`'s `kernel` event, never re-read afterwards: if the
 * kernel restarts mid-connect, the epoch we stamp is the (now dead) one the
 * session was actually built in, and `connectionStatus()` correctly reports it
 * as gone rather than pairing a fresh namespace with a `spark` it never got.
 */
async function runInKernel(code) {
	let stdout = '';
	let kernelError = null;
	let session = null;
	try {
		await execute(
			code,
			(ev) => {
				if (ev.type === 'kernel') {
					session = ev.session;
				} else if (ev.type === 'output') {
					const o = ev.output;
					if (o.output_type === 'stream' && o.name === 'stdout') {
						stdout += Array.isArray(o.text) ? o.text.join('') : o.text;
					} else if (o.output_type === 'error') {
						kernelError = `${o.ename}: ${o.evalue}`;
					}
				}
			},
			{ internal: true }
		);
	} catch (err) {
		// `execute()` threw before the code ever ran: the Jupyter sidecar is
		// unreachable. That is a Cellar problem, not a Databricks one, and saying so
		// is the difference between the user restarting Cellar and them re-checking a
		// token that was never the issue.
		throw new DatabricksError('kernel_unavailable', `the Python kernel could not be reached: ${err?.message ?? err}`);
	}
	const line = stdout.split('\n').find((l) => l.startsWith(SENTINEL));
	if (!line) throw new DatabricksError('error', kernelError || 'the kernel returned no result');
	return { result: JSON.parse(line.slice(SENTINEL.length)), session };
}

/**
 * The live connection, or null. `session` is the kernel epoch `spark` was built
 * in - see the module header: it is the only thing that can tell "connected"
 * from "connected before someone restarted the kernel".
 */
let connection = null;
/** The connection a kernel restart took from us, kept so the UI can say so. */
let lost = null;
/** One connect/disconnect at a time: both mutate the same kernel namespace. */
let inFlight = false;

/**
 * The connection as the UI should see it. Reconciles against the *current*
 * kernel epoch on every read, so a restart (or a rebind onto another venv)
 * downgrades us to disconnected without anyone having to notify this module.
 */
export function connectionStatus() {
	if (connection && connection.session !== currentSessionId()) {
		lost = { profile: connection.profile, clusterName: connection.clusterName };
		connection = null;
	}
	if (!connection) return { connected: false, ...(lost ? { lost } : {}) };
	return { connected: true, ...connection };
}

/**
 * Build `spark` + `w` in the kernel against `clusterId` using `profile`.
 * Resolves with `{ok:true, connection}` or throws a `DatabricksError` whose
 * `code` the sidebar turns into actionable copy.
 */
export async function connect({ profile, clusterId, clusterName }) {
	assertMatches(profile, PROFILE_RE, 'profile');
	assertMatches(clusterId, CLUSTER_RE, 'cluster id');
	if (inFlight) throw new DatabricksError('busy', 'a Databricks connect is already in progress');
	inFlight = true;
	try {
		const { result, session } = await runInKernel(CONNECT_CODE({ profile, cluster_id: clusterId }));
		if (!result.ok) {
			connection = null;
			publishGlobal({ type: 'databricks:changed' });
			throw new DatabricksError(result.code || 'error', result.message);
		}
		connection = {
			profile,
			clusterId,
			clusterName: clusterName || clusterId,
			host: result.host ?? null,
			sparkVersion: result.spark_version ?? null,
			session
		};
		lost = null;
		publishGlobal({ type: 'databricks:changed' });
		return { ok: true, connection: connectionStatus() };
	} finally {
		inFlight = false;
	}
}

/**
 * The connection as an *agent* should see it (MCP `kernel_state`, the notebook
 * map header, and the not-connected error every `databricks_*` tool returns).
 *
 * Deliberately spells out what is bound in the namespace: an agent that knows
 * `spark` exists will use it instead of writing its own connection boilerplate,
 * which is the whole point of this integration.
 */
export function agentStatus() {
	const status = connectionStatus();
	if (!status.connected) {
		return {
			connected: false,
			...(status.lost
				? { note: `The Databricks session on cluster "${status.lost.clusterName}" ended when the kernel restarted. Ask the user to reconnect from the Databricks sidebar section.` }
				: { note: 'No Databricks session. `spark` is not defined. Ask the user to connect from the Databricks sidebar section; agents cannot connect on their own.' })
		};
	}
	return {
		connected: true,
		profile: status.profile,
		cluster: { id: status.clusterId, name: status.clusterName },
		host: status.host,
		spark_version: status.sparkVersion,
		namespace: { spark: 'pyspark SparkSession (Databricks Connect)', w: 'databricks.sdk.WorkspaceClient' },
		note: '`spark` and `w` are live in the kernel namespace against the cluster above. Use them directly - do not re-create a DatabricksSession.'
	};
}

/** The profile of the live connection, or a `not_connected` error an agent can act on. */
function requireConnectedProfile() {
	const status = connectionStatus();
	if (!status.connected) {
		throw new DatabricksError(
			'not_connected',
			'Not connected to Databricks. Ask the user to connect from the Databricks section of the Cellar sidebar (agents cannot connect on their own).'
		);
	}
	return status.profile;
}

/** Unity Catalog listings for the agent, against the profile of the live connection. */
export const forAgent = {
	catalogs: async () => listCatalogs(requireConnectedProfile()),
	schemas: async (catalog) => listSchemas(requireConnectedProfile(), catalog),
	tables: async (catalog, schema) => listTables(requireConnectedProfile(), catalog, schema)
};

/** `catalog.schema.table`, or the two-part `schema.table` a legacy metastore uses. */
function assertTableName(name) {
	const parts = typeof name === 'string' ? name.split('.') : [];
	if (parts.length < 2 || parts.length > 3 || !parts.every((p) => UC_NAME_RE.test(p))) {
		throw new DatabricksError('bad_request', `invalid table name: ${JSON.stringify(name)} (expected catalog.schema.table)`);
	}
	return name;
}

/**
 * Read `limit` rows of a table through the kernel's `spark`, and return them as
 * JSON. Runs in the kernel because that is where the session lives - but unlike
 * the UI's table preview (which inserts a cell the user keeps), this leaves no
 * trace in the notebook: an agent peeking at a table should not append a cell to
 * the human's document.
 *
 * `default=str` on the dump is what makes dates, decimals, and binary columns
 * survive the trip instead of raising deep inside `json.dumps`.
 */
const PREVIEW_CODE = (cfg) => `
import json as _cellar_json

def _cellar_dbx_preview(_cfg):
    _spark = globals().get('spark')
    if _spark is None:
        return {'ok': False, 'code': 'not_connected',
                'message': '\`spark\` is not defined in the kernel. Ask the user to connect from the Databricks sidebar section.'}
    try:
        _df = _spark.read.table(_cfg['name']).limit(_cfg['limit'])
        _schema = [{'name': _f.name, 'type': _f.dataType.simpleString()} for _f in _df.schema.fields]
        _rows = [_r.asDict(recursive=True) for _r in _df.collect()]
    except Exception as _e:
        return {'ok': False, 'code': 'read_failed', 'message': '%s: %s' % (type(_e).__name__, _e)}
    try:
        _rows = _cellar_json.loads(_cellar_json.dumps(_rows, default=str))
    except Exception as _e:
        return {'ok': False, 'code': 'read_failed', 'message': 'rows are not JSON-serializable: %s' % (_e,)}
    return {'ok': True, 'name': _cfg['name'], 'limit': _cfg['limit'], 'schema': _schema, 'rows': _rows}

try:
    print('${SENTINEL}' + _cellar_json.dumps(_cellar_dbx_preview(_cellar_json.loads(${pyLiteral(cfg)}))))
except Exception as _e:
    print('${SENTINEL}' + _cellar_json.dumps(
        {'ok': False, 'code': 'error', 'message': '%s: %s' % (type(_e).__name__, _e)}))
finally:
    del _cellar_dbx_preview, _cellar_json
`;

/** Agent-facing table preview: `{name, limit, schema, rows}`. Requires a live session. */
export async function previewTable({ name, limit = 20 }) {
	assertTableName(name);
	requireConnectedProfile();
	const n = Number(limit);
	if (!Number.isInteger(n) || n < 1 || n > 1000) {
		throw new DatabricksError('bad_request', `invalid limit: ${JSON.stringify(limit)} (1-1000)`);
	}
	const { result } = await runInKernel(PREVIEW_CODE({ name, limit: n }));
	return unwrap(result);
}

/** Stop the session and drop `spark`/`w` from the kernel namespace. */
export async function disconnect() {
	if (inFlight) throw new DatabricksError('busy', 'a Databricks connect is already in progress');
	inFlight = true;
	try {
		// Nothing to stop if the kernel that held it is gone; just clear our state.
		if (connectionStatus().connected) await runInKernel(DISCONNECT_CODE);
		connection = null;
		lost = null;
		publishGlobal({ type: 'databricks:changed' });
		return { ok: true };
	} finally {
		inFlight = false;
	}
}

/**
 * Install `databricks-sdk` + `databricks-connect` into the *project* venv (the
 * kernel's own environment) with uv, the way `venv.js` installs ipykernel.
 *
 * `databricks-connect` must match the cluster's Databricks Runtime major.minor,
 * so `version` (e.g. `16.1`) pins it; unpinned installs the latest, which only
 * talks to the latest DBR.
 */
export async function installDeps({ version } = {}) {
	const python = requirePython();
	if (!(await hasUv())) {
		throw new DatabricksError('no_uv', 'uv is not on PATH; Cellar uses uv for all installs.');
	}
	let pin = '';
	if (version) {
		if (!/^\d+(\.\d+){0,2}$/.test(version)) {
			throw new DatabricksError('bad_request', `invalid version: ${JSON.stringify(version)}`);
		}
		// `16.1` means "the 16.1 line", which is how DBR versions are quoted.
		pin = /^\d+\.\d+$/.test(version) ? `==${version}.*` : `==${version}`;
	}
	await installPackages(python, ['databricks-sdk', `databricks-connect${pin}`]);
	return { ok: true, python, ...(await checkInstall()) };
}
