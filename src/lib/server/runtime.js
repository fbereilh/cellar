/**
 * Cellar — per-workspace runtime discovery + zero-config agent wiring.
 *
 * A `cellar` instance's MCP port can move between runs (a folder now prefers the
 * port it had last time - see ports.js - but that preference yields to anything
 * holding it, and an isolated / `--new` launch is always ephemeral), so a static
 * `http://127.0.0.1:<port>/mcp` URL in an agent's MCP config is not something to
 * rely on. To make connecting an agent zero-config, we instead:
 *
 *   1. write `<workspace>/.cellar/runtime.json` on launch, recording the live
 *      instance's { mcpPort, appPort, pid } so `cellar mcp` (the stdio bridge)
 *      can discover the running server; and
 *   2. point each agent harness at that stdio bridge by writing/merging its own
 *      config (Claude Code's `.mcp.json`, Codex's `.codex/config.toml`, …) with
 *      a `cellar` server entry that runs `cellar mcp` — the port never appears
 *      in config, so it never goes stale. That half lives entirely in
 *      `harness.js`, the single source of truth for where those files are and
 *      how they are merged; nothing here writes them.
 *
 * ## This file is a LIVE-INSTANCE record, not a preference
 *
 * `clearRuntime` deletes it on exit, precisely so a dead instance can never be
 * discovered. That is the opposite of what a durable per-folder setting needs,
 * which is why the remembered-port preference lives in its own
 * `.cellar/ports.json` (ports.js) rather than being folded in here.
 *
 * ## What discovery alone does NOT fix
 *
 * Discovery only covers finding the instance at CONNECT time. A `cellar mcp`
 * bridge already running when the instance is replaced holds a session no new
 * server recognises, and it must re-read this file and re-handshake to recover -
 * see the header of `mcp-bridge.js`, which is where that lives.
 *
 * Node builtins + global fetch only, so this is importable by both the CLI
 * launcher (`../src/lib/server/runtime.js`) and, if ever needed, the SvelteKit
 * server (`$lib`). Nothing here throws on the happy path; callers stay simple.
 */
import { join } from 'node:path';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	rmSync,
	linkSync,
	unlinkSync
} from 'node:fs';

/** Absolute path of the runtime discovery file for a workspace. */
export function runtimeFilePath(workspace) {
	return join(workspace, '.cellar', 'runtime.json');
}

/** Absolute path of the single-instance lockfile for a workspace. */
export function instanceLockPath(workspace) {
	return join(workspace, '.cellar', 'instance.lock');
}

/**
 * Record the live instance so `cellar mcp` can find it. Writes
 * `<workspace>/.cellar/runtime.json` with at least { mcpPort, appPort, pid }.
 *
 * @param {string} workspace
 * @param {{ mcpPort?: number, appPort?: number, jupyterPort?: number, pid?: number }} [info]
 */
export function writeRuntime(workspace, { mcpPort, appPort, jupyterPort, pid = process.pid } = {}) {
	const dir = join(workspace, '.cellar');
	mkdirSync(dir, { recursive: true });
	const info = { pid, mcpPort, appPort, jupyterPort, workspace };
	writeFileSync(runtimeFilePath(workspace), JSON.stringify(info, null, 2) + '\n');
	return info;
}

/** Read `<workspace>/.cellar/runtime.json`, or null if missing/unparseable. */
export function readRuntime(workspace) {
	const file = runtimeFilePath(workspace);
	if (!existsSync(file)) return null;
	try {
		return JSON.parse(readFileSync(file, 'utf8'));
	} catch {
		return null;
	}
}

/**
 * Remove the runtime discovery file (best effort), but only if it still points
 * at us. Two `cellar` instances in the same workspace share one runtime.json
 * (last writer wins); the first to exit must not delete a file the surviving
 * instance now owns, or `cellar mcp` could no longer discover it.
 */
export function clearRuntime(workspace, pid = process.pid) {
	const current = readRuntime(workspace);
	if (current && current.pid !== pid) return;
	try {
		rmSync(runtimeFilePath(workspace), { force: true });
	} catch {}
}

/** Read the owner pid recorded in a lockfile, or null if missing/garbage. */
function readLockPid(file) {
	try {
		const n = parseInt(readFileSync(file, 'utf8').trim(), 10);
		return Number.isInteger(n) && n > 0 ? n : null;
	} catch {
		return null;
	}
}

/**
 * Atomically claim this workspace for a single cellar instance.
 *
 * The lockfile is created with `O_EXCL`, so only ONE launcher can win the
 * folder even when two `cellar` commands race inside the multi-second boot
 * window (before either has written runtime.json). This is the piece that
 * closes the boot-window clobber: liveness probes alone can't, because a
 * genuinely simultaneous double-launch has both processes see "no instance"
 * before either records one.
 *
 * A lockfile whose owner pid is dead is stale (a hard-killed instance never
 * released it) — it is removed and acquisition retried. Returns:
 *   { acquired: true }             — we hold the folder; boot.
 *   { acquired: false, ownerPid }  — a live instance holds it; attach to it.
 */
export function acquireInstanceLock(workspace, pid = process.pid) {
	const dir = join(workspace, '.cellar');
	mkdirSync(dir, { recursive: true });
	const file = instanceLockPath(workspace);
	// Stage the pid in a per-pid temp file first, then atomically link it into
	// place. linkSync fails with EEXIST if the lock already exists, so the lock
	// is never visible on disk without its pid already written — closing the
	// create-then-write window where a racer could read an empty lock and
	// wrongly reclaim it.
	const temp = file + '.' + pid + '.tmp';
	writeFileSync(temp, String(pid) + '\n');
	try {
		for (let attempt = 0; attempt < 5; attempt++) {
			try {
				linkSync(temp, file); // fails EEXIST if a lock already exists
				return { acquired: true };
			} catch (err) {
				if (err?.code !== 'EEXIST') throw err;
				const ownerPid = readLockPid(file);
				if (ownerPid && ownerPid !== pid && pidAlive(ownerPid)) {
					return { acquired: false, ownerPid };
				}
				// Stale lock (dead owner, or our own leftover) — clear + retry.
				try {
					rmSync(file, { force: true });
				} catch {}
			}
		}
	} finally {
		try {
			unlinkSync(temp);
		} catch {}
	}
	// Lost every race to another launcher — treat the folder as owned (never
	// clobber). The caller attaches to whoever currently holds it.
	return { acquired: false, ownerPid: readLockPid(file) };
}

/** Release the single-instance lock, but only if we still own it. */
export function releaseInstanceLock(workspace, pid = process.pid) {
	const file = instanceLockPath(workspace);
	const ownerPid = readLockPid(file);
	if (ownerPid && ownerPid !== pid) return; // held by someone else now
	try {
		rmSync(file, { force: true });
	} catch {}
}

/** Quick liveness probe of the app HTTP port (any response = listening). */
export async function appPortResponds(appPort, timeoutMs = 1500) {
	if (!appPort) return false;
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		await fetch(`http://localhost:${appPort}/`, { signal: ctrl.signal });
		return true;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Wait for the instance that holds this folder to finish booting, then return
 * the browser URL to attach to. Polls runtime.json + the app port, because the
 * owner may still be booting (runtime.json is written mid-launch, before the
 * app is listening). Returns null if the owner dies before it comes up (crashed
 * during boot → caller should take over) or the timeout elapses (hung).
 */
export async function waitForInstanceUrl(workspace, ownerPid, { timeoutMs = 120000 } = {}) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (ownerPid && !pidAlive(ownerPid)) return null; // owner gone → take over
		const rt = readRuntime(workspace);
		if (rt && rt.appPort && (await appPortResponds(rt.appPort))) {
			return `http://localhost:${rt.appPort}/?ws=${encodeURIComponent(workspace)}`;
		}
		await new Promise((r) => setTimeout(r, 300));
	}
	return null;
}

/** True if a process with `pid` is currently alive. */
export function pidAlive(pid) {
	if (!pid) return false;
	try {
		process.kill(pid, 0); // signal 0 = existence check, does not kill
		return true;
	} catch (err) {
		// EPERM means the process exists but is owned by another user → alive.
		return err?.code === 'EPERM';
	}
}

/** Quick liveness probe of the MCP HTTP endpoint (any response = up). */
async function mcpPortResponds(mcpPort, timeoutMs = 1500) {
	if (!mcpPort) return false;
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		// A bare GET without a session returns HTTP 400 — that is still proof the
		// in-process MCP server is listening and answering on this port.
		await fetch(`http://127.0.0.1:${mcpPort}/mcp`, { method: 'GET', signal: ctrl.signal });
		return true;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Verify a recorded instance is actually alive: the pid must exist AND the MCP
 * port must answer. A dead/stale runtime.json returns false fast (no hang), so
 * `cellar mcp` can fail cleanly instead of proxying into the void.
 */
export async function isInstanceAlive(rt) {
	if (!rt) return false;
	if (!pidAlive(rt.pid)) return false;
	return mcpPortResponds(rt.mcpPort);
}
