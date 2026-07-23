import { describe, it, expect, afterAll, beforeAll, beforeEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
 *   2. The real purge: the probe deletes the cache file for EVERY selection this
 *      process signed in to (log out is global on purpose), and provably nothing
 *      else - a never-signed-in workspace's entry and the config file itself
 *      survive byte-for-byte.
 *   3. A PAT / databricks-cli profile purges NOTHING - it is reported as skipped.
 *   4. The session teardown reuses `disconnect`, so no reconnect intent survives a
 *      logout (a stale one would silently rebuild `spark` on the next restart).
 *   5. **A sign-out that did not provably complete is never reported as a clean
 *      one**, and its sign-in gate is KEPT - a cleared gate over a surviving token
 *      makes the next sign-in a silent cache hit for a user who believes they
 *      signed out.
 *
 * The kernel is mocked (per-notebook epoch + sentinel JSON), so no cluster is
 * needed. The purge itself runs the REAL probe against the REAL databricks-sdk, and
 * the cache filenames it must hit are derived INDEPENDENTLY here (mirroring
 * `credentials_provider.external_browser`) rather than by calling the code we test.
 * Those cases SKIP (loudly, with a reason) where no project venv carries the SDK -
 * a green run must never be mistakable for a verified purge. The honesty rules in
 * (5) need no SDK: they run against a stub interpreter, so they are always covered.
 */

const SENTINEL = '__CELLAR_DBX__';

// `hold`, when set, stalls the next kernel execution - the one lever that keeps a
// notebook's connect genuinely IN FLIGHT while a logout runs against it.
// `failDisconnect` is the other teardown failure: the kernel is unreachable, so
// `disconnect` throws out of `runInKernel` BEFORE the assignments that clear the
// state - the notebook stays bound, which is a different fact and a different remedy.
const state = vi.hoisted(() => ({
	session: 1 as number | null,
	hold: null as Promise<void> | null,
	failDisconnect: false
}));

vi.mock('../../src/lib/server/kernel', () => ({
	execute: async (_nb: string, code: string, onEvent: (e: unknown) => void) => {
		if (state.hold) await state.hold;
		if (state.failDisconnect && code.includes('_cellar_dbx_disconnect')) {
			throw new Error('kernel is not reachable');
		}
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
/**
 * Stub interpreters that answer every probe op with one canned sentinel line. They
 * are what let the SIGN-IN and REPORTING halves of these tests run anywhere: `login`
 * is the only way into `signedInHosts`/`signedInProfiles` and the real thing opens a
 * browser, and the purge's honesty rules are about what the probe REPORTS, not about
 * the SDK. `stubPython` reports a token cleared; `stubPythonEmpty` reports the probe
 * running and finding nothing (the derivation-miss case). Written in `beforeAll`.
 */
let stubPython = '';
let stubPythonEmpty = '';
/**
 * The env this file redirects at its temp home. `HOME` drives `os.homedir()` for
 * `databricks.ts`/`venv.js`/`instances.js`, so leaving it pointed at a deleted temp
 * dir would only be contained by vitest's isolated-pool default - a setting this
 * file must not silently depend on. Saved here, restored in `afterAll`.
 */
const REDIRECTED_ENV = ['HOME', 'DATABRICKS_CONFIG_FILE', 'CELLAR_WORKSPACE', 'CELLAR_PROJECT_VENV'] as const;
const savedEnv = new Map<string, string | undefined>();

/**
 * The project venv's python, but only if it can actually import databricks-sdk.
 * Resolved at MODULE scope so `describe.skipIf` can decide at collection time -
 * the real-purge cases must show up as SKIPPED, never as silently-passing.
 */
const python: string | null = (() => {
	const candidate = resolve(process.cwd(), '.venv', 'bin', 'python');
	if (!existsSync(candidate)) return null;
	return spawnSync(candidate, ['-c', 'import databricks.sdk'], { encoding: 'utf8' }).status === 0
		? candidate
		: null;
})();
const NO_SDK = 'no project .venv with databricks-sdk - the real purge cannot be exercised here';

const HOST_SIGNED_IN = 'https://logout-me.example.com';
const HOST_SIGNED_IN_TOO = 'https://logout-me-too.example.com';
const HOST_OTHER = 'https://keep-me.example.com';
const HOST_PAT = 'https://pat-me.example.com';
const HOST_BROWSER_PROFILE = 'https://prof-me.example.com';

/** A tiny executable that prints one canned probe result, whatever it is asked. */
function writeStub(name: string, result: Record<string, unknown>): string {
	const path = join(home, name);
	writeFileSync(path, `#!/bin/sh\ncat <<'EOF'\n${SENTINEL}${JSON.stringify(result)}\nEOF\n`, { mode: 0o755 });
	return path;
}

/** Point the probe at a stub (no SDK needed) or back at the real project venv. */
function useStub(which = stubPython) {
	process.env.CELLAR_PROJECT_VENV = which;
}
function useRealPython() {
	if (python) process.env.CELLAR_PROJECT_VENV = python;
	else delete process.env.CELLAR_PROJECT_VENV;
}

/**
 * Record a Cellar sign-in for a selection the only way the module allows - through
 * `login` - with the stub standing in for the browser flow. Reaching into the
 * private sets instead would prove nothing about the code path a real sign-in takes.
 */
async function signIn(sel: { host?: string; profile?: string }) {
	useStub();
	await dbx.login(sel);
}

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

/**
 * Write a cache entry under a filename the derivation can NEVER produce, whose
 * access token nonetheless names `iss`'s workspace - the shape a drifted SDK cache
 * key leaves behind. Only the token's own claims identify it, which is exactly what
 * the purge's scan fallback must key on.
 */
function seedUnderivableCacheEntry(name: string, iss: string): string {
	const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
	const jwt = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: `${iss}/oidc` })}.not-a-real-signature`;
	const dir = join(home, '.config', 'databricks-sdk-py', 'oauth');
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${name}.json`);
	writeFileSync(path, JSON.stringify({ token: { access_token: jwt, token_type: 'Bearer' } }));
	return path;
}

beforeAll(async () => {
	for (const key of REDIRECTED_ENV) savedEnv.set(key, process.env[key]);
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

	stubPython = writeStub('stub-python', { ok: true, cleared: ['stub-cache.json'], checked: 4 });
	stubPythonEmpty = writeStub('stub-python-empty', { ok: true, cleared: [], checked: 4, scanned: 2 });
	useRealPython();

	dbx = await import('../../src/lib/server/databricks');
});

afterAll(() => {
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(home, { recursive: true, force: true });
});

beforeEach(async () => {
	state.session = 1;
	state.failDisconnect = false;
	await dbx.disconnect().catch(() => {}); // a prior test's aborted connect must not cascade
	useRealPython();
	// Every sign-in is per-test: clear the module's gate through its own API so one
	// test's recorded sign-in cannot leak into the next one's expectations.
	useStub();
	await dbx.logout();
	useRealPython();
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

// The real purge needs the real SDK. Where it is absent these SKIP with the reason
// spelled out in the suite name rather than returning early with zero assertions: a
// green run must never be mistakable for a verified purge.
describe.skipIf(!python)(`logout purges only what Cellar cached${python ? '' : ` [SKIPPED: ${NO_SDK}]`}`, () => {
	it('deletes the signed-in host\'s token cache and leaves every other credential alone', async () => {
		const mine = seedTokenCache(HOST_SIGNED_IN);
		const someoneElses = seedTokenCache(HOST_OTHER);
		const configBefore = readFileSync(cfgPath, 'utf8');
		expect(existsSync(mine)).toBe(true);

		const result = await dbx.logout({ host: HOST_SIGNED_IN });

		expect(result.ok).toBe(true);
		expect(result.clearedTokens).toBe(1);
		expect(result.incomplete).toBe(false);
		// The token Cellar's own sign-in minted is gone, so the next connect re-auths.
		expect(existsSync(mine)).toBe(false);
		// ... and nothing else was touched: another workspace's cached session, and the
		// user's own profile store, survive untouched.
		expect(existsSync(someoneElses)).toBe(true);
		expect(readFileSync(cfgPath, 'utf8')).toBe(configBefore);
	});

	/**
	 * Log out is GLOBAL on purpose: every sign-in this process recorded, not just
	 * the selection the sidebar happens to be showing. A per-selection purge would
	 * leave another notebook's reconnect intent to rebuild `spark` after the user
	 * was told they signed out. So a SECOND signed-in workspace must be purged too -
	 * while a workspace that was never signed in stays untouched.
	 */
	it('signs out of EVERY signed-in workspace, and only those', async () => {
		await signIn({ host: HOST_SIGNED_IN });
		await signIn({ host: HOST_SIGNED_IN_TOO });
		useRealPython();

		const first = seedTokenCache(HOST_SIGNED_IN);
		const second = seedTokenCache(HOST_SIGNED_IN_TOO);
		const neverSignedIn = seedTokenCache(HOST_OTHER);
		const configBefore = readFileSync(cfgPath, 'utf8');

		// No selection at all: the caller's panel is irrelevant to the blast radius.
		const result = await dbx.logout();

		expect(result.clearedTokens).toBe(2);
		expect(result.incomplete).toBe(false);
		expect(existsSync(first)).toBe(false);
		expect(existsSync(second)).toBe(false);
		// Never signed in here, so this token is not Cellar's to delete...
		expect(existsSync(neverSignedIn)).toBe(true);
		// ...and the user's own credential store is still byte-for-byte intact.
		expect(readFileSync(cfgPath, 'utf8')).toBe(configBefore);

		const status = await dbx.getStatus();
		expect(status.signedInHosts).toEqual([]);
		// Two real SDK subprocesses (one per signed-in workspace) plus the seeds.
	}, 30_000);

	/**
	 * A derivation MISS must not read as "already clean". The cache key has drifted
	 * across SDK versions, so when the derived filenames hit nothing the purge falls
	 * back to identifying this host's entries POSITIVELY, by their own token claims -
	 * never by sweeping the directory, which is shared with the user's own scripts.
	 */
	it('still finds this host\'s token when the derived cache key misses - and only this host\'s', async () => {
		const drifted = seedUnderivableCacheEntry('0000drifted0000', HOST_SIGNED_IN);
		const anotherWorkspace = seedUnderivableCacheEntry('1111elsewhere1111', HOST_OTHER);

		const result = await dbx.logout({ host: HOST_SIGNED_IN });

		expect(result.clearedTokens).toBe(1);
		expect(result.incomplete).toBe(false);
		expect(existsSync(drifted)).toBe(false);
		// A credential that names a DIFFERENT workspace is not ours to delete, whatever
		// else is in that shared directory.
		expect(existsSync(anotherWorkspace)).toBe(true);
	}, 30_000);

	it('purges a no-token external-browser PROFILE\'s cache without touching ~/.databrickscfg', async () => {
		const mine = seedTokenCache(HOST_BROWSER_PROFILE, 'browser');
		const configBefore = readFileSync(cfgPath, 'utf8');

		const result = await dbx.logout({ profile: 'browser' });

		expect(result.clearedTokens).toBe(1);
		expect(existsSync(mine)).toBe(false);
		expect(readFileSync(cfgPath, 'utf8')).toBe(configBefore);
	});
});

describe('a PAT profile is the user\'s own credential', () => {
	it('has nothing of ours to purge: reported as skipped, its cache untouched', async () => {
		const seeded = python ? seedTokenCache(HOST_PAT, 'pat') : null;
		const configBefore = readFileSync(cfgPath, 'utf8');

		const result = await dbx.logout({ profile: 'pat' });

		expect(result.clearedTokens).toBe(0);
		expect(result.externalSkipped).toBe(1);
		// Nothing of ours to clear is not a failure - it is a clean, honest sign-out.
		expect(result.incomplete).toBe(false);
		if (seeded) expect(existsSync(seeded)).toBe(true);
		expect(readFileSync(cfgPath, 'utf8')).toBe(configBefore);
	});
});

/**
 * The honesty rules. These need no SDK - they are about what `logout` REPORTS when
 * the purge does not provably finish, and about the state it must refuse to leave
 * behind: a cleared sign-in gate over a token that is still on disk. That pairing is
 * the worst outcome of all, because the next "Sign in" is then a silent cache hit
 * and the user believes they signed out.
 */
describe('an incomplete sign-out is never reported as a clean one', () => {
	it('a purge that CANNOT RUN reports incomplete and KEEPS the sign-in gate', async () => {
		await signIn({ host: HOST_SIGNED_IN });
		// No interpreter at all: `requirePython()` throws `no_python`, the same shape a
		// missing SDK / a timeout / a Config error takes.
		delete process.env.CELLAR_PROJECT_VENV;

		const result = await dbx.logout({ host: HOST_SIGNED_IN });

		expect(result.purgeFailed).toBe(1);
		expect(result.clearedTokens).toBe(0);
		expect(result.incomplete).toBe(true);
		expect(result.incompleteReason).toMatch(/could not be cleared/i);
		// Every purge reason names the cache directory: the UI's remedy line tells the
		// user a token may still be deletable by hand, and it must not carry a second,
		// drifting copy of where that is.
		expect(result.incompleteReason).toMatch(/databricks-sdk-py\/oauth/);
		// The gate stays: it is the only thing left telling the user (and
		// `assertSignedIn`) that a usable credential may still exist.
		expect(result.clearedSignIns).toBe(0);
		useStub();
		const status = await dbx.getStatus();
		expect(status.signedInHosts).toContain('https://logout-me.example.com');
	});

	/**
	 * The sentence the UI renders can only name one failure, so it has to say HOW MANY
	 * there were - otherwise two failed purges read as one and the user believes the
	 * other workspace completed, while the counter next to it says otherwise.
	 */
	it('several failed purges are COUNTED in the reason, not silently reduced to the first', async () => {
		await signIn({ host: HOST_SIGNED_IN });
		await signIn({ host: HOST_SIGNED_IN_TOO });
		delete process.env.CELLAR_PROJECT_VENV;

		const result = await dbx.logout();

		expect(result.purgeFailed).toBe(2);
		expect(result.incompleteReason).toMatch(/2 signed-in workspaces/i);
		expect(result.incompleteReason).toMatch(/databricks-sdk-py\/oauth/);
		// Both gates survive, since neither purge provably completed.
		expect(result.clearedSignIns).toBe(0);
		useStub();
		const status = await dbx.getStatus();
		expect(status.signedInHosts).toHaveLength(2);
	});

	it('a purge that finds NOTHING for a signed-in selection is a miss, not a clean purge', async () => {
		await signIn({ host: HOST_SIGNED_IN });
		useStub(stubPythonEmpty);

		const result = await dbx.logout();

		expect(result.clearedTokens).toBe(0);
		expect(result.purgeMissed).toBe(1);
		expect(result.incomplete).toBe(true);
		expect(result.incompleteReason).toMatch(/still be on disk/i);
		expect(result.incompleteReason).toMatch(/databricks-sdk-py\/oauth/);
		expect(result.clearedSignIns).toBe(0);
	});

	/**
	 * A recorded sign-in whose profile has since been deleted or renamed in
	 * `~/.databrickscfg`. Without the profile the purge cannot derive WHICH cache
	 * entry holds that token, so it may still be on disk - which makes this a failed
	 * purge, not a clean skip. Reported as such, and its gate is kept: dropping it
	 * silently is the same cleared-gate-over-a-surviving-token trap as any other
	 * unproven purge, and the reason has to point at the cache so the user can finish
	 * the job by hand.
	 */
	it('a signed-in profile that VANISHED from the config keeps its gate and reports incomplete', async () => {
		await signIn({ profile: 'browser' });
		const configBefore = readFileSync(cfgPath, 'utf8');
		try {
			// The user renamed the profile between signing in and signing out.
			writeFileSync(cfgPath, configBefore.replace('[browser]', '[browser-renamed]'));

			const result = await dbx.logout();

			expect(result.purgeFailed).toBe(1);
			expect(result.clearedTokens).toBe(0);
			expect(result.incomplete).toBe(true);
			expect(result.incompleteReason).toMatch(/is not in/i);
			// Actionable, not a dead end: name where the token would be.
			expect(result.incompleteReason).toMatch(/databricks-sdk-py\/oauth/);
			// The gate SURVIVES - it is the only thing still telling the user (and
			// `assertSignedIn`) that a usable credential may be cached.
			expect(result.clearedSignIns).toBe(0);
			useStub();
			const status = await dbx.getStatus();
			expect(status.signedInProfiles).toContain('browser');
		} finally {
			writeFileSync(cfgPath, configBefore);
		}
	});

	it('a clean purge DOES clear the gate and reports no incompleteness', async () => {
		await signIn({ host: HOST_SIGNED_IN });

		const result = await dbx.logout();

		expect(result.clearedTokens).toBe(1);
		expect(result.clearedSignIns).toBe(1);
		expect(result.incomplete).toBe(false);
		expect(result.incompleteReason).toBeNull();
		const status = await dbx.getStatus();
		expect(status.signedInHosts).toEqual([]);
	});

	it('a notebook mid-connect cannot be disconnected, so the sign-out reports incomplete', async () => {
		delete process.env.CELLAR_PROJECT_VENV;
		await dbx.connect({ profile: 'pat', clusterId: '0725-abc', clusterName: 'Test Cluster' });
		expect(dbx.databricksBound()).toBe(true);

		// A second connect that never settles: the notebook is `inFlight`, so
		// `disconnect` refuses and its reconnect intent survives the sign-out.
		let release = () => {};
		state.hold = new Promise<void>((resolve) => (release = resolve));
		const connecting = dbx.connect({ profile: 'pat', clusterId: '0725-def', clusterName: 'Other' });
		try {
			await new Promise((r) => setTimeout(r, 10));

			const result = await dbx.logout({ profile: 'pat' });

			expect(result.sessionsFailed).toBe(1);
			// A REFUSED teardown, not a failed one: `disconnect` never touched the state,
			// and this resolves itself once the connect ends. The two must stay
			// distinguishable - their remedies are different.
			expect(result.sessionsBusy).toBe(1);
			expect(result.sessionsStuck).toBe(0);
			expect(result.incomplete).toBe(true);
			expect(result.incompleteReason).toMatch(/connect is still in progress/i);
			expect(result.incompleteReason).not.toMatch(/still bound/i);
			// A session that could not be ended says nothing about the token cache: the
			// reason must not point at a file, or the UI's remedy would tell the user to
			// delete something a successful purge already removed.
			expect(result.purgeFailed + result.purgeMissed).toBe(0);
			expect(result.incompleteReason).not.toMatch(/databricks-sdk-py\/oauth/);
		} finally {
			// Release even on a failed assertion, or the held execution wedges the
			// mocked kernel for every test after this one.
			state.hold = null;
			release();
			await connecting.catch(() => {});
			await dbx.disconnect().catch(() => {});
		}
	});

	/**
	 * The other teardown failure, and the worse one. `disconnect` throws out of
	 * `runInKernel(DISCONNECT_CODE)` - the sidecar is unreachable - which is BEFORE the
	 * assignments that clear `connection`/`reconnectTarget`, so the notebook stays
	 * genuinely BOUND and would rebuild `spark` on its next kernel restart. Reporting
	 * that as "a connect is still in progress" names a cause that never happened and
	 * sends the user to wait for something that will never finish.
	 */
	it('a teardown that FAILED reports the notebook still bound, not a connect in flight', async () => {
		delete process.env.CELLAR_PROJECT_VENV;
		await dbx.connect({ profile: 'pat', clusterId: '0725-abc', clusterName: 'Test Cluster' });
		expect(dbx.databricksBound()).toBe(true);
		state.failDisconnect = true;
		try {
			const result = await dbx.logout({ profile: 'pat' });

			expect(result.sessionsFailed).toBe(1);
			expect(result.sessionsStuck).toBe(1);
			expect(result.sessionsBusy).toBe(0);
			expect(result.incomplete).toBe(true);
			expect(result.incompleteReason).toMatch(/still bound to a cluster/i);
			expect(result.incompleteReason).not.toMatch(/connect is still in progress/i);
			// The reconnect intent really did survive - that is what makes this incomplete.
			expect(dbx.databricksBound()).toBe(true);
			// Still nothing to do with the token cache.
			expect(result.incompleteReason).not.toMatch(/databricks-sdk-py\/oauth/);
		} finally {
			state.failDisconnect = false;
			await dbx.disconnect().catch(() => {});
		}
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
