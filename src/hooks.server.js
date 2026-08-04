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
 * 4. Bridge the external-file watcher (fileWatch.ts) onto the event bus, so an
 *    open file tab reflects an edit made to its file on disk from outside Cellar.
 */
import { installConsoleCapture } from '$lib/server/logs';
import { startMcpServer } from '$lib/server/mcp/server';
import { startParentWatch } from '$lib/server/parent-watch';
import { onExternalChange, fileChangedEvent } from '$lib/server/fileWatch';
import { publishGlobal } from '$lib/server/events';

installConsoleCapture();

// 4. Bridge the external-file watcher onto the existing event bus, so an open
//    file tab learns that an agent (or a terminal, or another editor) rewrote
//    its file on disk. `file:changed` belongs to no notebook, so it takes the
//    GLOBAL shape - no `nb`, no `seq`: each event is a full statement about one
//    file, and a missed one is corrected by the next (and by the tab's own
//    window-focus revalidation). `fileChangedEvent` applies the inline-size gate.
onExternalChange((change) => publishGlobal(fileChangedEvent(change)));

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
