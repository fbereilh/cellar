/**
 * Server boot hooks.
 *
 * 1. Capture the server process's `console.*` into the in-app log ring buffer
 *    (`logs.js`) BEFORE anything else logs, so the Logs panel sees startup lines
 *    too. The terminal output is untouched; this only ALSO records.
 * 2. Start Cellar's in-process MCP agent interface. Running it in the SvelteKit
 *    server process is what lets it share the live notebook document + kernel and
 *    stay decoupled from kernel lifecycle (spec §4).
 */
import { installConsoleCapture } from '$lib/server/logs.js';
import { startMcpServer } from '$lib/server/mcp/server.js';

installConsoleCapture();
startMcpServer();
