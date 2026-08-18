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
 * died is the SESSION, not the address. So the fix belongs here: when the
 * session is gone the bridge re-reads `runtime.json` (picking up whatever
 * instance now serves the folder, on whatever port), re-runs the MCP handshake
 * to mint a fresh session, and retries the message that failed. The agent sees a
 * normal response and never learns anything happened.
 *
 * ## Re-attaching is driven by EVIDENCE THE SESSION IS GONE, never by any failure
 *
 * A re-attach is destructive: it closes the session, and with it the open POST
 * and SSE stream every in-flight request is riding. Cellar's run tools hold that
 * POST open for the WHOLE cell run (minutes, streaming progress notifications),
 * so over-triggering here would abort exactly the long work this bridge exists
 * to protect - a worse failure than the one being fixed. `send()` rejects for
 * three quite different reasons, and only two of them say anything about the
 * session (see `classifyUpstreamFailure`):
 *
 *   - `session-gone` - the server itself refused us (`-32000 No valid session`,
 *     or a 404 to a request carrying a session id, which the spec defines as
 *     "re-initialize"). This IS the evidence; re-attach at once.
 *   - `connection` - nothing answered (`fetch failed`, ECONNREFUSED/ECONNRESET,
 *     socket hang up). Ambiguous: a replaced instance looks like this, but so
 *     does a stale keep-alive socket against a perfectly healthy one. So it is
 *     CONFIRMED first - runtime.json naming a different port, or the recorded
 *     instance not answering - and an unconfirmed blip is retried once on the
 *     SAME session, which a fresh socket satisfies.
 *   - `other` - a live, session-valid server rejecting THIS message (429, 500,
 *     bad params). Relayed as an error for that request alone: no detach, no
 *     re-handshake, and above all no disturbing the other in-flight requests.
 *
 * ## Re-SENDING is a second, narrower question, and its answer is ASYMMETRIC
 *
 * Whether to re-attach asks about the SESSION. Whether to put the failed message
 * on the wire AGAIN asks about that MESSAGE, and the two must not be conflated,
 * because a resend is a duplicate DELIVERY and Cellar's write tools are not
 * idempotent: `add_cells` / `delete_cells` / `edit_cell` applied twice corrupt
 * the user's notebook, which is their primary data. So `provesNotDelivered`
 * gates every resend path, and a REQUEST is resent only where the failure PROVES
 * nothing ran - a server that ANSWERED with a session refusal (it rejected the
 * message before dispatching it) or a connection that was never ESTABLISHED
 * (ECONNREFUSED and friends: nothing was written). Those two are exactly the two
 * shapes a restart takes - same port, and moved port - so the headline "restart
 * Cellar and the agent's next call just works" flow is untouched.
 *
 * A socket that opened and then broke (`ECONNRESET`, `socket hang up`, a bare
 * `fetch failed`, an abort from our own `detach()`) cannot distinguish "never
 * arrived" from "arrived, ran, and the reply died with the socket". A REQUEST is
 * therefore NOT replayed there: it is failed with a message saying the call may
 * or may not have been applied, because a visible failure beats a silent
 * duplicate mutation and only the agent can decide what to do about it. A
 * NOTIFICATION carries no id and earns no response, so a duplicate delivery of
 * one is invisible - it keeps the full recovery, which is what makes the
 * asymmetry free (the handshake's `notifications/initialized` still survives a
 * blip).
 *
 * DECLINING THE RESEND IS NOT DECLINING THE HEAL. The two questions stay
 * independent all the way down `deliver`: an ambiguous failure still asks
 * `instanceGone()` and still re-attaches, because that repairs the transport for
 * every OTHER message riding it and its sweep is what promptly answers requests
 * whose replies died with the old server. Collapsed into one early return, a
 * long `run_cell` already in flight hung on a dead session until the host's 60s
 * timeout - the exact symptom this bridge exists to remove.
 *
 * Both of those are bounded by their OWN counter and neither may switch the other
 * off: `sameSessionRetried` bounds how many times one message goes back on the
 * wire, while `instanceGone()` is asked before EVERY re-attach. Collapsing them
 * let a second blip re-attach with no evidence at all, against an instance
 * provably alive on our own port.
 *
 * Other pending requests are failed ONLY after a genuine re-attach, when their
 * answers provably can never arrive, and exactly ONCE per re-attach (in the
 * single-flight continuation, not per caller - per caller, two concurrent
 * failures each failed the other's request AND then retried it, so one id got
 * both an error and a result). A request the recovery has already taken over -
 * answered, or handed off so its replay is on the wire - is exempt from every
 * verdict `deliver` would otherwise reach (`settledByRecovery`).
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

/** Node/undici codes that mean the connection itself failed, not that a server answered. */
const CONNECTION_ERROR_CODES = new Set([
	'ECONNREFUSED',
	'ECONNRESET',
	'EPIPE',
	'ETIMEDOUT',
	'ENOTFOUND',
	'EHOSTUNREACH',
	'ENETUNREACH',
	'EAI_AGAIN',
	'UND_ERR_SOCKET',
	'UND_ERR_CONNECT_TIMEOUT'
]);
/**
 * The strict subset of those that mean the connection was never ESTABLISHED -
 * we never reached a server at all, so nothing of ours can have run. The rest
 * (`ECONNRESET`, `EPIPE`, `ETIMEDOUT`, `UND_ERR_SOCKET`) are failures of a
 * connection that DID open, and say nothing about whether the request on it was
 * processed before it broke.
 */
const CONNECT_FAILED_CODES = new Set([
	'ECONNREFUSED',
	'ENOTFOUND',
	'EHOSTUNREACH',
	'ENETUNREACH',
	'EAI_AGAIN',
	'UND_ERR_CONNECT_TIMEOUT'
]);
/** The same thing said in prose, for a transport that carries no code. */
const CONNECT_FAILED_MESSAGE = /connection refused|econnrefused|enotfound|ehostunreach|enetunreach|getaddrinfo/i;
/**
 * The same thing said in prose, for a transport that carries no code. `aborted`
 * belongs here rather than with the rejections: an aborted request never got a
 * verdict from the server, and our OWN `detach()` aborts in-flight sends.
 */
const CONNECTION_MESSAGE =
	/fetch failed|socket hang up|premature close|other side closed|connection (?:closed|refused|reset|error)|network error|terminated|(?:was|operation) aborted/i;
/** A server telling us the session we carry is not one it knows. */
const SESSION_GONE_MESSAGE =
	/no valid session|session (?:not found|expired|has expired|is invalid|invalid)|send an initialize request/i;

/** Walk an error's `cause` chain - undici wraps the real socket error one level down. */
function* errorChain(err, depth = 5) {
	let cur = err;
	for (let i = 0; cur && i < depth; i++) {
		yield cur;
		cur = cur.cause;
	}
}

/**
 * The HTTP status an upstream failure carries, or null if it never reached one.
 * `StreamableHTTPError` records the status on a NUMERIC `code`; a node socket
 * error puts a STRING there, so the type check is what tells them apart.
 */
function httpStatusOf(err) {
	for (const e of errorChain(err)) {
		if (typeof e?.code === 'number' && e.code >= 100 && e.code <= 599) return e.code;
	}
	return null;
}

/**
 * Why an `upstream.send` rejected - the decision that gates tearing the session
 * down (see the module header for why that must be evidence-driven).
 *
 * @param {unknown} err
 * @returns {'session-gone' | 'connection' | 'other'}
 */
export function classifyUpstreamFailure(err) {
	const status = httpStatusOf(err);
	const text = String(err?.message ?? err ?? '');
	// A 404 to a request carrying a session id means "start a new session" per the
	// Streamable HTTP spec; Cellar's own server says the same with a 400 -32000.
	if (status === 404) return 'session-gone';
	if (status === 400 && (text.includes('-32000') || SESSION_GONE_MESSAGE.test(text))) {
		return 'session-gone';
	}
	// Any OTHER status means a live server that knows our session answered and
	// refused this one message. Nothing about the session is gone, and the text is
	// NOT consulted: the SDK folds the response BODY into this message, so a 500
	// from Cellar's own outer catch (`mcp error: <anything>`) relaying a tool
	// failure that merely mentions a session would otherwise tear down a healthy
	// session and abort every run streaming on it.
	if (status != null) return 'other';
	if (SESSION_GONE_MESSAGE.test(text)) return 'session-gone';
	for (const e of errorChain(err)) {
		if (e?.name === 'AbortError' || e?.code === 'ABORT_ERR') return 'connection';
		if (typeof e?.code === 'string' && CONNECTION_ERROR_CODES.has(e.code)) return 'connection';
	}
	if (CONNECTION_MESSAGE.test(text)) return 'connection';
	return 'other';
}

/**
 * Does this failure PROVE the message never reached the server's dispatcher?
 *
 * A DIFFERENT question from `classifyUpstreamFailure`, which answers "what does
 * this say about the SESSION" and so decides whether to re-attach. This one
 * decides whether the message may be put on the wire a SECOND time, and the two
 * must not be conflated: a resend is a duplicate DELIVERY, and Cellar's write
 * tools are not idempotent - `add_cells` / `delete_cells` / `edit_cell` applied
 * twice corrupt the user's notebook, which is their primary data.
 *
 * Exactly two failures prove non-delivery:
 *   - a server ANSWERED with a session refusal (`-32000 No valid session`, or a
 *     404 to a request carrying a session id). It rejected the message before
 *     dispatching it, so nothing ran - and this is the dominant restart case,
 *     which is why the headline "the agent's next call just works" flow survives.
 *   - the connection was never ESTABLISHED (ECONNREFUSED and friends). Nothing
 *     was written, so nothing can have been executed - which covers the other
 *     restart shape, where the replacement instance came up on a different port
 *     and the old address simply refuses.
 *
 * Everything else is AMBIGUOUS: a socket that opened and then broke
 * (`ECONNRESET`, `socket hang up`, `premature close`, a bare `fetch failed`, or
 * an abort from our own `detach()`) cannot distinguish "never arrived" from
 * "arrived, was executed, and the reply was lost with the socket".
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function provesNotDelivered(err) {
	if (classifyUpstreamFailure(err) === 'session-gone') return true;
	// The status short-circuit outranks everything below it, for the same reason
	// `classifyUpstreamFailure` documents: the SDK folds the response BODY into the
	// error message, so a live server that ANSWERED - from inside its dispatcher,
	// after the handler may already have run - must never be judged by text. A tool
	// failure reading `mcp error: ... connection refused by the Spark cluster` would
	// otherwise come back "safe to replay". This predicate decides whether a
	// mutation may be re-applied, so it has to be sound on its own terms rather
	// than by a caller's ordering.
	if (httpStatusOf(err) != null) return false;
	for (const e of errorChain(err)) {
		if (typeof e?.code === 'string' && CONNECT_FAILED_CODES.has(e.code)) return true;
	}
	return CONNECT_FAILED_MESSAGE.test(String(err?.message ?? err ?? ''));
}

/**
 * What a request is told when its send failed AMBIGUOUSLY. It deliberately does
 * not claim the call did not happen: the honest answer is that we cannot tell,
 * and this codebase's rule is that a visible failure beats a silent duplicate.
 */
export const AMBIGUOUS_SEND_MESSAGE =
	'The connection to Cellar broke while this request was in flight, so it may or may not have been ' +
	'applied. It was deliberately NOT re-sent, because re-sending a write would risk applying it twice. ' +
	'Check the notebook state before calling again.';

/**
 * What a request swept by a re-attach is told. Its send had RESOLVED, and the
 * SDK resolves a send once the POST's headers arrive, so the old server had
 * ACCEPTED the message and its handler was running or had already run - which
 * makes this the more confident case of the two, not the less. So it may not say
 * the call "was not completed" and may not invite a plain retry: only the RESULT
 * is provably lost.
 */
export const LOST_RESULT_MESSAGE =
	'The connection to the Cellar instance that was executing this request was lost, so its result can ' +
	'never be delivered; the call may or may not have been applied. Check the notebook state before ' +
	'retrying it.';

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
	/**
	 * Ids whose `relayUp` call has not returned yet, and which will therefore be
	 * answered by that call itself. Exempt from the post-re-attach sweep, because
	 * sweeping an id that is still going to be answered gives it two responses.
	 * Registered SYNCHRONOUSLY at the top of `relayUp`, before any await, so a
	 * re-attach can never start in the gap.
	 */
	const relaying = new Set();
	/** Single-flight re-attach, so a burst of failures triggers one reconnect. */
	let reattaching = null;
	let closing = false;
	let attachedPort = rt.mcpPort;
	/**
	 * Handshake messages the BRIDGE sent, keyed by the synthetic id it gave them (a
	 * string, which JSON-RPC allows, so it can never be mistaken for one of the
	 * agent's). The value is who the reply belongs to: `null` for a re-handshake
	 * the agent knows nothing about - swallowed, since the agent completed its own
	 * long ago and is waiting on no such id - or the agent's OWN initialize id when
	 * this replay stands IN for a handshake the agent is still waiting for, in
	 * which case the reply is relayed under that id.
	 */
	const ownIds = new Map();
	/**
	 * Agent request ids whose handshake a replay has taken over. They must never be
	 * re-sent: a transport is initialized exactly once, and a second initialize is
	 * answered `-32600 Server already initialized`, which would fail the very
	 * handshake the recovery is completing.
	 */
	const handedOff = new Set();
	let handshakeSeq = 0;

	const sendDown = (msg) =>
		stdio.send(msg).catch((err) => log(`stdout write failed: ${err?.message ?? err}`));

	/**
	 * Answer an outstanding request with a JSON-RPC error. Without this a message
	 * lost with the dead server hangs until the HOST's timeout (60s in the
	 * measured case) - a prompt, actionable failure is strictly better, and the
	 * agent can simply call again once Cellar is back.
	 *
	 * Idempotent, and that is load-bearing: JSON-RPC allows exactly ONE response
	 * per id, so an id already answered - by the real server (the relay deletes it
	 * on the way down) or by an earlier failure - must never be answered twice.
	 * Membership in `pending` IS the "still unanswered" record, so the delete's
	 * own verdict is the guard.
	 */
	const failRequest = (id, message) => {
		if (!pending.delete(id)) return;
		handedOff.delete(id);
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
				if (ownIds.has(msg.id)) {
					const forAgent = ownIds.get(msg.id);
					ownIds.delete(msg.id);
					// A re-handshake the agent knows nothing about: consume it. Relaying
					// it would hand the agent a second `initialize` result for a handshake
					// it finished long ago, under an id it is no longer waiting on.
					if (forAgent == null) return;
					// This replay stood in for the agent's OWN initialize: give it the
					// result under the id it is waiting on - but only while that id really
					// is still unanswered. Membership of `pending` IS that record, so the
					// delete's own verdict is the guard, exactly as in `failRequest`:
					// JSON-RPC allows ONE response per id, and a second re-attach can
					// replay a handshake whose id something else has since answered.
					handedOff.delete(forAgent);
					if (!pending.delete(forAgent)) return;
					sendDown({ ...msg, id: forAgent });
					return;
				}
				pending.delete(msg.id);
			}
			sendDown(msg);
		};
		// Upstream errors are NOT fatal and must never shut the bridge down. They
		// are also not the re-attach trigger: this fires for a failed SSE stream on
		// a perfectly healthy session, and it carries no message to classify or to
		// answer. Recovery is decided per send, where both exist. Log only.
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
			// If the agent's OWN initialize is what is still unanswered - its send is
			// what failed and brought us here - this replay IS its handshake, so the
			// reply is relayed under its id rather than swallowed, and the caller must
			// not send it a second time.
			const forAgent = pending.has(initRequest.id) ? initRequest.id : null;
			const id = `cellar-bridge-init-${++handshakeSeq}`;
			ownIds.set(id, forAgent);
			if (forAgent != null) handedOff.add(forAgent);
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
				let ok = false;
				try {
					ok = await attach();
				} catch (err) {
					log(`re-attach failed: ${err?.message ?? err}`);
					ok = false;
				} finally {
					// Cleared in a microtask so every caller awaiting THIS attempt sees
					// the same result before a new one can start.
					queueMicrotask(() => {
						reattaching = null;
					});
				}
				if (ok) {
					log(`re-attached to http://127.0.0.1:${attachedPort}/mcp`);
					// Only NOW can we say these can never be answered: we really did
					// mint a new session, so the stream carrying their replies is gone.
					// Swept here, once, rather than by each caller - per caller, two
					// concurrent failures each failed the OTHER's request and then
					// retried it, giving one id both an error and a result. A relay
					// still running answers its own id, so it is exempt.
					// `handedOff` is exempt for the same reason `relaying` is: the attach
					// that just succeeded replayed the agent's own `initialize` under a
					// synthetic id, so its answer is ALREADY on the wire and comes back
					// under the agent's id. Sweeping it gave that id an error AND, moments
					// later, the replay's result - and it failed the very handshake this
					// recovery exists to complete.
					for (const id of [...pending]) {
						if (relaying.has(id) || handedOff.has(id)) continue;
						failRequest(
							id,
							LOST_RESULT_MESSAGE
						);
					}
				}
				return ok;
			})();
		}
		return reattaching;
	};

	/**
	 * Is the instance we are attached to really gone?
	 *
	 * Asked only about an ambiguous `connection` failure, to keep a transient blip
	 * from tearing down a session with long runs streaming on it. Two independent
	 * signals, either of which settles it: runtime.json now names a DIFFERENT mcp
	 * port (a replacement registered itself), or the instance it names does not
	 * answer. Unverifiable reads as gone - the caller then re-attaches, which
	 * simply refuses if nothing is serving.
	 */
	const instanceGone = async () => {
		try {
			const cur = readRuntimeFn(workspace);
			if (!cur || cur.mcpPort !== attachedPort) return true;
			return !(await isAliveFn(cur));
		} catch (err) {
			log(`could not confirm the instance (${err?.message ?? err}); treating it as gone`);
			return true;
		}
	};

	/**
	 * Answer one request whose send failed AMBIGUOUSLY. Separate from the two
	 * messages above because it is a different fact: we do not know whether it
	 * arrived, so it is neither "lost" nor "not completed".
	 */
	const failAmbiguous = (msg) => {
		if (!isRequest(msg)) return;
		failRequest(msg.id, AMBIGUOUS_SEND_MESSAGE);
	};

	/**
	 * Has the recovery already taken responsibility for answering this request?
	 *
	 * Asked BEFORE any verdict `deliver` would otherwise reach, at every site where
	 * a re-attach may have run, because a yes makes every other question moot: the
	 * id is either already answered (`pending` no longer holds it - the sweep, the
	 * real server, an earlier failure) or HANDED OFF, meaning `attach()` replayed
	 * the agent's own `initialize` under a synthetic id and its reply is already on
	 * the wire under this one. Reached after a resend verdict instead, an
	 * ambiguously-failed handshake was answered with the ambiguous-write error while
	 * a perfectly good session sat attached: the replay's real result then arrived,
	 * found the id gone and was dropped, so the agent's `initialize` failed for the
	 * life of that spawn - the exact handshake the hand-off exists to complete.
	 */
	const settledByRecovery = (msg, isReq) => isReq && (!pending.has(msg.id) || handedOff.has(msg.id));

	/** Answer one request with the "nothing is serving this folder" error. */
	const failUnreachable = (msg) => {
		if (!isRequest(msg)) return;
		failRequest(
			msg.id,
			`Cellar is not reachable in ${workspace}: no running instance answered. ` +
				'Start it there (`cd ' +
				workspace +
				' && cellar`) and call again - this bridge reconnects on its own.'
		);
	};

	/**
	 * Relay one agent message upstream, recovering only from a failure that is
	 * evidence the SESSION is gone (see the module header).
	 */
	const relayUp = async (msg) => {
		if (isInitializeRequest(msg)) initRequest = msg;
		const isReq = isRequest(msg);
		if (isReq) {
			pending.add(msg.id);
			relaying.add(msg.id);
		}
		try {
			await deliver(msg, isReq);
		} finally {
			if (isReq) relaying.delete(msg.id);
		}
	};

	/**
	 * The body of one relay: send, and recover only from a failure that is
	 * evidence the session is gone. Bounded so a flapping instance can never spin
	 * here - at most the current session, one same-session retry, and a session
	 * adopted from (or minted by) a re-attach.
	 */
	const deliver = async (msg, isReq) => {
		let sameSessionRetried = false;
		// TWO INDEPENDENT QUESTIONS, and they must not be collapsed into one return.
		// "Is the SESSION gone" is answered below by `instanceGone()` / `reattach()`
		// and heals the transport for every OTHER message riding it; "may THIS message
		// go on the wire again" is answered by `provesNotDelivered` and belongs to
		// this call alone. Answering only the second one left the bridge sitting on a
		// dead session after an ambiguous failure, so a long `run_cell` already in
		// flight - whose reply provably could no longer arrive - hung until the host's
		// timeout, which is the exact symptom this bridge exists to remove.
		let mayResend = true;
		for (let attempt = 0; attempt < 4; attempt++) {
			const t = upstream;
			if (t) {
				let kind;
				try {
					await t.send(msg);
					return;
				} catch (err) {
					if (closing) return;
					kind = classifyUpstreamFailure(err);
					if (kind === 'other') {
						// A live, session-valid server rejecting THIS message. Detaching
						// here would abort every other in-flight run over a failure that
						// belongs to one request, so relay it and leave the session alone.
						log(`upstream rejected the request (${err?.message ?? err})`);
						if (isReq) failRequest(msg.id, `Cellar rejected the request: ${err?.message ?? err}`);
						return;
					}
					log(`upstream send failed (${err?.message ?? err})`);
					// THE RESEND GATE, and it is deliberately ASYMMETRIC between a request
					// and a notification - both go through here, and this is the ONE place
					// any of the three resend paths below can be reached from.
					//
					// A REQUEST may only be put on the wire again when the failure PROVES
					// it never reached the server's dispatcher (see `provesNotDelivered`),
					// because Cellar's write tools are NOT idempotent: `add_cells` /
					// `delete_cells` / `edit_cell` applied twice corrupt the user's
					// notebook, which is their primary data. An ambiguous socket failure
					// cannot tell "never arrived" from "arrived, ran, and the reply died
					// with the socket", so it is reported honestly rather than replayed -
					// a visible failure beats a silent duplicate mutation, and the agent
					// can check state and decide for itself.
					//
					// A NOTIFICATION carries no id and earns no response, so a duplicate
					// delivery of one is invisible; it keeps the full recovery. That is why
					// the asymmetry costs the bridge nothing structurally: the handshake's
					// `notifications/initialized` still survives a blip.
					//
					// This does NOT weaken the headline flow. A restart is answered either
					// by a session refusal (same port) or by a refused connection (new
					// port), and both PROVE non-delivery - so "restart Cellar, the agent's
					// next call just works" is untouched.
					if (isReq && !provesNotDelivered(err)) mayResend = false;
				}
				// A concurrent relay re-attached while we were failing: its session is
				// ours too. Take it rather than minting a second one, which would close
				// the transport that relay is still using out from under it. The session
				// question is already answered here - it healed - so all that is left is
				// whether THIS message may ride it.
				if (upstream && upstream !== t) {
					if (settledByRecovery(msg, isReq)) return;
					if (mayResend) continue;
					return failAmbiguous(msg);
				}
				if (kind === 'connection') {
					// THE SESSION QUESTION, asked on EVERY connection-class failure and
					// never switched off by a resend counter. `sameSessionRetried` bounds
					// how many times ONE MESSAGE goes back on the wire; `instanceGone()`
					// answers whether the SESSION is gone. Letting one flag decide both -
					// skipping the confirmation once a retry had been spent - meant a second
					// blip fell straight through to `reattach()` with no evidence at all,
					// tearing down a session against an instance provably alive on our own
					// port: every in-flight POST aborted and every pending request swept as
					// lost, which is the cardinal sin this module's header names.
					if (!(await instanceGone())) {
						// The recorded instance still names our port and answers, so this was
						// a blip (a stale keep-alive socket), not a replacement. A fresh
						// socket is all it takes, and the session - with whatever long run is
						// streaming on it - survives. There is nothing to heal, so nothing
						// here may re-attach, whatever this message's own fate.
						if (!mayResend) return failAmbiguous(msg);
						if (sameSessionRetried) {
							log('the instance is alive but the connection keeps failing; giving up on this message');
							break;
						}
						sameSessionRetried = true;
						log('the instance is still alive; retrying on the same session');
						continue;
					}
				}
			}

			// The SESSION question, asked whatever this message's own fate: a re-attach
			// heals the transport for every other message riding it, and its sweep is
			// what promptly answers the requests whose replies died with the old server.
			const ok = await reattach();
			// A failed re-attach is checked FIRST, because `attach()` registers the
			// hand-off before it sends the replay: a throw in between leaves the id
			// marked handed-off with nothing on the wire, so it must still be answered.
			if (!ok) return mayResend ? failUnreachable(msg) : failAmbiguous(msg);
			// Then the recovery's own claim on this id - already answered, or handshook
			// on its behalf - which outranks the resend verdict below: there is nothing
			// left to send and nothing ambiguous left to report.
			if (settledByRecovery(msg, isReq)) return;
			if (!mayResend) return failAmbiguous(msg);
		}
		if (isReq) {
			failRequest(
				msg.id,
				'Cellar kept dropping the connection, so the request was not completed. Call again.'
			);
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
