import { describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:net';
import http from 'node:http';

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
 * and the kernel into an `McpServer` - so this drives the http-server lifecycle
 * the shutdown hook relies on, which is the part `ports.js` depends on: after
 * `close()` the port is bindable again even while established connections and
 * the process itself live on.
 */
function canBind(port: number, host = '127.0.0.1'): Promise<boolean> {
	return new Promise((resolve) => {
		const srv: Server = createServer();
		srv.on('error', () => resolve(false));
		srv.listen(port, host, () => srv.close(() => resolve(true)));
	});
}

describe('the MCP http server frees its port for the next launch', () => {
	it('is bindable again right after close(), with a request still open', async () => {
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

		// A long call is established and still streaming.
		const inFlight = new Promise<void>((resolve) => {
			const req = http.request({ host: '127.0.0.1', port, method: 'POST' }, () => resolve());
			req.end('{}');
		});
		await inFlight;
		expect(await canBind(port)).toBe(false);

		// `close()` stops accepting and releases the LISTENING socket at once - it
		// does NOT wait for the established stream, which is the whole point: the
		// next launch can take the address back while the old process winds down.
		server.close();
		await new Promise((r) => setTimeout(r, 50));
		expect(await canBind(port)).toBe(true);

		// ...and the in-flight run was not aborted to achieve that.
		expect(held).toHaveLength(1);
		expect(held[0].writableEnded).toBe(false);
		for (const res of held) res.end();
	});
});
