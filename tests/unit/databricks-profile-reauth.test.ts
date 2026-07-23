import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * **An expired named-profile sign-in is not Cellar's to fix, and must not be
 * offered as if it were.**
 *
 * The captain's repro: `~/.databrickscfg` has `[DEFAULT] auth_type =
 * databricks-cli`, whose OAuth refresh token had expired. The SDK failed with the
 * `SDK_ERROR` message below - which mentions `oauth-authorization-server` in its
 * `discovery_url`, so the probe's `classify()` matched its `'oauth' in low` rule
 * and returned `oauth_login_required`. The sidebar then said "Sign in to
 * Databricks first - click 'Sign in with Databricks'", but that button runs
 * CELLAR's own external-browser OAuth, which mints a token into the SDK's
 * python-local cache that a `databricks-cli` profile never reads. Clicking it
 * changes nothing: a dead end.
 *
 * So the classification is redone in Node (`reclassifyReauth`), where the
 * resolved `Auth` says WHICH profile was asked for, and the profile name rides
 * out on the error so the sidebar can print the real command.
 *
 * What this pins:
 *   1. The pure rule (`isProfileReauthError`) matches the REAL SDK text - which is
 *      committed verbatim below, captured from the real databricks-sdk driven
 *      against the real Databricks CLI v1.6.0's own expired-refresh-token
 *      wording - and does not match failures that are something else.
 *   2. The seam: a failing listing for a named profile comes out as
 *      `profile_reauth_required` carrying that profile's name.
 *   3. The regressions the fix must not cause - a bare typed HOST and a no-token
 *      `external-browser` profile keep `oauth_login_required`, because for those
 *      Cellar's own sign-in genuinely IS the fix.
 *
 * The probe runs against a stub interpreter, so these cases need neither the SDK
 * nor a network: the string under test is the fixture, not something re-derived.
 */

const SENTINEL = '__CELLAR_DBX__';

/**
 * The real thing, captured verbatim: databricks-sdk 0.122.0 building
 * `Config(profile=…)` for an `auth_type = databricks-cli` profile whose
 * `databricks auth token` failed with the CLI's own invalid-refresh-token text.
 * Note the two traps it contains - `oauth-authorization-server` (which is what
 * misrouted it to Cellar's sign-in button) and "reauthenticate" (which contains
 * "authenticate", the `auth_failed` rule).
 */
const SDK_ERROR = `ValueError: default auth: databricks-cli: cannot get access token: Error: A new access token could not be retrieved because the refresh token is invalid. To reauthenticate, run the following command:
  $ databricks auth login --profile DEFAULT. Config: host=https://dbc-29a8e8d0-5a51.cloud.databricks.com, discovery_url=https://dbc-29a8e8d0-5a51.cloud.databricks.com/oidc/.well-known/oauth-authorization-server, profile=DEFAULT, auth_type=databricks-cli, http_timeout_seconds=30.0. Env: DATABRICKS_CONFIG_FILE`;

/**
 * The kernel is where `connect()` builds the session, and `CONNECT_CODE` hardcodes
 * `auth_failed` for the Config/WorkspaceClient step - so an expired profile reaches
 * the sidebar from this path too. The mock replays exactly that: the SDK error,
 * under the code the kernel would have stamped on it.
 */
/**
 * The kernel the mock pretends to be. Mutable so the reconnect suite can drive the
 * two things the recovery ladder keys off: the SESSION EPOCH (bumping it is what a
 * kernel restart looks like to `connectionStatus`, i.e. rung 3) and whether the
 * Spark Connect handle is still alive (rung 2's expiry). `connectOk` lets a test
 * establish a real connection first - the ladder only runs for a notebook that has
 * a `reconnectTarget`, which only a SUCCESSFUL connect sets.
 */
const kernel = { session: 1, connectOk: false, sessionExpired: false, connectMessage: SDK_ERROR };

vi.mock('../../src/lib/server/kernel', () => ({
	execute: async (_nb: string, code: string, onEvent: (e: unknown) => void) => {
		onEvent({ type: 'kernel', session: kernel.session });
		let out: unknown;
		if (code.includes('_cellar_dbx_ping')) {
			out = kernel.sessionExpired
				? { ok: true, alive: false, expired: true, closed: true }
				: { ok: true, alive: true, expired: false, closed: false };
		} else if (code.includes('_cellar_dbx_connect')) {
			out = kernel.connectOk
				? { ok: true, host: 'https://default.cloud.databricks.com', spark_version: '3.5.0' }
				: { ok: false, code: 'auth_failed', message: kernel.connectMessage };
		} else {
			out = { ok: true, imported: false };
		}
		onEvent({
			type: 'output',
			output: { output_type: 'stream', name: 'stdout', text: `${SENTINEL}${JSON.stringify(out)}\n` }
		});
		return {};
	},
	currentSessionId: () => kernel.session,
	kernelStatus: () => ({ status: 'idle', id: 'k1' }),
	restartKernel: vi.fn(),
	// Rung 1 of the ladder: a healthy socket needing no repair, so every reconnect
	// test falls through to the rung it is actually about.
	refreshKernelConnection: async () => ({ refreshed: false, reason: 'ok' })
}));

let dbx: typeof import('../../src/lib/server/databricks');
let reauth: typeof import('../../src/lib/databricksReauth');
let dir: string;
let stubPython: string;
const savedEnv = new Map<string, string | undefined>();

/**
 * A stub "python" that answers every probe op with one canned JSON line: `ok`
 * for `login` (so a gated profile can be signed in), and a chosen failure for
 * everything else. It reads the op out of the request argv the probe passes.
 */
function writeStub(failure: { code: string; message: string } | null): void {
	const fail = failure ? JSON.stringify({ ok: false, ...failure }) : '';
	writeFileSync(
		stubPython,
		[
			'#!/bin/sh',
			// argv: -c <script> <request-json>
			'req="$3"',
			'case "$req" in',
			`  *'"op": "login"'*|*'"op":"login"'*) printf '%s\\n' '${SENTINEL}{"ok":true,"host":"https://stub.example.com","user":"someone"}' ;;`,
			fail
				? `  *) printf '%s\\n' '${SENTINEL}${fail.replace(/'/g, `'\\''`)}' ;;`
				: `  *) printf '%s\\n' '${SENTINEL}{"ok":true,"clusters":[]}' ;;`,
			'esac'
		].join('\n'),
		{ mode: 0o755 }
	);
}

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), 'cellar-dbx-reauth-'));
	const cfg = join(dir, '.databrickscfg');
	writeFileSync(
		cfg,
		[
			// The captain's shape: a no-PAT profile the SDK authenticates through the
			// databricks CLI - the one whose expiry this whole file is about.
			'[DEFAULT]',
			'host = https://default.cloud.databricks.com',
			'auth_type = databricks-cli',
			'',
			// A no-token external-browser profile: Cellar's OWN sign-in mints its
			// token, so it must KEEP the sign-in-button remedy.
			'[ext_browser]',
			'host = https://ext.cloud.databricks.com',
			'auth_type = external-browser',
			''
		].join('\n')
	);
	stubPython = join(dir, 'stub-python');
	writeStub(null);
	for (const key of ['DATABRICKS_CONFIG_FILE', 'CELLAR_WORKSPACE', 'CELLAR_PROJECT_VENV']) {
		savedEnv.set(key, process.env[key]);
	}
	process.env.DATABRICKS_CONFIG_FILE = cfg;
	process.env.CELLAR_WORKSPACE = dir;
	process.env.CELLAR_PROJECT_VENV = stubPython;
	dbx = await import('../../src/lib/server/databricks');
	reauth = await import('../../src/lib/databricksReauth');
});

afterAll(() => {
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe('isProfileReauthError - the pure rule', () => {
	it('matches the real SDK error for an expired databricks-cli profile', () => {
		expect(reauth.isProfileReauthError(SDK_ERROR)).toBe(true);
	});

	it('matches the other wordings of a credential that cannot be refreshed', () => {
		expect(reauth.isProfileReauthError('Error: token refresh: refresh token is expired')).toBe(true);
		expect(
			reauth.isProfileReauthError('http 400: {"error":"invalid_refresh_token"}')
		).toBe(true);
		expect(
			reauth.isProfileReauthError(
				'default auth: databricks-cli: cannot get access token: Error: not logged in. Run: databricks auth login --host https://x'
			)
		).toBe(true);
	});

	it('does NOT match failures a fresh CLI login would not fix', () => {
		// A transient network failure of the same credential path.
		expect(
			reauth.isProfileReauthError(
				'default auth: databricks-cli: cannot get access token: Error: dial tcp: i/o timeout'
			)
		).toBe(false);
		// A rejected PAT.
		expect(
			reauth.isProfileReauthError('Unauthenticated: Invalid access token. Config: host=…, auth_type=pat')
		).toBe(false);
		// The CLI's generic "you have no profile" hint - it names the login command,
		// but nothing here says an existing credential died.
		expect(
			reauth.isProfileReauthError(
				'no configuration found\n  - Consider setting up a profile: databricks auth login --profile <name>'
			)
		).toBe(false);
		expect(reauth.isProfileReauthError('')).toBe(false);
		expect(reauth.isProfileReauthError(undefined)).toBe(false);
	});

	it('builds the exact command and splits its own message back apart', () => {
		expect(reauth.reauthCommand('DEFAULT')).toBe('databricks auth login --profile DEFAULT');
		expect(reauth.reauthCommand('prod-eu')).toBe('databricks auth login --profile prod-eu');
		const message = reauth.reauthMessage('DEFAULT', SDK_ERROR);
		expect(message).toContain('databricks auth login --profile DEFAULT');
		// The SDK's own text survives - the real cause is never hidden.
		expect(message).toContain('cannot get access token');
		// …and comes back out on its own, so the sidebar's detail row does not
		// repeat the remedy the box above already spells out.
		expect(reauth.reauthDetail(message)).toBe(SDK_ERROR);
		// No underlying detail => no detail row.
		expect(reauth.reauthDetail(reauth.reauthMessage('DEFAULT'))).toBe('');
	});

	it('names no profile it was not given (the renderer then shows no command)', () => {
		expect(reauth.reauthExplanation('DEFAULT')).toContain('DEFAULT');
		for (const missing of [undefined, null, '', '   ']) {
			const text = reauth.reauthExplanation(missing);
			expect(text).toContain('sign-in expired');
			// Not a half-written command, and not a guessed name: just what to do.
			expect(text).not.toContain('--profile');
		}
	});
});

describe('the seam: an expired profile surfaces its own code + profile name', () => {
	it('a listing failure for a named profile becomes profile_reauth_required', async () => {
		// Exactly what the probe used to return for the captain: the OAuth-shaped
		// classification that sent them to the do-nothing sign-in button.
		writeStub({ code: 'oauth_login_required', message: SDK_ERROR });
		await expect(dbx.listClusters({ profile: 'DEFAULT' })).rejects.toMatchObject({
			code: reauth.PROFILE_REAUTH_CODE,
			profile: 'DEFAULT'
		});
		// The message carries the command, so a log line and an MCP tool result are
		// actionable too - not only the sidebar.
		await expect(dbx.listClusters({ profile: 'DEFAULT' })).rejects.toThrow(
			/databricks auth login --profile DEFAULT/
		);
	});

	it('also when the SDK phrased it as a plain auth failure (the kernel connect path shape)', async () => {
		writeStub({ code: 'auth_failed', message: SDK_ERROR });
		await expect(dbx.listClusters({ profile: 'DEFAULT' })).rejects.toMatchObject({
			code: reauth.PROFILE_REAUTH_CODE,
			profile: 'DEFAULT'
		});
	});

	it('the kernel connect path reclassifies too (CONNECT_CODE only knows auth_failed)', async () => {
		// The cluster-runtime lookup is best-effort, so this stub failure just skips
		// the version pin; the connect itself then fails in the kernel with SDK_ERROR.
		writeStub({ code: 'auth_failed', message: SDK_ERROR });
		await expect(
			dbx.connect({ profile: 'DEFAULT', clusterId: '0710-abc123-xyz', nb: join(dir, 'notebook.ipynb') })
		).rejects.toMatchObject({ code: reauth.PROFILE_REAUTH_CODE, profile: 'DEFAULT' });
	});

	it('is a 401, like the other auth codes', () => {
		expect(dbx.statusFor(reauth.PROFILE_REAUTH_CODE)).toBe(401);
	});
});

describe('regressions: the paths Cellar CAN fix keep their own remedy', () => {
	it('a bare typed host keeps oauth_login_required (Cellar’s sign-in mints that token)', async () => {
		writeStub({ code: 'oauth_login_required', message: SDK_ERROR });
		// Sign in FIRST so the code under test is the reclassification, not the
		// pre-probe sign-in gate (which would return the same code and pass for the
		// wrong reason). The stub answers `login` ok whatever failure is set.
		await expect(dbx.login({ host: 'https://bare.cloud.databricks.com' })).resolves.toMatchObject({
			ok: true
		});
		await expect(dbx.listClusters({ host: 'https://bare.cloud.databricks.com' })).rejects.toMatchObject({
			code: 'oauth_login_required'
		});
	});

	it('a no-token external-browser profile keeps oauth_login_required too', async () => {
		writeStub({ code: 'oauth_login_required', message: SDK_ERROR });
		await expect(dbx.login({ profile: 'ext_browser' })).resolves.toMatchObject({ ok: true });
		await expect(dbx.listClusters({ profile: 'ext_browser' })).rejects.toMatchObject({
			code: 'oauth_login_required'
		});
	});

	it('an ordinary auth failure on a named profile is still auth_failed', async () => {
		writeStub({
			code: 'auth_failed',
			message: 'Unauthenticated: Invalid access token. Config: host=…, auth_type=pat'
		});
		await expect(dbx.listClusters({ profile: 'DEFAULT' })).rejects.toMatchObject({
			code: 'auth_failed'
		});
	});

	it('a successful listing is untouched', async () => {
		writeStub(null);
		await expect(dbx.listClusters({ profile: 'DEFAULT' })).resolves.toEqual([]);
	});
});

describe('the route body carries the profile name the sidebar prints', () => {
	it('includes `profile` for profile_reauth_required and omits it otherwise', async () => {
		const { databricksErrorResponse } = await import(
			'../../src/routes/api/databricks/error-response.js'
		);
		const withProfile = await databricksErrorResponse(
			new dbx.DatabricksError(reauth.PROFILE_REAUTH_CODE, 'expired', 'prod-eu')
		).json();
		expect(withProfile).toMatchObject({ code: reauth.PROFILE_REAUTH_CODE, profile: 'prod-eu' });

		const plain = await databricksErrorResponse(new dbx.DatabricksError('auth_failed', 'nope')).json();
		expect(plain.profile).toBeUndefined();
	});
});

/**
 * **The RECONNECT ladder must not launder the classification away.**
 *
 * This is the likeliest way a user meets an expired profile at all: the token
 * dies under a session that was already working, so what they touch is the
 * sidebar's Reconnect button (or an agent's `databricks_reconnect`), not a fresh
 * connect. Both rungs that rebuild a session are driven fire-and-forget by callers
 * that must never throw, so each swallows its error - rung 2 (`autoReconnect`)
 * down to `false`, rung 3 (`reconnectAfterKernelRestart`) down to a string reason.
 * That flattening dropped `code`/`profile`, and `reconnectSession` then raised the
 * generic `reconnect_failed` telling the user to "reconnect from the Databricks
 * sidebar section" - which is precisely the dead-end button this whole feature
 * exists to stop offering. The cluster probe cannot rescue it either: it runs on
 * the SAME expired auth, so it can only answer "could not tell".
 *
 * These pin that the classified failure survives BOTH rungs, and - equally - that
 * it is never invented: an ordinary failure still reads `reconnect_failed`, and a
 * reauth verdict from an earlier attempt cannot speak for a later one.
 */
/** A notebook with a real, live connection - the only state the recovery paths act on. */
async function connectedNotebook(name: string): Promise<string> {
	const nb = join(dir, name);
	writeStub(null);
	kernel.session = 1;
	kernel.connectOk = true;
	kernel.sessionExpired = false;
	kernel.connectMessage = SDK_ERROR;
	await expect(
		dbx.connect({ profile: 'DEFAULT', clusterId: '0710-abc123-xyz', clusterName: 'analytics', nb })
	).resolves.toMatchObject({ ok: true });
	return nb;
}

/** Run `fn` with the clock past `LIVENESS_TTL_MS`, so a cached "alive" cannot answer for us. */
async function pastLivenessTtl<T>(fn: () => Promise<T>): Promise<T> {
	const realNow = Date.now;
	Date.now = () => realNow() + 60_000;
	try {
		return await fn();
	} finally {
		Date.now = realNow;
	}
}

describe('the reconnect ladder keeps the expired-profile verdict', () => {
	it('rung 3 (kernel restart): surfaces profile_reauth_required, not the generic sidebar message', async () => {
		const nb = await connectedNotebook('reconnect-restart.ipynb');
		// A kernel restart bumps the epoch, so `spark` is gone and the ladder falls to
		// rung 3 - which rebuilds via connect(), where the dead token now surfaces.
		kernel.session = 2;
		kernel.connectOk = false;
		await expect(dbx.reconnectSession(nb)).rejects.toMatchObject({
			code: reauth.PROFILE_REAUTH_CODE,
			profile: 'DEFAULT'
		});
		// The command rides the message, so the agent tool result is actionable too.
		await expect(dbx.reconnectSession(nb)).rejects.toThrow(/databricks auth login --profile DEFAULT/);
	});

	it('rung 2 (server-side expiry): surfaces it too', async () => {
		const nb = await connectedNotebook('reconnect-expiry.ipynb');
		// The epoch is unchanged (no restart) but the Spark Connect client is closed,
		// so the heal runs in place - and its connect() hits the same dead token.
		kernel.sessionExpired = true;
		kernel.connectOk = false;
		await pastLivenessTtl(() =>
			expect(dbx.reconnectSession(nb)).rejects.toMatchObject({
				code: reauth.PROFILE_REAUTH_CODE,
				profile: 'DEFAULT'
			})
		);
	});

	it('an ordinary reconnect failure is still the generic reconnect_failed', async () => {
		const nb = await connectedNotebook('reconnect-generic.ipynb');
		kernel.session = 2;
		kernel.connectOk = false;
		// A failure that is NOT an expired profile: the reauth verdict must be earned,
		// never handed to every reconnect that happens to fail.
		kernel.connectMessage = 'Unauthenticated: Invalid access token. Config: host=…, auth_type=pat';
		await expect(dbx.reconnectSession(nb)).rejects.toMatchObject({ code: 'reconnect_failed' });
	});

	it('a later attempt is not spoken for by an earlier verdict', async () => {
		const nb = await connectedNotebook('reconnect-stale.ipynb');
		kernel.session = 2;
		kernel.connectOk = false;
		// Attempt 1 fails with the expired-profile shape and records that verdict.
		await expect(dbx.reconnectSession(nb)).rejects.toMatchObject({
			code: reauth.PROFILE_REAUTH_CODE
		});
		// The user runs the command; attempt 2 must come back clean rather than
		// re-raising the verdict it just retired.
		kernel.connectOk = true;
		await expect(dbx.reconnectSession(nb)).resolves.toMatchObject({ connected: true, reconnected: true });
		// And a LATER, unrelated failure reads as itself, not as the old expiry.
		kernel.session = 3;
		kernel.connectOk = false;
		kernel.connectMessage = 'Unauthenticated: Invalid access token. Config: host=…, auth_type=pat';
		await expect(dbx.reconnectSession(nb)).rejects.toMatchObject({ code: 'reconnect_failed' });
	});
});

/**
 * **The AUTO-HEAL status surfaces must name it too.**
 *
 * The explicit Reconnect button is not the only way a user meets this: the panel
 * polls (`getStatus` → `liveConnection`) and an agent asks (`databricks_status` →
 * `agentStatus`), and both run the self-heal on a dead session. When that heal
 * fails because the profile's saved sign-in expired, saying "reconnect from the
 * Databricks sidebar section" costs the user a hop to a button that cannot fix it.
 *
 * Note WHERE the user actually ends up: a failed heal runs through `connect()`,
 * which clears the connection - so the panel drops to the picker card, the one
 * offering the "Sign in with Databricks" button that cannot fix a CLI-managed
 * profile. That state, not just the brief `expired` one, has to carry the command.
 *
 * The verdict is the one `reconnectTo` recorded (`pendingReauth`), fenced so it
 * can only speak for the present: it needs a still-bound notebook, and any
 * successful `connect()` retires it.
 */
describe('the auto-heal status surfaces name the expired profile', () => {
	it('agentStatus relays the exact command instead of pointing at the sidebar', async () => {
		const nb = await connectedNotebook('autoheal-agent.ipynb');
		// The Spark Connect client is closed (a server-side expiry, no restart), so
		// agentStatus heals in place - and that heal hits the dead token.
		kernel.sessionExpired = true;
		kernel.connectOk = false;
		const status = (await pastLivenessTtl(() => dbx.agentStatus(nb))) as Record<string, unknown>;
		expect(status).toMatchObject({
			connected: false,
			expired: true,
			reauth_required: true,
			profile: 'DEFAULT',
			reauth_command: 'databricks auth login --profile DEFAULT'
		});
		expect(String(status.note)).toContain('databricks auth login --profile DEFAULT');
		// The dead-end instruction this whole feature exists to retire.
		expect(String(status.note)).not.toMatch(/reconnect from the Databricks sidebar section/);
	});

	it('an ordinary expiry keeps the plain "reconnect from the sidebar" note', async () => {
		const nb = await connectedNotebook('autoheal-agent-generic.ipynb');
		kernel.sessionExpired = true;
		kernel.connectOk = false;
		kernel.connectMessage = 'Unauthenticated: Invalid access token. Config: host=…, auth_type=pat';
		const status = (await pastLivenessTtl(() => dbx.agentStatus(nb))) as Record<string, unknown>;
		expect(status).toMatchObject({ connected: false, expired: true });
		expect(status.reauth_required).toBeUndefined();
		expect(status.profile).toBeUndefined();
		expect(String(status.note)).toContain('reconnect from the Databricks sidebar section');
	});

	it('a bound notebook whose heal already failed keeps saying so, not "just connect"', async () => {
		const nb = await connectedNotebook('autoheal-agent-durable.ipynb');
		kernel.sessionExpired = true;
		kernel.connectOk = false;
		await pastLivenessTtl(() => dbx.agentStatus(nb));
		// The failed heal ran through connect(), which cleared the connection - so the
		// NEXT read has no session to assess. It must still name the real blocker
		// instead of the generic "ask the user to connect from the sidebar".
		const later = (await pastLivenessTtl(() => dbx.agentStatus(nb))) as Record<string, unknown>;
		expect(later).toMatchObject({ connected: false, reauth_required: true, profile: 'DEFAULT' });
		expect(String(later.note)).toContain('databricks auth login --profile DEFAULT');
	});

	it('the sidebar status carries the box once a heal has proved the cause', async () => {
		const nb = await connectedNotebook('autoheal-panel.ipynb');
		kernel.sessionExpired = true;
		kernel.connectOk = false;
		// The panel's own read never blocks on a reconnect, so the first one reports
		// the honest bare expiry: nothing has established a cause yet.
		const first = await pastLivenessTtl(() => dbx.getStatus(nb));
		expect(first.connection).toMatchObject({ connected: false, expired: true });
		expect((first.connection as Record<string, unknown>).reauth).toBeUndefined();

		// Once a heal HAS concluded (here the awaited one), the panel carries the
		// verdict - including on the picker card the cleared connection drops it to,
		// which is where the useless "Sign in with Databricks" button lives.
		await pastLivenessTtl(() => dbx.agentStatus(nb));
		const second = await pastLivenessTtl(() => dbx.getStatus(nb));
		expect(second.connection).toMatchObject({
			connected: false,
			reauth: { code: reauth.PROFILE_REAUTH_CODE, profile: 'DEFAULT' }
		});
		expect(
			String(((second.connection as Record<string, unknown>).reauth as { message: string }).message)
		).toContain('databricks auth login --profile DEFAULT');
	});

	it('a restored session retires the verdict rather than keeping it on the panel', async () => {
		const nb = await connectedNotebook('autoheal-retired.ipynb');
		kernel.sessionExpired = true;
		kernel.connectOk = false;
		await pastLivenessTtl(() => dbx.agentStatus(nb));
		expect(
			((await pastLivenessTtl(() => dbx.getStatus(nb))).connection as Record<string, unknown>).reauth
		).toBeDefined();

		// The user runs the command and clicks Reconnect: a live session is proof the
		// credential works, so neither surface may keep showing the expiry.
		kernel.connectOk = true;
		kernel.sessionExpired = false;
		await expect(dbx.reconnectSession(nb)).resolves.toMatchObject({ connected: true });
		const panel = await pastLivenessTtl(() => dbx.getStatus(nb));
		expect(panel.connection).toMatchObject({ connected: true });
		expect((panel.connection as Record<string, unknown>).reauth).toBeUndefined();
		const agent = (await pastLivenessTtl(() => dbx.agentStatus(nb))) as Record<string, unknown>;
		expect(agent.connected).toBe(true);
		expect(agent.reauth_required).toBeUndefined();
	});

	it('a later loss is not blamed on the sign-in the user already fixed', async () => {
		const nb = await connectedNotebook('autoheal-superseded.ipynb');
		kernel.sessionExpired = true;
		kernel.connectOk = false;
		await pastLivenessTtl(() => dbx.agentStatus(nb));

		// The user re-authenticates and connects from the picker (not Reconnect, which
		// clears the record itself): a live session is what retires the verdict.
		kernel.connectOk = true;
		kernel.sessionExpired = false;
		await expect(
			dbx.connect({ profile: 'DEFAULT', clusterId: '0710-abc123-xyz', clusterName: 'analytics', nb })
		).resolves.toMatchObject({ ok: true });

		// Now the kernel restarts, so the notebook is bound with no live session again -
		// a state nothing re-classified. It must read as the restart it is, never as
		// the expired sign-in that was already fixed.
		kernel.session += 1;
		const status = (await pastLivenessTtl(() => dbx.agentStatus(nb))) as Record<string, unknown>;
		expect(status).toMatchObject({ connected: false });
		expect(status.reauth_required).toBeUndefined();
		expect(String(status.note)).toContain('ended when the kernel restarted');
		const panel = await pastLivenessTtl(() => dbx.getStatus(nb));
		expect((panel.connection as Record<string, unknown>).reauth).toBeUndefined();
	});

	it('a disconnected notebook is not haunted by the verdict of a binding it dropped', async () => {
		const nb = await connectedNotebook('autoheal-disconnected.ipynb');
		kernel.sessionExpired = true;
		kernel.connectOk = false;
		await pastLivenessTtl(() => dbx.agentStatus(nb));
		// Disconnect drops the reconnect intent, so there is no longer a session
		// Cellar is trying to restore - and nothing to re-authenticate FOR.
		await dbx.disconnect(nb);
		const agent = (await pastLivenessTtl(() => dbx.agentStatus(nb))) as Record<string, unknown>;
		expect(agent.reauth_required).toBeUndefined();
		expect(String(agent.note)).toContain('No Databricks session');
		const panel = await pastLivenessTtl(() => dbx.getStatus(nb));
		expect((panel.connection as Record<string, unknown>).reauth).toBeUndefined();
	});

	it('a renewed-but-compute-failed direct connect never keeps the stale expired-sign-in box', async () => {
		const nb = await connectedNotebook('autoheal-renewed-connect.ipynb');
		// The saved sign-in expires and the awaited heal records the verdict.
		kernel.sessionExpired = true;
		kernel.connectOk = false;
		await pastLivenessTtl(() => dbx.agentStatus(nb));
		expect(
			((await pastLivenessTtl(() => dbx.getStatus(nb))).connection as Record<string, unknown>).reauth
		).toBeDefined();

		// The user renews the credential in a terminal, then - instead of Reconnect -
		// uses the picker to connect to a cluster that fails for a NON-auth reason
		// (a terminated cluster, a version mismatch). The credential is now valid, so
		// this connect proves auth; its failure has nothing to do with the sign-in.
		kernel.sessionExpired = false;
		kernel.connectOk = false;
		kernel.connectMessage = 'Unauthenticated: Invalid access token. Config: host=…, auth_type=pat';
		await expect(
			dbx.connect({ profile: 'DEFAULT', clusterId: '0710-abc123-xyz', clusterName: 'analytics', nb })
		).rejects.toMatchObject({ code: 'auth_failed' });

		// The stale reauth verdict must be gone: entering connect() retired it, and
		// this failure never re-recorded one, so no surface may re-attach the box.
		const agent = (await pastLivenessTtl(() => dbx.agentStatus(nb))) as Record<string, unknown>;
		expect(agent.reauth_required).toBeUndefined();
		expect(String(agent.note)).not.toContain('databricks auth login --profile DEFAULT');
		const panel = await pastLivenessTtl(() => dbx.getStatus(nb));
		expect((panel.connection as Record<string, unknown>).reauth).toBeUndefined();
	});
});
