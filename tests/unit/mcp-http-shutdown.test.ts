import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:net';
import http from 'node:http';
import { releaseOnShutdown, SHUTDOWN_SIGNALS } from '../../src/lib/server/mcp/server';

/**
 * The MCP http server RELEASES its port on shutdown.
 *
 * Nothing used to close it (it also carries `timeout = 0`), and adapter-node's
 * graceful shutdown unbinds only its OWN listener - so the app process kept this
 * socket bound until it finally exited, which on the Ctrl-C path is the orphan
 * self-exit in `parent-watch.ts`, 5-10s later. That is what made the folder's
 * remembered MCP port busy on essentially every quick relaunch, so that half of
 * the preference never converged (`ports.js` deliberately does not wait it out).
 *
 * `startMcpServer` cannot be booted here - it wires the live notebook document
 * and the kernel into an `McpServer` - so the hook is its own exported function
 * and is driven directly, against a REAL listening server and a REAL emitted
 * signal. That is the part `ports.js` depends on: after the signal the port is
 * bindable again even while established connections and the process itself live
 * on. The signal emitter is injected rather than `process`, so the assertions
 * are about this hook and not about whatever else the test runner installs.
 */
function canBind(port: number, host = '127.0.0.1'): Promise<boolean> {
	return new Promise((resolve) => {
		const srv: Server = createServer();
		srv.on('error', () => resolve(false));
		srv.listen(port, host, () => srv.close(() => resolve(true)));
	});
}

/** A listening http server shaped like the MCP one: long streams, no timeouts. */
async function bootMcpLikeServer() {
	const held: http.ServerResponse[] = [];
	const server = http.createServer((_req, res) => {
		// The shape a run tool has: headers now, body minutes later.
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		res.flushHeaders();
		held.push(res);
	});
	server.requestTimeout = 0;
	server.timeout = 0;
	const port = await new Promise<number>((resolve) => {
		server.listen(0, '127.0.0.1', () => {
			const a = server.address();
			resolve(typeof a === 'object' && a ? a.port : 0);
		});
	});
	/** Establish a long call and resolve once its headers are back. */
	const startLongCall = () =>
		new Promise<void>((resolve) => {
			const req = http.request({ host: '127.0.0.1', port, method: 'POST' }, () => resolve());
			req.end('{}');
		});
	return {
		server,
		port,
		held,
		startLongCall,
		stop: () => {
			for (const res of held) if (!res.writableEnded) res.end();
			server.close();
		}
	};
}

describe('the MCP http server frees its port for the next launch', () => {
	it('unbinds on SIGTERM without aborting a run already streaming', async () => {
		const mcp = await bootMcpLikeServer();
		const signals = new EventEmitter();
		const off = releaseOnShutdown(mcp.server, signals);
		try {
			await mcp.startLongCall();
			expect(await canBind(mcp.port)).toBe(false);

			// The launcher SIGTERMs the app. The hook releases the LISTENING socket at
			// once - it does NOT wait for the established stream, which is the whole
			// point: the next launch can take the folder's remembered address back
			// while the old process is still winding down.
			signals.emit('SIGTERM');
			await new Promise((r) => setTimeout(r, 50));
			expect(await canBind(mcp.port)).toBe(true);

			// ...and the in-flight run was not aborted to achieve that: killing it
			// here would end the work more abruptly than the process exit will.
			expect(mcp.held).toHaveLength(1);
			expect(mcp.held[0].writableEnded).toBe(false);
		} finally {
			off();
			mcp.stop();
		}
	});

	it('answers SIGINT too, and a second signal changes nothing', async () => {
		const mcp = await bootMcpLikeServer();
		const signals = new EventEmitter();
		const off = releaseOnShutdown(mcp.server, signals);
		try {
			await mcp.startLongCall();
			signals.emit('SIGINT');
			await new Promise((r) => setTimeout(r, 50));
			expect(await canBind(mcp.port)).toBe(true);

			// Both signals really do arrive in sequence on a Ctrl-C into a reap, and
			// the second must be inert rather than disturbing the winding-down stream.
			signals.emit('SIGTERM');
			await new Promise((r) => setTimeout(r, 50));
			expect(await canBind(mcp.port)).toBe(true);
			expect(mcp.held[0].writableEnded).toBe(false);
		} finally {
			off();
			mcp.stop();
		}
	});

	it('keeps the port bound while nothing has signalled', async () => {
		// The counterpart that makes the test above mean something: it is the SIGNAL
		// that frees the port, not the passage of time or the act of registering.
		const mcp = await bootMcpLikeServer();
		const signals = new EventEmitter();
		const off = releaseOnShutdown(mcp.server, signals);
		try {
			await mcp.startLongCall();
			await new Promise((r) => setTimeout(r, 50));
			expect(await canBind(mcp.port)).toBe(false);
		} finally {
			off();
			mcp.stop();
		}
	});

	it('unsubscribes cleanly, so a torn-down hook stops answering signals', async () => {
		const mcp = await bootMcpLikeServer();
		const signals = new EventEmitter();
		releaseOnShutdown(mcp.server, signals)();
		try {
			for (const sig of SHUTDOWN_SIGNALS) signals.emit(sig);
			await new Promise((r) => setTimeout(r, 50));
			expect(await canBind(mcp.port)).toBe(false);
			expect(signals.listenerCount('SIGTERM')).toBe(0);
			expect(signals.listenerCount('SIGINT')).toBe(0);
		} finally {
			mcp.stop();
		}
	});
});
