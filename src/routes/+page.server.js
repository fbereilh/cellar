import { existsSync, readFileSync } from 'node:fs';
import { getDefaultNotebook } from '$lib/server/notebook.js';
import { workspaceRoot } from '$lib/server/fstree.js';
import { mcpConfigPath } from '$lib/server/runtime.js';

/**
 * Whether `<workspace>/.mcp.json` currently registers the `cellar` stdio server.
 * True → an agent opened in this repo auto-connects with zero config; false →
 * the launcher was run with `--no-mcp-config` (or the file was removed/edited),
 * so the manual `claude mcp add` path is the way in. Best-effort: any read/parse
 * trouble degrades to false rather than throwing.
 */
function detectMcpConfig() {
	try {
		const file = mcpConfigPath(workspaceRoot());
		if (!existsSync(file)) return false;
		const cfg = JSON.parse(readFileSync(file, 'utf8'));
		return cfg?.mcpServers?.cellar?.command === 'cellar';
	} catch {
		return false;
	}
}

/** Load the canonical notebook (cells + outputs) for the workspace. */
export function load() {
	// Live MCP endpoint for this instance. The launcher allocates a free port
	// per run and passes it via CELLAR_MCP_PORT (default 39587 matches the MCP
	// server's own fallback), so the "Connect an agent" panel can show the real
	// running value in the demoted raw-endpoint disclosure.
	const mcpPort = Number(process.env.CELLAR_MCP_PORT || 39587);
	return {
		notebook: getDefaultNotebook(),
		mcp: {
			port: mcpPort,
			url: `http://127.0.0.1:${mcpPort}/mcp`,
			// Zero-config: did the launcher write a project `.mcp.json` here?
			projectConfigured: detectMcpConfig()
		}
	};
}
