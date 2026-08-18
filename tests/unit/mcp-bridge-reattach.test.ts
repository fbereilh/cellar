import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http, { type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { runMcpBridge, NO_INSTANCE_ERROR_CODE } from '../../src/lib/server/mcp-bridge.js';
import { writeRuntime, clearRuntime } from '../../src/lib/server/runtime.js';

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
function startFakeCellar(port = 0, { failStatus = {} }: { failStatus?: Record<string, number> } = {}) {
	const sessions = new Set<string>();
	const seen: { method?: string; sessionId?: string }[] = [];
	const held: { id: unknown; res: http.ServerResponse }[] = [];
	const sockets = new Set<import('node:net').Socket>();
	let server: Server;
	const listening = new Promise<number>((resolve) => {
		server = http.createServer((req, res) => {
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
					const id = randomUUID();
					sessions.add(id);
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
				if (msg.id === undefined || msg.id === null) {
					res.writeHead(202).end(); // a notification
					return;
				}
				const fail = failStatus[msg.method as string];
				if (fail !== undefined) {
					// A live server that KNOWS our session refusing this one message.
					// Deliberately not a session refusal: no -32000, no "initialize".
					res.writeHead(fail, { 'content-type': 'application/json' }).end(
						JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null })
					);
					return;
				}
				if (msg.method === SLOW) {
					// Headers now, body later: the POST resolves and the request sits
					// in flight on the session's stream, like a cell run in progress.
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
				for (const s of sockets) s.destroy();
				server.close(() => r());
			})
	};
}

/** The agent-facing half: lets a test inject messages and read what came back. */
function fakeStdio() {
	const sent: Record<string, unknown>[] = [];
	const t = {
		onmessage: undefined as ((m: unknown) => void) | undefined,
		onerror: undefined as ((e: Error) => void) | undefined,
		onclose: undefined as (() => void) | undefined,
		start: async () => {},
		close: async () => {},
		send: async (m: Record<string, unknown>) => {
			sent.push(m);
		}
	};
	return {
		transport: t,
		sent,
		/** Everything the bridge has sent down for one id - the count is the point. */
		repliesFor: (id: unknown) => sent.filter((m) => m.id === id),
		/** Deliver a message without waiting, so several can be in flight at once. */
		post: (msg: Record<string, unknown>) => t.onmessage?.(msg),
		/** Deliver a message from the "agent" and wait for the reply it expects. */
		async request(msg: Record<string, unknown>, timeoutMs = 3000) {
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
		async awaitReply(id: unknown, timeoutMs = 3000) {
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
 * A pass-through in front of a fake Cellar that can drop ONE POST by destroying
 * its socket - a real ECONNRESET / "socket hang up", the way a server closing a
 * keep-alive connection at its idle boundary looks to a client that just reused
 * it. The instance behind it stays up throughout, which is the whole point: the
 * bridge must not read a blip as a replacement.
 */
function startFlakyProxy(targetPort: number) {
	let dropNextPost = false;
	const sockets = new Set<import('node:net').Socket>();
	let server: Server;
	const listening = new Promise<number>((resolve) => {
		server = http.createServer((req, res) => {
			if (dropNextPost && req.method === 'POST') {
				dropNextPost = false;
				req.socket.destroy();
				return;
			}
			const up = http.request(
				{ host: '127.0.0.1', port: targetPort, path: req.url, method: req.method, headers: req.headers },
				(upRes) => {
					res.writeHead(upRes.statusCode ?? 502, upRes.headers);
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
		dropNext: () => {
			dropNextPost = true;
		},
		close: () =>
			new Promise<void>((r) => {
				for (const s of sockets) s.destroy();
				server.close(() => r());
			})
	};
}

/** Poll until `fn` is true, so a test never leans on a fixed sleep. */
async function until(fn: () => boolean, timeoutMs = 3000) {
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
	async function startBridge() {
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
			log: () => {}
		});
		stopBridge = () => stdio.transport.onclose?.();
		// Give the initial attach a moment to settle.
		await new Promise((r) => setTimeout(r, 50));
		return { stdio, done, fatal: () => fatal, inFlight };
	}

	/** Bring an "instance" up for `ws` and publish it the way a launch does. */
	async function bootCellar(port = 0, opts?: { failStatus?: Record<string, number> }) {
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

	it('retries a dropped connection on the SAME session while the instance is still alive', async () => {
		// A connection-level failure is ambiguous: a replaced instance looks like
		// this, and so does a stale keep-alive socket against a healthy one. Read as
		// a replacement it destroys the session, and with it a cell run that is
		// minutes in - a worse failure than the one the re-attach exists to fix.
		const cellar = await bootCellar();
		const proxy = startFlakyProxy(cellar.port);
		const proxyPort = await proxy.listening;
		running.push(proxy);
		// The bridge attaches through the proxy, so runtime.json names it: the
		// instance stays registered, alive, and on the SAME port throughout.
		writeRuntime(ws, { mcpPort: proxyPort, appPort: proxyPort + 1, jupyterPort: proxyPort + 2, pid: process.pid });

		const { stdio } = await startBridge();
		await stdio.request(INIT);
		stdio.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
		const sessionsBefore = cellar.sessionCount();

		// A long call is in flight on this session.
		stdio.post({ jsonrpc: '2.0', id: 2, method: SLOW });
		await until(() => cellar.heldCount() === 1);

		// The next POST hits a socket the server drops under it.
		proxy.dropNext();
		const reply = await stdio.request({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, 8000);

		// It recovered by retrying, not by re-handshaking: same session, so the
		// long call is untouched and still completes.
		expect(reply).toMatchObject({ result: { echoed: 'tools/list' } });
		expect(cellar.sessionCount()).toBe(sessionsBefore);
		expect(stdio.repliesFor(2)).toHaveLength(0);
		cellar.release();
		expect(await stdio.awaitReply(2)).toMatchObject({ result: { echoed: SLOW } });
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
		// ...and only the one genuinely lost with the dead session is reported lost.
		expect(stdio.repliesFor(2)[0].error).toMatchObject({ code: NO_INSTANCE_ERROR_CODE });
		// One re-attach for the burst, not one per failing request.
		expect(second.sessionCount()).toBe(1);
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
