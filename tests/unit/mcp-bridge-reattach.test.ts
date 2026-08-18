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

/**
 * A minimal stand-in for Cellar's MCP HTTP endpoint, with the same session rule.
 * `port` 0 (the default) takes an ephemeral one; pass one to rebind the address
 * a previous "instance" used, which is how the same-port case is staged.
 */
function startFakeCellar(port = 0) {
	const sessions = new Set<string>();
	const seen: { method?: string; sessionId?: string }[] = [];
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
				res.writeHead(200, { 'content-type': 'application/json' }).end(
					JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { echoed: msg.method, session: sid } })
				);
			});
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
		close: () => new Promise<void>((r) => server.close(() => r()))
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
		}
	};
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
		const done = runMcpBridge({
			workspace: ws,
			makeStdio: () => stdio.transport,
			makeUpstream: (url: URL) => new StreamableHTTPClientTransport(url),
			onFatal: (code: number) => {
				fatal = code;
			},
			// Silence the bridge's stderr diagnostics; the assertions read behavior.
			log: () => {}
		});
		stopBridge = () => stdio.transport.onclose?.();
		// Give the initial attach a moment to settle.
		await new Promise((r) => setTimeout(r, 50));
		return { stdio, done, fatal: () => fatal };
	}

	/** Bring an "instance" up for `ws` and publish it the way a launch does. */
	async function bootCellar(port = 0) {
		const c = startFakeCellar(port);
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
