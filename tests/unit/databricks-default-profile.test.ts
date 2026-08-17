import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
	DEFAULT_PROFILE_CONSEQUENCE,
	SETTINGS_SECTION,
	defaultProfileProblem,
	resolveDefaultProfile,
	switchDefaultProfileCommand,
	type DefaultProfileInput
} from '../../src/lib/databricksDefaultProfile';

/**
 * "Would a bare `Config()` in a Cellar kernel find any credentials?" - the rule, and
 * the reader that feeds it.
 *
 * This area had NO test coverage at all before, and the rule it mirrors lives in
 * someone else's code (`databricks/sdk/config.py` `_resolve_profile`), so the suite
 * is in three layers:
 *
 *   1. the PURE rule, across every branch the SDK has, including the edges that
 *      look like they should resolve and do not;
 *   2. the READER, over real `~/.databrickscfg` files on disk, because the parse is
 *      where "an empty `[DEFAULT]`" and "a `[__settings__]` with no host" have to
 *      survive a projection that deliberately drops both from the profile picker;
 *   3. a DIFFERENTIAL check against the real SDK, when one is installed - the only
 *      thing that can catch the rule drifting away from the SDK it models.
 *
 * The suite writes only into its own temp dir and never touches the machine's real
 * `~/.databrickscfg`.
 */

vi.mock('../../src/lib/server/kernel', () => ({
	execute: vi.fn(),
	currentSessionId: () => null,
	kernelStatus: () => ({ status: 'idle', id: null }),
	restartKernel: vi.fn(),
	refreshKernelConnection: vi.fn(),
	// `getStatus` reads this for the Runtime card. No kernel here, so: never started.
	liveDatabricksRuntime: () => ({ started: false, version: null })
}));

/** A fully-specified input, so each case states only the fact it is about. */
const input = (over: Partial<DefaultProfileInput> = {}): DefaultProfileInput => ({
	exists: true,
	sections: [],
	settingsDefaultProfile: null,
	defaultSectionHasKeys: false,
	candidates: [],
	...over
});

describe('the SDK rule: _resolve_profile, branch by branch', () => {
	// Branch 1 (an explicit `profile=` argument) is deliberately absent: it is what
	// Cellar's OWN connect passes, and the whole point of this detector is the BARE
	// case a user's library hits. Asserted below as a property of the input shape.
	it('takes no requested-profile input at all - it models the bare Config() only', () => {
		expect(Object.keys(input())).not.toContain('requestedProfile');
	});

	it('rule 2: [__settings__] default_profile wins', () => {
		const v = resolveDefaultProfile(
			input({
				sections: [SETTINGS_SECTION, 'work'],
				settingsDefaultProfile: 'work',
				candidates: ['work']
			})
		);
		expect(v).toMatchObject({ resolves: true, reason: 'default_profile', profile: 'work', needsDefault: false });
	});

	it('rule 2 beats rule 3 - a named default outranks a populated [DEFAULT]', () => {
		const v = resolveDefaultProfile(
			input({
				sections: [SETTINGS_SECTION, 'DEFAULT', 'work'],
				settingsDefaultProfile: 'work',
				defaultSectionHasKeys: true,
				candidates: ['DEFAULT', 'work']
			})
		);
		expect(v.profile).toBe('work');
		expect(v.reason).toBe('default_profile');
	});

	it('rule 2 trims, and treats a blank value as absent (falls through to rule 4)', () => {
		const named = resolveDefaultProfile(
			input({ sections: [SETTINGS_SECTION, 'work'], settingsDefaultProfile: '  work  ', candidates: ['work'] })
		);
		expect(named).toMatchObject({ resolves: true, profile: 'work' });

		const blank = resolveDefaultProfile(
			input({ sections: [SETTINGS_SECTION, 'work'], settingsDefaultProfile: '   ', candidates: ['work'] })
		);
		expect(blank).toMatchObject({ resolves: false, reason: 'no_default' });
	});

	it('rule 3: a [DEFAULT] carrying keys resolves to DEFAULT', () => {
		const v = resolveDefaultProfile(
			input({ sections: ['DEFAULT'], defaultSectionHasKeys: true, candidates: ['DEFAULT'] })
		);
		expect(v).toMatchObject({ resolves: true, reason: 'default_section', profile: 'DEFAULT', needsDefault: false });
	});

	it('rule 3 needs KEYS, not the header: an empty [DEFAULT] falls through to rule 4', () => {
		// The edge the whole detector turns on. configparser's `defaults()` is `{}` for
		// a bare `[DEFAULT]` header, which is falsy - so the SDK does NOT resolve it.
		const v = resolveDefaultProfile(
			input({ sections: ['DEFAULT', 'work'], defaultSectionHasKeys: false, candidates: ['work'] })
		);
		expect(v).toMatchObject({ resolves: false, reason: 'no_default', profile: null, needsDefault: true });
	});

	it('rule 3 is case-sensitive: [default] is an ordinary profile, not the defaults', () => {
		// configparser compares against DEFAULTSECT === "DEFAULT" exactly, so a
		// lowercase section is just a profile named "default" and resolves nothing.
		const v = resolveDefaultProfile(
			input({ sections: ['default'], defaultSectionHasKeys: false, candidates: ['default'] })
		);
		expect(v).toMatchObject({ resolves: false, reason: 'no_default' });
	});

	it('rule 4: the reported failing shape - a named profile and nothing else', () => {
		const v = resolveDefaultProfile(
			input({ sections: ['dbc-29a8e8d0-5a51'], candidates: ['dbc-29a8e8d0-5a51'] })
		);
		expect(v).toMatchObject({ resolves: false, reason: 'no_default', profile: null, needsDefault: true });
		expect(v.candidates).toEqual(['dbc-29a8e8d0-5a51']);
	});
});

describe('the two shapes where a resolved name is unusable and Config() raises', () => {
	it('default_profile naming a section that is not in the file is dangling, not a fallback', () => {
		// `is_fallback` is false on this path, so the SDK RAISES rather than quietly
		// falling back to [DEFAULT]. Reporting it as "no default" would understate it.
		const v = resolveDefaultProfile(
			input({
				sections: [SETTINGS_SECTION, 'work'],
				settingsDefaultProfile: 'gone',
				defaultSectionHasKeys: true,
				candidates: ['work']
			})
		);
		expect(v).toMatchObject({ resolves: false, reason: 'dangling_default_profile', needsDefault: true });
	});

	it('default_profile = DEFAULT is dangling when [DEFAULT] carries no keys', () => {
		// configparser keeps DEFAULT in `_defaults`, never in `_sections`, and the SDK
		// only adds it to the candidate set when `defaults()` is truthy - so an empty
		// [DEFAULT] is a section that does not exist for resolution purposes.
		const v = resolveDefaultProfile(
			input({
				sections: [SETTINGS_SECTION, 'DEFAULT', 'work'],
				settingsDefaultProfile: 'DEFAULT',
				defaultSectionHasKeys: false,
				candidates: ['work']
			})
		);
		expect(v.reason).toBe('dangling_default_profile');
	});

	it('default_profile naming a host-less section still RESOLVES - the SDK does not require a host', () => {
		// The picker drops host-less sections; resolution does not. Reading `candidates`
		// instead of every section name here would report a working config as broken.
		const v = resolveDefaultProfile(
			input({
				sections: [SETTINGS_SECTION, 'partial', 'work'],
				settingsDefaultProfile: 'partial',
				candidates: ['work']
			})
		);
		expect(v).toMatchObject({ resolves: true, reason: 'default_profile', profile: 'partial' });
	});

	it('default_profile = __settings__ is refused as a reserved name', () => {
		const v = resolveDefaultProfile(
			input({ sections: [SETTINGS_SECTION, 'work'], settingsDefaultProfile: SETTINGS_SECTION, candidates: ['work'] })
		);
		expect(v).toMatchObject({ resolves: false, reason: 'reserved_default_profile', needsDefault: true });
	});
});

describe('it never nags a machine it has no advice for', () => {
	it('no config file at all: silent', () => {
		const v = resolveDefaultProfile(input({ exists: false }));
		expect(v).toMatchObject({ resolves: false, reason: 'no_config_file', needsDefault: false });
	});

	it('a config file with no offerable profile: silent, because there is nothing to choose', () => {
		// A host-mode user (typed host + OAuth) is in exactly this state. Telling them
		// to pick a default would point at an empty list.
		const v = resolveDefaultProfile(input({ sections: ['partial'], candidates: [] }));
		expect(v).toMatchObject({ resolves: false, reason: 'no_default', needsDefault: false });
	});

	it('every resolving branch is silent, whatever else is in the file', () => {
		for (const v of [
			resolveDefaultProfile(
				input({ sections: [SETTINGS_SECTION, 'a'], settingsDefaultProfile: 'a', candidates: ['a'] })
			),
			resolveDefaultProfile(input({ sections: ['DEFAULT'], defaultSectionHasKeys: true, candidates: ['DEFAULT'] }))
		]) {
			expect(v.needsDefault).toBe(false);
			expect(defaultProfileProblem(v)).toBeNull();
		}
	});
});

describe('what the user is shown', () => {
	it('every failing reason that surfaces has copy, and it names the reason', () => {
		const dangling = resolveDefaultProfile(
			input({ sections: [SETTINGS_SECTION, 'a'], settingsDefaultProfile: 'x', candidates: ['a'] })
		);
		const reserved = resolveDefaultProfile(
			input({ sections: [SETTINGS_SECTION, 'a'], settingsDefaultProfile: SETTINGS_SECTION, candidates: ['a'] })
		);
		const none = resolveDefaultProfile(input({ sections: ['a'], candidates: ['a'] }));
		for (const v of [dangling, reserved, none]) {
			expect(v.needsDefault).toBe(true);
			expect(defaultProfileProblem(v)).toBeTruthy();
		}
		// Three distinct causes must read as three distinct sentences.
		expect(new Set([dangling, reserved, none].map((v) => defaultProfileProblem(v))).size).toBe(3);
	});

	it('the consequence says Cellar itself is unaffected', () => {
		// The notice is about the user's OWN code. Without this clause it reads as
		// "your connection is broken", which would be alarming and also false: Cellar
		// passes its profile explicitly and keeps working.
		expect(DEFAULT_PROFILE_CONSEQUENCE).toMatch(/unaffected/i);
		expect(DEFAULT_PROFILE_CONSEQUENCE).toMatch(/spark/i);
	});

	it('the shared consequence carries NO error string - only the per-reason line may', () => {
		// The three reasons produce different SDK outcomes: rule 4 reports missing
		// credentials, a resolved-but-unusable name raises from the resolver. A shared
		// sentence naming one of those would be false for the other two.
		expect(DEFAULT_PROFILE_CONSEQUENCE).not.toMatch(/cannot configure default credentials/i);
		const none = resolveDefaultProfile(input({ sections: ['a'], candidates: ['a'] }));
		expect(defaultProfileProblem(none)).toMatch(/cannot configure default credentials/i);
	});

	it('the command is the CLI’s own supported one, with the profile named', () => {
		expect(switchDefaultProfileCommand('my-profile')).toBe('databricks auth switch --profile my-profile');
	});
});

// ---------------------------------------------------------------------------
// Layer 2: the reader, over real files.
// ---------------------------------------------------------------------------

let dbx: typeof import('../../src/lib/server/databricks');
let dir: string;

/** Write a config file and point the module at it. Returns the verdict for it. */
function verdictFor(text: string) {
	const cfg = join(dir, `cfg-${Math.random().toString(36).slice(2)}.ini`);
	writeFileSync(cfg, text);
	process.env.DATABRICKS_CONFIG_FILE = cfg;
	return { cfg, verdict: dbx.readDefaultProfile() };
}

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), 'cellar-dbx-default-'));
	process.env.CELLAR_WORKSPACE = dir;
	process.env.DATABRICKS_CONFIG_FILE = join(dir, 'placeholder.ini');
	dbx = await import('../../src/lib/server/databricks');
});

describe('readDefaultProfile over a real ~/.databrickscfg', () => {
	it('the reported failing shape: one named profile, no default anywhere', () => {
		const { verdict } = verdictFor('[dbc-29a8e8d0-5a51]\nhost = https://x.cloud.databricks.com\ntoken = pat\n');
		expect(verdict).toMatchObject({ resolves: false, reason: 'no_default', needsDefault: true });
		expect(verdict.candidates).toEqual(['dbc-29a8e8d0-5a51']);
	});

	it('adding [__settings__] default_profile fixes it - the exact effect of `databricks auth switch`', () => {
		const { verdict } = verdictFor(
			'[dbc-29a8e8d0-5a51]\nhost = https://x.cloud.databricks.com\ntoken = pat\n\n[__settings__]\ndefault_profile = dbc-29a8e8d0-5a51\n'
		);
		expect(verdict).toMatchObject({ resolves: true, reason: 'default_profile', needsDefault: false });
	});

	it('[__settings__] survives the parse even though the profile picker drops it', () => {
		// The projection that feeds the picker filters host-less sections, and
		// [__settings__] has no host. A reader built on that projection would never see
		// `default_profile` at all and would report every configured machine as broken.
		const { cfg, verdict } = verdictFor(
			'[work]\nhost = https://x.cloud.databricks.com\ntoken = pat\n\n[__settings__]\ndefault_profile = work\n'
		);
		expect(verdict.resolves).toBe(true);
		process.env.DATABRICKS_CONFIG_FILE = cfg;
		expect(dbx.readProfiles().profiles.map((p) => p.name)).toEqual(['work']); // picker view unchanged
	});

	it('an empty [DEFAULT] header does not resolve, but one with any key does', () => {
		const empty = verdictFor('[DEFAULT]\n\n[work]\nhost = https://x.cloud.databricks.com\ntoken = pat\n').verdict;
		expect(empty).toMatchObject({ resolves: false, reason: 'no_default', needsDefault: true });

		const filled = verdictFor('[DEFAULT]\nhost = https://x.cloud.databricks.com\ntoken = pat\n').verdict;
		expect(filled).toMatchObject({ resolves: true, reason: 'default_section' });
	});

	it('a key with an EMPTY value still counts as a key for rule 3', () => {
		// configparser stores `token =` as a present key, so `defaults()` is truthy.
		// The picker's own `hasToken` reads the VALUE and says false; these are
		// different questions of the same line, and both must stay right.
		const { verdict } = verdictFor('[DEFAULT]\ntoken =\n');
		expect(verdict).toMatchObject({ resolves: true, reason: 'default_section' });
	});

	it('comments and blank lines do not create sections or keys', () => {
		const { verdict } = verdictFor(
			'# a comment\n; another\n\n[DEFAULT]\n# host = https://commented-out\n\n[work]\nhost = https://x.cloud.databricks.com\ntoken = pat\n'
		);
		expect(verdict).toMatchObject({ resolves: false, reason: 'no_default' });
	});

	it('a missing file is silent rather than a problem to fix', () => {
		process.env.DATABRICKS_CONFIG_FILE = join(dir, 'does-not-exist.ini');
		expect(dbx.readDefaultProfile()).toMatchObject({ reason: 'no_config_file', needsDefault: false });
	});

	it('a file that cannot be READ claims nothing - it reports as absent, not as broken', () => {
		// Nothing was observed, so nothing is asserted. `readProfiles` still surfaces
		// the read error on its own; this must not tell the user to fix a file we
		// never saw. Skipped as root, where the mode is not enforced.
		const cfg = join(dir, 'unreadable.ini');
		writeFileSync(cfg, '[work]\nhost = https://x.cloud.databricks.com\n');
		chmodSync(cfg, 0o000);
		process.env.DATABRICKS_CONFIG_FILE = cfg;
		let readable = true;
		try {
			readable = dbx.readProfiles().error === undefined;
		} finally {
			chmodSync(cfg, 0o600);
		}
		if (readable) return; // running as root: the chmod does not bite
		process.env.DATABRICKS_CONFIG_FILE = cfg;
		chmodSync(cfg, 0o000);
		try {
			expect(dbx.readDefaultProfile()).toMatchObject({ reason: 'no_config_file', needsDefault: false });
		} finally {
			chmodSync(cfg, 0o600);
		}
	});

	it('rides getStatus, from the SAME single read as the profile list', () => {
		const { verdict } = verdictFor('[work]\nhost = https://x.cloud.databricks.com\ntoken = pat\n');
		expect(verdict.needsDefault).toBe(true);
		return dbx.getStatus().then((s) => {
			expect(s.config.defaultProfile).toEqual(verdict);
			expect(s.config.profiles.map((p) => p.name)).toEqual(verdict.candidates);
		});
	});
});

// ---------------------------------------------------------------------------
// Layer 3: differential against the real SDK.
// ---------------------------------------------------------------------------

/**
 * The rule is a re-implementation of someone else's code. A unit test can only
 * prove it matches what THIS file believes; the SDK is the authority. So when a
 * `databricks-sdk` is importable, every case above is replayed against the SDK's
 * OWN resolution and the two verdicts must agree.
 *
 * It runs against `Config._resolve_profile` plus the membership check
 * `_known_file_config_loader` applies to its answer - i.e. precisely the code
 * `$lib/databricksDefaultProfile` transcribes. Coupling to a private is the POINT
 * here rather than a smell: if that function moves or changes shape, this test
 * fails loudly and someone re-reads it, which is the only way the transcription
 * can be kept honest.
 *
 * A whole `Config()` deliberately does NOT decide these cases, because it answers
 * a strictly larger question - resolve AND authenticate. A profile that resolves
 * but carries no usable credential raises the same `ValueError` as one that never
 * resolved, so reading a raise as "did not resolve" would make the differential
 * demand the detector claim something it explicitly refuses to claim. The
 * end-to-end `Config()` behaviour is asserted separately, for the one case where
 * the two questions coincide and the user-visible symptom lives.
 *
 * Nothing here touches the machine's real config or credential store: every
 * fixture is written into this suite's own temp dir, and `DATABRICKS_CONFIG_FILE`
 * points the subprocess at it.
 */
const sdkPython = (() => {
	for (const py of [process.env.CELLAR_PROJECT_VENV, join(process.cwd(), '.venv', 'bin', 'python3'), 'python3']) {
		if (!py) continue;
		const r = spawnSync(py, ['-c', 'import databricks.sdk.core'], { encoding: 'utf8' });
		if (r.status === 0) return py;
	}
	return null;
})();

describe.skipIf(!sdkPython)('differential: the rule agrees with the real databricks-sdk', () => {
	const CASES: Array<{ name: string; text: string }> = [
		{ name: 'named profile only (the reported failure)', text: '[work]\nhost = https://unreachable.invalid\ntoken = pat\n' },
		{
			name: 'default_profile set',
			text: '[work]\nhost = https://unreachable.invalid\ntoken = pat\n[__settings__]\ndefault_profile = work\n'
		},
		{ name: '[DEFAULT] with keys', text: '[DEFAULT]\nhost = https://unreachable.invalid\ntoken = pat\n' },
		{
			name: 'empty [DEFAULT] header',
			text: '[DEFAULT]\n\n[work]\nhost = https://unreachable.invalid\ntoken = pat\n'
		},
		{
			name: 'lowercase [default] is not the defaults section',
			text: '[default]\nhost = https://unreachable.invalid\ntoken = pat\n'
		},
		{
			name: 'dangling default_profile',
			text: '[work]\nhost = https://unreachable.invalid\ntoken = pat\n[__settings__]\ndefault_profile = gone\n'
		},
		{
			name: 'default_profile naming a host-less section',
			text: '[partial]\nnot_a_host = x\n[work]\nhost = https://unreachable.invalid\ntoken = pat\n[__settings__]\ndefault_profile = partial\n'
		}
	];

	/**
	 * `Config._resolve_profile` followed by the membership test its caller applies -
	 * a line-for-line replay of `_known_file_config_loader`'s use of it, and nothing
	 * more. No `Config()` is constructed, so no credential strategy runs and no
	 * request is made.
	 */
	const RESOLVE_PROBE = [
		'import configparser, json, os',
		'from databricks.sdk.core import Config',
		'ini = configparser.ConfigParser()',
		'ini.read(os.environ["DATABRICKS_CONFIG_FILE"])',
		'try:',
		'    profile, is_fallback = Config._resolve_profile(None, ini)',
		'except Exception as e:',
		'    print(json.dumps({"resolves": False, "why": "%s: %s" % (type(e).__name__, e)})); raise SystemExit(0)',
		'if profile is None:',
		'    print(json.dumps({"resolves": False, "why": "no default"})); raise SystemExit(0)',
		// The candidate set the SDK checks the resolved name against. DEFAULT is added
		// only when it carries keys - configparser keeps it out of `_sections` entirely.
		'known = {n: v for n, v in ini._sections.items()}',
		'known.pop("__settings__", None)',
		'if ini.defaults():',
		'    known["DEFAULT"] = ini.defaults()',
		'if profile not in known:',
		'    print(json.dumps({"resolves": False, "why": "no %s profile configured" % profile})); raise SystemExit(0)',
		'print(json.dumps({"resolves": True, "profile": profile}))'
	].join('\n');

	/** Run a probe against `cfg`, with the runner's own DATABRICKS_* vars stripped. */
	function ask(script: string, cfg: string): Record<string, unknown> {
		const run = spawnSync(sdkPython!, ['-c', script], {
			encoding: 'utf8',
			// Only the FILE may decide: a DATABRICKS_* var inherited from the runner would
			// short-circuit `_known_file_config_loader` outright. That is also why the
			// detector consults no env vars - inside a Cellar kernel there are none left
			// to consult, `CONNECT_CODE` having scrubbed them before the session build.
			env: Object.fromEntries([
				...Object.entries(process.env).filter(([k]) => !k.startsWith('DATABRICKS_')),
				['DATABRICKS_CONFIG_FILE', cfg]
			]) as NodeJS.ProcessEnv
		});
		expect(run.status, run.stderr).toBe(0);
		return JSON.parse(run.stdout.trim().split('\n').pop()!);
	}

	for (const c of CASES) {
		it(`${c.name}`, () => {
			const cfg = join(dir, `sdk-${c.name.replace(/\W+/g, '-')}.ini`);
			writeFileSync(cfg, c.text);
			process.env.DATABRICKS_CONFIG_FILE = cfg;
			const ours = dbx.readDefaultProfile();
			const sdk = ask(RESOLVE_PROBE, cfg);
			expect(sdk.resolves, `SDK said ${JSON.stringify(sdk)}; we said ${JSON.stringify(ours)}`).toBe(ours.resolves);
			if (ours.resolves) expect(sdk.profile).toBe(ours.profile);
		});
	}

	it('end to end: the flagged shape really does raise the error the user reported', () => {
		// The one case where "does it resolve" and "does it authenticate" coincide, so a
		// whole Config() can be read without interpretation - and the case the notice is
		// FOR. Anything less than the real error string would leave the detector pointed
		// at a symptom nobody has seen.
		//
		// The two timeout knobs are the only departure from a literally bare Config():
		// on a config that resolves, the SDK attempts best-effort host-metadata discovery
		// against these fixtures' deliberately unreachable host, and its default retry
		// budget is 300 SECONDS. They bound the network only - resolution is decided from
		// the file before any request. (`databricks.ts`'s `logout` op cuts the same two
		// knobs for the same reason.)
		const probe = [
			'import json',
			'from databricks.sdk.core import Config',
			'try:',
			'    c = Config(retry_timeout_seconds=1, http_timeout_seconds=2)',
			'    print(json.dumps({"ok": True, "profile": c.profile}))',
			'except Exception as e:',
			'    print(json.dumps({"ok": False, "error": "%s: %s" % (type(e).__name__, e)}))'
		].join('\n');

		const broken = join(dir, 'e2e-broken.ini');
		writeFileSync(broken, '[work]\nhost = https://unreachable.invalid\ntoken = pat\n');
		process.env.DATABRICKS_CONFIG_FILE = broken;
		expect(dbx.readDefaultProfile().needsDefault).toBe(true);
		const before = ask(probe, broken);
		expect(before.ok).toBe(false);
		expect(String(before.error)).toContain('cannot configure default credentials');

		// ... and that the remedy Cellar hands the user is the thing that fixes it.
		// `databricks auth switch --profile work` writes exactly this stanza.
		const fixed = join(dir, 'e2e-fixed.ini');
		writeFileSync(
			fixed,
			'[work]\nhost = https://unreachable.invalid\ntoken = pat\n\n[__settings__]\ndefault_profile = work\n'
		);
		process.env.DATABRICKS_CONFIG_FILE = fixed;
		expect(dbx.readDefaultProfile().needsDefault).toBe(false);
		expect(ask(probe, fixed)).toMatchObject({ ok: true, profile: 'work' });
	});
});
