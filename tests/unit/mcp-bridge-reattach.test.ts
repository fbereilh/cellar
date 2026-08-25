import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http, { type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { runMcpBridge, NO_INSTANCE_ERROR_CODE, provesNotDelivered } from '../../src/lib/server/mcp-bridge.js';
import { writeRuntime, clearRuntime, pidAlive } from '../../src/lib/server/runtime.js';

/**
 * `cellar mcp` re-attaches across a Cellar restart.
 *
 * The bug: restarting Cellar replaced the app process and every Streamable-HTTP
 * MCP session with it, but the bridge - a separate process the AGENT's host
 * owns - outlived that and never noticed, because the SDK's client transport
 * reports a dead upstream through `onerror` while `onclose` fires only from its
 * own `close()`. A live-but-useless stdio child looks healthy to the host, which
 * respawns one only when it EXITS, so every later tool call failed until the
 * human restarted the MCP connection by hand.
 *
 * The port is not the cause: the "same port" test below reproduces the identical
 * `-32000 No valid session` failure with the address held FIXED, which is why a
 * stable port cannot be the cure and the fix lives in the bridge.
 *
 * These tests drive the REAL bridge against a REAL HTTP server that speaks the
 * same session protocol as `mcp/server.ts` (unknown session ⇒ 400 -32000), with
 * only the agent-facing stdio transport faked so messages can be injected.
 */

/** Method a test uses to hold a request open, the way a real cell run does. */
const SLOW = 'tools/call/slow';

/**
 * A minimal stand-in for Cellar's MCP HTTP endpoint, with the same session rule.
 * `port` 0 (the default) takes an ephemeral one; pass one to rebind the address
 * a previous "instance" used, which is how the same-port case is staged.
 *
 * `failStatus` maps a method to a status this server answers it with - the way a
 * healthy, session-valid Cellar refuses one message (a 429 or a 500). `SLOW`
 * answers its headers at once and holds the response stream open until
 * `release()`, which is how a real `run_cell` behaves for the length of a run:
 * the POST resolves immediately, and the reply arrives later over SSE.
 */
function startFakeCellar(
	port = 0,
	{
		failStatus = {},
		failBody = {},
		holdInitialize = false,
		holdNotification = false,
		parkInitialize = false
	}: {
		failStatus?: Record<string, number>;
		failBody?: Record<string, string>;
		/**
		 * Answer `initialize` with its session header and an OPEN event stream,
		 * flushing the RESULT only on `releaseInitialize()`. That is the same
		 * headers-now-body-later shape `SLOW` uses, and it is the only way to hold
		 * a handshake un-answered while the bridge's own re-attach carries on -
		 * which is what a second re-attach then races.
		 */
		holdInitialize?: boolean;
		/**
		 * Never answer `notifications/initialized` AT ALL - not even headers, so the
		 * client's `fetch` stays pending. `attach()` sends that notification as its
		 * last step, so this parks a re-attach mid-flight and lets a test decide
		 * exactly when the instance dies underneath it: the one window in which an
		 * upstream error arrives while `reattaching` is still set.
		 */
		holdNotification?: boolean;
		/**
		 * Never answer `initialize` at ALL - not even headers, so the client's
		 * `fetch` stays pending. That is the wedged-but-accepting instance: the
		 * kernel completes the TCP handshake while the app's event loop is blocked,
		 * so a re-handshake send has nothing to time it out but undici's ~300s
		 * default.
		 */
		parkInitialize?: boolean;
	} = {}
) {
	const sessions = new Set<string>();
	const seen: { method?: string; sessionId?: string }[] = [];
	const held: { id: unknown; res: http.ServerResponse }[] = [];
	const heldInit: { id: unknown; res: http.ServerResponse }[] = [];
	const heldNotes: http.ServerResponse[] = [];
	const parkedInit: http.ServerResponse[] = [];
	const sockets = new Set<import('node:net').Socket>();
	let server: Server;
	const listening = new Promise<number>((resolve) => {
		server = http.createServer((req, res) => {
			// EVERY response closes its connection, so a test can never leave the
			// bridge holding a pooled keep-alive socket to an "instance" it is about
			// to kill. Undici reuses such a socket and only learns it is dead when
			// the POST written onto it fails `UND_ERR_SOCKET: other side closed` - a
			// connection that OPENED and then broke, i.e. the deliberately AMBIGUOUS
			// case that is never re-sent, rather than either of the two shapes a
			// restart really presents (a refused connection on a new port, or a live
			// server answering `-32000` on the same one). Whether that socket is
			// still pooled milliseconds after the kill is pure platform timing -
			// macOS had evicted it, Linux on node 20 had not - so with keep-alive on,
			// each restart test picked at random which contract it was asserting.
			// A real restart is seconds of idle apart, past both node's 5s
			// `keepAliveTimeout` and undici's 4s, so the pooled socket is gone; the
			// tests compress it into one tick, and this restores what that tick
			// stands for. The ambiguous path keeps its own coverage (the flaky-proxy
			// tests and the `provesNotDelivered` block below), so nothing is lost.
			//
			// Only a response that ENDS here may carry it: a body with no length and
			// `Connection: close` is close-DELIMITED, so destroying such a socket is
			// a clean end of body rather than an error - which would silence the very
			// `onerror` the stream-loss heal is driven by. The two branches that hold
			// a stream open therefore take it back off (see below), and they never
			// leave an idle pooled socket anyway: their socket is busy until released.
			res.setHeader('Connection', 'close');
			if (req.method === 'GET') {
				// A bare GET is the liveness probe (`isInstanceAlive`); any answer is proof.
				res.writeHead(400).end('missing or unknown session');
				return;
			}
			let body = '';
			req.on('data', (c) => (body += c));
			req.on('end', () => {
				const msg = JSON.parse(body || '{}');
				const sid = req.headers['mcp-session-id'] as string | undefined;
				seen.push({ method: msg.method, sessionId: sid });
				const isInit = msg.method === 'initialize';
				if (isInit) {
					if (parkInitialize) {
						parkedInit.push(res);
						return;
					}
					const id = randomUUID();
					sessions.add(id);
					if (holdInitialize) {
						// Chunked, not close-delimited: a destroyed socket must read as a
						// BROKEN stream, which is what the stream-loss heal reacts to.
						res.removeHeader('Connection');
						res.writeHead(200, {
							'content-type': 'text/event-stream',
							'cache-control': 'no-cache',
							'mcp-session-id': id
						});
						res.flushHeaders();
						heldInit.push({ id: msg.id, res });
						return;
					}
					res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': id });
					res.end(
						JSON.stringify({
							jsonrpc: '2.0',
							id: msg.id,
							result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake', version: '0' } }
						})
					);
					return;
				}
				if (!sid || !sessions.has(sid)) {
					// Byte-for-byte the refusal `mcp/server.ts` emits, and the one the
					// real reproduction produced after a same-port restart.
					res.writeHead(400, { 'content-type': 'application/json' }).end(
						JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'No valid session; send an initialize request first.' }, id: null })
					);
					return;
				}
				// `failStatus` is consulted BEFORE the notification short-circuit, so a
				// test can refuse a notification too - which is how the handshake's own
				// `notifications/initialized` is made to fail while its `initialize`
				// succeeds, the one ordering the bridge must not read as a failed
				// handshake.
				const fail = failStatus[msg.method as string];
				const isNotification = msg.id === undefined || msg.id === null;
				if (isNotification && holdNotification && msg.method === 'notifications/initialized') {
					heldNotes.push(res);
					return;
				}
				if (isNotification && fail === undefined) {
					res.writeHead(202).end();
					return;
				}
				if (fail !== undefined) {
					// A live server that KNOWS our session refusing this one message.
					// Deliberately not a session refusal: no -32000 under a 400.
					res.writeHead(fail, { 'content-type': 'application/json' }).end(
						failBody[msg.method as string] ??
							JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null })
					);
					return;
				}
				if (msg.method === SLOW) {
					// Headers now, body later: the POST resolves and the request sits
					// in flight on the session's stream, like a cell run in progress.
					// Chunked, not close-delimited, for the same reason as the held
					// handshake above: killing the instance must break this stream.
					res.removeHeader('Connection');
					res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
					// Node holds the header back until the first write, and the client's
					// POST does not resolve until it arrives - so flush it now, or the
					// request would not be "in flight", it would be un-sent.
					res.flushHeaders();
					held.push({ id: msg.id, res });
					return;
				}
				res.writeHead(200, { 'content-type': 'application/json' }).end(
					JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { echoed: msg.method, session: sid } })
				);
			});
		});
		server!.on('connection', (s) => {
			sockets.add(s);
			s.on('close', () => sockets.delete(s));
		});
		server!.listen(port, '127.0.0.1', () => {
			const addr = server.address();
			resolve(typeof addr === 'object' && addr ? addr.port : port);
		});
	});
	return {
		listening,
		sessionCount: () => sessions.size,
		seen,
		heldCount: () => held.length,
		/** Flush a handshake that was held open by `holdInitialize`. */
		releaseInitialize: () => {
			for (const h of heldInit.splice(0)) {
				h.res.write(
					`event: message\ndata: ${JSON.stringify({
						jsonrpc: '2.0',
						id: h.id,
						result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake', version: '0' } }
					})}\n\n`
				);
				h.res.end();
			}
		},
		/**
		 * Break the stream carrying a held request WITHOUT taking the instance down.
		 * That is the one shape the bridge must not over-react to: the reply is
		 * gone, but the session (and every other run on it) is provably fine.
		 */
		dropHeld: () => {
			for (const h of held.splice(0)) h.res.destroy();
		},
		/** Answer every held request, the way a finished run flushes its result. */
		release: () => {
			for (const h of held.splice(0)) {
				h.res.write(
					`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: h.id, result: { echoed: SLOW } })}\n\n`
				);
				h.res.end();
			}
		},
		// Destroy sockets as well as closing: a reaped instance takes its open
		// streams with it, and a held SSE response would otherwise keep the
		// server (and the test) waiting forever.
		close: () =>
			new Promise<void>((r) => {
				held.length = 0;
				heldInit.length = 0;
				heldNotes.length = 0;
				parkedInit.length = 0;
				for (const s of sockets) s.destroy();
				server.close(() => r());
			})
	};
}

/** The agent-facing half: lets a test inject messages and read what came back. */
function fakeStdio() {
	const sent: Record<string, unknown>[] = [];
	// `runMcpBridge` starts its stdio transport as the LAST step of coming up, and
	// only once the startup `attach()` has succeeded - so this flag is the exact
	// moment the bridge is ready to relay. See `startBridge`, which waits for it.
	let started = false;
	const t = {
		onmessage: undefined as ((m: unknown) => void) | undefined,
		onerror: undefined as ((e: Error) => void) | undefined,
		onclose: undefined as (() => void) | undefined,
		start: async () => {
			started = true;
		},
		close: async () => {},
		send: async (m: Record<string, unknown>) => {
			sent.push(m);
		}
	};
	return {
		transport: t,
		sent,
		/** True once the bridge has finished coming up and started this transport. */
		started: () => started,
		/** Everything the bridge has sent down for one id - the count is the point. */
		repliesFor: (id: unknown) => sent.filter((m) => m.id === id),
		/** Deliver a message without waiting, so several can be in flight at once. */
		post: (msg: Record<string, unknown>) => t.onmessage?.(msg),
		/** Deliver a message from the "agent" and wait for the reply it expects. */
		async request(msg: Record<string, unknown>, timeoutMs = POLL_MS) {
			const before = sent.length;
			t.onmessage?.(msg);
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				const reply = sent.slice(before).find((m) => m.id === msg.id);
				if (reply) return reply;
				await new Promise((r) => setTimeout(r, 10));
			}
			throw new Error(`no reply for id ${String(msg.id)} within ${timeoutMs}ms`);
		},
		/** Wait for a reply to an id posted earlier. */
		async awaitReply(id: unknown, timeoutMs = POLL_MS) {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				const reply = sent.find((m) => m.id === id);
				if (reply) return reply;
				await new Promise((r) => setTimeout(r, 10));
			}
			throw new Error(`no reply for id ${String(id)} within ${timeoutMs}ms`);
		}
	};
}

/**
 * The ceiling every poll-until helper below waits to, and it is deliberately far
 * above what any of them needs on a quiet machine.
 *
 * They are POLL loops - each returns the instant its condition holds - so the
 * ceiling costs nothing when things work and only decides how long a genuinely
 * stuck bridge takes to FAIL. At 3s it was instead deciding something else: this
 * file drives a real HTTP server, a real `StreamableHTTPClientTransport` and real
 * reconnect handshakes, and the suite runs ~180 files across `cpus - 1` forks that
 * each spawn again, so a correct-but-contended handshake legitimately spent more
 * than 3s and the file failed on full runs while passing in isolation - the same
 * harness arithmetic `vitest.config.ts` records for its 30s default, one layer in.
 * Kept under the 30s vitest budget so a real hang still surfaces as this file's
 * own error rather than as an opaque suite timeout.
 *
 * SCOPE: the poll-until helpers ONLY. A call site whose timeout IS the assertion -
 * the wedged-instance case below, which proves the re-handshake send is BOUNDED -
 * must keep its own explicit, tight number, or a partially-regressed bound passes.
 */
const POLL_MS = 15_000;

/**
 * A pass-through in front of a fake Cellar that can drop ONE POST by destroying
 * its socket - a real ECONNRESET / "socket hang up", the way a server closing a
 * keep-alive connection at its idle boundary looks to a client that just reused
 * it. The instance behind it stays up throughout, which is the whole point: the
 * bridge must not read a blip as a replacement.
 */
function startFlakyProxy(targetPort: number) {
	let dropPosts = 0;
	let target = targetPort;
	const sockets = new Set<import('node:net').Socket>();
	let server: Server;
	const listening = new Promise<number>((resolve) => {
		server = http.createServer((req, res) => {
			if (dropPosts > 0 && req.method === 'POST') {
				dropPosts--;
				req.socket.destroy();
				return;
			}
			const up = http.request(
				{ host: '127.0.0.1', port: target, path: req.url, method: req.method, headers: req.headers },
				(upRes) => {
					res.writeHead(upRes.statusCode ?? 502, upRes.headers);
					// Node holds the headers back until the first body write, so a proxied
					// event-stream reply would never reach the client until the run ended -
					// i.e. the POST would not resolve and the request would not be "in
					// flight" at all. A real reverse proxy passes them straight through.
					res.flushHeaders();
					upRes.pipe(res);
				}
			);
			up.on('error', () => res.destroy());
			req.pipe(up);
		});
		server!.on('connection', (s) => {
			sockets.add(s);
			s.on('close', () => sockets.delete(s));
		});
		server!.listen(0, '127.0.0.1', () => {
			const addr = server.address();
			resolve(typeof addr === 'object' && addr ? addr.port : 0);
		});
	});
	return {
		listening,
		/** Drop the next `n` POSTs. GETs pass through, so the liveness probe still answers. */
		dropNext: (n = 1) => {
			dropPosts = n;
		},
		/**
		 * Point at a different instance while keeping this address. That is what a
		 * folder reclaiming its remembered MCP port looks like to the bridge: the
		 * SAME port, a DIFFERENT instance behind it.
		 */
		retarget: (port: number) => {
			target = port;
		},
		close: () =>
			new Promise<void>((r) => {
				for (const s of sockets) s.destroy();
				server.close(() => r());
			})
	};
}

/**
 * A port nothing is listening on - taken ephemerally and released, so it is a
 * real address that provably refuses a connection rather than a guess.
 */
async function deadPort(): Promise<number> {
	const srv = http.createServer();
	const port = await new Promise<number>((resolve) =>
		srv.listen(0, '127.0.0.1', () => {
			const a = srv.address();
			resolve(typeof a === 'object' && a ? a.port : 0);
		})
	);
	await new Promise<void>((r) => srv.close(() => r()));
	return port;
}

/**
 * The liveness probe the bridge is given here: `isInstanceAlive` with its
 * STOPWATCH taken out, and nothing else changed.
 *
 * That stopwatch is a FLAKE, and it is the bridge's own branch selector. The real
 * probe aborts its GET after 1500ms of WALL CLOCK and reports the abort as "not
 * alive" - but every fake instance, every proxy and the bridge itself share this
 * worker's ONE event loop, and the unit suite forks per CPU with each fork
 * spawning again, so under full-suite load that budget expires for an instance
 * that was listening the whole time (measured: a single probe here taking 392ms
 * on a contended run, an order of magnitude over its quiet-machine cost). Nothing
 * about a timer is the contract under test, but the answer decides which branch
 * the bridge takes, so the lie landed as a different assertion failure depending
 * on where it struck - a startup `attach()` giving up (`onFatal(1)`), `deliver`'s
 * one-reading `instanceGone()` minting a second session against a live instance,
 * or the heal's corroborated gate convicting one.
 *
 * Untimed, the same GET answers on the SIGNAL instead: a served port responds, an
 * unbound one refuses at once (every port here is one or the other), and a
 * contended worker makes the verdict LATE rather than WRONG - which the poll-until
 * helpers already absorb. The request, and therefore the latency shape the
 * concurrent-relay cases interleave against, is unchanged.
 */
async function probeInstance(rt: unknown): Promise<boolean> {
	const r = rt as { mcpPort?: number; pid?: number } | null | undefined;
	if (!r || !r.mcpPort) return false;
	// The pid half of the real rule is kept as-is: a test that swaps in a
	// genuinely-alive pid leans on it (the same-port replacement case).
	if (!pidAlive(r.pid)) return false;
	try {
		// Any answer is proof, exactly as in `mcpPortResponds`.
		await fetch(`http://127.0.0.1:${r.mcpPort}/mcp`, { method: 'GET' });
		return true;
	} catch {
		return false;
	}
}

/** Poll until `fn` is true, so a test never leans on a fixed sleep. */
async function until(fn: () => boolean, timeoutMs = POLL_MS) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (fn()) return;
		await new Promise((r) => setTimeout(r, 10));
	}
	throw new Error(`condition not met within ${timeoutMs}ms`);
}

const INIT = {
	jsonrpc: '2.0',
	id: 1,
	method: 'initialize',
	params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '0' } }
};

describe('cellar mcp bridge - surviving a Cellar restart', () => {
	let ws: string;
	const running: { close: () => Promise<void> }[] = [];
	let stopBridge: (() => void) | undefined;

	beforeEach(() => {
		ws = mkdtempSync(join(tmpdir(), 'cellar-bridge-'));
	});
	afterEach(async () => {
		stopBridge?.();
		stopBridge = undefined;
		for (const s of running.splice(0)) await s.close();
		rmSync(ws, { recursive: true, force: true });
	});

	/** Boot the real bridge against `ws`, with only the stdio side faked. */
	async function startBridge(
		opts: {
			isAliveFn?: (rt: unknown) => Promise<boolean> | boolean;
			handshakeTimeoutMs?: number;
			healConfirmDelayMs?: number;
		} = {}
	) {
		const stdio = fakeStdio();
		let fatal: number | undefined;
		// Ids whose POST has RESOLVED upstream, i.e. that are genuinely in flight on
		// the session rather than still being written. The real transport does the
		// work; this only records when its `send` settled, which is the moment a
		// test may treat the request as established.
		const inFlight = new Set<unknown>();
		const done = runMcpBridge({
			workspace: ws,
			makeStdio: () => stdio.transport,
			makeUpstream: (url: URL) => {
				const t = new StreamableHTTPClientTransport(url);
				const send = t.send.bind(t);
				t.send = async (m: Parameters<typeof send>[0], o?: Parameters<typeof send>[1]) => {
					await send(m, o);
					if (m && typeof m === 'object' && 'id' in m && m.id !== undefined) inFlight.add(m.id);
				};
				return t;
			},
			onFatal: (code: number) => {
				fatal = code;
			},
			// Silence the bridge's stderr diagnostics; the assertions read behavior.
			log: () => {},
			// See `probeInstance`: the real probe's own 1500ms wall clock is what
			// made this file shed a different test per contended run. A test whose
			// SUBJECT is a particular verdict still scripts its own, below.
			isAliveFn: (rt: unknown) => probeInstance(rt),
			// Keep the corroboration re-check quick so a test is not paced by it; the
			// RULE under test is the number of consecutive readings, not the gap.
			healConfirmDelayMs: 20,
			...opts
		});
		stopBridge = () => stdio.transport.onclose?.();
		// WAIT FOR THE SIGNAL, never a fixed delay. This used to sleep 50ms for the
		// startup attach - but `runMcpBridge` awaits its liveness probe BEFORE it
		// wires `stdio.onmessage`, and `fakeStdio.post`/`request` drop a message
		// silently while that is undefined. On a contended machine that probe alone
		// took hundreds of milliseconds, so the very first `stdio.request(INIT)`
		// vanished and the test then waited out its whole poll budget - "no reply
		// for id 1 within 15000ms", the shape this file shed under full-suite load.
		// `start()` is the bridge's last step of coming up, so it is the honest
		// readiness signal; `fatal` is the other terminal outcome, and waiting for
		// either means a startup that genuinely fails still reports as itself
		// rather than hanging here.
		await until(() => stdio.started() || fatal !== undefined);
		return { stdio, done, fatal: () => fatal, inFlight };
	}

	/** Bring an "instance" up for `ws` and publish it the way a launch does. */
	async function bootCellar(
		port = 0,
		opts?: {
			failStatus?: Record<string, number>;
			failBody?: Record<string, string>;
			holdInitialize?: boolean;
			holdNotification?: boolean;
			parkInitialize?: boolean;
		}
	) {
		const c = startFakeCellar(port, opts);
		const p = await c.listening;
		running.push(c);
		writeRuntime(ws, { mcpPort: p, appPort: p + 1, jupyterPort: p + 2, pid: process.pid });
		// Augment in place, not a spread copy: `killCellar` finds it by identity.
		return Object.assign(c, { port: p });
	}

	/** Take the current "instance" down, the way a restart's reap does. */
	async function killCellar(c: { close: () => Promise<void> }, { clear = true } = {}) {
		await c.close();
		const i = running.indexOf(c as never);
		if (i !== -1) running.splice(i, 1);
		if (clear) clearRuntime(ws, process.pid);
	}

	it('re-attaches and answers when the instance is replaced on a NEW port', async () => {
		const first = await bootCellar();
		const { stdio } = await startBridge();
		await stdio.request(INIT);
		stdio.transport.onmessage?.({ jsonrpc: '2.0', method: 'notifications/initialized' });
		expect(await stdio.request({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).toMatchObject({
			result: { echoed: 'tools/list' }
		});

		// Cellar restarts: old instance gone, a new one comes up on a DIFFERENT port.
		await killCellar(first);
		const second = await bootCellar();
		expect(second.port).not.toBe(first.port);

		// The agent simply calls again. No human reconnect, no restart.
		const reply = await stdio.request({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, 8000);
		expect(reply).toMatchObject({ result: { echoed: 'tools/list' } });
		expect(reply.error).toBeUndefined();
		// It re-ran the handshake against the new server to mint a fresh session.
		expect(second.sessionCount()).toBe(1);
		expect(second.seen.some((s) => s.method === 'initialize')).toBe(true);
	});

	it('re-attaches when the instance is replaced on the SAME port - the port was never the cause', async () => {
		const first = await bootCellar();
		const { stdio } = await startBridge();
		await stdio.request(INIT);
		await stdio.request({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

		// Hold the address FIXED across the restart. The SESSION still dies, which
		// is what makes a stable port no cure at all for this failure.
		const port = first.port;
		await killCellar(first);
		const replacement = await bootCellar(port);
		expect(replacement.port).toBe(port);

		const reply = await stdio.request({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, 8000);
		expect(reply).toMatchObject({ result: { echoed: 'tools/list' } });
		// It really did mint a new session rather than reuse the dead one.
		expect(replacement.sessionCount()).toBe(1);
	});

	it('does not exit when its upstream dies - the bridge must outlive one instance', async () => {
		const first = await bootCellar();
		const { stdio, fatal } = await startBridge();
		await stdio.request(INIT);
		await killCellar(first, { clear: false });
		await new Promise((r) => setTimeout(r, 100));
		// Nothing fatal, and the relay is still wired: it is waiting for the folder
		// to be served again, which is what makes the self-heal possible at all.
		expect(fatal()).toBeUndefined();
		expect(typeof stdio.transport.onmessage).toBe('function');
	});

	it('fails a request promptly, with an actionable message, when nothing is serving', async () => {
		const first = await bootCellar();
		const { stdio } = await startBridge();
		await stdio.request(INIT);

		await killCellar(first);

		const reply = await stdio.request({ jsonrpc: '2.0', id: 9, method: 'tools/list' }, 8000);
		// Not a 60s hang until the host times out: a named error the agent can act on.
		expect(reply.error).toMatchObject({ code: NO_INSTANCE_ERROR_CODE });
		expect(String((reply.error as { message: string }).message)).toContain(ws);
		expect(String((reply.error as { message: string }).message)).toContain('cellar');
	});

	it('heals on the NEXT call once Cellar comes back', async () => {
		const first = await bootCellar();
		const { stdio } = await startBridge();
		await stdio.request(INIT);
		await killCellar(first);

		// Call while nothing is running: refused.
		const refused = await stdio.request({ jsonrpc: '2.0', id: 10, method: 'tools/list' }, 8000);
		expect(refused.error).toBeDefined();

		// Cellar comes back. The very next call works, with no host intervention -
		// a bridge left running across a restart is not permanently poisoned.
		await bootCellar();
		const ok = await stdio.request({ jsonrpc: '2.0', id: 11, method: 'tools/list' }, 8000);
		expect(ok).toMatchObject({ result: { echoed: 'tools/list' } });
	});

	it('relays a non-session rejection as one error and leaves the session - and the run in flight - alone', async () => {
		// The bridge used to re-attach on ANY send failure. `send()` rejects for a
		// 429 or a 500 from a perfectly healthy, session-valid server too, and
		// tearing the session down there aborts every other in-flight request -
		// including the cell run this bridge exists to keep alive.
		const cellar = await bootCellar(0, { failStatus: { 'tools/call': 500 } });
		const { stdio } = await startBridge();
		await stdio.request(INIT);
		stdio.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
		const sessionsBefore = cellar.sessionCount();

		// A long call is in flight, its stream open on this session.
		stdio.post({ jsonrpc: '2.0', id: 2, method: SLOW });
		await until(() => cellar.heldCount() === 1);

		// A concurrent call the server refuses with a 500.
		const refused = await stdio.request({ jsonrpc: '2.0', id: 3, method: 'tools/call' });
		expect(refused.error).toBeDefined();

		// The session was NOT torn down: no second handshake, so no new session.
		expect(cellar.sessionCount()).toBe(sessionsBefore);
		// ...and the long call was not answered on its behalf, nor aborted: it is
		// still running, and still completes.
		expect(stdio.repliesFor(2)).toHaveLength(0);
		cellar.release();
		expect(await stdio.awaitReply(2)).toMatchObject({ result: { echoed: SLOW } });
		expect(stdio.repliesFor(3)).toHaveLength(1);
	});

	it('does not read a session phrase in a 500 body as a session refusal', async () => {
		// The SDK folds the response BODY into the error message, and Cellar's own
		// outer catch answers `500 'mcp error: ' + String(err)`. A tool failure that
		// merely MENTIONS a session (a Spark Connect session, say) must not be read
		// as the server refusing ours: that is the over-trigger reached by the other
		// door, and it would abort every run streaming on a healthy session.
		const cellar = await bootCellar(0, {
			failStatus: { 'tools/call': 500 },
			failBody: { 'tools/call': 'mcp error: Error: [SESSION_CLOSED] Spark Connect session expired' }
		});
		const { stdio } = await startBridge();
		await stdio.request(INIT);
		stdio.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
		const sessionsBefore = cellar.sessionCount();

		stdio.post({ jsonrpc: '2.0', id: 2, method: SLOW });
		await until(() => cellar.heldCount() === 1);

		const refused = await stdio.request({ jsonrpc: '2.0', id: 3, method: 'tools/call' });
		expect(refused.error).toBeDefined();
		expect(cellar.sessionCount()).toBe(sessionsBefore);
		expect(stdio.repliesFor(2)).toHaveLength(0);
		cellar.release();
		expect(await stdio.awaitReply(2)).toMatchObject({ result: { echoed: SLOW } });
	});

	it("completes the agent's OWN initialize when it is what hits the dead instance", async () => {
		// The bridge attached at startup, then Cellar was replaced before the agent
		// got its handshake in. The re-attach replays that very initialize to mint a
		// session, so re-sending it too would earn `-32600 Server already
		// initialized` and leave the connection unusable for this whole spawn.
		const first = await bootCellar();
		const { stdio } = await startBridge();
		await killCellar(first);
		const second = await bootCellar();

		const reply = await stdio.request(INIT, 8000);
		expect(reply).toMatchObject({ id: INIT.id, result: { protocolVersion: '2025-06-18' } });
		expect(reply.error).toBeUndefined();
		// Exactly one response for the handshake id, and exactly one session minted.
		expect(stdio.repliesFor(INIT.id)).toHaveLength(1);
		expect(second.sessionCount()).toBe(1);

		// ...and the session really works.
		stdio.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
		expect(await stdio.request({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, 8000)).toMatchObject({
			result: { echoed: 'tools/list' }
		});
	});

	/** Bridge + flaky proxy in front of one instance, ready to drop a POST. */
	async function bridgeBehindFlakyProxy() {
		const cellar = await bootCellar();
		const proxy = startFlakyProxy(cellar.port);
		const proxyPort = await proxy.listening;
		running.push(proxy);
		// The bridge attaches through the proxy, so runtime.json names it: the
		// instance stays registered, alive, and on the SAME port throughout, which
		// is what makes a dropped POST a BLIP rather than a replacement.
		writeRuntime(ws, { mcpPort: proxyPort, appPort: proxyPort + 1, jupyterPort: proxyPort + 2, pid: process.pid });
		const { stdio } = await startBridge();
		await stdio.request(INIT);
		stdio.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
		return { cellar, proxy, stdio };
	}

	it('never re-sends a REQUEST whose connection broke ambiguously - it says so instead', async () => {
		// A socket that OPENED and then broke cannot distinguish "never arrived"
		// from "arrived, ran, and the reply died with the socket". Cellar's write
		// tools are not idempotent, so re-sending one there can apply an
		// `add_cells` / `delete_cells` twice and corrupt the user's notebook. The
		// honest answer is a visible failure that names the uncertainty.
		const { cellar, proxy, stdio } = await bridgeBehindFlakyProxy();
		const sessionsBefore = cellar.sessionCount();

		// A long call is in flight on this session.
		stdio.post({ jsonrpc: '2.0', id: 2, method: SLOW });
		await until(() => cellar.heldCount() === 1);

		// The next POST hits a socket the server drops under it.
		proxy.dropNext();
		const reply = await stdio.request({ jsonrpc: '2.0', id: 3, method: 'tools/call' }, 8000);

		// Reported, not replayed - and the report does not claim the call did not
		// happen, because that is exactly what cannot be known here.
		expect(reply.error).toMatchObject({ code: NO_INSTANCE_ERROR_CODE });
		expect(String((reply.error as { message: string }).message)).toMatch(/may or may not have been applied/i);
		expect(stdio.repliesFor(3)).toHaveLength(1);
		// It really was not put on the wire again: the proxy ate the only copy, so
		// the server never saw it at all.
		expect(cellar.seen.filter((m) => m.method === 'tools/call')).toHaveLength(0);

		// And the session was NOT torn down over it, so the long call is untouched
		// and still completes - the work this bridge exists to protect.
		expect(cellar.sessionCount()).toBe(sessionsBefore);
		expect(stdio.repliesFor(2)).toHaveLength(0);
		cellar.release();
		expect(await stdio.awaitReply(2)).toMatchObject({ result: { echoed: SLOW } });
	});

	it('still re-sends a NOTIFICATION dropped the same way - it has no id and earns no reply', async () => {
		// The asymmetry that keeps the recovery free: a duplicate delivery of a
		// notification is invisible, so a blip costs nothing there. Without the
		// retry the message is simply lost, and the server never sees it.
		const { cellar, proxy, stdio } = await bridgeBehindFlakyProxy();
		const sessionsBefore = cellar.sessionCount();

		proxy.dropNext();
		stdio.post({ jsonrpc: '2.0', method: 'notifications/progress', params: { n: 1 } });

		await until(() => cellar.seen.some((m) => m.method === 'notifications/progress'), 8000);
		// Recovered by retrying on the SAME session, not by re-handshaking.
		expect(cellar.sessionCount()).toBe(sessionsBefore);
	});

	it('still heals the SESSION on an ambiguous failure, even though it will not re-send', async () => {
		// Two independent questions. Declining the resend is about THIS message;
		// whether the session is gone is about every OTHER message riding it. Asked
		// only the first, the bridge sat on a dead session, so a long call already
		// in flight - whose reply provably can no longer arrive - hung until the
		// host's 60s timeout, which is the exact symptom this bridge removes.
		const cellar = await bootCellar();
		const proxy = startFlakyProxy(cellar.port);
		const proxyPort = await proxy.listening;
		running.push(proxy);
		writeRuntime(ws, { mcpPort: proxyPort, appPort: proxyPort + 1, jupyterPort: proxyPort + 2, pid: process.pid });

		const { stdio, inFlight } = await startBridge();
		await stdio.request(INIT);
		stdio.post({ jsonrpc: '2.0', method: 'notifications/initialized' });

		// A long call is established on the session that is about to die.
		stdio.post({ jsonrpc: '2.0', id: 2, method: SLOW });
		await until(() => cellar.heldCount() === 1 && inFlight.has(2));

		// The instance is REALLY replaced - a new one registers on its own port.
		await killCellar(cellar);
		const replacement = await bootCellar();

		// ...and the next POST is reset under us, which is AMBIGUOUS: it may have
		// been delivered to something, so it may not be replayed.
		proxy.dropNext();
		const reply = await stdio.request({ jsonrpc: '2.0', id: 3, method: 'tools/call' }, 8000);
		const ambiguous = reply.error as { code: number; message: string };
		expect(ambiguous).toMatchObject({ code: NO_INSTANCE_ERROR_CODE });
		expect(ambiguous.message).toMatch(/may or may not have been applied/i);
		expect(replacement.seen.filter((m) => m.method === 'tools/call')).toHaveLength(0);

		// The SESSION question was still asked, so the bridge re-attached - and its
		// sweep answered the long call promptly instead of leaving it to hang.
		const lost = (await stdio.awaitReply(2, 8000)).error as { code: number; message: string };
		expect(lost).toMatchObject({ code: NO_INSTANCE_ERROR_CODE });
		expect(lost.message).toMatch(/may or may not have been applied/i);
		expect(replacement.sessionCount()).toBe(1);
		expect(stdio.repliesFor(2)).toHaveLength(1);
		expect(stdio.repliesFor(3)).toHaveLength(1);

		// ...and the healed session really works, with no further intervention.
		expect(await stdio.request({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, 8000)).toMatchObject({
			result: { echoed: 'tools/list' }
		});
	});

	it("completes the agent's OWN initialize when it fails AMBIGUOUSLY, not just when it is refused", async () => {
		// The hand-off is what completes a handshake the agent is still waiting on:
		// the re-attach replays that very `initialize`, so its reply comes back
		// under the agent's id. Answering the id with the ambiguous-write verdict
		// first fails exactly that handshake - and the replay's real result then
		// arrives to find the id gone and is dropped, leaving the connection
		// unusable for the whole spawn while a working session sits attached.
		const cellar = await bootCellar();
		const proxy = startFlakyProxy(cellar.port);
		const proxyPort = await proxy.listening;
		running.push(proxy);
		writeRuntime(ws, { mcpPort: proxyPort, appPort: proxyPort + 1, jupyterPort: proxyPort + 2, pid: process.pid });

		// The bridge attaches at startup, before the agent has said anything.
		const { stdio } = await startBridge();

		// The instance is replaced, and the agent's handshake lands on a socket that
		// is RESET rather than refused - which is ambiguous, not proof. Its
		// handshake is HELD open, so the hand-off is genuinely still unanswered when
		// the recovery reaches its verdict for this message; answered inline it
		// would leave nothing for a premature verdict to destroy.
		await killCellar(cellar);
		const replacement = await bootCellar(0, { holdInitialize: true });
		proxy.dropNext();

		stdio.post(INIT);
		await until(() => replacement.seen.some((m) => m.method === 'initialize'), 8000);
		// Let the recovery settle while the replayed handshake is still in flight.
		await new Promise((r) => setTimeout(r, 100));
		replacement.releaseInitialize();

		const reply = await stdio.awaitReply(INIT.id, 8000);
		expect(reply).toMatchObject({ id: INIT.id, result: { protocolVersion: '2025-06-18' } });
		expect(reply.error).toBeUndefined();
		expect(stdio.repliesFor(INIT.id)).toHaveLength(1);
		expect(replacement.sessionCount()).toBe(1);

		// ...and the session it minted really works.
		stdio.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
		expect(await stdio.request({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, 8000)).toMatchObject({
			result: { echoed: 'tools/list' }
		});
	});

	it("keeps the agent's initialize when only the re-handshake's NOTIFICATION fails", async () => {
		// `attach()` sends two messages: the replay, which carries the handshake and
		// mints the session, and `notifications/initialized`, a courtesy that
		// follows it. A failure of the SECOND says nothing about the FIRST, and must
		// not retroactively fail it - the replay's result is already on its way, so
		// answering the agent's id with an error drops that result as a duplicate
		// and leaves the connection unusable while a working session sits attached.
		const first = await bootCellar();
		const { stdio } = await startBridge();
		await killCellar(first);
		// Holds its handshake open (so the hand-off is genuinely unanswered when the
		// notification fails) and refuses the notification that follows it.
		const second = await bootCellar(0, {
			holdInitialize: true,
			failStatus: { 'notifications/initialized': 500 }
		});

		stdio.post(INIT);
		await until(() => second.seen.some((m) => m.method === 'notifications/initialized'), 8000);
		// Let the failed notification's verdict land while the replay is in flight.
		await new Promise((r) => setTimeout(r, 100));
		second.releaseInitialize();

		const reply = await stdio.awaitReply(INIT.id, 8000);
		expect(reply).toMatchObject({ id: INIT.id, result: { protocolVersion: '2025-06-18' } });
		expect(reply.error).toBeUndefined();
		expect(stdio.repliesFor(INIT.id)).toHaveLength(1);
		expect(second.sessionCount()).toBe(1);
	});

	it('answers a request whose stream died, with NO follow-up call from the agent', async () => {
		// The headline case. A long `run_cell` is in flight when Cellar restarts: its
		// POST already resolved, so the id sits in `pending` with nothing left to
		// answer it, and MCP hosts serialize tool calls - so there is no next message
		// to drive the per-send recovery. It used to hang until the host's 60s
		// timeout, the very symptom this bridge exists to remove.
		const first = await bootCellar();
		const { stdio, inFlight } = await startBridge();
		await stdio.request(INIT);
		stdio.post({ jsonrpc: '2.0', method: 'notifications/initialized' });

		stdio.post({ jsonrpc: '2.0', id: 2, method: SLOW });
		await until(() => first.heldCount() === 1 && inFlight.has(2));
		const sentBefore = stdio.sent.length;

		// Cellar goes away. The agent sends NOTHING further.
		await killCellar(first);

		const lost = (await stdio.awaitReply(2, 8000)).error as { code: number; message: string };
		expect(lost).toMatchObject({ code: NO_INSTANCE_ERROR_CODE });
		// Honest on both counts: the result can never arrive, and whether the call was
		// applied is unknown - it must not read as an invitation to blindly retry.
		expect(lost.message).toMatch(/may or may not have been applied/i);
		expect(lost.message).not.toMatch(/call again/i);
		// Exactly one response, and it is the only thing that went down.
		expect(stdio.repliesFor(2)).toHaveLength(1);
		expect(stdio.sent.length).toBe(sentBefore + 1);
	});

	it('never tears down a live run because ONE liveness reading timed out', async () => {
		// The heal's only negative signal is a 1500ms GET timing out, and Cellar's app
		// process is documented to block its own event loop for longer than that (a
		// synchronous jupytext persist, a `git blame`, a large notebook
		// `JSON.stringify`). Acting on a single such reading detached, which ABORTS
		// the in-flight POST of the very run this module protects: `attach()` re-probed,
		// found the stall had cleared, and tore the healthy session down.
		const cellar = await bootCellar();
		let stalledReadings = 0;
		const { stdio, inFlight } = await startBridge({
			isAliveFn: async (rt: unknown) => {
				if (stalledReadings > 0) {
					stalledReadings--;
					return false;
				}
				return probeInstance(rt);
			}
		});
		await stdio.request(INIT);
		const sessionsBefore = cellar.sessionCount();

		// A long call is streaming - which is also what puts an id in the heal's own
		// gate, so this exposure exists exactly while the protected work runs.
		stdio.post({ jsonrpc: '2.0', id: 2, method: SLOW });
		await until(() => cellar.heldCount() === 1 && inFlight.has(2));

		// The app stalls for exactly ONE reading, then answers again.
		stalledReadings = 1;
		// `notifications/initialized` is answered 202, and the SDK then opens its
		// standalone GET stream, which this fake refuses - so the heal is driven
		// without touching the run's own stream, exactly like a proxy blip.
		stdio.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
		await new Promise((r) => setTimeout(r, 500));

		// Uncorroborated, so nothing was disturbed: no re-handshake, no answer.
		expect(cellar.sessionCount()).toBe(sessionsBefore);
		expect(stdio.repliesFor(2)).toHaveLength(0);
		// ...and the run really does finish and deliver its own result.
		cellar.release();
		expect(await stdio.awaitReply(2, 8000)).toMatchObject({ result: { echoed: SLOW } });
		expect(stdio.repliesFor(2)).toHaveLength(1);
	});

	it('still answers a stranded run once the instance is unreachable CONSECUTIVELY', async () => {
		// The other direction of the same bar: corroboration must raise the evidence
		// required, not switch the recovery off. Here the instance never answers
		// again, so the readings agree and the stranded run is answered rather than
		// left to hang.
		const cellar = await bootCellar();
		let unreachable = false;
		const { stdio, inFlight } = await startBridge({
			isAliveFn: async (rt: unknown) => (unreachable ? false : probeInstance(rt))
		});
		await stdio.request(INIT);

		stdio.post({ jsonrpc: '2.0', id: 2, method: SLOW });
		await until(() => cellar.heldCount() === 1 && inFlight.has(2));

		unreachable = true;
		stdio.post({ jsonrpc: '2.0', method: 'notifications/initialized' });

		const lost = (await stdio.awaitReply(2, 8000)).error as { code: number; message: string };
		expect(lost).toMatchObject({ code: NO_INSTANCE_ERROR_CODE });
		expect(lost.message).toMatch(/may or may not have been applied/i);
		expect(stdio.repliesFor(2)).toHaveLength(1);
	});

	it('needs no corroboration when the record itself says the instance was REPLACED', async () => {
		// Positive evidence settles it outright - the strike count applies only to
		// the one signal that cannot tell a stall from a death. Here the liveness
		// probe would say "alive" every time; the changed pid is what convicts.
		const cellar = await bootCellar();
		const { stdio, inFlight } = await startBridge({ isAliveFn: async () => true });
		await stdio.request(INIT);

		stdio.post({ jsonrpc: '2.0', id: 2, method: SLOW });
		await until(() => cellar.heldCount() === 1 && inFlight.has(2));

		// Same address, a DIFFERENT instance behind it.
		const alive = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' });
		running.push({ close: async () => void alive.kill() });
		writeRuntime(ws, {
			mcpPort: cellar.port,
			appPort: cellar.port + 1,
			jupyterPort: cellar.port + 2,
			pid: alive.pid
		});

		stdio.post({ jsonrpc: '2.0', method: 'notifications/initialized' });

		const lost = (await stdio.awaitReply(2, 8000)).error as { code: number; message: string };
		expect(lost).toMatchObject({ code: NO_INSTANCE_ERROR_CODE });
		expect(stdio.repliesFor(2)).toHaveLength(1);
	});

	it('does not park the whole recovery on a wedged instance that never answers', async () => {
		// The re-handshake sends are `fetch` calls the SDK gives no deadline, so a
		// wedged-but-accepting instance (TCP completes, the event loop is blocked)
		// parked them until undici's ~300s default. Parked, `reattaching` never
		// settles: every relay awaiting it hangs and the stream-loss heal is disabled
		// for the whole window - minutes past the host timeout this module exists to
		// avoid. Bounded, the attach settles and recovery keeps cycling.
		const first = await bootCellar();
		const { stdio, fatal } = await startBridge({ handshakeTimeoutMs: 200 });
		await stdio.request(INIT);

		// The replacement accepts connections and answers the liveness GET, but never
		// answers `initialize` at all.
		await killCellar(first);
		const wedged = await bootCellar(0, { parkInitialize: true });

		// The agent's next call must come back promptly rather than hang. 3s is far
		// under undici's default and far over the injected 200ms bound, so it fails
		// only if the send is genuinely unbounded.
		const reply = await stdio.request({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, 3000);
		expect(reply.error).toMatchObject({ code: NO_INSTANCE_ERROR_CODE });
		expect(wedged.seen.some((m) => m.method === 'initialize')).toBe(true);
		// The bridge is untouched and still relaying, ready to heal on the next launch.
		expect(fatal()).toBeUndefined();
		expect(typeof stdio.transport.onmessage).toBe('function');
	});

	it('leaves a session alone when the stream dies but the instance is ALIVE', async () => {
		// The other half of the same rule: the error itself is never the trigger.
		// `instanceGone()` is asked first, and a live instance means nothing happens -
		// tearing the session down here would abort exactly the long work this bridge
		// protects, which is the cardinal sin the module names.
		const cellar = await bootCellar();
		const { stdio, inFlight } = await startBridge();
		await stdio.request(INIT);
		stdio.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
		const sessionsBefore = cellar.sessionCount();

		stdio.post({ jsonrpc: '2.0', id: 2, method: SLOW });
		await until(() => cellar.heldCount() === 1 && inFlight.has(2));

		// The stream breaks; the instance behind it never moves.
		cellar.dropHeld();
		await new Promise((r) => setTimeout(r, 400));

		expect(cellar.sessionCount()).toBe(sessionsBefore);
		// Nothing was answered on the strength of an error alone - the stated residual.
		expect(stdio.repliesFor(2)).toHaveLength(0);
		// ...and the session is still usable.
		expect(await stdio.request({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, 8000)).toMatchObject({
			result: { echoed: 'tools/list' }
		});
	});

	it('sees a replacement that reclaimed the SAME port, because the pid changed', async () => {
		// A folder that REMEMBERS its ports makes "same mcp port" the expected shape
		// of a restart, not evidence of continuity - so identifying the attached
		// instance by its address alone stopped working. The port matched and the
		// REPLACEMENT answered the liveness probe, so a genuinely replaced instance
		// read as present: the failing request was answered honestly but the session
		// was never healed, and a long run already in flight hung until the host's
		// timeout - the very symptom this bridge exists to remove.
		const first = await bootCellar();
		const proxy = startFlakyProxy(first.port);
		const proxyPort = await proxy.listening;
		running.push(proxy);
		// The bridge's address for the whole test is the proxy's, so it never changes.
		writeRuntime(ws, { mcpPort: proxyPort, appPort: proxyPort + 1, jupyterPort: proxyPort + 2, pid: process.pid });

		const { stdio, inFlight } = await startBridge();
		await stdio.request(INIT);
		stdio.post({ jsonrpc: '2.0', method: 'notifications/initialized' });

		// A long call is established on the session that is about to die.
		stdio.post({ jsonrpc: '2.0', id: 2, method: SLOW });
		await until(() => first.heldCount() === 1 && inFlight.has(2));

		// The instance is replaced behind the SAME address, and it records a DIFFERENT
		// pid - one that is genuinely alive, so the liveness probe cannot be what
		// gives the replacement away.
		const alive = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' });
		running.push({ close: async () => void alive.kill() });
		await killCellar(first, { clear: false });
		const second = await bootCellar();
		proxy.retarget(second.port);
		writeRuntime(ws, { mcpPort: proxyPort, appPort: proxyPort + 1, jupyterPort: proxyPort + 2, pid: alive.pid });

		// The next POST is reset under us - AMBIGUOUS, so it may not be replayed.
		proxy.dropNext();
		const reply = await stdio.request({ jsonrpc: '2.0', id: 3, method: 'tools/call' }, 8000);
		const ambiguous = reply.error as { code: number; message: string };
		expect(ambiguous).toMatchObject({ code: NO_INSTANCE_ERROR_CODE });
		expect(ambiguous.message).toMatch(/may or may not have been applied/i);

		// The SESSION question was still answered correctly, so the bridge re-attached
		// and its sweep answered the long call instead of leaving it to hang.
		const lost = (await stdio.awaitReply(2, 8000)).error as { code: number; message: string };
		expect(lost).toMatchObject({ code: NO_INSTANCE_ERROR_CODE });
		expect(lost.message).toMatch(/may or may not have been applied/i);
		expect(second.sessionCount()).toBe(1);

		// ...and the healed session really works, on the very same address.
		expect(await stdio.request({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, 8000)).toMatchObject({
			result: { echoed: 'tools/list' }
		});
	});

	it('never re-attaches on a SECOND blip while the instance is provably alive on our port', async () => {
		// `sameSessionRetried` bounds how many times one message goes back on the
		// wire; it must not also switch off the evidence check. Skipping
		// `instanceGone()` once a retry was spent let a second reset fall straight
		// through to a re-attach with no evidence, tearing down a healthy session:
		// every in-flight POST aborted and every pending request swept as lost.
		const cellar = await bootCellar();
		const proxy = startFlakyProxy(cellar.port);
		const proxyPort = await proxy.listening;
		running.push(proxy);
		writeRuntime(ws, { mcpPort: proxyPort, appPort: proxyPort + 1, jupyterPort: proxyPort + 2, pid: process.pid });

		const { stdio } = await startBridge();
		await stdio.request(INIT);
		stdio.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
		const sessionsBefore = cellar.sessionCount();

		// A long call is streaming on this session - the work the bridge exists to
		// protect.
		stdio.post({ jsonrpc: '2.0', id: 2, method: SLOW });
		await until(() => cellar.heldCount() === 1);

		// A notification is the only message that survives an ambiguous failure
		// still eligible to be re-sent, so it is what reaches the second blip. Both
		// its attempts are dropped; the instance behind the proxy never moves.
		proxy.dropNext(2);
		stdio.post({ jsonrpc: '2.0', method: 'notifications/progress', params: { n: 1 } });

		// Give the retry and the second failure time to play out.
		await new Promise((r) => setTimeout(r, 400));

		// No re-handshake: the session is provably fine, so it was left alone.
		expect(cellar.sessionCount()).toBe(sessionsBefore);
		// ...and the long call was neither aborted nor reported lost.
		expect(stdio.repliesFor(2)).toHaveLength(0);
		cellar.release();
		expect(await stdio.awaitReply(2, 8000)).toMatchObject({ result: { echoed: SLOW } });
		// The notification really was given up on rather than escalated.
		expect(cellar.seen.filter((m) => m.method === 'notifications/progress')).toHaveLength(0);
		// ...and the session is still usable.
		expect(await stdio.request({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, 8000)).toMatchObject({
			result: { echoed: 'tools/list' }
		});
	});

	it('re-sends a request the server REFUSED, because a refusal proves it never ran', async () => {
		// The other half of the rule, and the dominant restart case: a server that
		// answers `-32000 No valid session` rejected the message before dispatching
		// it, so replaying it cannot duplicate anything. This is what keeps
		// "restart Cellar and the agent's next call just works" true.
		const first = await bootCellar();
		const { stdio } = await startBridge();
		await stdio.request(INIT);
		stdio.post({ jsonrpc: '2.0', method: 'notifications/initialized' });

		// Same address, new instance: the send reaches a LIVE server that refuses
		// our session, rather than failing to connect at all.
		const port = first.port;
		await killCellar(first);
		const replacement = await bootCellar(port);

		const reply = await stdio.request({ jsonrpc: '2.0', id: 7, method: 'tools/call' }, 8000);
		expect(reply).toMatchObject({ result: { echoed: 'tools/call' } });
		expect(replacement.seen.some((m) => m.method === 'tools/call')).toBe(true);
	});

	it('answers every request exactly once when several fail at once across a restart', async () => {
		// JSON-RPC allows one response per id. Each concurrent relay used to fail
		// the OTHER's request and then retry its own, so both ids got an error AND
		// a result - and the error said a completed call had not completed.
		const first = await bootCellar();
		const { stdio, inFlight } = await startBridge();
		await stdio.request(INIT);
		stdio.post({ jsonrpc: '2.0', method: 'notifications/initialized' });

		// A long call is established on the session that is about to die: the server
		// is holding it AND its POST has resolved, so it is in flight rather than
		// still being written.
		stdio.post({ jsonrpc: '2.0', id: 2, method: SLOW });
		await until(() => first.heldCount() === 1 && inFlight.has(2));

		await killCellar(first);
		const second = await bootCellar();

		// Two calls arrive together, as a host issuing parallel tool calls does.
		stdio.post({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
		stdio.post({ jsonrpc: '2.0', id: 4, method: 'tools/list' });

		for (const id of [2, 3, 4]) await stdio.awaitReply(id, 8000);
		for (const id of [2, 3, 4]) expect(stdio.repliesFor(id)).toHaveLength(1);

		// Both retried calls really ran against the replacement ...
		expect(stdio.repliesFor(3)[0]).toMatchObject({ result: { echoed: 'tools/list' } });
		expect(stdio.repliesFor(4)[0]).toMatchObject({ result: { echoed: 'tools/list' } });
		// ...and only the one genuinely lost with the dead session is reported lost -
		// honestly. Its send had RESOLVED, and the SDK resolves a send once the POST
		// headers arrive, so the old server had ACCEPTED it and its handler was
		// running or had run (the fake was holding it open). Claiming it "was not
		// completed" and inviting a plain retry is what applies a write twice.
		const lost = stdio.repliesFor(2)[0].error as { code: number; message: string };
		expect(lost).toMatchObject({ code: NO_INSTANCE_ERROR_CODE });
		expect(lost.message).toMatch(/may or may not have been applied/i);
		expect(lost.message).not.toMatch(/was not completed/i);
		expect(lost.message).not.toMatch(/call again/i);
		// One re-attach for the burst, not one per failing request.
		expect(second.sessionCount()).toBe(1);
	});

	it('answers a handed-off initialize exactly ONCE when a second re-attach fires first', async () => {
		// The agent's own handshake is the one request a re-attach takes over: the
		// replay stands IN for it, so its reply comes back under the agent's id.
		// While that reply is still on the wire the id sits in `pending` but no
		// longer in `relaying`, so a SECOND re-attach used to sweep it - handing the
		// agent an error AND, moments later, the replay's result for one id, and
		// failing the very handshake the recovery exists to complete.
		const first = await bootCellar();
		const { stdio } = await startBridge();
		await killCellar(first);
		// Its handshake is held open, so the hand-off is genuinely unanswered.
		const second = await bootCellar(0, { holdInitialize: true });

		stdio.post(INIT);
		await until(() => second.seen.some((m) => m.method === 'initialize'), 8000);

		// Cellar is replaced AGAIN before that reply ever lands. The third instance
		// holds its handshake too, so the sweep runs while the id is still pending.
		await killCellar(second);
		const third = await bootCellar(0, { holdInitialize: true });

		// A notification is enough to drive the second re-attach: it carries no id,
		// so it cannot itself be what answers the handshake.
		stdio.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
		await until(() => third.seen.some((m) => m.method === 'notifications/initialized'), 8000);
		// Let the re-attach's continuation (which is where the sweep lives) run.
		await new Promise((r) => setTimeout(r, 100));

		third.releaseInitialize();
		await stdio.awaitReply(INIT.id, 8000);
		// Let any SECOND response for that id land before judging: the sweep's error
		// and the replay's result arrive in that order, milliseconds apart, so an
		// assertion taken at the first reply would pass against the double.
		await new Promise((r) => setTimeout(r, 200));

		// Exactly one response for that id, and it is the HANDSHAKE RESULT - not the
		// sweep's error, which would leave the agent's connection unusable.
		expect(stdio.repliesFor(INIT.id)).toHaveLength(1);
		const [reply] = stdio.repliesFor(INIT.id);
		expect(reply).toMatchObject({ id: INIT.id, result: { protocolVersion: '2025-06-18' } });
		expect(reply.error).toBeUndefined();
		// ...and the session it minted really works.
		expect(await stdio.request({ jsonrpc: '2.0', id: 12, method: 'tools/list' }, 8000)).toMatchObject({
			result: { echoed: 'tools/list' }
		});
	});

	it('never answers a long run TWICE when its own POST stream outlives the heal', async () => {
		// AT MOST ONE RESPONSE PER REQUEST ID, on the path that can break it. The
		// heal answers the ids it believes are stranded, but a re-attach that finds
		// nothing serving returns BEFORE it detaches - so the old transport stays
		// fully wired, and a run whose POST stream is still open delivers its real
		// result afterwards. Relayed unguarded that is a second response for an id
		// the agent has already been answered on, which is a protocol violation and
		// tells it a call it was told was lost in fact completed.
		const cellar = await bootCellar();
		const { stdio, inFlight } = await startBridge();
		await stdio.request(INIT);

		// A long call is established: the server holds it, and its POST has resolved.
		stdio.post({ jsonrpc: '2.0', id: 2, method: SLOW });
		await until(() => cellar.heldCount() === 1 && inFlight.has(2));

		// The folder now names an instance that is NOT there: `instanceGone()` is
		// satisfied by the moved port, and the re-attach then finds nothing to
		// attach to - so the live transport, and the run streaming on it, are left
		// exactly where they are.
		const vanished = await deadPort();
		writeRuntime(ws, { mcpPort: vanished, appPort: vanished + 1, jupyterPort: vanished + 2, pid: process.pid });

		// `notifications/initialized` is answered 202, and the SDK then opens its
		// standalone GET stream - which this fake refuses - so this is what drives
		// the stream-loss heal without touching the run's own stream.
		stdio.post({ jsonrpc: '2.0', method: 'notifications/initialized' });

		const lost = (await stdio.awaitReply(2, 8000)).error as { code: number; message: string };
		expect(lost).toMatchObject({ code: NO_INSTANCE_ERROR_CODE });
		expect(lost.message).toMatch(/may or may not have been applied/i);

		// The run finishes on the still-open stream and the server writes its real
		// result. That must go NOWHERE: the id was answered.
		cellar.release();
		await new Promise((r) => setTimeout(r, 300));
		expect(stdio.repliesFor(2)).toHaveLength(1);
		expect(stdio.repliesFor(2)[0].error).toBeDefined();
	});

	it('acts on an upstream error that lands INSIDE an in-flight re-attach', async () => {
		// `attach()` adopts its new transport before it sends anything, so a
		// replacement dying mid-handshake reports it while `reattaching` is still
		// set. Returning there dropped the error for good: the attach's own sweep
		// skips the id it has just handed off, the relay that triggered it returns
		// without answering, and - the host being blocked on `initialize` - no later
		// message can drive the per-send recovery. A permanent hang, and the bridge
		// never exits, so the host never respawns it either.
		const first = await bootCellar();
		const { stdio, fatal } = await startBridge();
		await killCellar(first);

		// The replacement holds BOTH halves of the re-handshake: the replayed
		// `initialize` (so the hand-off is genuinely outstanding) and the
		// `notifications/initialized` that follows it (so `attach()` is parked
		// mid-flight, which is the window this test exists for).
		const second = await bootCellar(0, { holdInitialize: true, holdNotification: true });

		stdio.post(INIT);
		await until(() => second.seen.some((m) => m.method === 'notifications/initialized'), 8000);

		// The instance dies while the attach is still parked: the held handshake
		// stream breaks (the upstream error) and nothing is left serving the folder.
		await killCellar(second);

		const reply = await stdio.awaitReply(INIT.id, 8000);
		const err = reply.error as { code: number; message: string };
		expect(err).toMatchObject({ code: NO_INSTANCE_ERROR_CODE });
		expect(err.message).toMatch(/may or may not have been applied/i);
		expect(stdio.repliesFor(INIT.id)).toHaveLength(1);
		// ...and the bridge is untouched, ready to heal on the next launch.
		expect(fatal()).toBeUndefined();
	});

	it('completes a handshake handed off mid-attach when a replacement is serving', async () => {
		// The other outcome of the same window: once the dropped error is acted on,
		// the heal re-attaches and the fresh replay re-claims the id, so the
		// handshake COMPLETES rather than being answered with an error - and it is
		// still answered exactly once.
		const first = await bootCellar();
		const { stdio } = await startBridge();
		await killCellar(first);
		const second = await bootCellar(0, { holdInitialize: true, holdNotification: true });

		stdio.post(INIT);
		await until(() => second.seen.some((m) => m.method === 'notifications/initialized'), 8000);

		// A third instance takes the folder over BEFORE the parked one dies, so the
		// heal has somewhere to go. (`clear: false` because every fake publishes this
		// process's pid, so clearing would erase the record of the newcomer.)
		const third = await bootCellar();
		await killCellar(second, { clear: false });

		const reply = await stdio.awaitReply(INIT.id, 8000);
		expect(reply).toMatchObject({ id: INIT.id, result: { protocolVersion: '2025-06-18' } });
		expect(reply.error).toBeUndefined();
		await new Promise((r) => setTimeout(r, 200));
		expect(stdio.repliesFor(INIT.id)).toHaveLength(1);
		expect(third.sessionCount()).toBe(1);

		// ...and the session it minted really works.
		stdio.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
		expect(await stdio.request({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, 8000)).toMatchObject({
			result: { echoed: 'tools/list' }
		});
	});

	it('answers a handed-off initialize whose replay stream then DIES with nothing serving', async () => {
		// The worst shape of all, and the one the hand-off exemption created. The
		// replay stands in for the agent's `initialize`, so the id is exempt from
		// every sweep on the strength of "its reply is on the wire" - and when that
		// wire dies the exemption is simply false. The stream-loss heal used to
		// subtract handed-off ids from its own gate, so it found nothing to do and
		// returned without even asking whether the instance was gone; and because
		// the host BLOCKS on `initialize`, no later message could ever drive the
		// per-send recovery. The bridge hung for good - and, never exiting, was
		// never respawned either, which is the whole failure class it exists to
		// remove.
		const first = await bootCellar();
		const { stdio, fatal } = await startBridge();
		await killCellar(first);
		// Holds its handshake open, so the hand-off is genuinely outstanding.
		const second = await bootCellar(0, { holdInitialize: true });

		stdio.post(INIT);
		await until(() => second.seen.some((m) => m.method === 'initialize'), 8000);

		// The replacement dies before flushing that result, and nothing takes over.
		await killCellar(second);

		const reply = await stdio.awaitReply(INIT.id, 8000);
		const err = reply.error as { code: number; message: string };
		expect(err).toMatchObject({ code: NO_INSTANCE_ERROR_CODE });
		// Honest, and the same rule as any other stranded request: the result can
		// never arrive, and whether it was applied is unknown.
		expect(err.message).toMatch(/may or may not have been applied/i);
		expect(stdio.repliesFor(INIT.id)).toHaveLength(1);
		// The bridge itself is untouched: it stays alive to heal on the next launch.
		expect(fatal()).toBeUndefined();
	});

	it('completes the handshake instead when a replacement DOES come up, with no agent message', async () => {
		// The other outcome of the same gate. Once the hand-off is no longer allowed
		// to hide the request, the heal re-attaches - and the fresh replay it puts on
		// the wire re-claims the id, so the handshake completes rather than being
		// swept. The agent sends nothing at all between the two.
		const first = await bootCellar();
		const { stdio } = await startBridge();
		await killCellar(first);
		const second = await bootCellar(0, { holdInitialize: true });

		stdio.post(INIT);
		await until(() => second.seen.some((m) => m.method === 'initialize'), 8000);

		// A third instance takes over the folder, THEN the replacement dies
		// mid-handshake - the restart ordering, and the one that leaves something
		// for the heal to re-attach to.
		// (`clear: false` so taking the old one down does not also erase the record
		// of the new one - they all publish this process's pid.)
		const third = await bootCellar(0, { holdInitialize: true });
		await killCellar(second, { clear: false });
		await until(() => third.seen.some((m) => m.method === 'initialize'), 8000);
		third.releaseInitialize();

		const reply = await stdio.awaitReply(INIT.id, 8000);
		expect(reply).toMatchObject({ id: INIT.id, result: { protocolVersion: '2025-06-18' } });
		expect(reply.error).toBeUndefined();
		// One response for that id - the sweep must not also have answered it.
		await new Promise((r) => setTimeout(r, 200));
		expect(stdio.repliesFor(INIT.id)).toHaveLength(1);
		// ...and the session it minted really works.
		stdio.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
		expect(await stdio.request({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, 8000)).toMatchObject({
			result: { echoed: 'tools/list' }
		});
	});

	it('never relays its own re-handshake reply to the agent', async () => {
		const first = await bootCellar();
		const { stdio } = await startBridge();
		await stdio.request(INIT);
		await killCellar(first);
		await bootCellar();
		await stdio.request({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, 8000);

		// The agent finished its handshake long ago. A second `initialize` result -
		// under an id it is no longer waiting on - would be a protocol surprise.
		const inits = stdio.sent.filter((m) => m.id === INIT.id);
		expect(inits).toHaveLength(1);
		expect(stdio.sent.some((m) => String(m.id ?? '').startsWith('cellar-bridge-init'))).toBe(false);
	});
});

describe('provesNotDelivered - may this message be put on the wire again?', () => {
	/** An undici-shaped failure: `TypeError: fetch failed` wrapping a socket error. */
	const fetchFailed = (code: string, message = code) =>
		Object.assign(new TypeError('fetch failed'), {
			cause: Object.assign(new Error(message), { code })
		});
	/** A `StreamableHTTPError`-shaped failure: the HTTP status on a NUMERIC code. */
	const httpError = (status: number, message: string) => Object.assign(new Error(message), { code: status });

	it('is true when a server ANSWERED with a session refusal - it never dispatched it', () => {
		expect(
			provesNotDelivered(httpError(400, 'Error POSTing: -32000 No valid session; send an initialize request first.'))
		).toBe(true);
		expect(provesNotDelivered(httpError(404, 'Not Found'))).toBe(true);
	});

	it('is true when the connection was never ESTABLISHED - nothing was written', () => {
		for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT']) {
			expect(provesNotDelivered(fetchFailed(code))).toBe(true);
		}
		// ...including a transport that carries no code at all.
		expect(provesNotDelivered(new Error('connect ECONNREFUSED 127.0.0.1:39587'))).toBe(true);
	});

	it('is FALSE for a socket that opened and then broke - that is the ambiguous case', () => {
		// These cannot tell "never arrived" from "arrived, ran, and the reply died
		// with the socket", so a non-idempotent write must not be replayed.
		for (const code of ['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_SOCKET']) {
			expect(provesNotDelivered(fetchFailed(code))).toBe(false);
		}
		expect(provesNotDelivered(new Error('socket hang up'))).toBe(false);
		expect(provesNotDelivered(new TypeError('fetch failed'))).toBe(false);
		// Our own detach() aborts in-flight sends, and the request may have run.
		expect(provesNotDelivered(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))).toBe(
			false
		);
	});

	it('is FALSE for a live, session-valid server refusing this one message', () => {
		// It answered - but from inside the dispatcher, so the tool may well have run.
		expect(provesNotDelivered(httpError(500, 'mcp error: Error: boom'))).toBe(false);
		expect(provesNotDelivered(httpError(429, 'Too Many Requests'))).toBe(false);
	});

	it('never judges a status-carrying failure by its message text', () => {
		// The SDK folds the response BODY into the error message, so a tool failure
		// that merely mentions a refused connection is not OUR connection being
		// refused - and a live server that ANSWERED may already have run the handler.
		expect(
			provesNotDelivered(httpError(500, 'mcp error: Error: connection refused by the Spark cluster'))
		).toBe(false);
		expect(provesNotDelivered(httpError(502, 'ECONNREFUSED reported by an upstream proxy'))).toBe(false);
	});

	it('does not read a session phrase in a 500 body as a refusal', () => {
		// The same over-trigger the re-attach guard closes, asked of the resend
		// rule: a tool failure that merely MENTIONS a session is not our session
		// being refused, so its request is not eligible for a replay.
		expect(
			provesNotDelivered(httpError(500, 'mcp error: Error: [SESSION_CLOSED] Spark Connect session expired'))
		).toBe(false);
	});
});
