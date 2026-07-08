/**
 * Cellar — `cellar mcp` stdio ↔ HTTP bridge.
 *
 * The in-process MCP server speaks Streamable HTTP on a per-run dynamic port
 * (see `mcp/server.js`), so a URL in agent config would go stale every launch.
 * Instead an agent is pointed at the stdio command `cellar mcp`, and this
 * bridge:
 *
 *   1. discovers the running instance for the workspace (`.cellar/runtime.json`)
 *      and verifies it is actually alive — failing fast with a clear stderr
 *      message + non-zero exit if not (never auto-launches a headless instance);
 *   2. proxies every JSON-RPC message transparently between a stdio server
 *      transport (facing the agent) and a Streamable HTTP client transport
 *      (facing the live server) — requests, responses, and notifications flow
 *      both ways with no knowledge of the tool schema, so it never drifts.
 *
 * Because it proxies at the transport level, the bridge stays correct as tools
 * are added or changed. stdout is the MCP channel — all diagnostics go to
 * stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readRuntime, isInstanceAlive } from './runtime.js';

const log = (msg) => process.stderr.write(`[cellar mcp] ${msg}\n`);

/**
 * Run the bridge for `workspace`. The returned promise stays pending for the
 * life of the bridge and resolves only on clean shutdown (stdin close / signal /
 * upstream close), so the caller must `await` it and not exit early. On a
 * missing or dead instance it prints the Decision-2 error and exits non-zero.
 */
export function runMcpBridge({ workspace }) {
	return new Promise(async (resolveDone) => {
		const rt = readRuntime(workspace);
		if (!(await isInstanceAlive(rt))) {
			log(`no running cellar found in ${workspace} - run \`cellar\` here first`);
			process.exit(1);
		}

		const url = new URL(`http://127.0.0.1:${rt.mcpPort}/mcp`);
		const upstream = new StreamableHTTPClientTransport(url);
		const stdio = new StdioServerTransport();

		let closing = false;
		const shutdown = async () => {
			if (closing) return;
			closing = true;
			try {
				await upstream.close();
			} catch {}
			try {
				await stdio.close();
			} catch {}
			resolveDone();
		};

		// Transparent transport-level relay in both directions.
		upstream.onmessage = (msg) => stdio.send(msg).catch((err) => log(`stdout write failed: ${err?.message ?? err}`));
		upstream.onerror = (err) => log(`upstream error: ${err?.message ?? err}`);
		upstream.onclose = () => {
			log('upstream connection closed');
			shutdown();
		};

		stdio.onmessage = (msg) => upstream.send(msg).catch((err) => log(`upstream send failed: ${err?.message ?? err}`));
		stdio.onerror = (err) => log(`stdin error: ${err?.message ?? err}`);
		stdio.onclose = () => shutdown();

		try {
			await upstream.start();
		} catch (err) {
			log(`failed to connect to running cellar (mcp port ${rt.mcpPort}): ${err?.message ?? err}`);
			process.exit(1);
		}
		await stdio.start();

		// Clean shutdown when the agent closes stdin or the process is signalled.
		// StdioServerTransport does not itself detect stdin end/close, so watch it.
		process.stdin.on('end', () => shutdown());
		process.stdin.on('close', () => shutdown());
		process.on('SIGINT', () => shutdown());
		process.on('SIGTERM', () => shutdown());

		log(`bridging stdio ↔ http://127.0.0.1:${rt.mcpPort}/mcp (pid ${rt.pid})`);
	});
}
