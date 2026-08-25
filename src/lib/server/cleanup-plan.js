/**
 * Cellar — what `cellar cleanup` is allowed to stop.
 *
 * This module exists because `cleanup --all` was a data-loss footgun: it stopped
 * EVERY live instance in EVERY workspace, and its confirmation was satisfied by a
 * non-TTY stdin — so `cellar cleanup --all`, run by any script or agent with no
 * flags at all, silently killed a live notebook session (kernel, namespace, hours
 * of work) in a folder the caller had never opened. Observed, not theoretical.
 *
 * ---- Why this change is larger than the bug that was reported --------------
 *
 * That eviction turned out to be ONE SYMPTOM of a broader pattern in this
 * command: a value the user typed is silently discarded or silently reinterpreted,
 * so the tool operates on a different workspace from the one the user believes
 * they named — and under `-y` it proceeds without ever saying so. Five further
 * instances were found and closed while fixing the reported one:
 *
 *   - an unrecognised POSITIONAL was silently dropped, so `cellar cleanup <path>
 *     --all` reaped the caller's own cwd instead of the path they named;
 *   - a REPEATED `-w` was silently first-wins, so a corrected typo left on the
 *     line stopped the first directory and reported the second as "elsewhere";
 *   - an EMPTY `-w` value fell through to the caller's cwd, so an unset `$WS` in
 *     a wrapper script stopped whatever folder the script was sitting in;
 *   - a `-w` NAMING NOTHING (a typo, or a regular file) made `--all` a silent
 *     no-op while the workspace actually meant kept running;
 *   - and running `--all` from a SUBDIRECTORY of your own project misfiled your
 *     OWN live instance as somebody else's, then offered the cross-workspace flag
 *     as the remedy — training the user to reach for the wide hammer to clean
 *     their own project, when the wide hammer is what destroyed a live session.
 *     A safety mechanism whose failure mode is teaching people to bypass it is
 *     worse than none.
 *
 * The first four are refused up front (see `parseCleanupArgs` in bin/cellar.js);
 * the last is fixed here, by `resolveCallerWorkspace`. The policy for this whole
 * command is now REFUSE-DON'T-GUESS: anything unexpected stops it, before
 * anything is pruned or signalled.
 *
 * The policy is a pure decision so it can be unit-tested without processes: the
 * launcher gathers facts (registry entries + a `ps` scan), this decides what may
 * die, and only then does anything get signalled.
 *
 * ---- The rule ------------------------------------------------------------
 *
 * The ONE honest signal available for "is this mine to stop?" is the WORKSPACE an
 * instance serves, compared against the workspace the command is being run in.
 * Everything else (age, port, pid) says nothing about ownership. So scope is that
 * axis, in three tiers:
 *
 *   'orphans'    (default)          dead + orphaned only. Never a live instance.
 *   'workspace'  (--all)            + live instances serving THIS workspace.
 *   'everywhere' (--all-workspaces) + live instances serving ANY workspace.
 *
 * An ORPHAN — a registry entry whose launcher is gone but whose app is still
 * listening, or an untracked app process reparented to init — is nobody's live
 * session by definition, so it is reaped at every tier including the default.
 * That is what keeps the tidy case (the reason people reach for `cleanup` at all)
 * a one-word command, and it is why narrowing `--all` costs an ordinary user
 * nothing: their leftovers were already covered.
 *
 * `--all` was NARROWED rather than removed, deliberately. `cellar cleanup --all`
 * is what someone types meaning "clear up after me", and that is now exactly what
 * it does. Turning it into a hard error would have taught every reader the
 * cross-workspace spelling instead — the strictly worse outcome, since the whole
 * point is that the dangerous form should be rare and deliberate.
 *
 * ---- Comparing workspaces ------------------------------------------------
 *
 * `workspaceKey` realpaths BOTH sides before comparing. That is an IDENTITY test
 * ("are these the same directory"), not a prefix/containment test, so it is the
 * safe use of realpath — and it is required, because the registry records the
 * path as it was resolved at launch while cleanup resolves the caller's cwd, and
 * on macOS every `/tmp` and `/var/folders` workspace has two spellings.
 *
 * CONTAINMENT enters at exactly ONE point and it is a different question:
 * `resolveCallerWorkspace` answers "which workspace am I standing in", by walking
 * UP from the caller's directory to the deepest registered workspace containing
 * it. The per-entry comparison in `planCleanup` stays an IDENTITY test against
 * that resolved answer — so containment can widen which directory counts as
 * "mine", and can never widen which ENTRIES a given directory reaches.
 *
 * A comparison that FAILS (unreadable path, a workspace since deleted) falls back
 * to the lexical string. That fails in the safe direction by construction: two
 * genuinely different directories can never collide on a lexical path, so the
 * only possible error is reading one directory as two — which under-reaches
 * (`--all` declines to stop an instance that was in fact yours) and can never
 * over-reach into a stranger's session.
 *
 * ---- Untracked processes -------------------------------------------------
 *
 * `scanUntrackedCellarProcesses` reports pid/ppid/command only; the command names
 * the cellar CHECKOUT the app was launched from, never the WORKSPACE it serves.
 * So an untracked process with a LIVE parent cannot be attributed to a workspace
 * at all, and an unattributable live process is treated as somebody else's:
 * reachable only at 'everywhere'. This is the tier that saved a real session
 * during this fix's own reproduction — with the registry isolated (a temp `HOME`,
 * i.e. every CI and agent run), a user's real instance is not in the registry we
 * can see, so it arrives here as exactly this shape.
 *
 * Untracked processes whose parent is init (ppid 1) are the orphan case and stay
 * in the default tier: no launcher owns them, so nothing is being taken from
 * anyone.
 *
 * Node builtins only, so `bin/cellar.js` can import it (see `package.json` files).
 */
import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

/** Scope tiers, widest last. */
export const CLEANUP_SCOPES = /** @type {const} */ (['orphans', 'workspace', 'everywhere']);

/**
 * The phrase that authorises stopping live instances in OTHER workspaces.
 *
 * It is a phrase rather than a yes/no precisely so `--yes`/`-y`/`CI=1`/a piped
 * stdin cannot supply it: those all mean "don't ask me about the routine thing",
 * and this is not the routine thing. Typed at the prompt, or passed as
 * `--confirm=<phrase>` for a non-interactive caller that genuinely means it.
 */
export const CONFIRM_PHRASE = 'stop-all-workspaces';

/**
 * Canonical identity for a workspace path: realpath when it resolves, else the
 * lexically-resolved path. Trailing separators are stripped so `/a/b` and `/a/b/`
 * are one directory. Never throws.
 *
 * @param {string | undefined | null} p
 * @returns {string} the key, or '' when there is no path to speak of
 */
export function workspaceKey(p) {
	if (!p || typeof p !== 'string') return '';
	// Upgraded in place rather than recomputed in a fallback, so no failing call is
	// ever repeated: `resolve` consults `process.cwd()` for a RELATIVE path and
	// THROWS once the working directory has been removed — the very case this
	// module exists to survive — so a catch that re-ran it threw straight back out
	// and falsified the never-throws contract above. `out` keeps the furthest it
	// got: the realpath, else the resolved path, else the raw string. The last of
	// those can only under-reach (two spellings of one directory read as two),
	// which is the safe direction documented above.
	let out = p;
	try {
		out = resolve(p);
		out = realpathSync(out);
	} catch {
		// keep whatever `out` has already reached
	}
	// Keep a bare root ('/'), strip a trailing separator anywhere else.
	while (out.length > 1 && out.endsWith(sep)) out = out.slice(0, -1);
	return out;
}

/**
 * Is `dir` inside `ws` (or the same directory)? Boundary-safe: a sibling that
 * merely shares a name prefix (`/tmp/projX` vs `/tmp/proj`) is NOT inside.
 *
 * Both sides must already be canonical keys (`workspaceKey`). Realpathing one
 * side of a prefix test and not the other is the trap this repo's worktree-roots
 * guidance warns about: the two spellings of a `/tmp` path would never share a
 * prefix, so containment would silently never fire.
 *
 * @param {string} dir
 * @param {string} ws
 */
function isInside(dir, ws) {
	return ws !== '' && (dir === ws || dir.startsWith(ws + sep));
}

/**
 * Which workspace is the caller standing in?
 *
 * Running `cellar cleanup --all` from `~/proj/notebooks` rather than `~/proj` is
 * ordinary, and an identity-only answer misfiled the caller's OWN live instance
 * as somebody else's — then pointed them at `--all-workspaces`, the phrase-gated
 * cross-workspace flag, to clean their own project. Teaching the wide hammer for
 * a routine task is the worst possible failure mode for this feature, since the
 * wide hammer is what destroyed a live session.
 *
 * So the caller's workspace is the DEEPEST registered workspace that IS the
 * caller's directory or an ANCESTOR of it, else the caller's directory unchanged.
 * Deepest-wins is what keeps a nested project from over-reaching: standing in
 * `/proj/a/b` with both `/proj` and `/proj/a` registered resolves to `/proj/a`,
 * so `/proj`'s instance stays elsewhere. It walks UP only, never down — a
 * workspace nested INSIDE the caller's directory is a different project, not
 * theirs to stop.
 *
 * @param {string} callerKey canonical key of the directory the command runs in
 * @param {Iterable<string>} workspaceKeys canonical keys of registered workspaces
 * @returns {string} the canonical key of the workspace the caller is in
 */
export function resolveCallerWorkspace(callerKey, workspaceKeys = []) {
	if (!callerKey) return '';
	let best = '';
	for (const ws of workspaceKeys) {
		if (isInside(callerKey, ws) && ws.length > best.length) best = ws;
	}
	return best || callerKey;
}

/**
 * Is this annotated registry entry an ORPHAN — launcher gone, but something of
 * it still running or still listening? Such an entry belongs to no live session.
 * @param {any} e
 */
function isOrphan(e) {
	return !e.launcherAlive && (e.appAlive || e.appResponds);
}

/**
 * Decide what a cleanup run may stop.
 *
 * Pure: takes already-gathered facts and returns a plan. `entries` are annotated
 * registry entries (`annotateInstance`); `untracked` are `{pid, ppid, command}`
 * rows from the `ps` scan. `workspace` is the key (see `workspaceKey`) of the
 * folder the command is running in.
 *
 * Nothing is signalled here. The caller prints the plan, confirms it, and only
 * then acts — so "see what would die before it dies" is structural rather than a
 * courtesy the caller could forget.
 *
 * @param {{
 *   entries?: any[],
 *   untracked?: {pid:number, ppid:number, command:string}[],
 *   workspace?: string,
 *   scope?: 'orphans'|'workspace'|'everywhere'
 * }} input
 * @returns {{
 *   reap: any[],
 *   killPids: number[],
 *   orphans: any[],
 *   liveHere: any[],
 *   liveElsewhere: any[],
 *   untrackedOrphans: {pid:number, ppid:number, command:string}[],
 *   untrackedLive: {pid:number, ppid:number, command:string}[],
 *   skippedHere: any[],
 *   skippedElsewhere: any[],
 *   skippedUntracked: {pid:number, ppid:number, command:string}[],
 *   crossWorkspace: boolean
 * }}
 */
export function planCleanup({ entries = [], untracked = [], workspace = '', scope = 'orphans' } = {}) {
	const tier = CLEANUP_SCOPES.includes(scope) ? scope : 'orphans';

	const orphans = entries.filter(isOrphan);
	const live = entries.filter((e) => e.launcherAlive);
	// An entry with no workspace recorded can never be shown to be this one, so it
	// counts as elsewhere — the safe direction (`workspaceKey('')` is '', and the
	// caller's key is a real path, so they cannot collide).
	const liveHere = live.filter((e) => workspaceKey(e.workspace) === workspace && workspace !== '');
	const liveElsewhere = live.filter((e) => !liveHere.includes(e));

	const untrackedOrphans = untracked.filter((u) => u.ppid === 1);
	const untrackedLive = untracked.filter((u) => u.ppid !== 1);

	const reap = [...orphans];
	if (tier === 'workspace' || tier === 'everywhere') reap.push(...liveHere);
	if (tier === 'everywhere') reap.push(...liveElsewhere);

	const killPids = untrackedOrphans.map((u) => u.pid);
	if (tier === 'everywhere') killPids.push(...untrackedLive.map((u) => u.pid));

	// What this plan deliberately leaves running, split by WHOSE it is: the
	// remedy differs, so a single bucket would print the wrong advice for one of
	// them (pointing at --all-workspaces for an instance in the caller's own
	// folder teaches the dangerous spelling to solve a problem `--all` solves).
	const skippedHere = tier === 'orphans' ? liveHere : [];
	const skippedElsewhere = tier === 'everywhere' ? [] : liveElsewhere;
	const skippedUntracked = tier === 'everywhere' ? [] : untrackedLive;

	return {
		reap,
		killPids,
		orphans,
		liveHere,
		liveElsewhere,
		untrackedOrphans,
		untrackedLive,
		skippedHere,
		skippedElsewhere,
		skippedUntracked,
		// True when this plan reaches a live process the caller cannot claim as its
		// own workspace's. This — not the flag name — is what gates the phrase.
		crossWorkspace:
			tier === 'everywhere' && (liveElsewhere.length > 0 || untrackedLive.length > 0)
	};
}
