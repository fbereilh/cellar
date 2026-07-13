/**
 * Cellar - native Databricks integration.
 *
 * Replaces the connection boilerplate a user would otherwise paste into a cell
 * (scrub stale `DATABRICKS_*` / `SPARK_CONNECT_*` env vars, pin a config
 * profile, build a `WorkspaceClient`, find a cluster by name, build a
 * `DatabricksSession`) with a one-click sidebar flow.
 *
 * ## Auth
 * Auth is the **databricks SDK's own** auth, nothing else - never the
 * `databricks` CLI on PATH and never the VS Code extension's bundled binary.
 * Cellar resolves each connection to one of two SDK `Config`s and hands the
 * *same* one to the listing subprocess and the kernel session, so the two can
 * never authenticate differently:
 *
 *   - **PAT** - a `~/.databrickscfg` profile that carries a `token`. The SDK
 *     reads it directly (`Config(profile=…)`); no browser, no CLI.
 *   - **OAuth U2M (`external-browser`)** - everything else (a profile with a
 *     `host` but no token - the common `auth_type = databricks-cli` shape - or a
 *     workspace host the user typed by hand). `Config(host=…,
 *     auth_type='external-browser')` runs the SDK's *own* OAuth flow: it opens
 *     the system browser, the user signs in as themselves, and the SDK mints and
 *     caches the token under `~/.config/databricks-sdk-py/oauth/`. This needs no
 *     pre-cached `databricks auth login` and no CLI on PATH, so any teammate can
 *     connect from a bare host. The cache is keyed by (host, client_id, scopes,
 *     profile), so once the interactive `login` subprocess has minted it, every
 *     later listing subprocess and the kernel session load it silently - which is
 *     why they all build the Config the same way (host only, profile unset).
 *
 * The interactive browser step runs in a short-lived **`login` subprocess** (not
 * the kernel, so it never blocks a running cell) with a long timeout; an
 * in-process `signedInHosts` gate then lets the fast listing subprocesses run
 * without ever risking a surprise second browser. The workspace *host* comes
 * from a profile's `host` or is typed directly - a cached profile is never
 * required. The profile list below is parsed from `~/.databrickscfg` so the
 * picker works before anything is installed.
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
 * `CONNECT_CODE`) so a stale `DATABRICKS_*` / `SPARK_CONNECT_*` var cannot
 * override the Config we just built. One deliberate divergence from the
 * boilerplate: `DATABRICKS_CONFIG_FILE` is preserved rather than deleted, since
 * it is what tells the SDK where the config we read the profiles from lives.
 *
 * ## Connection state is epoch-scoped, AND liveness-checked
 * `spark` lives in the kernel namespace, so a kernel restart destroys it. This
 * module records the kernel-session epoch (`kernel.js`'s monotonic
 * `currentSessionId()`) the session was created in and reports `connected:false`
 * the moment that epoch is no longer current - the same rule `service.js` uses
 * to tell a live run from a persisted one. Never report a connection from a
 * dead namespace: the user's next `spark.read…` would `NameError`.
 *
 * The epoch rule alone is not enough. A Spark Connect session can die
 * *server-side* while the same kernel epoch is still current - an idle timeout or
 * a cluster GC closes the handle, and the next `spark.*` call raises
 * `[INVALID_HANDLE.SESSION_CLOSED]` even though `spark` is still bound and the
 * epoch never changed. So `agentStatus()` also runs a cheap **liveness probe**
 * (`spark.sql('SELECT 1')` in the kernel, cached with a short TTL so repeated
 * status reads stay fast and never queue behind a running cell) and, when it sees
 * a session-closed error, **auto-reconnects** against the stored selection
 * (`connectedSel` + the same cluster) via the ordinary `connect()` path -
 * `getOrCreate()` rebuilds the expired session. A genuine kernel restart still
 * reads as disconnected (the epoch rule is untouched); only a same-epoch expiry
 * self-heals.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execute, currentSessionId, kernelStatus } from './kernel';
import { getActiveNotebookPath } from './notebook';
import { publishGlobal } from './events';
import { logInfo, logWarn, logError } from './logs';
import { hasUv, installPackages, isValidVenv, venvPython } from './venv.js';
import type { RunStreamEvent, SessionId } from './types';

// --- domain types ----------------------------------------------------------

/** A UI selection resolving to auth: a `~/.databrickscfg` profile OR a typed host. */
interface Selection {
	profile?: string | null;
	host?: string | null;
}

/**
 * The resolved auth descriptor both the listing subprocess and the kernel
 * session build a `Config` from - PAT (a profile with a token) or external-
 * browser OAuth against a host.
 */
type Auth = { mode: 'pat'; profile: string; host: string } | { mode: 'oauth'; host: string };

/** A profile parsed out of `~/.databrickscfg` (token value never exposed). */
interface Profile {
	name: string;
	host: string;
	hasToken: boolean;
	authType: string | null;
}

/** The command handed to one `PROBE` subprocess run via `argv[1]`. */
interface ProbeRequest {
	op: string;
	auth?: Auth;
	catalog?: string;
	schema?: string;
}

/**
 * The one genuinely dynamic boundary: the single JSON line the PROBE subprocess
 * (and the kernel bootstrap) always print. Success carries op-specific fields
 * (narrowed at each use site); failure is the fixed `{code, message}` contract.
 */
type ProbeOk = { ok: true } & Record<string, unknown>;
type ProbeFail = { ok: false; code: string; message: string };
type ProbeResult = ProbeOk | ProbeFail;

// Op-specific views of a `ProbeOk` payload, applied with a single `as` where the
// shape is known (the fields the python side prints for that op).
interface CheckPayload {
	sdk?: boolean;
	connect?: boolean;
	sdk_version?: string | null;
	connect_version?: string | null;
}
interface LoginPayload {
	host?: string;
	user?: string | null;
}
interface ConnectPayload {
	host?: string;
	spark_version?: string | null;
}
interface ClusterRow {
	cluster_id: string;
	name: string;
	state: string;
	spark_version: string | null;
	node_type: string | null;
}
interface CatalogRow {
	name: string;
	comment: string | null;
}
type SchemaRow = CatalogRow;
interface TableRow {
	name: string;
	full_name: string;
	table_type: string | null;
	format: string | null;
}

/** The kernel epoch a live connection's `spark` was built in. */
interface ConnectionInfo {
	profile: string | null;
	clusterId: string;
	clusterName: string;
	host: string | null;
	sparkVersion: string | null;
	session: SessionId | null;
}

/** What a kernel restart took from us, kept so the UI can explain the loss. */
interface LostConnection {
	profile: string | null;
	clusterName: string;
}

/** The connection as a reader sees it: reconciled against the current epoch. */
type ConnectionStatus =
	| { connected: false; lost?: LostConnection }
	| ({ connected: true } & ConnectionInfo);

/** Line prefix both the subprocess and the kernel bootstrap print their JSON result on. */
const SENTINEL = '__CELLAR_DBX__';

/** How long a metadata subprocess may run before it is killed. */
const PROBE_TIMEOUT_MS = 45_000;

/**
 * How long the interactive `login` subprocess may run: it opens the browser and
 * blocks on the localhost OAuth redirect, so it has to outlast a human signing
 * in (approve the app, pick an account, MFA). A kill here reads as "sign-in was
 * not completed", not "the workspace is down".
 */
const LOGIN_TIMEOUT_MS = 300_000;

/** Env vars the boilerplate clears. `DATABRICKS_CONFIG_FILE` is deliberately kept. */
const KEEP_ENV = new Set(['DATABRICKS_CONFIG_FILE']);
const isStaleEnv = (k: string): boolean =>
	(k.startsWith('DATABRICKS_') || k.startsWith('SPARK_CONNECT_')) && !KEEP_ENV.has(k);

/** A profile name as `~/.databrickscfg` and the SDK accept it. */
const PROFILE_RE = /^[A-Za-z0-9._-]+$/;
/** A workspace host the user may type by hand, once `https://` is prepended. */
const HOST_RE = /^https:\/\/[A-Za-z0-9.-]+(:\d+)?(\/[^\s]*)?$/;
/** A Databricks cluster id, e.g. `0725-123456-abcd1234`. */
const CLUSTER_RE = /^[A-Za-z0-9-]+$/;
/** A Unity Catalog identifier part. */
const UC_NAME_RE = /^[A-Za-z0-9_$-]+$/;

function workspace(): string {
	return process.env.CELLAR_WORKSPACE || process.cwd();
}

/**
 * The interpreter the kernel runs in, which is also the one the metadata
 * subprocess must use: whatever `databricks-sdk` the kernel can import is
 * exactly what our listing calls should import, or the two would disagree about
 * whether the feature is installed at all.
 */
export function projectPython(): string | null {
	const bound = process.env.CELLAR_PROJECT_VENV;
	if (bound && existsSync(bound)) return bound;
	// `vite dev` without the launcher: fall back to the conventional project venv.
	const local = join(workspace(), '.venv');
	return isValidVenv(local) ? venvPython(local) : null;
}

/** Where the SDK reads profiles from (`DATABRICKS_CONFIG_FILE` wins, as in the SDK). */
export function configPath(): string {
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
 *
 * Each profile also reports `hasToken` (a `token` key ⇒ PAT auth, no browser)
 * and its declared `authType`, so the UI can tell a one-click PAT profile from
 * one that needs the interactive OAuth sign-in. The token *value* is never
 * exposed - only whether one is present.
 */
export function readProfiles(): {
	configPath: string;
	exists: boolean;
	profiles: Profile[];
	error?: string;
} {
	const path = configPath();
	if (!existsSync(path)) return { configPath: path, exists: false, profiles: [] };
	let text: string;
	try {
		text = readFileSync(path, 'utf8');
	} catch (err) {
		return {
			configPath: path,
			exists: true,
			error: err instanceof Error ? err.message : String(err),
			profiles: []
		};
	}
	const sections: Profile[] = [];
	let current: Profile | null = null;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith('#') || line.startsWith(';')) continue;
		const section = /^\[(.+)]$/.exec(line);
		if (section) {
			current = { name: section[1].trim(), host: '', hasToken: false, authType: null };
			sections.push(current);
			continue;
		}
		if (!current) continue;
		const eq = line.indexOf('=');
		if (eq === -1) continue;
		const key = line.slice(0, eq).trim().toLowerCase();
		const value = line.slice(eq + 1).trim();
		if (key === 'host') current.host = value;
		else if (key === 'token') current.hasToken = !!value;
		else if (key === 'auth_type') current.authType = value;
	}
	// Also drop anything the SDK could not accept as a `profile=` value.
	const profiles = sections.filter((s) => s.host && PROFILE_RE.test(s.name));
	return { configPath: path, exists: true, profiles };
}

/** Normalize a user-typed workspace host: trim, drop a trailing slash, force https. */
function normalizeHost(host?: string | null): string {
	let h = String(host ?? '').trim().replace(/\/+$/, '');
	if (!h) return '';
	if (!/^https?:\/\//i.test(h)) h = `https://${h}`;
	return h.replace(/^http:\/\//i, 'https://');
}

/**
 * Resolve a UI selection - a `profile` name, or a typed `host` - to the auth
 * descriptor both the subprocess and the kernel build their `Config` from:
 *
 *   - `{ mode: 'pat', profile }`   - profile with a token; SDK reads it.
 *   - `{ mode: 'oauth', host }`    - external-browser OAuth against `host`.
 *
 * A profile without a token resolves to OAuth against the profile's own host, so
 * the ubiquitous `auth_type = databricks-cli` profile just works via the SDK's
 * native U2M flow - no CLI, no pre-cached login.
 */
export function resolveAuth({ profile, host }: Selection = {}): Auth {
	if (profile) {
		assertMatches(profile, PROFILE_RE, 'profile');
		const found = readProfiles().profiles.find((p) => p.name === profile);
		if (!found) {
			throw new DatabricksError('profile_missing', `profile "${profile}" is not in ${configPath()}`);
		}
		if (found.hasToken) return { mode: 'pat', profile, host: normalizeHost(found.host) };
		return { mode: 'oauth', host: normalizeHost(found.host) };
	}
	const h = normalizeHost(host);
	if (!h || !HOST_RE.test(h)) {
		throw new DatabricksError('bad_request', `invalid workspace host: ${JSON.stringify(host)}`);
	}
	return { mode: 'oauth', host: h };
}

/**
 * The process env with the stale Databricks/Spark vars removed. The auth
 * descriptor is passed to the probe as an explicit `Config`, so there is no
 * `DATABRICKS_CONFIG_PROFILE` to set here - a leftover one would only override
 * the host/profile we just resolved, which is exactly what `isStaleEnv` clears.
 */
function scrubEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of Object.keys(env)) if (isStaleEnv(key)) delete env[key];
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

# A per-request read timeout so a wedged socket read fails fast (and the SDK
# retries) instead of hanging until the parent SIGKILLs us at PROBE_TIMEOUT_MS -
# which is exactly what surfaced as the silent "no result and no stderr". Every
# listing call is small, so this only ever trips on a genuinely stalled
# connection, never on a legitimately large-but-flowing response.
HTTP_TIMEOUT = 30

def classify(e):
    n = type(e).__name__
    m = str(e)
    low = m.lower()
    if n in ('ImportError', 'ModuleNotFoundError'):
        return 'sdk_missing'
    if 'profile' in low and 'not found' in low:
        return 'profile_missing'
    # The OAuth U2M flow failing/being cancelled: the token could not be minted,
    # so the remedy is "sign in again", not "check your token". The SDK phrases
    # these as "default auth: external-browser: ..." (a port already bound when a
    # prior sign-in is still waiting, a cancelled consent, an unreachable IdP).
    if ('external-browser' in low or 'consent' in low or 'oauth' in low
            or 'authorization code' in low or 'address already in use' in low):
        return 'oauth_login_required'
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
    # would only ever be dead rows in the picker. Filter them out SERVER-SIDE:
    # a busy workspace accumulates thousands of one-shot job/pipeline run
    # clusters, and listing them all means the SDK pages through hundreds of
    # responses - slow, and prone to stall on a single wedged socket read, which
    # is what SIGKILLed the probe at PROBE_TIMEOUT_MS and produced the silent
    # "no result and no stderr". Asking the server for only the attachable
    # (UI/API) clusters keeps the result to a handful of rows and one page.
    # Fall back to the unfiltered walk if the installed SDK predates filter_by.
    skip = ('JOB', 'PIPELINE', 'MODELS', 'SQL')
    try:
        from databricks.sdk.service.compute import ListClustersFilterBy, ClusterSource
        it = w.clusters.list(
            filter_by=ListClustersFilterBy(cluster_sources=[ClusterSource.UI, ClusterSource.API]))
    except Exception:
        it = w.clusters.list()
    rows = []
    for c in it:
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

def build_client(auth):
    # One place that turns the resolved auth descriptor into a WorkspaceClient, so
    # the listing subprocess and (mirrored in CONNECT_CODE) the kernel session
    # build byte-identical Configs -> the OAuth token cache key matches -> a token
    # minted by 'login' is reused everywhere with no second browser.
    from databricks.sdk import WorkspaceClient
    from databricks.sdk.core import Config
    mode = auth.get('mode')
    if mode == 'pat':
        cfg = Config(profile=auth['profile'], http_timeout_seconds=HTTP_TIMEOUT)
    elif mode == 'oauth':
        cfg = Config(host=auth['host'], auth_type='external-browser', http_timeout_seconds=HTTP_TIMEOUT)
    else:
        raise ValueError('unknown auth mode: %r' % (mode,))
    return WorkspaceClient(config=cfg)

def main():
    req = json.loads(sys.argv[1])
    op = req.get('op')
    if op == 'check':
        return check()
    try:
        import databricks.sdk  # noqa: F401 - fail with a clear code before we touch auth
    except Exception as e:
        return fail(e, 'sdk_missing')
    auth = req.get('auth') or {}
    try:
        w = build_client(auth)
    except Exception as e:
        return fail(e)
    try:
        if op == 'login':
            # Force the credential to materialize: for external-browser this opens
            # the browser, waits for the redirect, and caches the token. The
            # round-trip to the workspace also proves the host is reachable.
            me = w.current_user.me()
            return {'ok': True, 'host': w.config.host, 'user': getattr(me, 'user_name', None)}
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
	code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = 'DatabricksError';
		this.code = code;
	}
}

/**
 * HTTP status for a `DatabricksError.code`. The UI keys its copy off `code`, not
 * the status, so this only has to be honest enough for the network tab.
 */
export function statusFor(code: string): number {
	switch (code) {
		case 'bad_request':
			return 400;
		case 'auth_failed':
		case 'profile_missing':
		case 'oauth_login_required':
		case 'login_failed':
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
function requirePython(): string {
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
function probe(request: ProbeRequest, timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbeResult> {
	const python = requirePython();
	return new Promise<ProbeResult>((resolve, reject) => {
		const child = spawn(python, ['-c', PROBE, JSON.stringify(request)], {
			env: scrubEnv(),
			cwd: workspace(),
			stdio: ['ignore', 'pipe', 'pipe']
		});
		let stdout = '';
		let stderr = '';
		let killedByTimeout = false;
		const timer = setTimeout(() => {
			killedByTimeout = true;
			child.kill('SIGKILL');
			reject(
				request.op === 'login'
					? new DatabricksError(
							'login_failed',
							`Databricks sign-in was not completed within ${timeoutMs / 1000}s. Try signing in again.`
						)
					: new DatabricksError(
							'timeout',
							`Databricks did not respond within ${timeoutMs / 1000}s. Check that the workspace host is reachable.`
						)
			);
		}, timeoutMs);

		// stdio is ['ignore','pipe','pipe'], so both streams exist at runtime.
		child.stdout!.on('data', (d) => (stdout += d));
		child.stderr!.on('data', (d) => (stderr += d));
		child.on('error', (err) => {
			clearTimeout(timer);
			logError('databricks', `could not run probe (${request.op}): ${err.message}`);
			reject(new DatabricksError('no_python', `could not run ${python}: ${err.message}`));
		});
		child.on('exit', (code, signal) => {
			clearTimeout(timer);
			// The subprocess's raw stderr is exactly the underlying detail the friendly
			// UI copy hides (a traceback, a TLS/connection error, an SDK deprecation),
			// so surface it in the log panel even on an otherwise "ok" result.
			const err = stderr.trim();
			if (err) logWarn('databricks', `probe stderr (${request.op}): ${err}`);
			const line = stdout.split('\n').find((l) => l.startsWith(SENTINEL));
			if (!line) {
				// The timeout path already rejected with a clear message and killed the
				// child itself, so this SIGKILL is ours - don't mislabel it as a crash.
				if (killedByTimeout) return;
				// The script always prints one; getting here means python itself died
				// before it could. Surface HOW it died (a hard crash must read as a hard
				// crash, not a silent "no result") - the signal/code is the whole clue.
				const how = signal ? `signal=${signal}` : `code=${code}`;
				const hint =
					signal === 'SIGSEGV' ? ' (segfault)' : code === 137 ? ' (killed, likely OOM)' : '';
				logError(
					'databricks',
					`probe (${request.op}) produced no result: python exited ${how}${hint}${err ? '' : ' with no stderr'}`
				);
				reject(
					new DatabricksError('error', err || `the Databricks probe crashed: python exited ${how}${hint}`)
				);
				return;
			}
			try {
				// The one dynamic boundary: parse the sentinel JSON line into ProbeResult.
				const result = JSON.parse(line.slice(SENTINEL.length)) as ProbeResult;
				// The probe never raises; a failure comes back as {ok:false, code, message}.
				// That message carries the REAL cause (`Exc: detail`) - record it so the
				// user sees why the op failed, beyond the friendly sidebar text.
				if (result && result.ok === false) {
					logError('databricks', `${request.op} failed [${result.code || 'error'}]: ${result.message || 'unknown error'}`);
				}
				resolve(result);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				logError('databricks', `unparseable probe result (${request.op}): ${msg}`);
				reject(new DatabricksError('error', `unparseable probe result: ${msg}`));
			}
		});
	});
}

/** Throw a `DatabricksError` for a `{ok:false}` probe/kernel result; else return it. */
function unwrap(result: ProbeResult): ProbeOk {
	if (result?.ok) return result;
	throw new DatabricksError(result?.code || 'error', result?.message || 'Databricks call failed');
}

/**
 * Assert the op-specific shape of a probe payload. Probe fields arrive as
 * `unknown` (the JSON boundary), so this is the one place a shape is asserted
 * onto them - the python side is what guarantees it per op.
 */
const payload = <T>(r: ProbeResult): T => r as unknown as T;

function assertMatches(value: unknown, re: RegExp, label: string): string {
	if (typeof value !== 'string' || !re.test(value)) {
		throw new DatabricksError('bad_request', `invalid ${label}: ${JSON.stringify(value)}`);
	}
	return value;
}

// ---------------------------------------------------------------------------
// Read APIs (server-side)
// ---------------------------------------------------------------------------

/**
 * Hosts this server process has completed an OAuth sign-in for (or bound via
 * PAT). It gates the listing subprocesses: they may only run once we know a
 * usable token exists on disk, so a listing can never be the thing that pops an
 * unexpected browser - the deliberate, long-lived `login` subprocess is. Lost on
 * a server restart, which is safe: the on-disk token cache survives, so the next
 * `login` is silent (cache hit) and just re-populates this set.
 */
const signedInHosts = new Set();

/** Throw `oauth_login_required` if an OAuth selection has not signed in yet. */
function assertSignedIn(auth: Auth): void {
	if (auth.mode === 'oauth' && !signedInHosts.has(auth.host)) {
		throw new DatabricksError(
			'oauth_login_required',
			`Sign in to ${auth.host} first (this opens your browser to authenticate).`
		);
	}
}

/** Resolve a `{profile}|{host}` selection to an auth descriptor and gate listing on sign-in. */
function authForListing(sel: Selection): Auth {
	const auth = resolveAuth(sel);
	assertSignedIn(auth);
	return auth;
}

/**
 * Complete the SDK's auth for a selection so later listings/sessions run
 * silently. For PAT there is nothing interactive to do (the token is already in
 * the config), so this is a no-op that just records the host. For OAuth it runs
 * the interactive `login` subprocess (opens the browser, caches the token).
 */
export async function login(sel: Selection) {
	const auth = resolveAuth(sel);
	if (auth.mode === 'pat') {
		signedInHosts.add(auth.host);
		return { ok: true, mode: 'pat', host: auth.host };
	}
	const result = payload<LoginPayload>(unwrap(await probe({ op: 'login', auth }, LOGIN_TIMEOUT_MS)));
	signedInHosts.add(auth.host);
	return { ok: true, mode: 'oauth', host: result.host ?? auth.host, user: result.user ?? null };
}

/** Runtime install state of the Databricks packages in the project venv. */
interface InstallStatus {
	python: string | null;
	sdk: boolean;
	connect: boolean;
	sdkVersion?: string | null;
	connectVersion?: string | null;
}

/** Are `databricks-sdk` / `databricks-connect` importable by the kernel's interpreter? */
export async function checkInstall(): Promise<InstallStatus> {
	const python = projectPython();
	if (!python) return { python: null, sdk: false, connect: false };
	const result = payload<CheckPayload>(await probe({ op: 'check' }));
	return { python, sdk: !!result.sdk, connect: !!result.connect, sdkVersion: result.sdk_version, connectVersion: result.connect_version };
}

/** Everything the sidebar needs to render before a connection exists. */
export async function getStatus() {
	const { configPath: path, exists, profiles, error } = readProfiles();
	let install: InstallStatus = { python: projectPython(), sdk: false, connect: false };
	let installError: string | null = null;
	try {
		install = await checkInstall();
	} catch (err) {
		installError = err instanceof Error ? err.message : String(err);
	}
	return {
		config: { path, exists, profiles, error: error ?? null },
		install,
		installError,
		uv: await hasUv(),
		signedInHosts: [...signedInHosts],
		connection: connectionStatus()
	};
}

interface CatalogList {
	ok: true;
	catalogs: CatalogRow[];
	truncated: boolean;
}
interface SchemaList {
	ok: true;
	schemas: SchemaRow[];
	truncated: boolean;
}
interface TableList {
	ok: true;
	tables: TableRow[];
	truncated: boolean;
}

export async function listClusters(sel: Selection): Promise<ClusterRow[]> {
	const auth = authForListing(sel);
	return payload<{ clusters: ClusterRow[] }>(unwrap(await probe({ op: 'clusters', auth }))).clusters;
}

export async function listCatalogs(sel: Selection): Promise<CatalogList> {
	const auth = authForListing(sel);
	return payload<CatalogList>(unwrap(await probe({ op: 'catalogs', auth })));
}

export async function listSchemas(sel: Selection, catalog: string): Promise<SchemaList> {
	const auth = authForListing(sel);
	assertMatches(catalog, UC_NAME_RE, 'catalog');
	return payload<SchemaList>(unwrap(await probe({ op: 'schemas', auth, catalog })));
}

export async function listTables(sel: Selection, catalog: string, schema: string): Promise<TableList> {
	const auth = authForListing(sel);
	assertMatches(catalog, UC_NAME_RE, 'catalog');
	assertMatches(schema, UC_NAME_RE, 'schema');
	return payload<TableList>(unwrap(await probe({ op: 'tables', auth, catalog, schema })));
}

// ---------------------------------------------------------------------------
// The session (in the kernel)
// ---------------------------------------------------------------------------

/**
 * Embed `cfg` as a python literal. `JSON.stringify` of a JSON string yields a
 * double-quoted literal whose escapes (`\\"`, `\\\\`, `\\n`, `\\uXXXX`) are all
 * valid python - so the kernel parses exactly the bytes we sent, whatever the
 * host or profile name contains. The regex validation above is the real guard;
 * this is the belt to its braces.
 */
const pyLiteral = (cfg: unknown): string => JSON.stringify(JSON.stringify(cfg));

/**
 * The boilerplate, run once inside the kernel. Everything is underscore-prefixed
 * or deleted afterwards, so the only names it leaves behind are the two the user
 * asked for: `spark` and `w`.
 *
 * Auth mirrors `build_client()` in the PROBE exactly: one `Config` (PAT via
 * profile, or external-browser OAuth via host) drives both the `WorkspaceClient`
 * and the `DatabricksSession` through `.sdkConfig(...)`, so the session and the
 * server-side listings authenticate identically. For OAuth the token was already
 * minted + cached by the `login` subprocess, so nothing here opens a browser. The
 * cluster is bound via `Config(cluster_id=...)`, NOT a separate builder call:
 * databricks-connect 15.x+ raises "sdkConfig must not be set when connection
 * parameters are explicitly configured." if `.sdkConfig()` is combined with an
 * explicit `.clusterId()` / `.remote()`.
 *
 * An existing session is stopped first - `getOrCreate()` would otherwise hand
 * back the *old* cluster's session and silently ignore the cluster just picked.
 */
const CONNECT_CODE = (cfg: { auth: Auth; cluster_id: string }): string => `
import json as _cellar_json

def _cellar_dbx_connect(_cfg):
    import os
    _keep = {${[...KEEP_ENV].map((k) => `'${k}'`).join(', ')}}
    for _k in [_k for _k in list(os.environ)
               if (_k.startswith('DATABRICKS_') or _k.startswith('SPARK_CONNECT_')) and _k not in _keep]:
        os.environ.pop(_k, None)
    _auth = _cfg['auth']
    _g = globals()
    _old = _g.pop('spark', None)
    if _old is not None:
        try:
            _old.stop()
        except Exception:
            pass
    try:
        from databricks.sdk import WorkspaceClient
        from databricks.sdk.core import Config
    except Exception as _e:
        return {'ok': False, 'code': 'sdk_missing', 'message': '%s: %s' % (type(_e).__name__, _e)}
    try:
        from databricks.connect import DatabricksSession
    except Exception as _e:
        return {'ok': False, 'code': 'connect_missing', 'message': '%s: %s' % (type(_e).__name__, _e)}
    try:
        # cluster_id must live INSIDE the Config, not on a separate .clusterId()
        # builder call: databricks-connect 15.x+ rejects .sdkConfig() combined
        # with any explicit connection param ("sdkConfig must not be set when
        # connection parameters are explicitly configured."). One Config still
        # drives both the WorkspaceClient and the session, keeping auth identical.
        if _auth['mode'] == 'pat':
            _sdk = Config(profile=_auth['profile'], cluster_id=_cfg['cluster_id'])
        else:
            _sdk = Config(host=_auth['host'], auth_type='external-browser', cluster_id=_cfg['cluster_id'])
        _w = WorkspaceClient(config=_sdk)
        _host = _w.config.host
    except Exception as _e:
        return {'ok': False, 'code': 'auth_failed', 'message': '%s: %s' % (type(_e).__name__, _e)}
    try:
        _spark = DatabricksSession.builder.sdkConfig(_sdk).getOrCreate()
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
 * A cheap liveness probe run in the kernel against the bound `spark`. A live
 * Spark Connect session answers `SELECT 1` in a single tiny RPC; a session that
 * expired server-side (idle timeout / cluster GC) raises
 * `[INVALID_HANDLE.SESSION_CLOSED]` (or "Spark Connect Session expired on the
 * server"), which the epoch check can never see because the kernel epoch is
 * still current. `expired:true` is what tells `agentStatus()` to auto-reconnect.
 * A non-session error (a transient network blip) comes back `alive:false,
 * expired:false`, so it degrades to "connected but unverified" rather than
 * tearing down a session that is probably fine.
 */
const PING_CODE = `
import json as _cellar_json

def _cellar_dbx_ping():
    _spark = globals().get('spark')
    if _spark is None:
        return {'ok': True, 'alive': False, 'expired': False, 'reason': 'no_spark'}
    try:
        _spark.sql('SELECT 1').collect()
        return {'ok': True, 'alive': True, 'expired': False}
    except Exception as _e:
        _msg = '%s: %s' % (type(_e).__name__, _e)
        _low = _msg.lower()
        _expired = ('session_closed' in _low or 'invalid_handle' in _low
                    or 'session expired' in _low or 'session was closed' in _low
                    or 'session is closed' in _low or 'sessionclosed' in _low)
        return {'ok': True, 'alive': False, 'expired': _expired, 'message': _msg}

try:
    print('${SENTINEL}' + _cellar_json.dumps(_cellar_dbx_ping()))
except Exception as _e:
    print('${SENTINEL}' + _cellar_json.dumps(
        {'ok': False, 'code': 'error', 'message': '%s: %s' % (type(_e).__name__, _e)}))
finally:
    del _cellar_dbx_ping, _cellar_json
`;

/** Does an error message look like a dead/expired Spark Connect session handle? */
export function isSessionClosed(message: unknown): boolean {
	const m = String(message ?? '').toLowerCase();
	return (
		m.includes('session_closed') ||
		m.includes('sessionclosed') ||
		m.includes('invalid_handle') ||
		m.includes('session expired') ||
		m.includes('session was closed') ||
		m.includes('session is closed')
	);
}

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
async function runInKernel(code: string): Promise<{ result: ProbeResult; session: SessionId | null }> {
	let stdout = '';
	let kernelError: string | null = null;
	let session: SessionId | null = null;
	try {
		// Databricks binds `spark`/`w` into the ACTIVE notebook's kernel (per-notebook
		// Databricks is a later phase); the epoch we stamp comes from that kernel.
		await execute(
			getActiveNotebookPath(),
			code,
			(ev: RunStreamEvent) => {
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
		const detail = err instanceof Error ? err.message : String(err);
		logError('databricks', `kernel unreachable during Databricks op: ${detail}`);
		throw new DatabricksError('kernel_unavailable', `the Python kernel could not be reached: ${detail}`);
	}
	const line = stdout.split('\n').find((l) => l.startsWith(SENTINEL));
	if (!line) {
		if (kernelError) logError('databricks', `kernel error during Databricks op: ${kernelError}`);
		throw new DatabricksError('error', kernelError || 'the kernel returned no result');
	}
	// The kernel bootstrap prints the same sentinel {ok,...} JSON as the PROBE.
	return { result: JSON.parse(line.slice(SENTINEL.length)) as ProbeResult, session };
}

/**
 * The live connection, or null. `session` is the kernel epoch `spark` was built
 * in - see the module header: it is the only thing that can tell "connected"
 * from "connected before someone restarted the kernel".
 */
let connection: ConnectionInfo | null = null;
/** The `{profile}|{host}` selection the live connection was built from (for `forAgent` listings). */
let connectedSel: Selection | null = null;
/** The connection a kernel restart took from us, kept so the UI can say so. */
let lost: LostConnection | null = null;
/** One connect/disconnect at a time: both mutate the same kernel namespace. */
let inFlight = false;

/**
 * The cached result of the last liveness probe. `agentStatus()` reads it instead
 * of re-pinging the workspace on every call: a probe is only re-run when the
 * cache is missing, stale (older than `LIVENESS_TTL_MS`), or from a different
 * kernel epoch. Keeping the round-trip out of the common path is what preserves
 * "status is fast" while still catching a server-side session expiry.
 */
interface Liveness {
	session: SessionId | null;
	alive: boolean;
	expired: boolean;
	checkedAt: number;
	message?: string;
}
let liveness: Liveness | null = null;
/** In-flight probe, so concurrent status reads share one `SELECT 1`, not N. */
let livenessInFlight: Promise<Liveness> | null = null;
/** In-flight auto-reconnect, so a burst of expired-status reads heals once. */
let reconnecting: Promise<boolean> | null = null;

/** How long a liveness probe result is trusted before it must be refreshed. */
const LIVENESS_TTL_MS = 15_000;

/**
 * The connection as the UI should see it. Reconciles against the *current*
 * kernel epoch on every read, so a restart (or a rebind onto another venv)
 * downgrades us to disconnected without anyone having to notify this module.
 *
 * This is the epoch-only view (no workspace round-trip), so it stays cheap for
 * the frequently-polled sidebar. The server-side liveness check lives in
 * `agentStatus()`, which is what the agent surface reads.
 */
export function connectionStatus(): ConnectionStatus {
	if (connection && connection.session !== currentSessionId()) {
		lost = { profile: connection.profile, clusterName: connection.clusterName };
		connection = null;
		connectedSel = null;
		liveness = null;
	}
	if (!connection) return { connected: false, ...(lost ? { lost } : {}) };
	return { connected: true, ...connection };
}

/**
 * Probe whether the bound `spark` session is actually alive, memoizing the
 * result. Concurrent callers share the one in-flight probe. A `SELECT 1` is a
 * single tiny RPC, so this is cheap - but it still runs in the kernel, so the
 * caller (`agentStatus`) skips it entirely when the kernel is busy rather than
 * queue behind a running cell.
 */
async function probeLiveness(session: SessionId | null): Promise<Liveness> {
	if (livenessInFlight) return livenessInFlight;
	livenessInFlight = (async () => {
		let live: Liveness;
		try {
			const { result, session: ran } = await runInKernel(PING_CODE);
			const r = result as ProbeResult & { alive?: boolean; expired?: boolean; message?: string };
			live = {
				session: ran ?? session,
				alive: r.ok === true && r.alive === true,
				expired: r.ok === true && r.expired === true,
				checkedAt: Date.now(),
				message: r.message
			};
		} catch (err) {
			// The kernel was unreachable (a Cellar problem, not an expiry). Record it as
			// "unverified", never as expired: tearing down a session because the sidecar
			// hiccuped would be the wrong direction.
			live = {
				session,
				alive: false,
				expired: false,
				checkedAt: Date.now(),
				message: err instanceof Error ? err.message : String(err)
			};
		}
		liveness = live;
		return live;
	})();
	try {
		return await livenessInFlight;
	} finally {
		livenessInFlight = null;
	}
}

/**
 * Rebuild an expired session against the stored selection + cluster, via the
 * ordinary `connect()` path (`getOrCreate()` rebuilds the closed session). Reuses
 * the exact auth + cluster of the connection that just expired, so the epoch
 * semantics are preserved: a real kernel restart already nulled `connection`
 * above, so this can only ever heal a same-epoch, server-side expiry. Concurrent
 * callers share one attempt.
 */
async function autoReconnect(): Promise<boolean> {
	if (reconnecting) return reconnecting;
	const conn = connection;
	const sel = connectedSel;
	if (!conn || !sel) return false;
	reconnecting = (async () => {
		try {
			logInfo('databricks', `Spark Connect session expired; auto-reconnecting cluster "${conn.clusterName}"`);
			await connect({
				profile: sel.profile ?? null,
				host: sel.host ?? null,
				clusterId: conn.clusterId,
				clusterName: conn.clusterName
			});
			liveness = { session: currentSessionId(), alive: true, expired: false, checkedAt: Date.now() };
			logInfo('databricks', 'Databricks auto-reconnect succeeded');
			return true;
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			logWarn('databricks', `Databricks auto-reconnect failed: ${detail}`);
			// Cache the failed-heal so a burst of status reads does not hammer the
			// cluster with reconnect attempts; the TTL lets it retry later.
			liveness = {
				session: currentSessionId(),
				alive: false,
				expired: true,
				checkedAt: Date.now(),
				message: detail
			};
			return false;
		} finally {
			reconnecting = null;
		}
	})();
	return reconnecting;
}

/**
 * Build `spark` + `w` in the kernel against `clusterId`, using the resolved auth
 * for the chosen `profile` OR typed `host`. Resolves with `{ok:true, connection}`
 * or throws a `DatabricksError` whose `code` the sidebar turns into actionable
 * copy. `assertSignedIn` guarantees an OAuth connect never opens a browser in the
 * kernel: the interactive login already happened in its own subprocess.
 */
export async function connect({
	profile,
	host,
	clusterId,
	clusterName
}: {
	profile?: string | null;
	host?: string | null;
	clusterId: string;
	clusterName?: string | null;
}): Promise<{ ok: true; connection: ConnectionStatus }> {
	assertMatches(clusterId, CLUSTER_RE, 'cluster id');
	const sel: Selection = profile ? { profile } : { host };
	const auth = resolveAuth(sel);
	assertSignedIn(auth);
	if (inFlight) throw new DatabricksError('busy', 'a Databricks connect is already in progress');
	inFlight = true;
	try {
		logInfo('databricks', `connecting: profile "${profile}", cluster "${clusterName || clusterId}"`);
		const { result, session } = await runInKernel(CONNECT_CODE({ auth, cluster_id: clusterId }));
		if (!result.ok) {
			connection = null;
			connectedSel = null;
			publishGlobal({ type: 'databricks:changed' });
			logError('databricks', `connect failed [${result.code || 'error'}]: ${result.message || 'unknown error'}`);
			throw new DatabricksError(result.code || 'error', result.message);
		}
		const ok = payload<ConnectPayload>(result);
		connection = {
			profile: profile ?? null,
			clusterId,
			clusterName: clusterName || clusterId,
			host: ok.host ?? auth.host ?? null,
			sparkVersion: ok.spark_version ?? null,
			session
		};
		// Re-query catalogs against the same auth, using the SDK's canonical host.
		connectedSel = auth.mode === 'pat' ? { profile } : { host: connection.host };
		lost = null;
		// A fresh session is alive by construction; seed the cache so an immediate
		// status read doesn't pay for a redundant liveness probe.
		liveness = { session, alive: true, expired: false, checkedAt: Date.now() };
		publishGlobal({ type: 'databricks:changed' });
		logInfo('databricks', `connected: host ${ok.host ?? '?'}, spark ${ok.spark_version ?? '?'}`);
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
export async function agentStatus() {
	const status: ConnectionStatus = connectionStatus();
	if (!status.connected) {
		liveness = null;
		return {
			connected: false,
			...(status.lost
				? { note: `The Databricks session on cluster "${status.lost.clusterName}" ended when the kernel restarted. Ask the user to reconnect from the Databricks sidebar section.` }
				: { note: 'No Databricks session. `spark` is not defined. Ask the user to connect from the Databricks sidebar section; agents cannot connect on their own.' })
		};
	}

	// `spark` is bound in the current epoch - but the Spark Connect handle may have
	// died server-side (idle timeout / cluster GC) while the epoch stayed current.
	// Verify liveness (cached; skipped when the kernel is busy so we never queue
	// behind a running cell), and self-heal on a session-closed error.
	const sid = status.session;
	const fresh = liveness && liveness.session === sid && Date.now() - liveness.checkedAt < LIVENESS_TTL_MS;
	let live: Liveness | null = fresh ? liveness : null;
	if (!live) {
		if (kernelStatus().status === 'busy') {
			// Don't block status behind a running cell. Fall back to the last-known
			// reading for this epoch if we have one; otherwise report unverified.
			live = liveness && liveness.session === sid ? liveness : null;
		} else {
			live = await probeLiveness(sid);
		}
	}

	if (live?.expired) {
		const healed = await autoReconnect();
		if (!healed) {
			return {
				connected: false,
				expired: true,
				stale: true,
				cluster: { id: status.clusterId, name: status.clusterName },
				host: status.host,
				note: 'The Databricks Connect session expired (idle timeout or cluster GC) and Cellar could not automatically reconnect. Ask the user to reconnect from the Databricks sidebar section, then re-run the cell.'
			};
		}
		// autoReconnect() rebuilt spark/w against the same cluster; report the fresh
		// connection so the agent knows spark is usable again.
		const healedStatus = connectionStatus();
		if (healedStatus.connected) {
			return {
				...connectedPayload(healedStatus),
				reconnected: true,
				note: 'The previous Databricks Connect session had expired; Cellar automatically reconnected. `spark` and `w` are live again against the cluster above - re-run any cell that failed with SESSION_CLOSED. Use them directly, do not re-create a DatabricksSession.'
			};
		}
	}

	const payloadOut = connectedPayload(status);
	if (live && !live.alive && !live.expired) {
		// A non-session error (or a busy-skipped probe): spark is still bound and the
		// epoch is current, so report connected, but flag that we could not confirm.
		return { ...payloadOut, liveness_unverified: true };
	}
	return payloadOut;
}

/** The standard connected payload the agent reads, shared by the healthy + healed paths. */
function connectedPayload(status: ConnectionStatus & { connected: true }) {
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

/** The `{profile}|{host}` selection of the live connection, or a `not_connected` error an agent can act on. */
function requireConnectedSel(): Selection {
	const status = connectionStatus();
	if (!status.connected || !connectedSel) {
		throw new DatabricksError(
			'not_connected',
			'Not connected to Databricks. Ask the user to connect from the Databricks section of the Cellar sidebar (agents cannot connect on their own).'
		);
	}
	return connectedSel;
}

/** Unity Catalog listings for the agent, against the auth of the live connection. */
export const forAgent = {
	catalogs: async (): Promise<CatalogList> => listCatalogs(requireConnectedSel()),
	schemas: async (catalog: string): Promise<SchemaList> => listSchemas(requireConnectedSel(), catalog),
	tables: async (catalog: string, schema: string): Promise<TableList> =>
		listTables(requireConnectedSel(), catalog, schema)
};

/** `catalog.schema.table`, or the two-part `schema.table` a legacy metastore uses. */
function assertTableName(name: string): string {
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
const PREVIEW_CODE = (cfg: { name: string; limit: number }): string => `
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

interface PreviewColumn {
	name: string;
	type: string;
}
/** Agent-facing table preview payload: schema + JSON rows read through `spark`. */
interface PreviewResult {
	ok: true;
	name: string;
	limit: number;
	schema: PreviewColumn[];
	rows: Record<string, unknown>[];
}

/** Agent-facing table preview: `{name, limit, schema, rows}`. Requires a live session. */
export async function previewTable({
	name,
	limit = 20
}: {
	name: string;
	limit?: number;
}): Promise<PreviewResult> {
	assertTableName(name);
	requireConnectedSel();
	const n = Number(limit);
	if (!Number.isInteger(n) || n < 1 || n > 1000) {
		throw new DatabricksError('bad_request', `invalid limit: ${JSON.stringify(limit)} (1-1000)`);
	}
	let { result } = await runInKernel(PREVIEW_CODE({ name, limit: n }));
	// If the read failed because the session expired server-side, self-heal once:
	// rebuild spark against the same cluster and retry - the agent gets its rows
	// instead of a dead-session error it cannot recover from on its own.
	if (result.ok === false && isSessionClosed(result.message) && (await autoReconnect())) {
		({ result } = await runInKernel(PREVIEW_CODE({ name, limit: n })));
	}
	return payload<PreviewResult>(unwrap(result));
}

/** Stop the session and drop `spark`/`w` from the kernel namespace. */
export async function disconnect(): Promise<{ ok: true }> {
	if (inFlight) throw new DatabricksError('busy', 'a Databricks connect is already in progress');
	inFlight = true;
	try {
		// Nothing to stop if the kernel that held it is gone; just clear our state.
		if (connectionStatus().connected) await runInKernel(DISCONNECT_CODE);
		connection = null;
		connectedSel = null;
		lost = null;
		liveness = null;
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
export async function installDeps({ version }: { version?: string | null } = {}) {
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
	// checkInstall() already reports `python`; spreading it last is what the caller
	// sees, so no explicit `python` key here (it would only be overwritten).
	return { ok: true, ...(await checkInstall()) };
}
