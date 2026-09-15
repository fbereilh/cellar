import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	jupyterRuntimeDir,
	readSidecarPort,
	sidecarPortConflict,
	waitForHttp,
	waitForSidecarPort
} from '../../src/lib/server/jupyter-sidecar.js';

/**
 * The launcher reads the port the Jupyter sidecar ACTUALLY bound, rather than
 * polling the one it asked for (jupyter_server walks to a nearby port when the
 * requested one was taken). The end-to-end reproduction - a real launcher, a
 * real sidecar and a squatter on the requested port - is
 * tests/e2e/launcher-jupyter-port-taken.spec.ts, which is what pins the launcher's
 * wiring; the rules it rests on are pinned here too, since e2e is absent from the
 * pre-push gate.
 */

const TOKEN = 'a'.repeat(48);
const dirs: string[] = [];
const servers: Server[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	for (const s of servers.splice(0)) s.close();
});
function tmp() {
	const d = mkdtempSync(join(tmpdir(), 'cellar-jside-'));
	dirs.push(d);
	return d;
}

/** Stand-in for the spawned sidecar: only what waitForSidecarPort reads. */
function fakeChild(pid = 4242) {
	const c = new EventEmitter() as EventEmitter & { pid: number; exitCode: number | null; signalCode: string | null };
	c.pid = pid;
	c.exitCode = null;
	c.signalCode = null;
	return c;
}

describe('readSidecarPort', () => {
	it('reads the port from the server-info file carrying this launch token, whatever its pid', () => {
		const dir = tmp();
		// Named after a pid the launcher never saw (a Windows venv python runs the
		// real interpreter as a child process).
		writeFileSync(join(dir, 'jpserver-98765.json'), JSON.stringify({ port: 39656, token: TOKEN, pid: 98765 }));
		expect(readSidecarPort(dir, TOKEN)).toBe(39656);
	});

	it('ignores files written by other servers and picks the one carrying this token', () => {
		const dir = tmp();
		writeFileSync(join(dir, 'jpserver-1.json'), JSON.stringify({ port: 8888, token: 'b'.repeat(48), pid: 1 }));
		expect(readSidecarPort(dir, TOKEN)).toBeNull();
		writeFileSync(join(dir, 'jpserver-2.json'), JSON.stringify({ port: 39700, token: TOKEN, pid: 2 }));
		writeFileSync(join(dir, 'jpserver-3.json'), JSON.stringify({ port: 9999, token: 'c'.repeat(48), pid: 3 }));
		expect(readSidecarPort(dir, TOKEN)).toBe(39700);
	});

	it('treats a missing dir, a half-written file or a portless file as not reported yet', () => {
		const dir = tmp();
		expect(readSidecarPort(join(dir, 'absent'), TOKEN)).toBeNull();
		expect(readSidecarPort(dir, TOKEN)).toBeNull();
		const f = join(dir, 'jpserver-1.json');
		writeFileSync(f, '{"port": 396');
		expect(readSidecarPort(dir, TOKEN)).toBeNull();
		for (const port of [0, -1, 70000, '39656', 1.5, null]) {
			writeFileSync(f, JSON.stringify({ port, token: TOKEN }));
			expect(readSidecarPort(dir, TOKEN)).toBeNull();
		}
	});

	it('only reads server-info files, not other files in the runtime dir', () => {
		const dir = tmp();
		writeFileSync(join(dir, 'jpserver-1-open.html'), JSON.stringify({ port: 39656, token: TOKEN }));
		writeFileSync(join(dir, 'kernel-abc.json'), JSON.stringify({ port: 39656, token: TOKEN }));
		expect(readSidecarPort(dir, TOKEN)).toBeNull();
	});
});

describe('waitForSidecarPort', () => {
	it('resolves with the port the sidecar reported, not the one it was asked for', async () => {
		const dir = tmp();
		const child = fakeChild();
		const p = waitForSidecarPort({ runtimeDir: dir, token: TOKEN, child: child as never, requestedPort: 39655, pollMs: 10 });
		setTimeout(() => writeFileSync(join(dir, 'jpserver-5151.json'), JSON.stringify({ port: 39656, token: TOKEN })), 40);
		await expect(p).resolves.toBe(39656);
		expect(child.listenerCount('exit')).toBe(0);
	});

	it('rejects, naming the requested port, when the sidecar exits before reporting', async () => {
		const child = fakeChild();
		const p = waitForSidecarPort({ runtimeDir: tmp(), token: TOKEN, child: child as never, requestedPort: 39655, pollMs: 10 });
		setTimeout(() => child.emit('exit', 1, null), 30);
		await expect(p).rejects.toThrow(/sidecar exited \(code 1\) before it started serving \(it was asked for port 39655\)/);
	});

	it('names the pin when a pinned port could not be bound', async () => {
		const child = fakeChild();
		child.exitCode = 1; // already gone by the time we look
		const p = waitForSidecarPort({ runtimeDir: tmp(), token: TOKEN, child: child as never, requestedPort: 8888, isPinned: true });
		await expect(p).rejects.toThrow(/Port 8888 is pinned by CELLAR_JUPYTER_PORT/);
	});

	it('gives up after the timeout, saying the sidecar never reported a port', async () => {
		const child = fakeChild();
		const t0 = Date.now();
		const p = waitForSidecarPort({ runtimeDir: tmp(), token: TOKEN, child: child as never, requestedPort: 39655, timeoutMs: 150, pollMs: 10, probeTimeoutMs: 50 });
		await expect(p).rejects.toThrow(/did not report which port it bound .* asked for port 39655/);
		expect(Date.now() - t0).toBeLessThan(2000);
		expect(child.listenerCount('exit')).toBe(0);
	});
});

describe('waitForSidecarPort confirming the requested port directly', () => {
	/** A Jupyter stand-in: 200 on /api for the right token, 403 otherwise. */
	async function jupyterLike(token: string) {
		const { createServer: httpServer } = await import('node:http');
		const srv = httpServer((req, res) => {
			res.statusCode = req.headers.authorization === `token ${token}` ? 200 : 403;
			res.end('{}');
		});
		await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
		return { srv, port: (srv.address() as { port: number }).port };
	}

	it('accepts the requested port when it answers this launch token, with no server-info file', async () => {
		const { srv, port } = await jupyterLike(TOKEN);
		try {
			const child = fakeChild();
			const p = waitForSidecarPort({ runtimeDir: tmp(), token: TOKEN, child: child as never, requestedPort: port, pollMs: 10, timeoutMs: 2000 });
			await expect(p).resolves.toBe(port);
			expect(child.listenerCount('exit')).toBe(0);
		} finally {
			srv.close();
		}
	});

	it('still works when the runtime dir could not be determined', async () => {
		const { srv, port } = await jupyterLike(TOKEN);
		try {
			const p = waitForSidecarPort({ runtimeDir: null, token: TOKEN, child: fakeChild() as never, requestedPort: port, pollMs: 10, timeoutMs: 2000 });
			await expect(p).resolves.toBe(port);
		} finally {
			srv.close();
		}
	});

	it('never accepts a server that refuses this launch token (another Jupyter on the requested port)', async () => {
		const { srv, port } = await jupyterLike('b'.repeat(48));
		try {
			const p = waitForSidecarPort({ runtimeDir: tmp(), token: TOKEN, child: fakeChild() as never, requestedPort: port, pollMs: 10, timeoutMs: 300 });
			await expect(p).rejects.toThrow(new RegExp(`port ${port} did not accept this launch's token - last attempt: HTTP 403`));
		} finally {
			srv.close();
		}
	});

	it('does not let a silent squatter on the requested port stall the wait', async () => {
		const srv = createServer(() => {});
		servers.push(srv);
		await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
		const port = (srv.address() as { port: number }).port;
		const t0 = Date.now();
		const p = waitForSidecarPort({ runtimeDir: tmp(), token: TOKEN, child: fakeChild() as never, requestedPort: port, pollMs: 10, timeoutMs: 400, probeTimeoutMs: 100 });
		await expect(p).rejects.toThrow(/last attempt: no response within 100ms/);
		expect(Date.now() - t0).toBeLessThan(3000);
	});

	it('prefers the walked port from the server-info file over a silent requested port', async () => {
		const srv = createServer(() => {});
		servers.push(srv);
		await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
		const requested = (srv.address() as { port: number }).port;
		const dir = tmp();
		const p = waitForSidecarPort({ runtimeDir: dir, token: TOKEN, child: fakeChild() as never, requestedPort: requested, pollMs: 10, timeoutMs: 2000, probeTimeoutMs: 100 });
		setTimeout(() => writeFileSync(join(dir, 'jpserver-7.json'), JSON.stringify({ port: requested + 1, token: TOKEN })), 40);
		await expect(p).resolves.toBe(requested + 1);
	});
});

describe('jupyterRuntimeDir', () => {
	it('returns the directory the interpreter reports', async () => {
		const dir = tmp();
		const py = join(dir, 'fake-python');
		writeFileSync(py, '#!/bin/sh\necho /some/runtime/dir\n');
		chmodSync(py, 0o755);
		await expect(jupyterRuntimeDir(py, process.env)).resolves.toBe('/some/runtime/dir');
	});

	it('kills a probe that never answers and says so, instead of hanging the launch', async () => {
		const dir = tmp();
		const py = join(dir, 'hung-python');
		writeFileSync(py, '#!/bin/sh\nexec sleep 30\n');
		chmodSync(py, 0o755);
		const t0 = Date.now();
		await expect(jupyterRuntimeDir(py, process.env, { timeoutMs: 200 })).rejects.toThrow(
			/runtime dir: it did not answer within/
		);
		expect(Date.now() - t0).toBeLessThan(3000);
	});

	it('reports a probe that fails, with its stderr', async () => {
		const dir = tmp();
		const py = join(dir, 'broken-python');
		writeFileSync(py, '#!/bin/sh\necho "No module named jupyter_core" >&2\nexit 1\n');
		chmodSync(py, 0o755);
		await expect(jupyterRuntimeDir(py, process.env)).rejects.toThrow(/\(exit 1\): No module named jupyter_core/);
	});
});

describe('sidecarPortConflict', () => {
	it('refuses a walk onto a port this launch reserved for another server, naming it', () => {
		expect(sidecarPortConflict(39656, 39655, { app: 39656, MCP: 39700 })).toMatch(
			/port 39655 was taken .* moved to port 39656, which this launch had reserved for the app server/
		);
		expect(sidecarPortConflict(39657, 39655, { app: 39656, MCP: 39700 })).toBeNull();
		expect(sidecarPortConflict(39655, 39655, { app: 39656, MCP: 39700 })).toBeNull();
	});
});

describe('waitForHttp', () => {
	it('gives up on a port that accepts connections but never answers, instead of hanging', async () => {
		// The reproduction's squatter: accept, say nothing. Without a per-request
		// bound the first fetch parks for minutes and the loop deadline is never
		// re-checked.
		const srv = createServer(() => {});
		servers.push(srv);
		await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
		const port = (srv.address() as { port: number }).port;
		const t0 = Date.now();
		await expect(
			waitForHttp(`http://127.0.0.1:${port}/api`, {
				timeoutMs: 400,
				requestTimeoutMs: 100,
				intervalMs: 20,
				describe: (last) => `silent squatter (last attempt: ${last})`
			})
		).rejects.toThrow(/silent squatter \(last attempt: no response within \d+ms\)/);
		expect(Date.now() - t0).toBeLessThan(3000);
	});

	it('lets a slow response finish within the overall budget when the request bound allows it', async () => {
		const { createServer: httpServer } = await import('node:http');
		const srv = httpServer((_q, res) => setTimeout(() => res.end('{}'), 400));
		servers.push(srv as unknown as Server);
		await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
		const port = (srv.address() as { port: number }).port;
		await expect(
			waitForHttp(`http://127.0.0.1:${port}/`, { timeoutMs: 2000, requestTimeoutMs: 2000, intervalMs: 20 })
		).resolves.toBeUndefined();
		await expect(
			waitForHttp(`http://127.0.0.1:${port}/`, { timeoutMs: 600, requestTimeoutMs: 100, intervalMs: 20 })
		).rejects.toThrow(/no response within/);
	});

	it('resolves once the URL answers', async () => {
		const { createServer: httpServer } = await import('node:http');
		const srv = httpServer((_q, res) => res.end('{}'));
		await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
		const port = (srv.address() as { port: number }).port;
		try {
			await expect(waitForHttp(`http://127.0.0.1:${port}/api`, { timeoutMs: 2000 })).resolves.toBeUndefined();
		} finally {
			srv.close();
		}
	});
});
