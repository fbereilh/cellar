import { getNotebook } from '$lib/server/notebook.js';

/** Load the canonical notebook (cells + outputs) for the workspace. */
export function load() {
	// Live MCP endpoint for this instance. The launcher allocates a free port
	// per run and passes it via CELLAR_MCP_PORT (default 39587 matches the MCP
	// server's own fallback), so the "Connect an agent" panel shows the real
	// running value rather than a hardcoded port.
	const mcpPort = Number(process.env.CELLAR_MCP_PORT || 39587);
	return {
		notebook: getNotebook(),
		mcp: { port: mcpPort, url: `http://127.0.0.1:${mcpPort}/mcp` }
	};
}
