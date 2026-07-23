import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * **Log out vs disconnect.** Disconnect ends the Spark session and leaves you
 * authenticated. Log out also drops the authentication - but only the part that is
 * CELLAR's: the token Cellar's own browser sign-in minted, which the SDK keeps in
 * its python-local cache (`~/.config/databricks-sdk-py/oauth/<hash>.json`).
 *
 * The user's own credentials are explicitly out of bounds: `~/.databrickscfg`
 * profiles, OS keyring entries and the databricks CLI's token cache are managed by
 * the CLI/SDK, not by Cellar, so a logout must never delete them. That asymmetry is
 * the whole point of the feature and is what this file pins:
 *
 *   1. `hasCellarCachedOAuth` - the pure decision about WHOSE credential it is.
 *   2. The real purge: the probe deletes the cache file for the selection signed in
 *      to, and provably nothing else (another workspace's entry, and the config
 *      file itself, survive byte-for-byte).
 *   3. A PAT / databricks-cli profile purges NOTHING - it is reported as skipped.
 *   4. The session teardown reuses `disconnect`, so no reconnect intent survives a
 *      logout (a stale one would silently rebuild `spark` on the next restart).
 *
 * The kernel is mocked (per-notebook epoch + sentinel JSON), so no cluster is
 * needed. The purge itself runs the REAL probe against the REAL databricks-sdk, and
 * the cache filenames it must hit are derived INDEPENDENTLY here (mirroring
 * `credentials_provider.external_browser`) rather than by calling the code we test.
 */

const SENTINEL = '__CELLAR_DBX__';

const state = vi.hoisted(() => ({ session: 1 as number | null }));

vi.mock('../../src/lib/server/kernel', () => ({
	execute: async (_nb: string, code: string, onEvent: (e: unknown) => void) => {
		onEvent({ type: 'kernel', session: state.session });
		let out: Record<string, unknown>;
		if (code.includes('_cellar_dbx_ping')) out = { ok: true, alive: true, expired: false };
		else if (code.includes('_cellar_dbx_connect')) out = { ok: true, host: 'https://pat-me.example.com', spark_version: '3.5.0' };
		else out = { ok: true };
		onEvent({
			type: 'output',
			output: { output_type: 'stream', name: 'stdout', text: SENTINEL + JSON.stringify(out) + '\n' }
		});
		return {};
	},
	currentSessionId: () => state.session,
	kernelStatus: () => ({ status: 'idle', id: state.session == null ? null : 'k1' }),
	restartKernel: async () => ({ status: 'idle', id: 'k1', session_id: 1 })
}));

let dbx: typeof import('../../src/lib/server/databricks');
let home: string;
let cfgPath: string;
/** The project venv's python, but only if it can actually import databricks-sdk. */
let python: string | null = null;

const HOST_SIGNED_IN = 'https://logout-me.example.com';
const HOST_OTHER = 'https://keep-me.example.com';
const HOST_PAT = 'https://pat-me.example.com';
const HOST_BROWSER_PROFILE = 'https://prof-me.example.com';

/**
 * Seed a token-cache file the way the SDK's own external-browser provider would,
 * and return its path. Deliberately an INDEPENDENT re-derivation of the cache key
 * (host + client_id + scopes + profile, hashed by the SDK's `TokenCache`): if the
 * probe's derivation drifts from the provider's, these files stop matching and the
 * purge assertions fail - which is exactly the regression worth catching.
 */
function seedTokenCache(host: string, profile = ''): string {
	const script = [
		'import os, sys',
		'from databricks.sdk import oauth',
		'host, profile = sys.argv[1], sys.argv[2]',
		'tc = oauth.TokenCache(host=host, oidc_endpoints=None, client_id="databricks-cli",',
		'                      redirect_url="http://localhost:8020", client_secret=None,',
		'                      scopes=["all-apis", "offline_access"], profile=profile)',
		'os.makedirs(os.path.dirname(tc.filename), exist_ok=True)',
		'open(tc.filename, "w").write(\'{"access_token": "fake-cellar-minted-token"}\')',
		'print(tc.filename)'
	].join('\n');
	const run = spawnSync(python!, ['-c', script, host, profile], {
		encoding: 'utf8',
		env: { ...process.env, HOME: home }
	});
	expect(run.status, `seeding failed: ${run.stderr}`).toBe(0);
	return run.stdout.trim();
}

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), 'cellar-dbx-logout-'));
	cfgPath = join(home, '.databrickscfg');
	writeFileSync(
		cfgPath,
		[
			'[pat]',
			`host = ${HOST_PAT}`,
			'token = dummy-pat',
			'',
			'[browser]',
			`host = ${HOST_BROWSER_PROFILE}`,
			'auth_type = external-browser',
			''
		].join('\n')
	);
	// `HOME` is what the SDK expands its cache path against, and `probe()` passes the
	// process env through - so the purge lands in this temp home, never the user's.
	process.env.HOME = home;
	process.env.DATABRICKS_CONFIG_FILE = cfgPath;
	process.env.CELLAR_WORKSPACE = home;

	const candidate = resolve(process.cwd(), '.venv', 'bin', 'python');
	if (existsSync(candidate)) {
		const probe = spawnSync(candidate, ['-c', 'import databricks.sdk'], { encoding: 'utf8' });
		if (probe.status === 0) {
			python = candidate;
			process.env.CELLAR_PROJECT_VENV = candidate;
		}
	}

	dbx = await import('../../src/lib/server/databricks');
});

beforeEach(async () => {
	state.session = 1;
	await dbx.disconnect().catch(() => {}); // a prior test's aborted connect must not cascade
});

describe('hasCellarCachedOAuth - whose credential is it?', () => {
	it('a bare typed host is CELLAR-minted (our own browser sign-in)', () => {
		expect(dbx.hasCellarCachedOAuth(dbx.resolveAuth({ host: HOST_SIGNED_IN }))).toBe(true);
	});

	it('a no-token external-browser profile is CELLAR-minted too (the one gated profile shape)', () => {
		expect(dbx.hasCellarCachedOAuth(dbx.resolveAuth({ profile: 'browser' }))).toBe(true);
	});

	it('a PAT profile is the USER\'s credential - never ours to delete', () => {
		expect(dbx.hasCellarCachedOAuth(dbx.resolveAuth({ profile: 'pat' }))).toBe(false);
	});
});

describe('logout purges only what Cellar cached', () => {
	it('deletes the signed-in host\'s token cache and leaves every other credential alone', async () => {
		if (!python) return; // no project venv with databricks-sdk (see beforeAll)

		const mine = seedTokenCache(HOST_SIGNED_IN);
		const someoneElses = seedTokenCache(HOST_OTHER);
		const configBefore = readFileSync(cfgPath, 'utf8');
		expect(existsSync(mine)).toBe(true);

		const result = await dbx.logout({ host: HOST_SIGNED_IN });

		expect(result.ok).toBe(true);
		expect(result.clearedTokens).toBe(1);
		// The token Cellar's own sign-in minted is gone, so the next connect re-auths.
		expect(existsSync(mine)).toBe(false);
		// ... and nothing else was touched: another workspace's cached session, and the
		// user's own profile store, survive untouched.
		expect(existsSync(someoneElses)).toBe(true);
		expect(readFileSync(cfgPath, 'utf8')).toBe(configBefore);
	});

	it('purges a no-token external-browser PROFILE\'s cache without touching ~/.databrickscfg', async () => {
		if (!python) return;

		const mine = seedTokenCache(HOST_BROWSER_PROFILE, 'browser');
		const configBefore = readFileSync(cfgPath, 'utf8');

		const result = await dbx.logout({ profile: 'browser' });

		expect(result.clearedTokens).toBe(1);
		expect(existsSync(mine)).toBe(false);
		expect(readFileSync(cfgPath, 'utf8')).toBe(configBefore);
	});

	it('a PAT profile has nothing of ours to purge: reported as skipped, its cache untouched', async () => {
		const seeded = python ? seedTokenCache(HOST_PAT, 'pat') : null;
		const configBefore = readFileSync(cfgPath, 'utf8');

		const result = await dbx.logout({ profile: 'pat' });

		expect(result.clearedTokens).toBe(0);
		expect(result.externalSkipped).toBe(1);
		if (seeded) expect(existsSync(seeded)).toBe(true);
		expect(readFileSync(cfgPath, 'utf8')).toBe(configBefore);
	});
});

describe('logout also ends the session (reusing the disconnect path)', () => {
	// These exercise the SESSION half, where the kernel is mocked. Unbinding the
	// project venv keeps `connect()`'s DBR-version probe off the network: with no
	// interpreter it fails fast and connect falls back, instead of spending its HTTP
	// budget trying to reach a workspace host that does not exist.
	let venv: string | undefined;
	beforeEach(() => {
		venv = process.env.CELLAR_PROJECT_VENV;
		delete process.env.CELLAR_PROJECT_VENV;
		return () => {
			if (venv) process.env.CELLAR_PROJECT_VENV = venv;
		};
	});

	it('drops the live connection AND the durable reconnect intent', async () => {
		await dbx.connect({ profile: 'pat', clusterId: '0725-abc', clusterName: 'Test Cluster' });
		expect(dbx.connectionStatus().connected).toBe(true);
		expect(dbx.databricksBound()).toBe(true);

		const result = await dbx.logout({ profile: 'pat' });

		expect(result.disconnected).toBeGreaterThanOrEqual(1);
		expect(dbx.connectionStatus().connected).toBe(false);
		// The reconnect intent must go too: left behind, the next kernel restart would
		// silently rebuild `spark` for a user who was just told they are signed out.
		expect(dbx.databricksBound()).toBe(false);
	});

	it('leaves no sign-in recorded, so a gated selection must authenticate again', async () => {
		await dbx.logout({ profile: 'pat' });
		const status = await dbx.getStatus();
		expect(status.signedInHosts).toEqual([]);
		expect(status.signedInProfiles).toEqual([]);
	});
});
