/**
 * Start Cellar's in-process MCP agent interface when the backend boots. Running
 * it in the SvelteKit server process is what lets it share the live notebook
 * document + kernel and stay decoupled from kernel lifecycle (spec §4).
 */
import { startMcpServer } from '$lib/server/mcp/server.js';

startMcpServer();
