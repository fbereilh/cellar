/**
 * Cellar - `cellar mcp` stdio ↔ HTTP bridge.
 *
 * The in-process MCP server speaks Streamable HTTP on a per-run port (see
 * `mcp/server.js`), so a URL in agent config would go stale. Instead an agent is
 * pointed at the stdio command `cellar mcp`, and this bridge:
 *
 *   1. discovers the running instance for the workspace (`.cellar/runtime.json`)
 *      and verifies it is actually alive - failing fast with a clear stderr
 *      message + non-zero exit if not (never auto-launches a headless instance);
 *   2. proxies every JSON-RPC message transparently between a stdio server
 *      transport (facing the agent) and a Streamable HTTP client transport
 *      (facing the live server) - requests, responses, and notifications flow
 *      both ways with no knowledge of the tool schema, so it never drifts; and
 *   3. RE-ATTACHES itself when the instance it was bridging to is replaced.
 *
 * Because it proxies at the transport level, the bridge stays correct as tools
 * are added or changed. stdout is the MCP channel - all diagnostics go to stderr.
 *
 * ## (3) Why the re-attach exists - the "I have to restart the MCP" bug
 *
 * Restarting Cellar in a folder replaces the app process, and with it every
 * Streamable-HTTP MCP session it held. This bridge OUTLIVES that: it is a
 * separate process owned by the agent's host, not by Cellar.
 *
 * The failure was silent and total, and none of it was about the port. Measured
 * end to end against a real host and a real instance:
 *
 *   - `StreamableHTTPClientTransport` reports a dropped or refused upstream
 *     through `onerror`, and `onclose` fires ONLY from its own `close()`. The
 *     bridge wired its shutdown to `onclose`, so it never exited - it sat alive
 *     forever holding a session id no server recognised.
 *   - An MCP host respawns a stdio server only when the child process EXITS. A
 *     live-but-useless child looks perfectly healthy, so nothing ever triggered
 *     a reconnect. That is the masking condition: the breakage had no symptom
 *     the host could see.
 *   - Every later tool call therefore failed - `fetch failed` when the new
 *     instance took a different port, and `-32000 No valid session; send an
 *     initialize request first.` when it took the SAME one - surfacing to the
 *     user as a hang and then a client-side timeout. The only cure was to
 *     restart the MCP connection by hand.
 *
 * The port is NOT the cause and a stable port is NOT the cure: holding the MCP
 * port fixed across a restart reproduces the failure identically, because what
 * died is the SESSION, not the address. So the fix belongs here: on an upstream
 * failure the bridge re-reads `runtime.json` (picking up whatever instance now
 * serves the folder, on whatever port), re-runs the MCP handshake to mint a
 * fresh session, and retries the message that failed. The agent sees a normal
 * response and never learns anything happened.
 *
 * This is the ONLY place with protocol awareness, and it is kept to the minimum
 * that a re-handshake requires: remember the agent's `initialize` request so it
 * can be replayed, and track which request ids are outstanding so the ones lost
 * with the dead server can be failed promptly instead of hanging until the
 * host's timeout. Everything else is still an opaque relay.
 *
 * Re-attaching never starts an instance - same rule as the initial connect. If
 * nothing is serving the folder, the pending request is answered with an error
 * naming that, and the NEXT call tries again (so a bridge left running across a
 * Cellar restart heals itself the moment Cellar is back).
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readRuntime, isInstanceAlive } from './runtime.js';

/** @typedef {import('@modelcontextprotocol/sdk/shared/transport.js').Transport} Transport */

/** Diagnostics go to stderr - stdout is the MCP channel and must carry nothing else. */
const stderrLog = (msg) => process.stderr.write(`[cellar mcp] ${msg}\n`);

/** JSON-RPC error code reported when no instance is serving the workspace. */
export const NO_INSTANCE_ERROR_CODE = -32001;

/** True for a JSON-RPC request (has both an id and a method) - i.e. it expects a reply. */
export function isRequest(msg) {
	return !!msg && typeof msg === 'object' && msg.id !== undefined && msg.id !== null && typeof msg.method === 'string';
}

/** True for a JSON-RPC response/error (an id, but no method). */
export function isResponse(msg) {
	return !!msg && typeof msg === 'object' && msg.id !== undefined && msg.id !== null && msg.method === undefined;
}

/** True for the MCP `initialize` request, whose params we must replay to re-handshake. */
export function isInitializeRequest(msg) {
	return isRequest(msg) && msg.method === 'initialize';
}

/**
 * Run the bridge for `workspace`. The returned promise stays pending for the
 * life of the bridge and resolves only on clean shutdown (stdin close / signal),
 * so the caller must `await` it and not exit early. On a missing or dead
 * instance at startup it prints the error below and exits non-zero.
 *
 * Everything past `workspace` is an injection seam used only by tests (a fake
 * stdio side, a scripted discovery, a non-exiting `onFatal`, a silent `log`);
 * the defaults are the real ones, and `bin/cellar.js` passes only `workspace`.
 *
 * @param {{
 *   workspace: string,
 *   readRuntimeFn?: (workspace: string) => any,
 *   isAliveFn?: (rt: any) => Promise<boolean> | boolean,
 *   makeUpstream?: (url: URL) => Transport,
 *   makeStdio?: () => Transport,
 *   onFatal?: (code: number) => any,
 *   log?: (msg: string) => any
 * }} opts
 */
export async function runMcpBridge({
	workspace,
	readRuntimeFn = readRuntime,
	isAliveFn = isInstanceAlive,
	makeUpstream = (url) => new StreamableHTTPClientTransport(url),
	makeStdio = () => new StdioServerTransport(),
	onFatal = (code) => process.exit(code),
	log = stderrLog
} = {}) {
	const rt = readRuntimeFn(workspace);
	if (!(await isAliveFn(rt))) {
		// This is the message a user meets when their agent config is CORRECT but
		// nothing is serving it, so it must not read like a misconfiguration: say
		// what is missing (a running instance), that the wiring itself is fine, and
		// the exact command that fixes it. `cellar mcp` deliberately does not start
		// an instance - it bridges to the one the human is working in, and silently
		// booting a headless second Cellar behind their back is a different feature.
		log(`no Cellar instance is running in ${workspace}.`);
		log('this bridge attaches to a running Cellar - it never starts one - so there is nothing to connect to yet.');
		log('that usually means Cellar simply is not running, NOT that your MCP config is wrong. Start it there:');
		log(`    cd ${workspace} && cellar`);
		log('then leave it running; the agent connects on its next tool call. If that path looks wrong, the agent');
		log('launched this bridge from the wrong directory - `cellar harness list` shows the config it is reading.');
		return onFatal(1);
	}

	const stdio = makeStdio();

	// A promise that resolves only on clean shutdown; the caller awaits it.
	let resolveDone;
	const done = new Promise((resolve) => {
		resolveDone = resolve;
	});

	/** The current upstream transport, or null while detached. */
	let upstream = null;
	/** The agent's own `initialize` request, replayed verbatim to re-handshake. */
	let initRequest = null;
	/** Ids of requests relayed upstream and not yet answered. */
	const pending = new Set();
	/** Single-flight re-attach, so a burst of failures triggers one reconnect. */
	let reattaching = null;
	let closing = false;
	let attachedPort = rt.mcpPort;
	/**
	 * Ids of handshake messages the BRIDGE sent on its own behalf. Their responses
	 * belong to us, not to the agent - which already completed its handshake - so
	 * they are swallowed rather than relayed. They carry a synthetic id (a string,
	 * which JSON-RPC allows) so they can never be mistaken for one of the agent's.
	 */
	const ownIds = new Set();
	let handshakeSeq = 0;

	const sendDown = (msg) =>
		stdio.send(msg).catch((err) => log(`stdout write failed: ${err?.message ?? err}`));

	/**
	 * Answer an outstanding request with a JSON-RPC error. Without this a message
	 * lost with the dead server hangs until the HOST's timeout (60s in the
	 * measured case) - a prompt, actionable failure is strictly better, and the
	 * agent can simply call again once Cellar is back.
	 */
	const failRequest = (id, message) => {
		pending.delete(id);
		sendDown({ jsonrpc: '2.0', id, error: { code: NO_INSTANCE_ERROR_CODE, message } });
	};

	/** Detach the current upstream without letting its close cascade a shutdown. */
	const detach = async () => {
		const old = upstream;
		upstream = null;
		if (!old) return;
		// Drop the handlers FIRST: close() is the one thing that fires onclose, and
		// a deliberate swap must not read as the upstream going away for good.
		old.onmessage = undefined;
		old.onerror = undefined;
		old.onclose = undefined;
		try {
			await old.close();
		} catch {}
	};

	/** Wire a fresh transport and relay its messages down to the agent. */
	const wire = (t) => {
		t.onmessage = (msg) => {
			if (isResponse(msg)) {
				// Our own re-handshake's reply: consume it. Relaying it would hand the
				// agent a second `initialize` result for a handshake it finished long
				// ago, under an id it is no longer waiting on.
				if (ownIds.delete(msg.id)) return;
				pending.delete(msg.id);
			}
			sendDown(msg);
		};
		// Upstream errors are NOT fatal and must never shut the bridge down: they
		// are how a replaced instance announces itself, and the re-attach below is
		// driven by the send that fails, not by this. Log only.
		t.onerror = (err) => log(`upstream error: ${err?.message ?? err}`);
		t.onclose = () => log('upstream connection closed');
	};

	/**
	 * Attach to whatever instance currently serves the workspace, minting a fresh
	 * MCP session. Re-reads runtime.json every time, so it follows the instance
	 * across a restart whatever port it came up on.
	 */
	const attach = async () => {
		const cur = readRuntimeFn(workspace);
		if (!(await isAliveFn(cur))) return false;
		await detach();
		const t = makeUpstream(new URL(`http://127.0.0.1:${cur.mcpPort}/mcp`));
		wire(t);
		await t.start();
		upstream = t;
		attachedPort = cur.mcpPort;
		// Re-run the handshake so the new server mints a session for us (the
		// transport picks its `Mcp-Session-Id` up off the initialize response, which
		// is what every later message then carries). Only ever needed on a
		// RE-attach: on the first attach the agent's own initialize is still to come
		// and flows through the ordinary relay.
		if (initRequest) {
			const id = `cellar-bridge-init-${++handshakeSeq}`;
			ownIds.add(id);
			await t.send({ ...initRequest, id });
			await t.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
		}
		return true;
	};

	/**
	 * Re-attach after an upstream failure. Single-flight: several sends can fail
	 * at once and they must share one reconnect, not race N handshakes.
	 */
	const reattach = () => {
		if (!reattaching) {
			reattaching = (async () => {
				try {
					return await attach();
				} catch (err) {
					log(`re-attach failed: ${err?.message ?? err}`);
					return false;
				} finally {
					// Cleared in a microtask so every caller awaiting THIS attempt sees
					// the same result before a new one can start.
					queueMicrotask(() => {
						reattaching = null;
					});
				}
			})();
		}
		return reattaching;
	};

	/**
	 * Relay one agent message upstream, re-attaching and retrying once if the
	 * instance behind us has been replaced.
	 */
	const relayUp = async (msg) => {
		if (isInitializeRequest(msg)) initRequest = msg;
		if (isRequest(msg)) pending.add(msg.id);
		try {
			if (!upstream) throw new Error('not attached');
			await upstream.send(msg);
			return;
		} catch (err) {
			if (closing) return;
			log(`upstream send failed (${err?.message ?? err}); re-attaching …`);
		}

		const ok = await reattach();
		if (!ok) {
			if (isRequest(msg)) {
				failRequest(
					msg.id,
					`Cellar is not reachable in ${workspace}: no running instance answered. ` +
						'Start it there (`cd ' +
						workspace +
						' && cellar`) and call again - this bridge reconnects on its own.'
				);
			}
			return;
		}
		log(`re-attached to http://127.0.0.1:${attachedPort}/mcp`);

		// Requests already in flight against the dead server can never be answered:
		// fail them now rather than let them hang. The message we are about to
		// retry is deliberately exempt - the new server WILL answer it.
		for (const id of [...pending]) {
			if (id === msg.id) continue;
			failRequest(id, 'Cellar restarted while this request was in flight; it was not completed. Call again.');
		}

		try {
			await upstream.send(msg);
		} catch (err) {
			log(`retry after re-attach failed: ${err?.message ?? err}`);
			if (isRequest(msg)) failRequest(msg.id, `Cellar is reachable but rejected the request: ${err?.message ?? err}`);
		}
	};

	const shutdown = async () => {
		if (closing) return;
		closing = true;
		await detach();
		try {
			await stdio.close();
		} catch {}
		resolveDone();
	};

	stdio.onmessage = (msg) => {
		relayUp(msg).catch((err) => log(`relay failed: ${err?.message ?? err}`));
	};
	stdio.onerror = (err) => log(`stdin error: ${err?.message ?? err}`);
	stdio.onclose = () => shutdown();

	// Any failure here is fatal and must fail fast (non-zero exit + stderr),
	// never leave `cellar mcp` hanging with a swallowed rejection.
	try {
		if (!(await attach())) throw new Error('instance vanished during startup');
	} catch (err) {
		log(`failed to connect to running cellar (mcp port ${rt.mcpPort}): ${err?.message ?? err}`);
		return onFatal(1);
	}
	try {
		await stdio.start();
	} catch (err) {
		log(`failed to start stdio transport: ${err?.message ?? err}`);
		await detach();
		return onFatal(1);
	}

	// Clean shutdown when the agent closes stdin or the process is signalled.
	// StdioServerTransport does not itself detect stdin end/close, so watch it.
	process.stdin.on('end', () => shutdown());
	process.stdin.on('close', () => shutdown());
	process.on('SIGINT', () => shutdown());
	process.on('SIGTERM', () => shutdown());

	log(`bridging stdio ↔ http://127.0.0.1:${attachedPort}/mcp (pid ${rt.pid})`);

	return done;
}
