/**
 * Cellar — global instance registry + reaper.
 *
 * The per-workspace runtime.json / instance.lock (runtime.js) makes a single
 * instance per folder, but nothing reaped OLD instances:
 *
 *   - a launcher killed uncleanly (terminal closed hard, SIGKILL, crash) leaves
 *     its app (`build/index.js`) orphaned — reparented to init, still listening
 *     for hours/days; and
 *   - after a code update, a still-running instance keeps serving stale in-memory
 *     code (including the MCP `instructions` + tool descriptions) to agents that
 *     discover its port.
 *
 * This registry is the cross-workspace record that lets a launch — and the
 * `cellar ls` / `cellar cleanup` commands — find and reap those. One JSON file
 * per instance under `~/.cellar/instances/<launcherPid>.json`, recording the
 * launcher + child pids, ports, workspace and start time. It lives in $HOME (NOT
 * the project's `.cellar/`), so it survives the workspace directory being removed
 * — exactly the case (deleted worktrees) where orphans pile up.
 *
 * Node builtins + global fetch only, so both the launcher (`../instances.js`) and
 * the SvelteKit server (`$lib`, for the orphan self-exit watch) can import it.
 * Nothing here throws on the happy path; callers stay simple.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import {
	pidAlive,
	appPortResponds,
	clearRuntime,
	releaseInstanceLock
} from './runtime.js';

/** Absolute path of the global instance registry directory. */
export function registryDir() {
	return join(homedir(), '.cellar', 'instances');
}
function entryPath(launcherPid) {
	return join(registryDir(), `${launcherPid}.json`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Record this instance in the global registry (keyed by launcher pid). */
export function registerInstance(info) {
	const dir = registryDir();
	mkdirSync(dir, { recursive: true });
	const launcherPid = info.launcherPid ?? process.pid;
	const record = { launcherPid, ...info };
	try {
		writeFileSync(entryPath(launcherPid), JSON.stringify(record, null, 2) + '\n');
	} catch {}
	return record;
}

/** Merge extra fields (e.g. child pids learned after spawn) into an entry. */
export function updateInstance(launcherPid, patch) {
	const cur = readInstance(launcherPid);
	if (!cur) return registerInstance({ launcherPid, ...patch });
	const next = { ...cur, ...patch };
	try {
		writeFileSync(entryPath(launcherPid), JSON.stringify(next, null, 2) + '\n');
	} catch {}
	return next;
}

/** Read one registry entry by launcher pid, or null if missing/unparseable. */
export function readInstance(launcherPid) {
	try {
		return JSON.parse(readFileSync(entryPath(launcherPid), 'utf8'));
	} catch {
		return null;
	}
}

/** Remove this instance's registry file (best effort). */
export function unregisterInstance(launcherPid = process.pid) {
	try {
		rmSync(entryPath(launcherPid), { force: true });
	} catch {}
}

/** All valid registry entries. */
export function listInstances() {
	const dir = registryDir();
	if (!existsSync(dir)) return [];
	const out = [];
	let names;
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	for (const name of names) {
		if (!name.endsWith('.json')) continue;
		try {
			const e = JSON.parse(readFileSync(join(dir, name), 'utf8'));
			if (e && Number.isInteger(e.launcherPid)) out.push(e);
		} catch {}
	}
	return out;
}

/** True if the workspace directory this instance served still exists on disk. */
export function workspaceExists(e) {
	return !!e.workspace && existsSync(e.workspace);
}

/** Annotate an entry with liveness (launcher pid, child pid, app port response). */
export async function annotateInstance(e) {
	const launcherAlive = pidAlive(e.launcherPid);
	const appAlive = pidAlive(e.appPid);
	const appResponds = await appPortResponds(e.appPort);
	return { ...e, launcherAlive, appAlive, appResponds };
}

/** Poll until `pid` is dead or the timeout elapses; returns whether it died. */
export async function waitForPidDeath(pid, timeoutMs = 8000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (!pidAlive(pid)) return true;
		await sleep(150);
	}
	return !pidAlive(pid);
}

/** SIGTERM a pid, then SIGKILL if it is still alive after a grace period. */
export async function killPid(pid, { graceMs = 4000 } = {}) {
	if (!pid || !pidAlive(pid)) return;
	try {
		process.kill(pid, 'SIGTERM');
	} catch {}
	if (!(await waitForPidDeath(pid, graceMs))) {
		try {
			process.kill(pid, 'SIGKILL');
		} catch {}
	}
}

/**
 * Reap one registered instance: stop its launcher gracefully (SIGTERM → wait →
 * SIGKILL) so the launcher cascades a clean shutdown to its own children and
 * releases its lock/runtime; then make sure the recorded app/jupyter children are
 * gone (they orphan if the launcher was SIGKILLed before it could cascade); then
 * drop its bookkeeping (lock/runtime for the SIGKILL path, and the registry file).
 */
export async function reapInstance(e, { log = () => {} } = {}) {
	const { launcherPid, appPid, jupyterPid, workspace } = e;
	if (launcherPid && pidAlive(launcherPid)) {
		log(`  stopping launcher pid ${launcherPid}`);
		await killPid(launcherPid, { graceMs: 8000 });
	}
	// Children orphan if the launcher never got to cascade its own shutdown.
	for (const pid of [appPid, jupyterPid]) {
		if (pid && pidAlive(pid)) {
			log(`  killing child pid ${pid}`);
			await killPid(pid, { graceMs: 3000 });
		}
	}
	// Belt-and-suspenders for the SIGKILL path, where the launcher's own cleanup()
	// never ran (pid-guarded, so it is a no-op if the folder is owned by someone new).
	if (workspace) {
		clearRuntime(workspace, launcherPid);
		releaseInstanceLock(workspace, launcherPid);
	}
	unregisterInstance(launcherPid);
}

/** Remove registry files for fully-dead instances (launcher dead, app not up). */
export async function pruneDeadInstances() {
	const pruned = [];
	for (const e of listInstances()) {
		if (pidAlive(e.launcherPid)) continue;
		if (pidAlive(e.appPid)) continue;
		if (await appPortResponds(e.appPort)) continue;
		unregisterInstance(e.launcherPid);
		pruned.push(e);
	}
	return pruned;
}

/** Reap every registered instance for `workspace` except `excludePid`. */
export async function reapWorkspaceInstances(workspace, { excludePid, log } = {}) {
	const reaped = [];
	for (const e of listInstances()) {
		if (e.launcherPid === excludePid) continue;
		if (e.workspace !== workspace) continue;
		await reapInstance(e, { log });
		reaped.push(e);
	}
	return reaped;
}

/** Reap instances whose workspace directory no longer exists (deleted worktrees). */
export async function reapVanishedWorkspaces({ excludePid, log } = {}) {
	const reaped = [];
	for (const e of listInstances()) {
		if (e.launcherPid === excludePid) continue;
		if (workspaceExists(e)) continue;
		await reapInstance(e, { log });
		reaped.push(e);
	}
	return reaped;
}

/**
 * Best-effort scan (POSIX only) for cellar app processes — `node …/build/index.js`
 * under a cellar checkout — that are NOT in the registry (started before this
 * feature existed, or whose registry file was lost). Returns [{pid, ppid, command}].
 * Used by `cellar ls`/`cellar cleanup` to surface + reap zombies the registry can
 * no longer account for; never used to auto-kill on launch.
 */
export function scanUntrackedCellarProcesses() {
	if (process.platform === 'win32') return [];
	let out;
	try {
		out = execFileSync('ps', ['-eo', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
	} catch {
		return [];
	}
	const known = new Set();
	for (const e of listInstances()) {
		if (e.appPid) known.add(e.appPid);
		if (e.launcherPid) known.add(e.launcherPid);
	}
	const rows = [];
	for (const line of out.split('\n')) {
		const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
		if (!m) continue;
		const pid = parseInt(m[1], 10);
		const ppid = parseInt(m[2], 10);
		const command = m[3];
		if (pid === process.pid) continue;
		if (known.has(pid)) continue;
		// A cellar APP process is exactly `node <abs>/build/index.js …` where the
		// path names a cellar checkout. Anchoring on the `node` executable + an
		// ABSOLUTE `…/build/index.js` argument is deliberately strict: other agents'
		// processes carry our prompt text (which mentions "node build/index.js" and
		// "cellar") as arguments, and a loose substring match would target them.
		const cm = command.match(/^(\S+)\s+(\/\S+\/build\/index\.js)(?:\s|$)/);
		if (!cm) continue;
		if (cm[1].split('/').pop() !== 'node') continue;
		if (!/cellar/i.test(cm[2])) continue;
		rows.push({ pid, ppid, command });
	}
	return rows;
}
