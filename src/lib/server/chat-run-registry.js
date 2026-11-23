/**
 * Cellar - the OUT-OF-PROCESS record of live chat process groups, and the reaper
 * that finds the ones an app left behind.
 *
 * A chat child is spawned `detached`, so it leads a process group (and a
 * session) of its own - that is what lets Stop reach everything the CLI started
 * (see `signalRunTree` in `chat/claude-cli.ts`). The cost is that the tree is no
 * longer in any group the app's own death reaches. Every in-process route that
 * stops it is a HANDLER (`stopChatRunsOnShutdown`, `parent-watch`), so an app
 * that leaves WITHOUT running one - an uncaught exception, an OOM kill, a
 * SIGKILL, which `killPid` escalates to after a 4s grace - leaves the tree
 * running in a session nothing will ever signal. The in-process registry
 * (`chat/active.ts`) dies with the app, so nothing could even FIND it.
 *
 * So each chat process group is also written to disk the moment it exists, the
 * way `instances.js` records instances: one JSON file per run under
 * `~/.cellar/chat-runs/`, in $HOME so it survives the workspace being removed.
 * A later launch and `cellar cleanup` read it back and reap what is orphaned.
 *
 * ## What may be killed - the whole safety argument
 *
 * A record is a pgid plus two IDENTITIES, both checked with the instance
 * registry's own `verifyPidIdentity` (never a second identity rule):
 *
 *  1. The OWNER - the app process that spawned the run. While it is provably
 *     alive the run is somebody's LIVE chat cell and is never touched, by any
 *     sweep, at any scope. Only an owner that is provably GONE (dead, or its pid
 *     now held by a process with a different start time) makes a record an
 *     orphan. An owner we cannot verify keeps the record and signals nothing.
 *
 *  2. The LEADER - the chat child itself, whose pid IS the group id. The group
 *     is signalled ONLY while the leader is provably the process we recorded
 *     (same pid, same start time). That is what makes a recycled pid harmless:
 *     once our leader is gone the OS may hand its pid - and with it the group
 *     id - to an unrelated process that makes itself a group leader, and
 *     `kill(-pgid)` would then take down that unrelated tree. A reused pid
 *     necessarily started later than the one we recorded, so its start time
 *     cannot match, and the record is pruned without a signal.
 *
 * The SIGKILL escalation re-asks question 2 rather than trusting the answer it
 * got before the SIGTERM, for the same reason.
 *
 * ## Stated residual
 *
 * A descendant that OUTLIVES its leader is not reached: with the leader gone
 * there is no positive match on anything of ours, and a group id alone is not
 * one. That is the same line `signalRunTree` already draws in-process (once the
 * leader is reaped it signals nothing). It is narrow for a chat run in
 * particular: a chat session holds no shell tool, so its descendants are the
 * CLI's own short-lived helpers, and the orphan that matters - the CLI still
 * running its turn on the user's quota - is the leader.
 *
 * ## Lifetime of a record
 *
 * Written right after `spawn` (one ~2ms `ps` for the leader's start time, the
 * precedent being the launcher's own `processStartTime(app.pid)`), and removed
 * when the app sees the LEADER exit - not when the run settles: a stop settles
 * on its verdict before the tree is gone, and a record removed then would leave
 * a SIGTERM-ignoring leader unrecorded exactly when the app is going away. A
 * record left behind by a clean shutdown is harmless: the next sweep finds its
 * leader dead and prunes it without a signal.
 *
 * Under `CELLAR_ISOLATED` nothing is recorded and nothing is swept: that mode
 * exists so a launch never touches the shared state in $HOME.
 *
 * Node builtins only (via `instances.js`), so the launcher can import it like
 * `instances.js` and `venv.js`; it is in `package.json` `files` for that reason.
 * Nothing here throws on the happy path - a chat run must never fail because its
 * bookkeeping could not be written.
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isIsolatedEnv, processStartTime, verifyPidIdentity } from './instances.js';
import { pidAlive } from './runtime.js';

/**
 * Where chat-run records live. `CELLAR_CHAT_RUNS_DIR` redirects it - the test
 * seam, like `CELLAR_USER_SETTINGS` and `CELLAR_CHAT_SLOTS` - so no test has to
 * write into, or sweep, the developer's own $HOME.
 */
export function chatRunsDir(env = process.env) {
	const override = env?.CELLAR_CHAT_RUNS_DIR;
	return override ? resolve(override) : join(homedir(), '.cellar', 'chat-runs');
}

/** Grace between the SIGTERM and the (re-verified) SIGKILL, matching the engine's own. */
const CHAT_REAP_GRACE_MS = 3_000;
const POLL_MS = 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** This process's own start time, read once: it is the OWNER identity of every record it writes. */
let ownStart;
function ownStartTime() {
	if (ownStart === undefined) ownStart = processStartTime(process.pid);
	return ownStart;
}

/**
 * Record a just-spawned chat child's process group. Returns the record's path
 * (hand it to `forgetChatRun` when the leader exits), or null when nothing was
 * recorded.
 *
 * Nothing is recorded where the record could never authorise anything: no
 * process groups (Windows), isolated mode, or a start time `ps` could not read -
 * a record without one could only ever be pruned, never verified.
 *
 * @param {number | undefined} pgid  the chat child's pid, which is its group id
 * @param {{ notebook?: string | null, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {string | null}
 */
export function recordChatRun(pgid, { notebook = null, env = process.env } = {}) {
	try {
		if (process.platform === 'win32' || isIsolatedEnv(env)) return null;
		if (!Number.isInteger(pgid) || pgid <= 1) return null;
		const leaderStart = processStartTime(pgid);
		const ownerStart = ownStartTime();
		if (leaderStart == null || ownerStart == null) return null;
		const dir = chatRunsDir(env);
		mkdirSync(dir, { recursive: true });
		const name = `${pgid}-${randomBytes(4).toString('hex')}.json`;
		const path = join(dir, name);
		const record = {
			pgid,
			leaderStart,
			ownerPid: process.pid,
			ownerStart,
			notebook: typeof notebook === 'string' ? notebook : null,
			workspace: env?.CELLAR_WORKSPACE ?? null,
			recordedAt: Date.now()
		};
		// Written whole and renamed into place, so a sweep in another process never
		// reads half a record. The temp name starts with a dot, which the listing
		// skips.
		const tmp = join(dir, `.${name}.tmp`);
		writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n');
		renameSync(tmp, path);
		return path;
	} catch {
		return null;
	}
}

/** Drop one record (best effort, idempotent). */
export function forgetChatRun(path) {
	if (!path) return;
	try {
		rmSync(path, { force: true });
	} catch {
		/* best effort */
	}
}

/**
 * A record is trusted to name a group only when every identity field is there.
 * Anything else - a hand edit, a format from some other version - can only be
 * PRUNED, never acted on.
 */
function validRecord(r) {
	return (
		!!r &&
		Number.isInteger(r.pgid) &&
		r.pgid > 1 &&
		r.pgid !== process.pid &&
		Number.isFinite(r.leaderStart) &&
		Number.isInteger(r.ownerPid) &&
		r.ownerPid > 0 &&
		Number.isFinite(r.ownerStart)
	);
}

/**
 * Every record on disk, as `{ path, record }`. `record` is null for a file that
 * does not parse or does not carry a full identity.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ path: string, record: any }[]}
 */
export function listChatRuns(env = process.env) {
	const dir = chatRunsDir(env);
	if (!existsSync(dir)) return [];
	let names;
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const out = [];
	for (const name of names) {
		if (name.startsWith('.') || !name.endsWith('.json')) continue;
		const path = join(dir, name);
		let record = null;
		try {
			const parsed = JSON.parse(readFileSync(path, 'utf8'));
			if (validRecord(parsed)) record = parsed;
		} catch {
			/* unreadable: reported as null */
		}
		out.push({ path, record });
	}
	return out;
}

/**
 * Decide what one record allows. Pure apart from the `ps` reads the identity
 * checks make.
 *
 *   live   - its owner app is provably alive: a running chat cell. Never touched.
 *   keep   - the owner or the leader cannot be verified (no `ps` answer). Nothing
 *            is signalled and the record stays, so a later sweep can decide.
 *   prune  - the owner is gone and the leader is dead, or its pid now belongs
 *            to an unrelated process. The record is removed; NOTHING is signalled.
 *   reap   - the owner is gone and the leader is provably the process we
 *            recorded: an orphan. Its group may be signalled.
 *
 * @returns {{ action: 'live' | 'keep' | 'prune' | 'reap', reason: string }}
 */
export function chatRunDecision(record) {
	if (!validRecord(record)) return { action: 'prune', reason: 'record carries no usable identity' };
	const owner = verifyPidIdentity(record.ownerPid, { startTime: record.ownerStart });
	if (owner === true) return { action: 'live', reason: `owner app pid ${record.ownerPid} is running` };
	if (owner === null) return { action: 'keep', reason: `owner app pid ${record.ownerPid} cannot be verified` };
	const gone = `owner app pid ${record.ownerPid} is gone`;
	const leader = verifyPidIdentity(record.pgid, { startTime: record.leaderStart });
	if (leader === true) return { action: 'reap', reason: `${gone}; leader pid ${record.pgid} is the process recorded` };
	if (leader === null) return { action: 'keep', reason: `${gone}; leader pid ${record.pgid} cannot be verified` };
	const why = pidAlive(record.pgid) ? 'now belongs to an unrelated process (pid reused)' : 'has exited';
	return { action: 'prune', reason: `${gone}; leader pid ${record.pgid} ${why}` };
}

/** Does any process still belong to group `pgid`? */
function groupAlive(pgid) {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (err) {
		return err?.code === 'EPERM';
	}
}

/** Signal a whole group; false when it was already gone (or not ours to signal). */
function signalGroup(pgid, signal) {
	try {
		process.kill(-pgid, signal);
		return true;
	} catch {
		return false;
	}
}

/**
 * Act on one record: signal its group if (and only if) `chatRunDecision` says
 * `reap`, and drop the record unless the decision says to keep it.
 *
 * @param {{ path: string, record: any }} entry
 * @param {{ log?: (msg: string) => void, graceMs?: number }} [opts]
 * @returns {Promise<{ action: string, reason: string, signalled: boolean }>}
 */
export async function reapChatRun(entry, { log = () => {}, graceMs = CHAT_REAP_GRACE_MS } = {}) {
	const { path, record } = entry;
	const decision = chatRunDecision(record);
	const label = `[cellar] chat run pgid=${record?.pgid ?? '?'}${record?.notebook ? ` (${record.notebook})` : ''}`;
	if (decision.action === 'live' || decision.action === 'keep') {
		return { ...decision, signalled: false };
	}
	if (decision.action === 'prune') {
		log(`${label}: ${decision.reason} -> pruned, nothing signalled`);
		forgetChatRun(path);
		return { ...decision, signalled: false };
	}

	log(`${label}: orphaned, ${decision.reason} -> stopping its process group`);
	signalGroup(record.pgid, 'SIGTERM');
	const deadline = Date.now() + graceMs;
	while (groupAlive(record.pgid) && Date.now() < deadline) await sleep(POLL_MS);
	if (groupAlive(record.pgid)) {
		// Re-asked, never carried over from before the SIGTERM: the group id is only
		// still ours while the leader is.
		if (verifyPidIdentity(record.pgid, { startTime: record.leaderStart }) === true) {
			log(`${label}: still running after ${graceMs}ms -> SIGKILL`);
			signalGroup(record.pgid, 'SIGKILL');
		} else {
			log(`${label}: leader gone, a descendant outlived it -> not signalled (no identity left to match)`);
		}
	}
	forgetChatRun(path);
	return { ...decision, signalled: true };
}

/**
 * Drop every record that can no longer name anything of ours (owner gone and
 * leader dead or reused) - bookkeeping only, it never signals. What
 * `cellar cleanup` runs before asking about anything that would be stopped.
 *
 * @param {{ env?: NodeJS.ProcessEnv, log?: (msg: string) => void }} [opts]
 * @returns {number} how many were pruned
 */
export function pruneDeadChatRuns({ env = process.env, log = () => {} } = {}) {
	let pruned = 0;
	for (const { path, record } of listChatRuns(env)) {
		const d = chatRunDecision(record);
		if (d.action !== 'prune') continue;
		log(`[cellar] chat run pgid=${record?.pgid ?? '?'}: ${d.reason} -> pruned, nothing signalled`);
		forgetChatRun(path);
		pruned++;
	}
	return pruned;
}

/**
 * The orphans a sweep would stop, without touching anything - what
 * `cellar cleanup --dry-run` and its consent prompt show.
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
export function findOrphanChatRuns(env = process.env) {
	return listChatRuns(env).filter((e) => chatRunDecision(e.record).action === 'reap');
}

/**
 * Sweep every record: reap the orphans, prune what can no longer be verified as
 * ours, leave live runs alone. Safe to run at any time and from any process -
 * it can only ever signal a group whose owning app is provably gone and whose
 * leader is provably the process recorded.
 *
 * @param {{ env?: NodeJS.ProcessEnv, log?: (msg: string) => void, graceMs?: number }} [opts]
 * @returns {Promise<{ reaped: any[], pruned: number }>}
 */
export async function reapOrphanChatRuns({ env = process.env, log = () => {}, graceMs } = {}) {
	const reaped = [];
	let pruned = 0;
	for (const entry of listChatRuns(env)) {
		const r = await reapChatRun(entry, { log, graceMs });
		if (r.action === 'reap') reaped.push(entry.record);
		else if (r.action === 'prune') pruned++;
	}
	return { reaped, pruned };
}
