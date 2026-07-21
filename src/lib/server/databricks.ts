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
 *   - **Profile** - a named `~/.databrickscfg` profile. The SDK reads it
 *     directly (`Config(profile=…)`) and authenticates it **however that profile
 *     is configured** - a `token` (PAT, no browser), a `databricks-cli` /
 *     keyring / already-cached OAuth token (silent), or, only on a genuine cache
 *     miss, the SDK's own `external-browser` flow. Cellar does NOT second-guess
 *     which: it trusts the SDK, and it always preserves the profile *name* rather
 *     than collapsing a no-token profile to a bare host. A profile that the SDK
 *     can authenticate (the ubiquitous `auth_type = databricks-cli` / OAuth
 *     profile with a cached token - the captain's `DEFAULT`) therefore just works
 *     with no Cellar sign-in step. The ONE exception, so a listing/connect can
 *     never itself pop a browser: a no-token `auth_type = external-browser`
 *     profile (`profileNeedsSignIn`) is held behind the same sign-in gate as a
 *     bare host - it still authenticates by name (`Config(profile=…)`), just after
 *     the deliberate `login` runs. Any other profile whose auth genuinely needs a
 *     fresh interactive login surfaces `oauth_login_required` reactively (from the
 *     SDK error), which the `login` subprocess then satisfies.
 *   - **OAuth U2M (`external-browser`)** - a workspace **host the user typed by
 *     hand**, with no profile to read. `Config(host=…, auth_type='external-
 *     browser')` runs the SDK's *own* OAuth flow: it opens the system browser,
 *     the user signs in as themselves, and the SDK mints and caches the token
 *     under `~/.config/databricks-sdk-py/oauth/`. This needs no pre-cached
 *     `databricks auth login` and no CLI on PATH, so any teammate can connect
 *     from a bare host. Because a bare host has no profile-scoped cached token,
 *     this path is gated: the interactive `login` must run before any listing.
 *
 * The interactive browser step runs in a short-lived **`login` subprocess** (not
 * the kernel, so it never blocks a running cell) with a long timeout. For a bare
 * host an in-process `signedInHosts` gate (and its `signedInProfiles` sibling for
 * a no-token external-browser profile) lets the fast listing subprocesses run
 * only after that sign-in, so a listing can never be the thing that pops the
 * browser; every other named profile is never pre-gated (the SDK owns its auth
 * and reads its own token cache first). The workspace *host* comes from a profile's `host`
 * or is typed directly - a cached profile is never required. The profile list
 * below is parsed from `~/.databrickscfg` so the picker works before anything is
 * installed.
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
import { execute, currentSessionId, kernelStatus, restartKernel, refreshKernelConnection } from './kernel';
import {
	dbrMajorMinor,
	parseVersionMismatch,
	pinTargetForConnect,
	versionMismatchMessage
} from './dbrVersion';
import { resolveNotebookPath } from './notebook';
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
 * session build a `Config` from - a named profile the SDK authenticates itself
 * (`Config(profile=…)`, whatever the profile's `auth_type`) or external-browser
 * OAuth against a bare typed host.
 */
type Auth =
	| { mode: 'profile'; profile: string; host: string; needsSignIn: boolean }
	| { mode: 'oauth'; host: string };

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
	cluster_id?: string;
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
 * Each profile also reports `hasToken` (a `token` key ⇒ PAT auth) and its
 * declared `authType`. Every named profile is handed to the SDK the same way
 * (`Config(profile=…)`), which authenticates a no-token profile from its own
 * cached OAuth/keyring/CLI credential - so these fields are almost purely a UI
 * label. The one gate they drive is `profileNeedsSignIn`: a no-token
 * `auth_type = external-browser` profile is the sole shape the SDK could pop a
 * browser for, so it (alone) is held behind sign-in. The token *value* is never
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
 * The one profile shape a silent listing/connect could still make the SDK open a
 * browser for: `auth_type = external-browser` with no `token`. A profile with a
 * `token` (PAT), or `databricks-cli`, or no explicit `auth_type` at all (the SDK
 * infers `databricks-cli` - the captain's `DEFAULT`) is NOT this: it authenticates
 * from a token or a CLI-supplied credential and only ever errors cleanly, never a
 * browser. So the gate keys on `external-browser` specifically - never on a merely
 * missing `auth_type` - to avoid re-gating `DEFAULT`.
 */
function profileNeedsSignIn(p: Profile): boolean {
	return p.authType === 'external-browser' && !p.hasToken;
}

/**
 * Resolve a UI selection - a `profile` name, or a typed `host` - to the auth
 * descriptor both the subprocess and the kernel build their `Config` from:
 *
 *   - `{ mode: 'profile', profile }` - a `~/.databrickscfg` profile the SDK
 *     authenticates itself, whatever its `auth_type` (a `token`, a
 *     `databricks-cli` / keyring / cached-OAuth credential, or a fresh
 *     external-browser login only on a genuine cache miss).
 *   - `{ mode: 'oauth', host }`      - external-browser OAuth against a bare host.
 *
 * A named profile - **with or without a token** - resolves to profile auth with
 * its name preserved: Cellar trusts the SDK's profile auth and never collapses a
 * no-token profile into its own browser-OAuth flow (that discarded the profile
 * identity and forced a redundant sign-in for a profile the SDK could already
 * authenticate, e.g. an `auth_type = databricks-cli` profile with a cached
 * token). Cellar's own OAuth (`mode: 'oauth'`) is reserved for a typed host with
 * no profile to read.
 *
 * `needsSignIn` marks the ONE profile shape the SDK could pop a browser for from
 * an otherwise-silent listing/connect: `auth_type = external-browser` with no
 * `token`. Those alone are gated behind an explicit sign-in (`assertSignedIn`,
 * exactly like a bare host), so a listing/connect never triggers the browser -
 * only the deliberate `login` subprocess does. Every other profile (a PAT,
 * `databricks-cli`, or - the captain's `DEFAULT` - one with no explicit
 * `auth_type`, which the SDK infers as `databricks-cli`) is never pre-gated: it
 * lists silently, and a profile whose auth genuinely needs a fresh interactive
 * login still surfaces `oauth_login_required` reactively from the SDK error.
 */
export function resolveAuth({ profile, host }: Selection = {}): Auth {
	if (profile) {
		assertMatches(profile, PROFILE_RE, 'profile');
		const found = readProfiles().profiles.find((p) => p.name === profile);
		if (!found) {
			throw new DatabricksError('profile_missing', `profile "${profile}" is not in ${configPath()}`);
		}
		return {
			mode: 'profile',
			profile,
			host: normalizeHost(found.host),
			needsSignIn: profileNeedsSignIn(found)
		};
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

def cluster(w, cluster_id):
    # The one field the connect flow needs BEFORE building the session: the
    # cluster's Databricks Runtime (spark_version), so it can pin
    # databricks-connect to a matching client. Fetched authoritatively from the
    # workspace (not trusted from the picker), so a stale/renamed cluster still
    # reports its real runtime. The state field rides along so the connect and
    # reconnect gates can refuse a TERMINATED cluster with a clean
    # cluster_terminated instead of a raw Spark Connect error (agents cannot
    # start compute).
    c = w.clusters.get(cluster_id=cluster_id)
    return {'ok': True, 'spark_version': getattr(c, 'spark_version', None),
            'state': enum_value(getattr(c, 'state', None)) or 'UNKNOWN'}

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
    if mode == 'profile':
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
        if op == 'cluster':
            return cluster(w, req['cluster_id'])
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
		case 'version_mismatch':
		case 'cluster_terminated':
		case 'reconnect_failed':
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
 * Bare **hosts** this server process has completed an OAuth sign-in for. It gates
 * the host path's listing subprocesses (a typed host has no profile-scoped token
 * cache to read): they may run only once we know a usable token exists on disk,
 * so a listing can never be the thing that pops an unexpected browser - the
 * deliberate, long-lived `login` subprocess is. Lost on a server restart, which
 * is safe: the on-disk token cache survives, so the next `login` is silent (cache
 * hit) and just re-populates this set.
 */
const signedInHosts = new Set<string>();

/**
 * **Profiles** this server process has signed in for. The sibling of
 * `signedInHosts` for the ONE profile shape that is gated: a no-token
 * `auth_type = external-browser` profile (`profileNeedsSignIn`), whose SDK auth
 * could otherwise open a browser from a listing/connect. Every other profile is
 * never gated, so it never lands here. Same restart-safe reasoning: the SDK's own
 * token cache survives, so the next `login` is a silent cache hit.
 */
const signedInProfiles = new Set<string>();

/**
 * Throw `oauth_login_required` if a selection that could pop a browser has not
 * signed in yet: a bare-host OAuth selection, or a no-token external-browser
 * profile (`auth.needsSignIn`). Any other profile passes straight through - the
 * SDK reads its own credential and, if it genuinely needs one, errors reactively.
 */
function assertSignedIn(auth: Auth): void {
	if (auth.mode === 'oauth') {
		if (!signedInHosts.has(auth.host)) {
			throw new DatabricksError(
				'oauth_login_required',
				`Sign in to ${auth.host} first (this opens your browser to authenticate).`
			);
		}
		return;
	}
	if (auth.needsSignIn && !signedInProfiles.has(auth.profile)) {
		throw new DatabricksError(
			'oauth_login_required',
			`Sign in to profile "${auth.profile}" first (this opens your browser to authenticate).`
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
 * silently, by forcing the credential to materialize (the `login` op's
 * `current_user.me()` round-trip). For a bare **host** this opens the browser and
 * caches the token; for a named **profile** the SDK reads its own auth - a PAT or
 * an already-cached OAuth/keyring token verifies silently, and only a genuine
 * cache miss opens the browser. Either way the round-trip proves the workspace is
 * reachable. The completed sign-in is recorded so the gated selections
 * (`assertSignedIn`) - a bare host, or a no-token external-browser profile - now
 * list/connect silently.
 */
export async function login(sel: Selection) {
	const auth = resolveAuth(sel);
	const result = payload<LoginPayload>(unwrap(await probe({ op: 'login', auth }, LOGIN_TIMEOUT_MS)));
	if (auth.mode === 'oauth') signedInHosts.add(auth.host);
	else signedInProfiles.add(auth.profile);
	return { ok: true, mode: auth.mode, host: result.host ?? auth.host, user: result.user ?? null };
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

/**
 * Everything the sidebar needs to render before a connection exists. `nb` is the
 * notebook whose connection to report - the sidebar passes the ACTIVE notebook,
 * so the panel always reflects the focused notebook's Databricks session. The
 * profiles/install/uv fields are workspace-level and notebook-independent.
 *
 * `connection` is `liveConnection(nb)` (not the raw epoch-only `connectionStatus`):
 * it reflects a REAL liveness verdict, so a session whose Spark Connect client was
 * closed (idle timeout / cluster GC) reads as expired/reconnecting rather than
 * "connected" over a dead handle. That runs a cached `SELECT 1` probe, so this
 * call may contact the workspace - but the probe is memoized (short TTL) and
 * skipped while the kernel is busy, and it NEVER boots a kernel, so the sidebar
 * poll stays cheap. It never blocks on a reconnect either (see `liveConnection`).
 */
export async function getStatus(nb?: string | null) {
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
		signedInProfiles: [...signedInProfiles],
		connection: await liveConnection(nb)
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
 * The pure, ipywidgets-free core of the live Spark-progress feature: the
 * per-stage → overall-completion projection (`_cellar_spark_summary`) and the
 * stateful bar manager (`_CellarSparkProgress`). Kept renderer-agnostic (the
 * manager takes an injected renderer) so it is exercisable from a plain `python3`
 * in a unit test with a fake renderer, exactly as `dataflow.ts`'s probe is - see
 * `tests/unit/spark-progress.test.ts`.
 *
 * Design facts, all hard-won against a real Databricks cluster (recorded in
 * `AGENTS.md`):
 *   - `registerProgressHandler` is Spark **Connect only** (`@remote_only`), which
 *     is exactly what Cellar's Databricks integration uses. The handler is called
 *     synchronously on the cell-execution thread inside `.collect()`, so a widget
 *     displayed here parents to the running cell's output - just like tqdm.
 *   - The handler fires ~4-5 times per ~2s tick with IDENTICAL payloads, so it
 *     MUST dedupe (here: by `key`, an absolute-counts tuple - never increments).
 *   - A query shorter than the server `reportInterval` (~2s) delivers a single
 *     terminal `done=True` callback and no intermediate ticks. That is expected;
 *     the `if s['done'] ... return` guard means such a query (and Cellar's own
 *     sub-second internal `SELECT 1` probes) never flashes a bar.
 */
export const SPARK_PROGRESS_CORE_PY = `
def _cellar_human_bytes(n):
    try:
        n = float(n or 0)
    except Exception:
        return ''
    if n <= 0:
        return ''
    for _u in ('B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'):
        if n < 1024.0 or _u == 'PiB':
            return ('%d B' % int(n)) if _u == 'B' else ('%.1f %s' % (n, _u))
        n /= 1024.0

def _cellar_spark_summary(stages, inflight_tasks, done):
    stages = list(stages or [])
    total = 0
    completed = 0
    nbytes = 0
    for _st in stages:
        total += int(getattr(_st, 'num_tasks', 0) or 0)
        completed += int(getattr(_st, 'num_completed_tasks', 0) or 0)
        nbytes += int(getattr(_st, 'num_bytes_read', 0) or 0)
    try:
        inflight = int(inflight_tasks or 0)
    except Exception:
        inflight = 0
    pct = (100.0 * completed / total) if total > 0 else 0.0
    _parts = ['%d/%d tasks' % (completed, total)]
    if inflight > 0:
        _parts.append('%d running' % inflight)
    _hb = _cellar_human_bytes(nbytes)
    if _hb:
        _parts.append(_hb)
    return {
        'total': total,
        'completed': completed,
        'inflight': inflight,
        'bytes': nbytes,
        'num_stages': len(stages),
        'pct': pct,
        'done': bool(done),
        'key': (completed, total, inflight, bool(done), len(stages)),
        'label': ' \\u00b7 '.join(_parts),
    }

class _CellarSparkProgress:
    def __init__(self, renderer):
        self._r = renderer
        self._bars = {}

    def handle(self, stages, inflight_tasks, operation_id, done):
        # The handler runs inside the user's .collect(); a bug here must never
        # break their query, so the whole body is swallowed.
        try:
            s = _cellar_spark_summary(stages, inflight_tasks, done)
            e = self._bars.get(operation_id)
            if e is None:
                # No bar yet: only create one for a query still doing real work.
                # A terminal-only callback (sub-interval query / internal probe)
                # or a zero-task plan never flashes a bar.
                if s['done'] or s['total'] <= 0:
                    return
                e = {'w': self._r.make(), 'key': None}
                self._bars[operation_id] = e
                self._r.show(e['w'])
            # DEDUPE: the ~4-5 identical callbacks per tick collapse to one render.
            if s['key'] == e['key']:
                return
            e['key'] = s['key']
            self._r.update(e['w'], s)
            if s['done']:
                # Complete + stop tracking this query. The renderer fills to 100%
                # and closes the widget; the bar never persists (clean-on-save
                # strips the widget-view mime).
                self._r.close(e['w'], s)
                self._bars.pop(operation_id, None)
        except Exception:
            pass


def _cellar_spark_progress_cb(mgr):
    # The callable actually registered with Spark. It is deliberately NOT the
    # bound method: pyspark's Progress._notify invokes the handler with no
    # try/except of its own, so an argument-binding mismatch (a future
    # databricks-connect ProgressHandler.__call__ signature change - added,
    # renamed, or reordered params) would raise INSIDE the user's .collect()
    # and break their query, which the handler body's own try/except cannot
    # reach. This *args/**kwargs wrapper binds any call shape, extracts the four
    # fields by keyword (falling back to positional index for other call
    # conventions), and swallows everything - so a signature drift degrades to
    # 'no bar' instead of a crash. It must itself never raise.
    def _cb(*args, **kwargs):
        try:
            def _pick(name, idx):
                if name in kwargs:
                    return kwargs[name]
                if idx < len(args):
                    return args[idx]
                return None
            mgr.handle(_pick('stages', 0), _pick('inflight_tasks', 1),
                       _pick('operation_id', 2), _pick('done', 3))
        except Exception:
            pass
    return _cb
`;

/**
 * Registers the progress handler on a live `spark` session, wired to an
 * ipywidgets renderer (an `HBox[FloatProgress, Label]`, the same composite tqdm
 * uses, so it draws through Cellar's already-working widget pipeline with zero
 * frontend work). Guarded on ipywidgets being importable: if it is absent the
 * function registers nothing and returns, degrading silently to today's behavior
 * (Cellar only guarantees `ipykernel` in a project venv). `clearProgressHandlers`
 * first makes re-registration on reconnect idempotent (no duplicate bars).
 */
const SPARK_PROGRESS_INSTALL_PY = `
def _cellar_install_spark_progress(_spark):
    _g = globals()
    try:
        import ipywidgets as _ipw
        from IPython.display import display as _ipy_display
    except Exception:
        return False

    class _CellarIpwRenderer:
        def make(self):
            _bar = _ipw.FloatProgress(value=0.0, min=0.0, max=100.0,
                                      description='Spark', bar_style='info')
            _lbl = _ipw.Label(value='starting\\u2026')
            return (_ipw.HBox([_bar, _lbl]), _bar, _lbl)

        def show(self, w):
            # Emit ONLY the widget-view mime, never the text/plain HBox repr:
            # clean-on-save strips the widget mime, and with no fallback the
            # output is left empty and dropped entirely, so a query's progress
            # bar leaves ZERO residue in the saved .ipynb (a kept text/plain repr
            # would otherwise persist an 'HBox(children=(FloatProgress(...)))'
            # line). Live rendering is unaffected - the browser draws from the
            # widget model over the comm, not the fallback.
            _ipy_display(w[0], include=['application/vnd.jupyter.widget-view+json'])

        def update(self, w, s):
            _box, _bar, _lbl = w
            _bar.value = s['pct']
            _lbl.value = s['label']

        def close(self, w, s):
            _box, _bar, _lbl = w
            _bar.value = 100.0
            _bar.bar_style = 'success'
            _lbl.value = s['label']
            try:
                _box.close()
            except Exception:
                pass

    _mgr = _CellarSparkProgress(_CellarIpwRenderer())
    _g['_cellar_spark_progress'] = _mgr
    _cb = _cellar_spark_progress_cb(_mgr)
    _g['_cellar_spark_progress_cb'] = _cb
    try:
        _spark.clearProgressHandlers()
    except Exception:
        pass
    try:
        _spark.registerProgressHandler(_cb)
        return True
    except Exception:
        return False
`;

/**
 * The boilerplate, run once inside the kernel. Everything is underscore-prefixed
 * or deleted afterwards, so the only names it leaves behind are the two the user
 * asked for: `spark` and `w`.
 *
 * Auth mirrors `build_client()` in the PROBE exactly: one `Config` (a named
 * profile the SDK authenticates, or external-browser OAuth via a bare host)
 * drives both the `WorkspaceClient`
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
${SPARK_PROGRESS_CORE_PY}
${SPARK_PROGRESS_INSTALL_PY}
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
        if _auth['mode'] == 'profile':
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
    # Deliberately NOT rebinding dbutils: the Cellar-native dbutils.widgets shim
    # injected at kernel start (widgetsShim.ts) owns the bare dbutils name so
    # parameter widgets work with or without a connection. The SDK's own
    # w.dbutils stays reachable and untouched. No double-binding / shadowing.
    # Live per-stage job progress bars. Best-effort: a failure here (no
    # ipywidgets, an older client) must never fail the connection.
    try:
        _cellar_install_spark_progress(_spark)
    except Exception:
        pass
    try:
        _version = _spark.version
    except Exception:
        _version = None
    return {'ok': True, 'host': _host, 'spark_version': _version}

import os as _cellar_os
# Preserve Cellar's injected DATABRICKS_RUNTIME_VERSION across the connect. The
# "Databricks runtime" toggle sets it at kernel start to flip a notebook's
# import-time IS_DATABRICKS gate (see databricksRuntime.ts / kernel.ts); it starts
# with 'DATABRICKS_' and so matches the scrub inside _cellar_dbx_connect, which
# would pop it. That scrub is REQUIRED, not incidental: databricks-connect refuses
# to build a REMOTE Spark session while it believes it is on a Databricks runtime,
# so the var must be absent while the session is created (this is why a plain
# KEEP_ENV entry is wrong - it would re-break connect). So the scrub + session
# build run with a clean env as before, and we restore the var afterward so the
# user's cells still see IS_DATABRICKS == True. Without this, the reconnect that
# runs right after initKernel injected the var (a kernel restart of a bound
# notebook) silently un-advertises the runtime - DATABRICKS_RUNTIME_VERSION reads
# None after a connected restart, the exact bug this guards.
_cellar_saved_runtime = _cellar_os.environ.get('DATABRICKS_RUNTIME_VERSION')
try:
    print('${SENTINEL}' + _cellar_json.dumps(_cellar_dbx_connect(_cellar_json.loads(${pyLiteral(cfg)}))))
except Exception as _e:
    print('${SENTINEL}' + _cellar_json.dumps(
        {'ok': False, 'code': 'error', 'message': '%s: %s' % (type(_e).__name__, _e)}))
finally:
    if _cellar_saved_runtime is not None:
        _cellar_os.environ['DATABRICKS_RUNTIME_VERSION'] = _cellar_saved_runtime
    del _cellar_dbx_connect, _cellar_json, _cellar_os, _cellar_saved_runtime
`;

/**
 * A tiny kernel probe: is `databricks.connect` already imported in this kernel?
 * If it is, a reinstall of a DIFFERENT client version cannot take effect until the
 * kernel restarts (Python caches the imported module in `sys.modules`), so the
 * caller restarts to load the freshly-pinned client. If it was never imported (the
 * common first-connect case), the reinstall is picked up by the fresh import in
 * `CONNECT_CODE` with NO restart — so the user's variables survive.
 */
const CONNECT_IMPORTED_CODE = `
import json as _cellar_json, sys as _cellar_sys
print('${SENTINEL}' + _cellar_json.dumps({'ok': True, 'imported': 'databricks.connect' in _cellar_sys.modules}))
del _cellar_json, _cellar_sys
`;

/** Stop the session and unbind both names. Idempotent: a missing `spark` is fine. */
const DISCONNECT_CODE = `
import json as _cellar_json

def _cellar_dbx_disconnect():
    _g = globals()
    _old = _g.pop('spark', None)
    _g.pop('w', None)
    _g.pop('_cellar_spark_progress', None)
    if _old is None:
        return {'ok': True, 'stopped': False}
    try:
        _old.clearProgressHandlers()
    except Exception:
        pass
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
 *
 * DEFINITIVE local signal, checked BEFORE the `SELECT 1`: a Spark Connect client
 * that has been closed reports `spark._client.is_closed == True`
 * (`SparkConnectClient.is_closed`). This is a synchronous, in-kernel boolean with
 * NO gRPC round-trip, so it is authoritative even when the workspace is
 * unreachable - and when it is set, `spark.sql(...)` would only raise
 * `[NO_ACTIVE_SESSION] No active Spark session found` (`SparkConnectClient._stub`
 * raises precisely because `self.is_closed`). Ignoring `is_closed` and trusting
 * the epoch is exactly how Cellar came to report "connected" over a hard local
 * "the client is closed" fact, so it is consulted first and reported as
 * `expired:true` (a closed client cannot recover in place; only a reconnect can).
 * `w` (the WorkspaceClient) is never touched by this - only the Spark session is
 * probed - so a `w`-only workflow keeps working even when this reports expired.
 */
const PING_CODE = `
import json as _cellar_json

def _cellar_dbx_ping():
    _spark = globals().get('spark')
    if _spark is None:
        return {'ok': True, 'alive': False, 'expired': False, 'reason': 'no_spark'}
    try:
        _client = getattr(_spark, '_client', None)
        if _client is not None and getattr(_client, 'is_closed', False):
            return {'ok': True, 'alive': False, 'expired': True, 'closed': True,
                    'message': 'SparkConnectClient.is_closed is True (session closed locally)'}
    except Exception:
        pass
    try:
        _spark.sql('SELECT 1').collect()
        return {'ok': True, 'alive': True, 'expired': False, 'closed': False}
    except Exception as _e:
        _msg = '%s: %s' % (type(_e).__name__, _e)
        _low = _msg.lower()
        _expired = ('session_closed' in _low or 'invalid_handle' in _low
                    or 'session expired' in _low or 'session was closed' in _low
                    or 'session is closed' in _low or 'sessionclosed' in _low
                    or 'no_active_session' in _low or 'no active spark session' in _low)
        return {'ok': True, 'alive': False, 'expired': _expired, 'message': _msg}

try:
    print('${SENTINEL}' + _cellar_json.dumps(_cellar_dbx_ping()))
except Exception as _e:
    print('${SENTINEL}' + _cellar_json.dumps(
        {'ok': False, 'code': 'error', 'message': '%s: %s' % (type(_e).__name__, _e)}))
finally:
    del _cellar_dbx_ping, _cellar_json
`;

/**
 * Does an error message look like a dead/expired Spark Connect session handle?
 * Includes `NO_ACTIVE_SESSION` / "no active spark session": a locally CLOSED
 * client (`is_closed == True`) raises that from `SparkConnectClient._stub`, so
 * it is a session-closed signal every bit as definitive as `SESSION_CLOSED`.
 */
export function isSessionClosed(message: unknown): boolean {
	const m = String(message ?? '').toLowerCase();
	return (
		m.includes('session_closed') ||
		m.includes('sessionclosed') ||
		m.includes('invalid_handle') ||
		m.includes('session expired') ||
		m.includes('session was closed') ||
		m.includes('session is closed') ||
		m.includes('no_active_session') ||
		m.includes('no active spark session')
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
async function runInKernel(nb: string, code: string): Promise<{ result: ProbeResult; session: SessionId | null }> {
	let stdout = '';
	let kernelError: string | null = null;
	let session: SessionId | null = null;
	try {
		// Databricks binds `spark`/`w` into THIS notebook's own kernel (each notebook
		// has its own kernel + Databricks session); the epoch we stamp comes from it.
		await execute(
			nb,
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
	/**
	 * The Spark Connect client's local `is_closed` flag, when the probe could read
	 * it. `true` is a DEFINITIVE dead-session signal (no gRPC round-trip); `false`
	 * means open (or open-but-unconfirmed); `undefined` means the probe never ran
	 * (kernel busy) or errored before it could look.
	 */
	closed?: boolean;
	checkedAt: number;
	message?: string;
}

/**
 * Per-notebook Databricks connection state. `spark`/`w` live in a notebook's own
 * kernel namespace (each notebook has its own kernel — see the kernel manager),
 * so each notebook holds an INDEPENDENT Databricks Connect session: notebook A
 * can be connected to cluster X while B is unconnected or on cluster Y, and
 * restarting A's kernel drops only A's session (its epoch bumps, which
 * `connectionStatus(nb)` reconciles against). The state is therefore keyed by
 * the notebook's absolute path, never a module singleton.
 */
/**
 * The information needed to re-establish a session identically: the auth
 * selection (`{profile}|{host}`) plus the cluster it was bound to. Both the
 * expiry self-heal and the kernel-restart re-establish reconnect through this
 * one descriptor, so they can never target different profile/clusters.
 */
interface ReconnectTarget {
	sel: Selection;
	clusterId: string;
	clusterName: string;
}

interface ConnState {
	/**
	 * The live connection, or null. `session` is the kernel epoch `spark` was built
	 * in - see the module header: it is the only thing that can tell "connected"
	 * from "connected before someone restarted the kernel".
	 */
	connection: ConnectionInfo | null;
	/** The `{profile}|{host}` selection the live connection was built from (for `forAgent` listings). */
	connectedSel: Selection | null;
	/** The connection a kernel restart took from us, kept so the UI can say so. */
	lost: LostConnection | null;
	/**
	 * The reconnect INTENT (auth selection + cluster) of the last live connection,
	 * kept ACROSS a kernel restart. `connectionStatus()` clears `connection` the
	 * moment the epoch changes, so it cannot answer "what should we reconnect to";
	 * this survives that reconciliation and is what lets a restart / autorestart /
	 * `%restart_python` re-establish the SAME `spark`/`w` automatically (see
	 * `reconnectAfterKernelRestart`). Set on every successful `connect()`; cleared
	 * only by an explicit `disconnect()`.
	 */
	reconnectTarget: ReconnectTarget | null;
	/** One connect/disconnect at a time PER NOTEBOOK: both mutate that kernel's namespace. */
	inFlight: boolean;
	liveness: Liveness | null;
	/** In-flight probe, so concurrent status reads for one notebook share one `SELECT 1`, not N. */
	livenessInFlight: Promise<Liveness> | null;
	/** In-flight auto-reconnect for one notebook, so a burst of expired-status reads heals once. */
	reconnecting: Promise<boolean> | null;
}

const states = new Map<string, ConnState>();

/** The connection state for a notebook, created empty on first touch. Keyed by absolute path. */
function stateFor(nb: string): ConnState {
	let s = states.get(nb);
	if (!s) {
		s = {
			connection: null,
			connectedSel: null,
			lost: null,
			reconnectTarget: null,
			inFlight: false,
			liveness: null,
			livenessInFlight: null,
			reconnecting: null
		};
		states.set(nb, s);
	}
	return s;
}

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
export function connectionStatus(nb?: string | null): ConnectionStatus {
	const abs = resolveNotebookPath(nb);
	const s = stateFor(abs);
	if (s.connection && s.connection.session !== currentSessionId(abs)) {
		s.lost = { profile: s.connection.profile, clusterName: s.connection.clusterName };
		s.connection = null;
		s.connectedSel = null;
		s.liveness = null;
	}
	if (!s.connection) return { connected: false, ...(s.lost ? { lost: s.lost } : {}) };
	return { connected: true, ...s.connection };
}

/**
 * Whether a notebook is BOUND to a Databricks cluster - i.e. it has a live session
 * OR a kept reconnect intent (set on connect, survives a kernel restart, cleared
 * only by an explicit `disconnect`). This is the durable "this is a Databricks
 * notebook" signal, deliberately distinct from `connectionStatus().connected`
 * (which reports the LIVE session and reads false between a restart and its
 * auto-reconnect). `kernel.ts` reads it at kernel-start time to scope the
 * `DATABRICKS_RUNTIME_VERSION` injection to connected notebooks - so a restart of
 * a bound notebook re-injects the env (the binding persists) while a purely-local
 * kernel never gets it. Never boots a kernel; cheap; keyed by absolute path.
 */
export function databricksBound(nb?: string | null): boolean {
	const s = stateFor(resolveNotebookPath(nb));
	return s.connection !== null || s.reconnectTarget !== null;
}

/**
 * Probe whether the bound `spark` session is actually alive, memoizing the
 * result. Concurrent callers share the one in-flight probe. A `SELECT 1` is a
 * single tiny RPC, so this is cheap - but it still runs in the kernel, so the
 * caller (`agentStatus`) skips it entirely when the kernel is busy rather than
 * queue behind a running cell.
 */
async function probeLiveness(nb: string, session: SessionId | null): Promise<Liveness> {
	const s = stateFor(nb);
	if (s.livenessInFlight) return s.livenessInFlight;
	s.livenessInFlight = (async () => {
		let live: Liveness;
		try {
			const { result, session: ran } = await runInKernel(nb, PING_CODE);
			const r = result as ProbeResult & {
				alive?: boolean;
				expired?: boolean;
				closed?: boolean;
				message?: string;
			};
			live = {
				session: ran ?? session,
				alive: r.ok === true && r.alive === true,
				expired: r.ok === true && r.expired === true,
				closed: r.ok === true && typeof r.closed === 'boolean' ? r.closed : undefined,
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
		s.liveness = live;
		return live;
	})();
	try {
		return await s.livenessInFlight;
	} finally {
		s.livenessInFlight = null;
	}
}

/**
 * Rebuild `spark`/`w` against a stored `ReconnectTarget` via the ordinary
 * `connect()` path (`getOrCreate()` re-creates the closed/absent session). The one
 * seam both reconnection triggers - the server-side expiry self-heal and the
 * kernel-restart re-establish - go through, so they reconnect to the EXACT same
 * profile+cluster; there is no second reconnection mechanism to drift.
 */
async function reconnectTo(nb: string, target: ReconnectTarget): Promise<void> {
	await connect({
		profile: target.sel.profile ?? null,
		host: target.sel.host ?? null,
		clusterId: target.clusterId,
		clusterName: target.clusterName,
		nb
	});
}

/**
 * Rebuild an expired session against the stored reconnect target, via the ordinary
 * `connect()` path. Reuses the exact auth + cluster of the connection that just
 * expired, so the epoch semantics are preserved: a real kernel restart already
 * nulled `connection` above, so THIS path can only ever heal a same-epoch,
 * server-side expiry (a restart is handled by `reconnectAfterKernelRestart`, which
 * reads the same `reconnectTarget`). Concurrent callers share one attempt.
 */
async function autoReconnect(nb: string): Promise<boolean> {
	const s = stateFor(nb);
	if (s.reconnecting) return s.reconnecting;
	const conn = s.connection;
	const target = s.reconnectTarget;
	if (!conn || !target) return false;
	s.reconnecting = (async () => {
		try {
			logInfo('databricks', `Spark Connect session expired; auto-reconnecting cluster "${target.clusterName}"`);
			await reconnectTo(nb, target);
			s.liveness = { session: currentSessionId(nb), alive: true, expired: false, checkedAt: Date.now() };
			logInfo('databricks', 'Databricks auto-reconnect succeeded');
			return true;
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			logWarn('databricks', `Databricks auto-reconnect failed: ${detail}`);
			// Cache the failed-heal so a burst of status reads does not hammer the
			// cluster with reconnect attempts; the TTL lets it retry later.
			s.liveness = {
				session: currentSessionId(nb),
				alive: false,
				expired: true,
				checkedAt: Date.now(),
				message: detail
			};
			return false;
		} finally {
			s.reconnecting = null;
		}
	})();
	return s.reconnecting;
}

/**
 * Re-establish a notebook's Databricks session after its KERNEL was restarted.
 *
 * A restart / autorestart / `%restart_python` wipes the kernel namespace, so
 * `spark`/`w` are gone and `connectionStatus()` reconciles the connection to
 * disconnected. But the reconnect INTENT (profile+cluster) is kept in
 * `reconnectTarget` across the restart, so this rebuilds the SAME session
 * automatically - the user does not have to reconnect by hand. Reuses the ordinary
 * `connect()` path via `reconnectTo` (identical to the expiry self-heal), so the
 * auth and epoch semantics stay correct: the rebuilt session is stamped with the
 * NEW epoch, so it reads as genuinely live.
 *
 * The kernel calls this fire-and-forget after a restart completes, so it must
 * NEVER throw and must NEVER block the restart. Every edge degrades honestly:
 *   - no reconnect target       → the notebook never had a session; do nothing.
 *   - kernel not started        → never boot a kernel just to reconnect.
 *   - a connect already in flight → leave it; skip.
 *   - `connect()` fails         → leave the session reported as lost (`s.lost`), so
 *     the UI/agent tell the user to reconnect from the sidebar, exactly as a real
 *     restart-loss reads today. The reconnect intent is kept, so the NEXT restart
 *     retries.
 *
 * Only ever heals ONE notebook (keyed by `nb`); another notebook's kernel/session
 * is never touched.
 */
export async function reconnectAfterKernelRestart(
	nb?: string | null
): Promise<{ reconnected: boolean; reason?: string }> {
	const abs = resolveNotebookPath(nb);
	const s = stateFor(abs);
	const target = s.reconnectTarget;
	// The notebook never had a live Databricks session: nothing to re-establish.
	if (!target) return { reconnected: false, reason: 'no_prior_session' };
	// Never force a kernel to boot solely to reconnect Databricks. A restart keeps
	// the kernel entry, so this is only hit if the kernel was torn down (shutdown /
	// cull) - in which case dropping the session is the correct behavior.
	if (kernelStatus(abs).status === 'not_started') return { reconnected: false, reason: 'no_kernel' };
	// A connect/disconnect is already mutating this notebook's namespace; don't race it.
	if (s.inFlight) return { reconnected: false, reason: 'busy' };
	// The restart bumped the epoch; reconcile so the stale connection is cleared
	// before we rebuild (a successful connect() then stamps the fresh epoch).
	connectionStatus(abs);
	try {
		logInfo('databricks', `kernel for ${abs} restarted; auto-reconnecting Databricks cluster "${target.clusterName}"`);
		await reconnectTo(abs, target);
		logInfo('databricks', 'Databricks reconnect after kernel restart succeeded');
		return { reconnected: true };
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		logWarn('databricks', `Databricks reconnect after kernel restart failed: ${detail}`);
		// Degrade honestly: surface it as a session the restart took, which the
		// UI/agent already phrase as "reconnect from the Databricks sidebar section".
		s.lost = { profile: target.sel.profile ?? null, clusterName: target.clusterName };
		return { reconnected: false, reason: detail };
	}
}

/**
 * The cluster's Databricks Runtime major.minor (e.g. `"17.3"`), or `null` when it
 * cannot be resolved — serverless (no classic DBR), a permissions error, an
 * unreachable workspace. Never throws: version-pinning is best-effort, and a
 * `null` here just means the connect proceeds unpinned and the version-mismatch
 * safety net (Part B) covers a genuine mismatch.
 */
async function clusterDbr(auth: Auth, clusterId: string): Promise<string | null> {
	try {
		const result = await probe({ op: 'cluster', auth, cluster_id: clusterId });
		if (!result.ok) return null;
		return dbrMajorMinor(payload<{ spark_version?: string | null }>(result).spark_version);
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		logWarn('databricks', `could not resolve cluster runtime for ${clusterId}: ${detail}`);
		return null;
	}
}

/**
 * Is `databricks.connect` already imported in this notebook's kernel? Only then
 * does a reinstall of a different client require a kernel restart to take effect.
 * A not-started kernel has imported nothing, so this never boots one just to ask.
 */
async function isConnectImported(nb: string): Promise<boolean> {
	if (kernelStatus(nb).status === 'not_started') return false;
	try {
		const { result } = await runInKernel(nb, CONNECT_IMPORTED_CODE);
		return result.ok === true && (result as { imported?: boolean }).imported === true;
	} catch {
		// Could not even ask the kernel: assume imported so we restart, the safe
		// direction (a needless restart only wipes a namespace the user can rebuild;
		// a skipped one leaves a stale client that fails the connection).
		return true;
	}
}

/**
 * Pin `databricks-connect` to the cluster's DBR line (`dbr`, e.g. `"17.3"`) when
 * the installed client does not already match, so the Spark session builds against
 * a compatible client. Returns `true` iff it actually reinstalled — the caller
 * uses that to decide whether to (re-)run the connect, and it is what makes the
 * Part B retry loop-safe (an already-matching client returns `false`, no retry).
 *
 * Only re-pins an EXISTING install: a missing client is the `connect_missing`
 * path (the user installs from the sidebar), not something to auto-install here.
 * A reinstall while the kernel already imported the old client needs a restart to
 * load the new one; a fresh (never-imported) kernel does not, so the common
 * first-connect path keeps the user's variables. Best-effort by contract: a failed
 * reinstall is logged and swallowed (returns `false`) so pinning never blocks a
 * connection.
 */
async function ensurePinnedConnect(nb: string, dbr: string | null): Promise<boolean> {
	if (!dbr) return false;
	let installed: InstallStatus;
	try {
		installed = await checkInstall();
	} catch {
		return false;
	}
	if (!installed.connect) return false;
	const target = pinTargetForConnect(dbr, installed.connectVersion ?? null);
	if (!target) return false;
	const imported = await isConnectImported(nb);
	try {
		logInfo(
			'databricks',
			`pinning databricks-connect to ${target}.* to match cluster runtime (installed ${installed.connectVersion ?? 'unknown'})`
		);
		await installDeps({ version: target });
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		logWarn('databricks', `could not pin databricks-connect to ${target}.*: ${detail}`);
		return false;
	}
	if (imported) {
		logInfo('databricks', `restarting kernel so databricks-connect==${target}.* is loaded`);
		await restartKernel(nb);
	}
	return true;
}

/**
 * Build `spark` + `w` in the kernel against `clusterId`, using the resolved auth
 * for the chosen `profile` OR typed `host`. Resolves with `{ok:true, connection}`
 * or throws a `DatabricksError` whose `code` the sidebar turns into actionable
 * copy. `assertSignedIn` guarantees a connect that could pop a browser (a bare
 * host, or a no-token external-browser profile) never opens one in the kernel:
 * it throws `oauth_login_required` until the interactive login has run in its own
 * subprocess. A profile the SDK can authenticate silently proceeds directly.
 *
 * Version pinning (the databricks-connect ≤ DBR rule): the client must be no newer
 * than the cluster's runtime or the session hard-fails. This is enforced in two
 * layers — Part A resolves the cluster's DBR and pins a matching client BEFORE
 * building the session (prevention); Part B catches a mismatch that still slips
 * through (unresolvable DBR), pins from the error's own runtime version, retries
 * once, and otherwise surfaces an actionable `version_mismatch` message.
 */
export async function connect({
	profile,
	host,
	clusterId,
	clusterName,
	nb
}: {
	profile?: string | null;
	host?: string | null;
	clusterId: string;
	clusterName?: string | null;
	nb?: string | null;
}): Promise<{ ok: true; connection: ConnectionStatus }> {
	assertMatches(clusterId, CLUSTER_RE, 'cluster id');
	const abs = resolveNotebookPath(nb);
	const s = stateFor(abs);
	const sel: Selection = profile ? { profile } : { host };
	const auth = resolveAuth(sel);
	assertSignedIn(auth);
	if (s.inFlight) throw new DatabricksError('busy', 'a Databricks connect is already in progress');
	s.inFlight = true;
	try {
		logInfo('databricks', `connecting: profile "${profile}", cluster "${clusterName || clusterId}"`);
		// Part A (prevention): resolve the cluster's Databricks Runtime and pin a
		// matching databricks-connect client BEFORE building the session, so a
		// "latest" client can never mismatch an older cluster. Best-effort - a null
		// DBR (serverless / unresolvable) just skips the pin.
		const dbr = await clusterDbr(auth, clusterId);
		await ensurePinnedConnect(abs, dbr);

		let { result, session } = await runInKernel(abs, CONNECT_CODE({ auth, cluster_id: clusterId }));

		// Part B (safety net): a version mismatch can still surface when the runtime
		// could not be pre-resolved. The error itself names the runtime, so pin the
		// client from it and retry ONCE. `ensurePinnedConnect` returns false unless it
		// actually reinstalled (already-matching → false), so this can never loop.
		if (!result.ok) {
			const mismatch = parseVersionMismatch(result.message);
			if (mismatch && (await ensurePinnedConnect(abs, mismatch.runtime))) {
				logInfo('databricks', `retrying connect after pinning databricks-connect to ${mismatch.runtime}.*`);
				({ result, session } = await runInKernel(abs, CONNECT_CODE({ auth, cluster_id: clusterId })));
			}
		}

		if (!result.ok) {
			s.connection = null;
			s.connectedSel = null;
			publishGlobal({ type: 'databricks:changed' });
			// A still-unresolved version mismatch: surface an actionable, user-facing
			// message (with the exact pin) instead of the raw SDK exception, under a
			// dedicated `version_mismatch` code the sidebar has copy for.
			const mismatch = parseVersionMismatch(result.message);
			if (mismatch) {
				const message = versionMismatchMessage(mismatch);
				logError('databricks', `connect failed [version_mismatch]: ${message} (raw: ${result.message})`);
				throw new DatabricksError('version_mismatch', message);
			}
			logError('databricks', `connect failed [${result.code || 'error'}]: ${result.message || 'unknown error'}`);
			throw new DatabricksError(result.code || 'error', result.message);
		}
		const ok = payload<ConnectPayload>(result);
		s.connection = {
			profile: profile ?? null,
			clusterId,
			clusterName: clusterName || clusterId,
			host: ok.host ?? auth.host ?? null,
			sparkVersion: ok.spark_version ?? null,
			session
		};
		// Re-query catalogs against the same auth, using the SDK's canonical host.
		s.connectedSel = auth.mode === 'profile' ? { profile } : { host: s.connection.host };
		// Remember the reconnect intent so a KERNEL restart - which the epoch
		// reconciliation in connectionStatus() clears from `connection` - can
		// re-establish the SAME session automatically (reconnectAfterKernelRestart).
		s.reconnectTarget = { sel: s.connectedSel, clusterId, clusterName: s.connection.clusterName };
		s.lost = null;
		// A fresh session is alive by construction; seed the cache so an immediate
		// status read doesn't pay for a redundant liveness probe.
		s.liveness = { session, alive: true, expired: false, checkedAt: Date.now() };
		publishGlobal({ type: 'databricks:changed' });
		logInfo('databricks', `connected: host ${ok.host ?? '?'}, spark ${ok.spark_version ?? '?'}`);
		return { ok: true, connection: connectionStatus(abs) };
	} finally {
		s.inFlight = false;
	}
}

/** A connection reconciled as still live for the current epoch. */
type Connected = ConnectionStatus & { connected: true };

/**
 * The real-liveness verdict for a CONNECTED notebook, produced by `assessLiveness`
 * and formatted by both the agent surface (`agentStatus`) and the UI status poll
 * (`liveConnection`) so they can never disagree about whether `spark` is alive.
 *   - `live`        - the probe (or a fresh cached reading) confirmed the session.
 *   - `reconnected` - it had expired and Cellar rebuilt it; `status` is the fresh one.
 *   - `expired`     - it is definitively dead (server-side expiry, or a locally
 *                     CLOSED Spark Connect client) and could not be healed in place.
 *   - `unverified`  - could not confirm liveness (kernel busy with no cached
 *                     reading, or a transient error): still bound, just unconfirmed.
 */
type Assessment =
	| { kind: 'live' }
	| { kind: 'reconnected'; status: Connected }
	| { kind: 'expired' }
	| { kind: 'unverified'; liveness: Liveness | null };

/**
 * Reconcile a connected notebook's REAL Spark Connect liveness, memoized via the
 * liveness cache. The one place that decides live/expired/unverified, shared by
 * the agent surface and the UI poll.
 *
 * The load-bearing signal is `is_closed`: a closed Spark Connect client is a
 * DEFINITIVE, synchronous, local dead-session fact (no gRPC round-trip), so the
 * probe reports it as `expired` even though the kernel epoch is unchanged. Trusting
 * the epoch (or a `SELECT 1` that came back with an unrecognized `NO_ACTIVE_SESSION`
 * message) over that hard local fact is exactly how Cellar reported "connected"
 * against a dead handle - see the PING_CODE header. Only the Spark session is
 * probed; `w` is untouched, so a `w`-only workflow is unaffected by an expiry here.
 *
 * `heal` controls the reconnect: the agent surface (`heal:true`) AWAITS
 * `autoReconnect` and reports the healed session; the UI (`heal:false`) must never
 * stall a status poll minutes behind a cold-cluster restart, so it fires the
 * reconnect fire-and-forget (its success publishes `databricks:changed`, which
 * reloads the panel) and reports the honest `expired` now.
 */
async function assessLiveness(abs: string, status: Connected, { heal }: { heal: boolean }): Promise<Assessment> {
	const s = stateFor(abs);
	const sid = status.session;
	const fresh = s.liveness && s.liveness.session === sid && Date.now() - s.liveness.checkedAt < LIVENESS_TTL_MS;
	let live: Liveness | null = fresh ? s.liveness : null;
	if (!live) {
		if (kernelStatus(abs).status === 'busy') {
			// Don't block status behind a running cell. Fall back to the last-known
			// reading for THIS epoch if we have one; otherwise we cannot verify (a
			// closed client can only be observed by running the probe, which we can't
			// queue behind the busy cell) - so report unverified, never a bare connected.
			live = s.liveness && s.liveness.session === sid ? s.liveness : null;
		} else {
			live = await probeLiveness(abs, sid);
		}
	}

	if (live?.expired) {
		if (heal) {
			// autoReconnect() rebuilds spark/w against the same cluster; report the
			// fresh connection so the agent knows spark is usable again.
			if (await autoReconnect(abs)) {
				const healedStatus = connectionStatus(abs);
				if (healedStatus.connected) return { kind: 'reconnected', status: healedStatus };
			}
			return { kind: 'expired' };
		}
		// autoReconnect() catches its own errors and never throws, so fire-and-forget.
		void autoReconnect(abs);
		return { kind: 'expired' };
	}

	if (live && live.alive) return { kind: 'live' };
	// live is null (busy, no cached reading) OR a non-session error / a closed flag
	// we could not read: spark is still bound and the epoch is current, so we stay
	// connected but could not CONFIRM the session is live.
	return { kind: 'unverified', liveness: live };
}

/**
 * The connection as an *agent* should see it (MCP `kernel_state`, the notebook
 * map header, and the not-connected error every `databricks_*` tool returns).
 *
 * Deliberately spells out what is bound in the namespace: an agent that knows
 * `spark` exists will use it instead of writing its own connection boilerplate,
 * which is the whole point of this integration.
 */
export async function agentStatus(nb?: string | null) {
	const abs = resolveNotebookPath(nb);
	const s = stateFor(abs);
	const status: ConnectionStatus = connectionStatus(abs);
	if (!status.connected) {
		s.liveness = null;
		return {
			connected: false,
			...(status.lost
				? { note: `The Databricks session on cluster "${status.lost.clusterName}" ended when the kernel restarted. Ask the user to reconnect from the Databricks sidebar section.` }
				: { note: 'No Databricks session. `spark` is not defined. Ask the user to connect from the Databricks sidebar section; agents cannot connect on their own.' })
		};
	}

	// `spark` is bound in the current epoch - but the Spark Connect handle may have
	// died server-side (idle timeout / cluster GC) or had its client closed while the
	// epoch stayed current. Verify liveness (cached; skipped when the kernel is busy)
	// and self-heal on a dead session.
	const a = await assessLiveness(abs, status, { heal: true });
	if (a.kind === 'reconnected') {
		return {
			...connectedPayload(a.status),
			reconnected: true,
			note: 'The previous Databricks Connect session had expired; Cellar automatically reconnected. `spark` and `w` are live again against the cluster above - re-run any cell that failed with SESSION_CLOSED. Use them directly, do not re-create a DatabricksSession.'
		};
	}
	if (a.kind === 'expired') {
		return {
			connected: false,
			expired: true,
			stale: true,
			cluster: { id: status.clusterId, name: status.clusterName },
			host: status.host,
			note: 'The Databricks Connect session expired (idle timeout, cluster GC, or a closed Spark Connect client) and Cellar could not automatically reconnect. Ask the user to reconnect from the Databricks sidebar section, then re-run the cell.'
		};
	}
	if (a.kind === 'unverified') {
		// A non-session error, or a busy-skipped probe with no cached reading: spark is
		// still bound and the epoch is current, so report connected, but flag that we
		// could not confirm - and expose is_closed / probe age so a caller can tell
		// "unknown (busy)" from "confirmed open but a transient SELECT failed".
		const l = a.liveness;
		return {
			...connectedPayload(status),
			liveness_unverified: true,
			...(l
				? {
						liveness_checked_ms_ago: Date.now() - l.checkedAt,
						...(typeof l.closed === 'boolean' ? { is_closed: l.closed } : {})
					}
				: {})
		};
	}
	return connectedPayload(status);
}

/**
 * The connection the UI sidebar reads: `connectionStatus()` (epoch-reconciled)
 * enriched with the real liveness verdict, so the panel reflects a session that
 * expired server-side (or whose Spark Connect client was closed) instead of
 * reporting a dead session as "connected" on the strength of a still-current
 * epoch. Never blocks on a reconnect (see `assessLiveness`'s `heal:false`).
 */
async function liveConnection(
	nb?: string | null
): Promise<ConnectionStatus & { expired?: boolean; livenessUnverified?: boolean; isClosed?: boolean }> {
	const abs = resolveNotebookPath(nb);
	const status = connectionStatus(abs);
	if (!status.connected) return status;
	const a = await assessLiveness(abs, status, { heal: false });
	if (a.kind === 'reconnected') return a.status;
	if (a.kind === 'expired') {
		// Surface it as a session the notebook LOST (same shape a kernel-restart loss
		// uses, so the sidebar's existing "reconnect below" affordance renders), plus
		// an explicit `expired` flag so the panel can phrase it as an expiry.
		return { connected: false, expired: true, lost: { profile: status.profile, clusterName: status.clusterName } };
	}
	if (a.kind === 'unverified') {
		return {
			...status,
			livenessUnverified: true,
			...(typeof a.liveness?.closed === 'boolean' ? { isClosed: a.liveness.closed } : {})
		};
	}
	return status;
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

/** The `{profile}|{host}` selection of a notebook's live connection, or a `not_connected` error an agent can act on. */
function requireConnectedSel(nb: string): Selection {
	const s = stateFor(nb);
	const status = connectionStatus(nb);
	if (!status.connected || !s.connectedSel) {
		throw new DatabricksError(
			'not_connected',
			'Not connected to Databricks. Ask the user to connect from the Databricks section of the Cellar sidebar (agents cannot connect on their own).'
		);
	}
	return s.connectedSel;
}

// --- agent-driven reconnect / connect (MCP) --------------------------------
//
// The agent surface for the connection lifecycle. It adds NO new
// session-establishment or reconnect mechanism: every path funnels through the
// SAME `refreshKernelConnection` (rung 1, kernel.ts) + `reconnectTo` → `connect()`
// (rungs 2/3) the automatic recovery already uses, so the agent tool and the
// watchdog/expiry self-heal can never drift. What is new here is only the
// ORCHESTRATION (walk the ladder in order) plus HONEST SIDE-EFFECT reporting: the
// agent must never think a reconnect was free when a version re-pin restarted the
// kernel and cleared its namespace (the same NameError trap the run-status
// doctrine exists to prevent).

/** Cluster states in which a Databricks Connect session cannot be built. */
const DOWN_CLUSTER_STATES = new Set(['TERMINATED', 'TERMINATING', 'ERROR']);

/**
 * The cluster's lifecycle state (`RUNNING`, `TERMINATED`, `PENDING`, …), or null
 * if it cannot be resolved. Reads authoritatively from the workspace via the same
 * `cluster` PROBE op the version pin uses; never throws (a null just means "could
 * not tell", so the caller degrades to the raw connect error rather than a
 * confident-but-wrong verdict).
 */
async function clusterState(sel: Selection, clusterId: string): Promise<string | null> {
	try {
		const result = await probe({ op: 'cluster', auth: resolveAuth(sel), cluster_id: clusterId });
		if (!result.ok) return null;
		return payload<{ state?: string | null }>(result).state ?? null;
	} catch {
		return null;
	}
}

/**
 * Turn a failed reconnect/connect into the most actionable error. If the target
 * cluster is provably down (TERMINATED / TERMINATING / ERROR), that is the real
 * cause and it is HUMAN-ONLY to fix — agents cannot start compute (D2) — so raise
 * a dedicated `cluster_terminated`. Otherwise the cause is unknown, so raise
 * `reconnect_failed` pointing at the sidebar. Always throws.
 */
async function throwReconnectFailure(target: ReconnectTarget, prefix: string): Promise<never> {
	const state = await clusterState(target.sel, target.clusterId);
	if (state && DOWN_CLUSTER_STATES.has(state.toUpperCase())) {
		throw new DatabricksError(
			'cluster_terminated',
			`${prefix} The cluster "${target.clusterName}" is ${state}. Agents cannot start compute — ask the user to start the cluster from the Databricks sidebar (or workspace), then reconnect.`
		);
	}
	throw new DatabricksError(
		'reconnect_failed',
		`${prefix} Ask the user to reconnect from the Databricks sidebar section.`
	);
}

/** The agent-facing payload a successful reconnect returns, with honest namespace-loss flags. */
function reconnectedPayload(
	abs: string,
	{ socketRefreshed, kernelRestarted }: { socketRefreshed: boolean; kernelRestarted: boolean }
) {
	const status = connectionStatus(abs);
	if (!status.connected) {
		// Shouldn't happen (we only call this after a confirmed reconnect), but never
		// claim a live session we cannot see.
		throw new DatabricksError(
			'reconnect_failed',
			'Reconnected, but the session did not come up live. Ask the user to reconnect from the Databricks sidebar section.'
		);
	}
	publishGlobal({ type: 'databricks:changed' });
	const note = kernelRestarted
		? '`spark` and `w` are live again against the cluster above — BUT reconnecting had to restart your kernel (a databricks-connect re-pin), so EVERY Python variable you had defined is gone (ran_this_session is now false for every cell). Re-run the cells you need before continuing.'
		: '`spark` and `w` are live again against the cluster above; your kernel namespace was preserved. Re-run any cell that failed with SESSION_CLOSED — use spark/w directly, do not re-create a DatabricksSession.';
	return {
		...connectedPayload(status),
		reconnected: true,
		socket_refreshed: socketRefreshed,
		kernel_restarted: kernelRestarted,
		namespace_cleared: kernelRestarted,
		note
	};
}

/**
 * Re-establish a notebook's Databricks Connect session against the cluster the
 * USER already chose, after it went dead — the agent-facing counterpart to the
 * automatic recovery. Walks the ONE recovery ladder in order:
 *
 *   Rung 1 (transport): `refreshKernelConnection` rebuilds a dropped kernel
 *     WebSocket in place — no kernel restart, `spark`/`w` intact.
 *   Rung 2 (session): a server-side expiry (SESSION_CLOSED / closed client) heals
 *     via `agentStatus`'s `autoReconnect` → `connect()`. Namespace preserved unless
 *     a version re-pin restarts the kernel.
 *   Rung 3 (process): a kernel restart bumped the epoch, so `spark`/`w` are gone;
 *     `reconnectAfterKernelRestart` re-establishes the SAME cluster via `connect()`.
 *     The namespace was already cleared by the restart.
 *
 * The agent may only RESTORE what a human established (the stored `reconnectTarget`),
 * never choose a new cluster here (that is `connectCluster`) and never start compute.
 * Returns the `connectedPayload` plus `reconnected` / `socket_refreshed` /
 * `kernel_restarted` / `namespace_cleared` so the agent never assumes a reconnect
 * was free. Throws a `DatabricksError` (`not_connected`, `kernel_unavailable`,
 * `cluster_terminated`, `reconnect_failed`, `busy`) the `databricksTool` wrapper
 * turns into a structured `{error, message}`.
 */
export async function reconnectSession(nb?: string | null) {
	const abs = resolveNotebookPath(nb);
	const s = stateFor(abs);
	const target = s.reconnectTarget;
	// The session was never established by a human: the agent cannot choose one here.
	if (!target) {
		throw new DatabricksError(
			'not_connected',
			'This notebook has no Databricks session to restore. Ask the user to connect from the Databricks sidebar section (agents cannot choose a cluster or start compute on their own; connect a cluster with databricks_connect only once one has been chosen).'
		);
	}

	// Rung 1: repair a dropped kernel socket in place (namespace-preserving; never
	// restarts the kernel). If the process itself was proven dead this tore it down —
	// there is no live kernel to re-establish a session in, and we never boot one just
	// to reconnect, so surface that honestly.
	const refresh = await refreshKernelConnection(abs);
	if (refresh.reason === 'kernel_gone') {
		throw new DatabricksError(
			'kernel_unavailable',
			'The kernel process was lost, so its Databricks session cannot be restored yet. Run any cell to start a fresh kernel — Cellar re-establishes the session automatically — or ask the user to reconnect from the sidebar.'
		);
	}
	const socketRefreshed = refresh.refreshed && refresh.reason === 'reconnected';

	// Reconcile the connection against the current kernel epoch (a restart nulls it).
	const status = connectionStatus(abs);

	if (status.connected) {
		// Epoch current, `spark` bound. Verify real liveness and heal a server-side
		// expiry in place (rung 2). `agentStatus(heal:true)` is the one place that does
		// this — probe (cached, skipped while busy) + `autoReconnect` on SESSION_CLOSED —
		// so reuse it rather than a second probe path. A version re-pin inside the heal
		// could restart the kernel; detect it by the epoch moving across the call.
		const epochBefore = currentSessionId(abs);
		const a = (await agentStatus(abs)) as Record<string, unknown>;
		if (a.connected === true) {
			const epochAfter = currentSessionId(abs);
			const kernelRestarted = epochBefore != null && epochAfter !== epochBefore;
			return reconnectedPayload(abs, { socketRefreshed, kernelRestarted });
		}
		// Bound but the session is dead and could not be healed in place.
		return throwReconnectFailure(target, 'The Databricks session expired and Cellar could not reconnect it.');
	}

	// Not connected at the current epoch → the kernel was restarted (rung 3).
	// Re-establish the SAME cluster via the existing post-restart path (reuses
	// `connect()`). The namespace was already cleared by that restart.
	const r = await reconnectAfterKernelRestart(abs);
	if (r.reconnected) {
		return reconnectedPayload(abs, { socketRefreshed, kernelRestarted: true });
	}
	if (r.reason === 'no_kernel') {
		throw new DatabricksError(
			'kernel_unavailable',
			'The kernel is not running, so its Databricks session cannot be restored yet. Run any cell to start a fresh kernel — Cellar re-establishes the session automatically — or ask the user to reconnect from the sidebar.'
		);
	}
	if (r.reason === 'busy') {
		throw new DatabricksError('busy', 'A Databricks connect is already in progress for this notebook; try again shortly.');
	}
	return throwReconnectFailure(target, `Could not reconnect to cluster "${target.clusterName}".`);
}

/**
 * Connect a notebook to a cluster the AGENT chose (D1). Reuses `connect()` wholesale
 * — same auth (`resolveAuth`/`assertSignedIn`), same version-pin machinery, same
 * `reconnectTarget` bookkeeping — so there is no second connect path. Two gates on
 * top:
 *   - AUTH: a selection that could pop a browser (an OAuth host, or a no-token
 *     external-browser profile) that has not signed in throws `oauth_login_required`
 *     (the browser sign-in is human-only); any other profile the SDK can authenticate
 *     proceeds. `assertSignedIn` inside `connect()` enforces this; checked up front so
 *     the cluster-state probe is not paid for an unusable auth.
 *   - COMPUTE (D2): a TERMINATED/ERROR cluster is refused with `cluster_terminated`
 *     — agents cannot start compute — instead of failing with a raw Spark error.
 *
 * Reports the side effects the agent must understand: a version re-pin can restart
 * the kernel and clear the namespace (`kernel_restarted` / `namespace_cleared`).
 */
export async function connectCluster({
	clusterId,
	clusterName,
	profile,
	host,
	nb
}: {
	clusterId: string;
	clusterName?: string | null;
	profile?: string | null;
	host?: string | null;
	nb?: string | null;
}) {
	assertMatches(clusterId, CLUSTER_RE, 'cluster id');
	const abs = resolveNotebookPath(nb);
	const sel: Selection = profile ? { profile } : { host };
	// Gate 1 (auth): refuse an un-signed-in OAuth host before doing any work.
	assertSignedIn(resolveAuth(sel));
	// Gate 2 (compute is human-only): refuse a down cluster with a clean, actionable
	// error rather than starting it (agents cannot) or failing with a raw Spark error.
	const state = await clusterState(sel, clusterId);
	if (state && DOWN_CLUSTER_STATES.has(state.toUpperCase())) {
		throw new DatabricksError(
			'cluster_terminated',
			`Cluster "${clusterName || clusterId}" is ${state}. Agents cannot start compute — ask the user to start it from the Databricks sidebar (or workspace), then connect.`
		);
	}
	const epochBefore = currentSessionId(abs);
	// Reuse the entire connect path: auth, version pin (may reinstall + restart the
	// kernel), CONNECT_CODE, `reconnectTarget`, and the `databricks:changed` publish.
	await connect({ profile, host, clusterId, clusterName, nb: abs });
	const epochAfter = currentSessionId(abs);
	// A restart only clears a namespace that EXISTED — a fresh connect that merely
	// booted the kernel (no prior epoch) cleared nothing, so guard on epochBefore.
	const kernelRestarted = epochBefore != null && epochAfter !== epochBefore;
	const status = connectionStatus(abs);
	if (!status.connected) {
		throw new DatabricksError('error', 'Connected, but the session did not come up live. Ask the user to check the Databricks sidebar.');
	}
	return {
		...connectedPayload(status),
		kernel_restarted: kernelRestarted,
		namespace_cleared: kernelRestarted,
		note: kernelRestarted
			? 'Connected to the cluster above — BUT connecting had to reinstall databricks-connect to match the cluster runtime, which RESTARTED your kernel: every Python variable you had is gone (ran_this_session is now false for every cell). Re-run the cells you need. `spark` and `w` are live; use them directly.'
			: 'Connected to the cluster above. `spark` and `w` are live in the kernel namespace; use them directly — do not re-create a DatabricksSession.'
	};
}

/**
 * List the workspace's attachable clusters for the agent (read-only discovery, so
 * it can pick one for `databricks_connect` or report state to the user). Auth is an
 * explicit `profile`/`host`, or — when neither is given — the notebook's own live
 * connection. Gated on a signed-in host (`listClusters` → `authForListing`), so an
 * un-signed-in OAuth selection returns `oauth_login_required`. Never starts compute.
 */
export async function listClustersForAgent(
	nb?: string | null,
	sel?: { profile?: string | null; host?: string | null }
): Promise<ClusterRow[]> {
	const abs = resolveNotebookPath(nb);
	let selection: Selection;
	if (sel && (sel.profile || sel.host)) {
		selection = sel.profile ? { profile: sel.profile } : { host: sel.host };
	} else {
		const s = stateFor(abs);
		if (connectionStatus(abs).connected && s.connectedSel) {
			selection = s.connectedSel;
		} else {
			throw new DatabricksError(
				'not_connected',
				'Provide a `profile` (a ~/.databrickscfg profile name) to list clusters, or ask the user to connect a notebook first. Agents cannot list clusters without an auth selection.'
			);
		}
	}
	return listClusters(selection);
}

/**
 * Unity Catalog listings for the agent, against the auth of a notebook's live
 * connection. The listing itself is a stateless server-side SDK call (no kernel),
 * but the AUTH comes from that notebook's connection, so a catalog browse only
 * works for a notebook that is connected.
 */
export const forAgent = {
	catalogs: async (nb?: string | null): Promise<CatalogList> => listCatalogs(requireConnectedSel(resolveNotebookPath(nb))),
	schemas: async (catalog: string, nb?: string | null): Promise<SchemaList> =>
		listSchemas(requireConnectedSel(resolveNotebookPath(nb)), catalog),
	tables: async (catalog: string, schema: string, nb?: string | null): Promise<TableList> =>
		listTables(requireConnectedSel(resolveNotebookPath(nb)), catalog, schema)
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
	limit = 20,
	nb
}: {
	name: string;
	limit?: number;
	nb?: string | null;
}): Promise<PreviewResult> {
	assertTableName(name);
	const abs = resolveNotebookPath(nb);
	requireConnectedSel(abs);
	const n = Number(limit);
	if (!Number.isInteger(n) || n < 1 || n > 1000) {
		throw new DatabricksError('bad_request', `invalid limit: ${JSON.stringify(limit)} (1-1000)`);
	}
	let { result } = await runInKernel(abs, PREVIEW_CODE({ name, limit: n }));
	// If the read failed because the session expired server-side, self-heal once:
	// rebuild spark against the same cluster and retry - the agent gets its rows
	// instead of a dead-session error it cannot recover from on its own.
	if (result.ok === false && isSessionClosed(result.message) && (await autoReconnect(abs))) {
		({ result } = await runInKernel(abs, PREVIEW_CODE({ name, limit: n })));
	}
	return payload<PreviewResult>(unwrap(result));
}

/** Stop a notebook's session and drop `spark`/`w` from its kernel namespace. */
export async function disconnect(nb?: string | null): Promise<{ ok: true }> {
	const abs = resolveNotebookPath(nb);
	const s = stateFor(abs);
	if (s.inFlight) throw new DatabricksError('busy', 'a Databricks connect is already in progress');
	s.inFlight = true;
	try {
		// Nothing to stop if the kernel that held it is gone; just clear our state.
		if (connectionStatus(abs).connected) await runInKernel(abs, DISCONNECT_CODE);
		s.connection = null;
		s.connectedSel = null;
		// An explicit disconnect is the ONLY thing that clears the reconnect intent:
		// after this a kernel restart must NOT silently re-establish the session.
		s.reconnectTarget = null;
		s.lost = null;
		s.liveness = null;
		publishGlobal({ type: 'databricks:changed' });
		return { ok: true };
	} finally {
		s.inFlight = false;
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
