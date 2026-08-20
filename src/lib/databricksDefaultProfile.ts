/**
 * "Would a bare `Config()` in this kernel find any Databricks credentials at all?"
 *
 * The ONE rule for it, plus the copy and the exact command that fixes it, shared
 * by the server (`databricks.ts`, which reads `~/.databrickscfg`) and the browser
 * (`Databricks.svelte`, which renders the notice) so the two can never disagree
 * about whether a machine is fine. Browser-safe by construction: no imports, pure
 * data in, pure data out.
 *
 * ## Why this exists
 *
 * Cellar connects with an EXPLICIT profile - `Config(profile=…)` - and binds
 * `spark`/`w` as kernel globals. That identity lives nowhere a SECOND resolution
 * can look: not in `os.environ`, not in any process-wide SDK default. So a user
 * library that resolves credentials for itself starts from zero:
 *
 *     from databricks.sdk.runtime import spark   # module body runs RemoteDbUtils()
 *     ws = WorkspaceClient()                     # bare, no config
 *
 * `databricks/sdk/runtime/__init__.py` builds `RemoteDbUtils()` at module scope
 * and deliberately does NOT catch its failure ("we want to propagate the error …
 * because this is a core functionality of the sdk"), so on a machine where default
 * resolution finds nothing the import dies with
 *
 *     ValueError: default auth: cannot configure default credentials
 *
 * even though Cellar's own `spark` works perfectly in the same kernel.
 *
 * That failure is a property of the MACHINE, not of Cellar: it reproduces with no
 * Cellar involved. But Cellar is where the user meets it, Cellar already parses
 * `~/.databrickscfg` for its profile picker, and the whole rule is local - so
 * Cellar can see it coming and say so, for free, with no network call.
 *
 * ## The rule, verbatim from the SDK
 *
 * `databricks/sdk/config.py` `_resolve_profile` (0.122.0) is the entire thing:
 *
 *     1. explicit profile argument      -> use it
 *     2. [__settings__].default_profile -> use it
 *     3. [DEFAULT] has keys             -> "DEFAULT"
 *     4. otherwise                      -> None  ->  "cannot configure default credentials"
 *
 * Branch 1 is out of this detector's domain BY CONSTRUCTION - it is what Cellar's
 * own connect does, and it is why Cellar works where the user's library does not.
 * This models the bare case, branches 2-4, plus the two shapes where a resolved
 * name then turns out to be unusable and `Config()` raises rather than returning
 * nothing (`_resolve_profile`'s reserved-name guard, and `config.py`'s
 * "has no <name> profile configured" raise for a non-fallback miss).
 *
 * ## What it deliberately does NOT claim
 *
 * Only that a profile is RESOLVED, never that it AUTHENTICATES. A `[DEFAULT]`
 * carrying keys but no usable credential resolves fine and then fails later for a
 * different reason. Proving that needs the network, a keychain prompt, or both -
 * so this stays a local file read and reports only what a local file read can
 * honestly answer. Over-claiming here would nag a user whose machine is fine,
 * which is the one thing this must not do.
 *
 * Environment variables are deliberately NOT consulted either, and the reason is a
 * fact about Cellar that holds only INSIDE A CONNECTED KERNEL: `CONNECT_CODE`
 * scrubs every `DATABRICKS_*` var from `os.environ` before it builds the session
 * (databricks-connect refuses to build a REMOTE session while it believes it is on
 * a runtime), so once a connect has run, the config file really is the only thing
 * left that can answer and a `DATABRICKS_CONFIG_PROFILE` exported in the user's
 * shell does not survive to be a mitigation.
 *
 * **That is why the notice is gated on a kernel that has really run `CONNECT_CODE`**
 * - see `defaultProfileNoticeApplies` below, which owns that rule so the component
 * holds no copy of it. Before a connect the scrub has not run, so a shell
 * `DATABRICKS_HOST`+`DATABRICKS_TOKEN` is still present and short-circuits
 * `_known_file_config_loader` outright - a bare `Config()` resolves without reading
 * this file at all, and the notice would be a false nag, the one thing it must not
 * be. Gating is the right half of that fix and consulting the SERVER's own env is
 * the wrong one: after connect the scrub has removed those vars from the KERNEL, so
 * an env-aware server would fall silent exactly when the warning becomes true.
 */

/** The reserved bookkeeping section the Databricks CLI writes `default_profile` into. */
export const SETTINGS_SECTION = '__settings__';

/**
 * configparser's defaults section. Compared CASE-SENSITIVELY, exactly as
 * configparser does (`DEFAULTSECT = "DEFAULT"`): a `[default]` section is an
 * ordinary profile named "default" and does NOT satisfy rule 3.
 */
export const DEFAULT_SECTION = 'DEFAULT';

/** Why default resolution ends where it does. The first two mean it succeeded. */
export type DefaultProfileReason =
	/** Rule 2: `[__settings__] default_profile` named it. */
	| 'default_profile'
	/** Rule 3: `[DEFAULT]` carries keys, so the SDK falls back to it. */
	| 'default_section'
	/** No `~/.databrickscfg` at all - nothing to offer, nothing to fix here. */
	| 'no_config_file'
	/** Rule 4: the file has neither a `default_profile` nor a non-empty `[DEFAULT]`. */
	| 'no_default'
	/** `default_profile` names a profile the file does not contain - `Config()` raises. */
	| 'dangling_default_profile'
	/** `default_profile = __settings__`, the reserved name - `Config()` raises. */
	| 'reserved_default_profile';

/** What the detector is given: the config file, reduced to the facts the rule reads. */
export interface DefaultProfileInput {
	/** Did `~/.databrickscfg` exist and parse? A read error counts as not existing. */
	exists: boolean;
	/**
	 * Every section header in the file, in order, `DEFAULT` and `__settings__`
	 * included. Needed whole because a `default_profile` may legally name a
	 * section that declares no `host`, which the picker's own list drops.
	 */
	sections: string[];
	/** `[__settings__] default_profile` as written, or null when the key is absent. */
	settingsDefaultProfile: string | null;
	/** Does `[DEFAULT]` declare at least one `key = value`? (configparser's `defaults()`) */
	defaultSectionHasKeys: boolean;
	/** Profiles Cellar could offer as the default: host-declaring, SDK-nameable. */
	candidates: string[];
}

/** The verdict. One object, read identically by the server and the sidebar. */
export interface DefaultProfileVerdict {
	/** Would a bare `Config()` load a profile from this file? */
	resolves: boolean;
	/** How it resolved, or why it did not. */
	reason: DefaultProfileReason;
	/** The profile a bare `Config()` would load. Null unless `resolves`. */
	profile: string | null;
	/** Profiles that can be offered as the default. Empty ⇒ there is nothing to offer. */
	candidates: string[];
	/**
	 * Show the notice? Resolution failing is NOT enough on its own: a machine with
	 * no profiles has nothing to choose between, and telling it to pick one would be
	 * noise pointing at an empty list. The notice appears exactly when there is a
	 * real choice to make.
	 */
	needsDefault: boolean;
}

/**
 * Apply `_resolve_profile` to a parsed `~/.databrickscfg`.
 *
 * Pure and injectable on purpose: the whole rule is decidable from the file, so it
 * must be exercisable without a live connection, a workspace, or a kernel - there
 * was no test coverage at all in this area before it.
 */
export function resolveDefaultProfile(input: DefaultProfileInput): DefaultProfileVerdict {
	const candidates = [...input.candidates];
	const fail = (reason: DefaultProfileReason): DefaultProfileVerdict => ({
		resolves: false,
		reason,
		profile: null,
		candidates,
		needsDefault: candidates.length > 0
	});
	const ok = (reason: 'default_profile' | 'default_section', profile: string): DefaultProfileVerdict => ({
		resolves: true,
		reason,
		profile,
		candidates,
		needsDefault: false
	});

	if (!input.exists) return { ...fail('no_config_file'), needsDefault: false };

	// The set a resolved name is checked against, mirroring `config.py` exactly:
	// every section EXCEPT the reserved one, plus `DEFAULT` only when it carries
	// keys. `DEFAULT` is excluded first because configparser keeps it in `_defaults`,
	// never in `_sections` - so an empty `[DEFAULT]` is not a profile that exists.
	const known = new Set(
		input.sections.filter((s) => s !== SETTINGS_SECTION && s !== DEFAULT_SECTION)
	);
	if (input.defaultSectionHasKeys) known.add(DEFAULT_SECTION);

	// Rule 2. The SDK trims, and treats a blank value as absent.
	const named = (input.settingsDefaultProfile ?? '').trim();
	if (named) {
		if (named === SETTINGS_SECTION) return fail('reserved_default_profile');
		// Named but missing: `is_fallback` is false, so the SDK RAISES rather than
		// falling through to `[DEFAULT]`. A broken pointer, not an absent one.
		if (!known.has(named)) return fail('dangling_default_profile');
		return ok('default_profile', named);
	}

	// Rule 3. Keys, not merely the header: an empty `[DEFAULT]` leaves
	// `ini_file.defaults()` falsy and the SDK falls through to rule 4.
	if (input.defaultSectionHasKeys) return ok('default_section', DEFAULT_SECTION);

	// Rule 4.
	return fail('no_default');
}

/**
 * The connection facts the notice rule reads. A subset of the panel's own
 * `DbxConnection`, so the component passes what it already has.
 */
export interface DefaultProfileConnection {
	/** A live Spark Connect session in this kernel. */
	connected?: boolean;
	/**
	 * The session expired server-side (idle timeout / cluster GC / a closed client).
	 * Reported as `connected:false` with a `lost` cluster.
	 */
	expired?: boolean;
	/**
	 * The session ended when the kernel restarted. Declared, and deliberately NOT
	 * read: a restart gives a FRESH process which inherits the shell's `DATABRICKS_*`
	 * again, so the file is no longer the whole answer. Naming it here is what keeps
	 * that boundary visible at the rule rather than only in prose.
	 */
	lost?: { clusterName?: string; profile?: string } | null;
	/** A restart is in flight. Not read, for the same reason as `lost`. */
	restarting?: boolean;
}

/**
 * Should the "no default profile" notice be shown for this verdict, in a notebook
 * whose connection looks like this?
 *
 * THE RULE, and it lives here rather than in the component on purpose: it is a
 * decision, not a rendering, and the only suite this repo's CI and its gate run is
 * the unit one - so a rule kept as an expression inside `Databricks.svelte` could be
 * deleted and merge green, taking the false nag below with it. `Databricks.svelte`
 * calls this and holds no copy of it; `tests/e2e/databricks-default-profile.spec.ts`
 * proves the panel really renders what it answers.
 *
 * Two halves:
 *
 *   - `needsDefault` - the file's own verdict, already false both when resolution
 *     succeeds and when there is no profile to offer as a default, so a machine that
 *     is fine and one with nothing to choose between are silent by construction.
 *   - has this KERNEL PROCESS run `CONNECT_CODE`? Load-bearing, not caution: the
 *     verdict reads the config FILE alone, which is the whole truth only once that
 *     scrub has taken every `DATABRICKS_*` var out of the kernel. Before a connect a
 *     shell `DATABRICKS_HOST`+`DATABRICKS_TOKEN` short-circuits the SDK's file loader
 *     outright, so a bare `Config()` resolves without reading the file at all and the
 *     notice would be a false nag - the one thing this feature must never be.
 *
 * `expired` counts and `lost`/`restarting` does NOT, which is the exact boundary
 * rather than an approximation. The server only reaches its expiry branch AFTER the
 * session was live (`liveConnection` returns on `!status.connected` above it), so an
 * expired session is provably the SAME process that ran the scrub - and it is where
 * the user is most likely troubleshooting, their own `WorkspaceClient()` failing
 * while the card explaining it went missing. A lost/restarting session is the
 * opposite: a kernel restart gives a FRESH process which inherits the shell's
 * `DATABRICKS_*` again, so the premise does not hold and the notice stays silent.
 *
 * `held` is the third input and it is a LAYOUT fact rather than a new premise: the
 * Databricks panel is HOLDING its connected view through a transition it expects (a
 * cluster switch, a runtime-toggle restart) - `holdsSessionDetail` in
 * [[databricksPanelState]], which already applies the notebook-ownership question, so
 * another notebook's transition can never reach here. Mid-restart the payload drops
 * BOTH halves above, so read without it this card unmounted for the length of the
 * restart and sprang back afterwards, moving everything below it in the sidebar - the
 * jump the flicker fix exists to remove. It cannot make the notice a false nag: the
 * connected view is only ever held over a session that was really live moments ago,
 * so the reading it holds is one of the two halves above, decided against that
 * session; the moment the transition settles the verdict is taken afresh, and a FIRST
 * connect holds nothing at all. Which profile the machine defaults to is a property of
 * `~/.databrickscfg`, and neither a switch nor a restart writes it.
 */
export function defaultProfileNoticeApplies(
	verdict: DefaultProfileVerdict | null | undefined,
	connection: DefaultProfileConnection | null | undefined,
	held = false
): boolean {
	if (verdict?.needsDefault !== true) return false;
	return !!connection?.connected || connection?.expired === true || held;
}

/**
 * The command's two fixed halves. Split for the same reason `databricksReauth`
 * splits its own: the sidebar renders this in a ~200px box where it MUST wrap, and
 * a browser wraps happily after a hyphen - turning `--profile` into `-` / `-profile`,
 * a command a reader would mistype. The renderer keeps the flag in a no-wrap span,
 * and building the copied string from these same constants is what stops what is
 * SHOWN and what is COPIED from ever drifting apart.
 */
export const SWITCH_COMMAND_HEAD = 'databricks auth switch';
export const SWITCH_PROFILE_FLAG = '--profile';

/**
 * The exact command that makes `profile` the machine's default.
 *
 * `databricks auth switch` is the CLI's own first-class command for this: it writes
 * `default_profile` into the `[__settings__]` section of `~/.databrickscfg`. Cellar
 * shows it rather than running it, for three reasons that all point the same way:
 *
 *   - **Cellar never shells out to the `databricks` CLI.** That is a standing rule
 *     of this integration, not a preference - auth is the SDK's profile auth and
 *     nothing else - and the CLI need not even be installed for Cellar to work.
 *   - **Cellar must not write `~/.databrickscfg`.** It is the user's credential
 *     config, shared with every other Databricks tool on the machine.
 *   - **Which profile is the default is the user's call.** Databricks' own guidance
 *     is explicit that a tool must never pick one for them; this presents the
 *     options and produces the command for whichever they choose.
 *
 * The same reasoning, and the same shape, as the `databricks auth login` remedy in
 * [[databricksReauth]].
 */
export function switchDefaultProfileCommand(profile: string): string {
	return `${SWITCH_COMMAND_HEAD} ${SWITCH_PROFILE_FLAG} ${profile}`;
}

/**
 * What the user is told, in one sentence, for the reason actually detected.
 *
 * Says only what was OBSERVED - a file read, nothing more - and never that Cellar
 * is broken or that the connection is at risk, because neither is true: Cellar
 * passes its profile explicitly and is unaffected. Only a resolution failure has
 * copy; the resolving reasons return null, since a machine that is fine is told
 * nothing at all.
 */
export function defaultProfileProblem(v: DefaultProfileVerdict): string | null {
	switch (v.reason) {
		// Each names the SDK's ACTUAL outcome, which differs: rule 4 falls through to
		// no configuration at all and reports it as missing credentials, while a
		// resolved-but-unusable name raises from the resolver itself. Stating one
		// error string for all three would put a message in front of the user that
		// two of them never produce.
		case 'no_default':
			return 'No profile here is marked as the default, so resolving credentials fails with “cannot configure default credentials”.';
		case 'dangling_default_profile':
			return 'The default profile named here is not defined in this file, so resolving credentials raises an error.';
		case 'reserved_default_profile':
			return `The default profile is set to “${SETTINGS_SECTION}”, a reserved name the SDK refuses, so resolving credentials raises an error.`;
		default:
			return null;
	}
}

/**
 * Who this affects, stated once - shared by every reason, so it carries no error
 * string of its own (see `defaultProfileProblem`). Kept as a constant rather than
 * inlined in the component so a test can pin it and the two halves cannot reword
 * independently.
 *
 * Deliberately concrete about WHO is affected - library code that resolves for
 * itself - and about who is not: Cellar's own `spark`/`w` pass a profile
 * explicitly and keep working either way. Without that second half the notice
 * reads as "your connection is broken", which would be alarming AND wrong.
 */
export const DEFAULT_PROFILE_CONSEQUENCE =
	'It affects notebook code that resolves credentials itself — a bare WorkspaceClient(), or importing databricks.sdk.runtime. Cellar’s own spark and w are unaffected.';

/** The instruction above the command list. */
export const DEFAULT_PROFILE_REMEDY = 'Choose a profile and run its command in a terminal:';
