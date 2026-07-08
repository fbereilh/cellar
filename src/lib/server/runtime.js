/**
 * Cellar — per-workspace runtime discovery + zero-config agent wiring.
 *
 * The launcher allocates a fresh MCP port each run (so concurrent `cellar`
 * instances never collide), which means a static `http://127.0.0.1:<port>/mcp`
 * URL in an agent's MCP config goes stale every launch. To make connecting an
 * agent zero-config, we instead:
 *
 *   1. write `<workspace>/.cellar/runtime.json` on launch, recording the live
 *      instance's { mcpPort, appPort, pid } so `cellar mcp` (the stdio bridge)
 *      can discover the running server; and
 *   2. write/merge `<workspace>/.mcp.json` with a `cellar` stdio server entry
 *      that runs `cellar mcp` — the port never appears in config, so it never
 *      goes stale.
 *
 * Node builtins + global fetch only, so this is importable by both the CLI
 * launcher (`../src/lib/server/runtime.js`) and, if ever needed, the SvelteKit
 * server (`$lib`). Nothing here throws on the happy path; callers stay simple.
 */
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';

/** Absolute path of the runtime discovery file for a workspace. */
export function runtimeFilePath(workspace) {
	return join(workspace, '.cellar', 'runtime.json');
}

/** Absolute path of the project-scoped MCP config file for a workspace. */
export function mcpConfigPath(workspace) {
	return join(workspace, '.mcp.json');
}

/**
 * Record the live instance so `cellar mcp` can find it. Writes
 * `<workspace>/.cellar/runtime.json` with at least { mcpPort, appPort, pid }.
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

/** Remove the runtime discovery file (best effort). */
export function clearRuntime(workspace) {
	try {
		rmSync(runtimeFilePath(workspace), { force: true });
	} catch {}
}

/** True if a process with `pid` is currently alive. */
function pidAlive(pid) {
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

/**
 * Write/merge `<workspace>/.mcp.json` so an agent opened in this repo (Claude
 * Code) auto-connects over stdio via `cellar mcp` — no port in config, so it
 * never goes stale. Idempotent, and preserves any other servers the user has
 * already configured (merge, never clobber). Returns a short status string.
 */
export function writeMcpConfig(workspace) {
	const file = mcpConfigPath(workspace);
	const entry = { command: 'cellar', args: ['mcp'] };

	let config = {};
	if (existsSync(file)) {
		try {
			config = JSON.parse(readFileSync(file, 'utf8'));
		} catch {
			// Corrupt/hand-edited JSON — do NOT clobber the user's file.
			return `skipped (${file} is not valid JSON; leaving it untouched)`;
		}
		if (config === null || typeof config !== 'object' || Array.isArray(config)) {
			return `skipped (${file} is not a JSON object; leaving it untouched)`;
		}
	}

	const servers = config.mcpServers && typeof config.mcpServers === 'object' ? config.mcpServers : {};
	const existing = servers.cellar;
	const already =
		existing && existing.command === entry.command && JSON.stringify(existing.args) === JSON.stringify(entry.args);

	config.mcpServers = { ...servers, cellar: entry };
	const next = JSON.stringify(config, null, 2) + '\n';

	// Idempotent: skip the write if nothing would change on disk.
	if (existsSync(file) && already) {
		try {
			if (readFileSync(file, 'utf8') === next) return 'up to date';
		} catch {}
	}

	writeFileSync(file, next);
	return already ? 'updated' : 'wrote cellar server';
}
