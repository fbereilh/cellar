import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
	readSidecarPort,
	sidecarInfoFile,
	sidecarPortConflict,
	waitForHttp,
	waitForSidecarPort
} from '../../src/lib/server/jupyter-sidecar.js';

/**
 * The launcher reads the port the Jupyter sidecar ACTUALLY bound, rather than
 * polling the one it asked for (jupyter_server walks to a nearby port when the
 * requested one was taken). The end-to-end reproduction - a real launcher, a
 * real sidecar and a squatter on the requested port - is
 * tests/e2e/launcher-jupyter-port-taken.spec.ts; e2e is absent from the pre-push
 * gate, so the rules it rests on are pinned here as well.
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
	it('reads the port from a server-info file carrying this launch token', () => {
		const f = sidecarInfoFile(tmp(), 4242);
		expect(f.endsWith('jpserver-4242.json')).toBe(true);
		writeFileSync(f, JSON.stringify({ port: 39656, token: TOKEN, pid: 4242 }));
		expect(readSidecarPort(f, TOKEN)).toBe(39656);
	});

	it('ignores a file written by another server (a stale file from a reused pid)', () => {
		const f = sidecarInfoFile(tmp(), 4242);
		writeFileSync(f, JSON.stringify({ port: 39656, token: 'b'.repeat(48), pid: 4242 }));
		expect(readSidecarPort(f, TOKEN)).toBeNull();
	});

	it('treats a missing, half-written or portless file as not reported yet', () => {
		const f = sidecarInfoFile(tmp(), 1);
		expect(readSidecarPort(f, TOKEN)).toBeNull();
		writeFileSync(f, '{"port": 396');
		expect(readSidecarPort(f, TOKEN)).toBeNull();
		for (const port of [0, -1, 70000, '39656', 1.5, null]) {
			writeFileSync(f, JSON.stringify({ port, token: TOKEN }));
			expect(readSidecarPort(f, TOKEN)).toBeNull();
		}
	});
});

describe('waitForSidecarPort', () => {
	it('resolves with the port the sidecar reported, not the one it was asked for', async () => {
		const f = sidecarInfoFile(tmp(), 4242);
		const child = fakeChild();
		const p = waitForSidecarPort({ infoFile: f, token: TOKEN, child: child as never, requestedPort: 39655, pollMs: 10 });
		setTimeout(() => writeFileSync(f, JSON.stringify({ port: 39656, token: TOKEN })), 40);
		await expect(p).resolves.toBe(39656);
		expect(child.listenerCount('exit')).toBe(0);
	});

	it('rejects, naming the requested port, when the sidecar exits before reporting', async () => {
		const child = fakeChild();
		const p = waitForSidecarPort({ infoFile: sidecarInfoFile(tmp(), 4242), token: TOKEN, child: child as never, requestedPort: 39655, pollMs: 10 });
		setTimeout(() => child.emit('exit', 1, null), 30);
		await expect(p).rejects.toThrow(/sidecar exited \(code 1\) before it started serving \(it was asked for port 39655\)/);
	});

	it('names the pin when a pinned port could not be bound', async () => {
		const child = fakeChild();
		child.exitCode = 1; // already gone by the time we look
		const p = waitForSidecarPort({ infoFile: sidecarInfoFile(tmp(), 4242), token: TOKEN, child: child as never, requestedPort: 8888, isPinned: true });
		await expect(p).rejects.toThrow(/Port 8888 is pinned by CELLAR_JUPYTER_PORT/);
	});

	it('gives up after the timeout, saying the sidecar never reported a port', async () => {
		const child = fakeChild();
		const t0 = Date.now();
		const p = waitForSidecarPort({ infoFile: sidecarInfoFile(tmp(), 4242), token: TOKEN, child: child as never, requestedPort: 39655, timeoutMs: 150, pollMs: 10 });
		await expect(p).rejects.toThrow(/did not report which port it bound .* asked for port 39655/);
		expect(Date.now() - t0).toBeLessThan(2000);
		expect(child.listenerCount('exit')).toBe(0);
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

describe('bin/cellar.js wiring (source guard: e2e is absent from the pre-push gate)', () => {
	const src = readFileSync(resolve(__dirname, '../../bin/cellar.js'), 'utf8');
	it('builds the Jupyter URL from the port the sidecar reported', () => {
		const read = src.indexOf('jupyterPort = await waitForSidecarPort(');
		const url = src.indexOf('const jupyterUrl = `http://127.0.0.1:${jupyterPort}`');
		expect(read).toBeGreaterThan(-1);
		expect(url).toBeGreaterThan(read);
		expect(src).not.toMatch(/const jupyterUrl = `http:\/\/127\.0\.0\.1:\$\{requestedJupyterPort\}`/);
	});
	it('gives a pinned Jupyter port port_retries=0, so it fails rather than walks', () => {
		expect(src).toContain("...(jupyterPinned ? ['--ServerApp.port_retries=0'] : [])");
	});
});
