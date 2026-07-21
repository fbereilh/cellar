import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';

/**
 * `resolveAuth` - the seam that turns a UI selection ({profile} | {host}) into
 * the SDK `Config` descriptor. The regression this pins:
 *
 * A working `~/.databrickscfg` profile that carries **no PAT** (the common
 * `auth_type = databricks-cli` / OAuth-cached shape, e.g. the captain's DEFAULT)
 * used to be misclassified as `mode:'oauth'` with its profile name DISCARDED, so
 * Cellar gated it behind its OWN browser OAuth instead of just handing the name
 * to the SDK (which authenticates it from its own cached credential). Doctrine is
 * "auth is the SDK's profile auth and nothing else": a named profile - with or
 * without a token - must resolve to `mode:'profile'` with the name preserved, and
 * Cellar's own OAuth stays reserved for a bare typed host with no profile.
 *
 * The kernel is mocked only to avoid its import-time side effects; `resolveAuth`
 * is pure and synchronous (it reads the config file via `DATABRICKS_CONFIG_FILE`
 * and spawns nothing).
 */

vi.mock('../../src/lib/server/kernel', () => ({
	execute: vi.fn(),
	currentSessionId: () => null,
	kernelStatus: () => ({ status: 'idle', id: null }),
	restartKernel: vi.fn(),
	refreshKernelConnection: vi.fn()
}));

let dbx: typeof import('../../src/lib/server/databricks');

beforeAll(async () => {
	const dir = mkdtempSync(join(tmpdir(), 'cellar-dbx-auth-'));
	const cfg = join(dir, '.databrickscfg');
	writeFileSync(
		cfg,
		[
			// A no-PAT profile the SDK authenticates itself (databricks-cli / cached OAuth).
			'[DEFAULT]',
			'host = https://default.cloud.databricks.com',
			'auth_type = databricks-cli',
			'',
			// A no-PAT profile with NO explicit auth_type (SDK infers databricks-cli).
			'[bare_profile]',
			'host = https://bare.cloud.databricks.com',
			'',
			// A PAT profile.
			'[pat_profile]',
			'host = https://pat.cloud.databricks.com/',
			'token = dummy-pat-value',
			'',
			// A no-token external-browser profile - the ONE gated shape (could pop a browser).
			'[ext_browser]',
			'host = https://ext.cloud.databricks.com',
			'auth_type = external-browser',
			'',
			// An external-browser profile that ALSO carries a token - the token wins, not gated.
			'[ext_browser_token]',
			'host = https://exttok.cloud.databricks.com',
			'auth_type = external-browser',
			'token = dummy-pat-value',
			'',
			// The CLI writes bookkeeping sections here too - not a profile (no host).
			'[__settings__]',
			'foo = bar',
			''
		].join('\n')
	);
	process.env.DATABRICKS_CONFIG_FILE = cfg;
	process.env.CELLAR_WORKSPACE = dir;
	dbx = await import('../../src/lib/server/databricks');
});

describe('resolveAuth', () => {
	it('a no-PAT profile valid in the config resolves to profile auth with its name preserved (NOT oauth)', () => {
		const auth = dbx.resolveAuth({ profile: 'DEFAULT' }) as Record<string, unknown>;
		expect(auth.mode).toBe('profile');
		expect(auth.profile).toBe('DEFAULT');
		expect(auth.host).toBe('https://default.cloud.databricks.com');
		// The load-bearing regression check: no spurious oauth_login_required path.
		expect(auth.mode).not.toBe('oauth');
	});

	it('a PAT profile still resolves to profile auth (the SDK reads the token) with its name preserved', () => {
		const auth = dbx.resolveAuth({ profile: 'pat_profile' }) as Record<string, unknown>;
		expect(auth.mode).toBe('profile');
		expect(auth.profile).toBe('pat_profile');
		// host is normalized (trailing slash dropped).
		expect(auth.host).toBe('https://pat.cloud.databricks.com');
	});

	it('a bare typed host with no profile resolves to Cellar OAuth against that host', () => {
		const auth = dbx.resolveAuth({ host: 'my-workspace.cloud.databricks.com' }) as Record<
			string,
			unknown
		>;
		expect(auth.mode).toBe('oauth');
		expect(auth.host).toBe('https://my-workspace.cloud.databricks.com');
		expect(auth.profile).toBeUndefined();
	});

	it('a profile name not present in the config throws profile_missing (never a silent OAuth fallback)', () => {
		expect(() => dbx.resolveAuth({ profile: 'nope' })).toThrowError(/profile_missing|not in/);
		try {
			dbx.resolveAuth({ profile: 'nope' });
		} catch (e) {
			expect((e as { code?: string }).code).toBe('profile_missing');
		}
	});

	it('an unusable host (empty / not a URL) throws bad_request', () => {
		expect(() => dbx.resolveAuth({ host: '' })).toThrow();
		try {
			dbx.resolveAuth({ host: 'not a host' });
		} catch (e) {
			expect((e as { code?: string }).code).toBe('bad_request');
		}
	});

	it('readProfiles still reports hasToken for the UI label (informational)', () => {
		const { profiles } = dbx.readProfiles();
		const names = profiles.map((p) => p.name).sort();
		// __settings__ (host-less) dropped
		expect(names).toEqual(['DEFAULT', 'bare_profile', 'ext_browser', 'ext_browser_token', 'pat_profile']);
		expect(profiles.find((p) => p.name === 'DEFAULT')?.hasToken).toBe(false);
		expect(profiles.find((p) => p.name === 'pat_profile')?.hasToken).toBe(true);
	});
});

/**
 * The browser-safety gate: a listing/connect must never itself pop the SDK's
 * OAuth browser. Only ONE profile shape can - a no-token `auth_type =
 * external-browser` profile - so it (like a bare host) is held behind an explicit
 * sign-in; every other profile the SDK can authenticate silently is ungated. This
 * is encoded in `resolveAuth`'s `needsSignIn` flag and enforced by the listing
 * gate (`listClusters` throws `oauth_login_required` BEFORE spawning any probe).
 */
describe('profile sign-in gate (needsSignIn)', () => {
	it('a databricks-cli profile is ungated (needsSignIn false)', () => {
		const auth = dbx.resolveAuth({ profile: 'DEFAULT' }) as Record<string, unknown>;
		expect(auth.needsSignIn).toBe(false);
	});

	it('a no-authType no-token profile is ungated (DEFAULT-shape, needsSignIn false)', () => {
		const auth = dbx.resolveAuth({ profile: 'bare_profile' }) as Record<string, unknown>;
		expect(auth.mode).toBe('profile');
		expect(auth.needsSignIn).toBe(false);
	});

	it('a PAT profile is ungated (needsSignIn false)', () => {
		const auth = dbx.resolveAuth({ profile: 'pat_profile' }) as Record<string, unknown>;
		expect(auth.needsSignIn).toBe(false);
	});

	it('a no-token external-browser profile is gated (needsSignIn true)', () => {
		const auth = dbx.resolveAuth({ profile: 'ext_browser' }) as Record<string, unknown>;
		expect(auth.mode).toBe('profile');
		expect(auth.profile).toBe('ext_browser'); // name preserved, still a profile
		expect(auth.needsSignIn).toBe(true);
	});

	it('an external-browser profile WITH a token is ungated (the token wins)', () => {
		const auth = dbx.resolveAuth({ profile: 'ext_browser_token' }) as Record<string, unknown>;
		expect(auth.needsSignIn).toBe(false);
	});

	it('listing an un-signed-in external-browser profile throws oauth_login_required (before any probe)', async () => {
		await expect(dbx.listClusters({ profile: 'ext_browser' })).rejects.toMatchObject({
			code: 'oauth_login_required'
		});
	});
});
