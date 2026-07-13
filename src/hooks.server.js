/**
 * Server boot hooks.
 *
 * 1. Capture the server process's `console.*` into the in-app log ring buffer
 *    (`logs.js`) BEFORE anything else logs, so the Logs panel sees startup lines
 *    too. The terminal output is untouched; this only ALSO records.
 * 2. Start Cellar's in-process MCP agent interface. Running it in the SvelteKit
 *    server process is what lets it share the live notebook document + kernel and
 *    stay decoupled from kernel lifecycle (spec §4).
 * 3. Self-exit if orphaned: if our launcher dies uncleanly we would otherwise keep
 *    running (reparented to init) and serve stale code to agents (parent-watch.js).
 */
import { installConsoleCapture } from '$lib/server/logs';
import { startMcpServer } from '$lib/server/mcp/server';
import { startParentWatch } from '$lib/server/parent-watch';

installConsoleCapture();

// Name the signal that stops this server, so a killed kernel is distinguishable
// from a crash in the log. adapter-node registers its own SIGTERM/SIGINT
// handlers for graceful shutdown; these listeners are additive (they only log)
// and never call process.exit, so they don't interfere with that.
for (const sig of ['SIGTERM', 'SIGINT']) {
	process.on(sig, () => {
		console.log(`[cellar] app server received ${sig} - shutting down (kernel will stop)`);
	});
}

startMcpServer();
startParentWatch();
