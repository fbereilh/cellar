import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:net';
import {
	mkdtempSync,
	rmSync,
	writeFileSync,
	readFileSync,
	mkdirSync,
	existsSync,
	statSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	choosePort,
	canBindPort,
	isRememberablePort,
	portsHeldByLiveInstances,
	portPrefsPath,
	readPortPrefs,
	writePortPrefs,
	resolveWorkspacePorts,
	REMEMBERED_PORTS,
	PORT_RELEASE_GRACE_MS,
	bindHosts
} from '../../src/lib/server/ports.js';

/**
 * Stable per-workspace ports.
 *
 * A folder remembers the app/MCP ports it got and asks for them again, so its
 * address stops moving on every restart. The whole rule lives in `choosePort`
 * and is exercised here directly with injected effects - no server booted - per
 * the five cases that decide it: remembered-and-free, held by a live registered
 * instance, taken by an unrelated process, no preference at all, and an explicit
 * env pin. Plus the invariant that the isolated / `--new` path never goes
 * sticky, which is what keeps concurrent e2e instances collision-free.
 */

/**
 * Bind a real listener so a port is genuinely unavailable, not just claimed.
 *
 * `host` matters and defaults to the wildcard: on macOS a SO_REUSEADDR bind of
 * `127.0.0.1:P` succeeds while another socket holds `0.0.0.0:P` and vice versa,
 * so a squatter only conflicts with a role that binds the SAME address. That is
 * real behaviour, not a test artifact - it is why each role probes its own host.
 */
function listenOn(port = 0, host = '0.0.0.0'): Promise<{ port: number; close: () => Promise<void> }> {
	return new Promise((resolve, reject) => {
		const srv: Server = createServer();
		srv.on('error', reject);
		srv.listen(port, host, () => {
			const addr = srv.address();
			const actual = typeof addr === 'object' && addr ? addr.port : port;
			resolve({
				port: actual,
				close: () => new Promise<void>((r) => srv.close(() => r()))
			});
		});
	});
}

/** An ephemeral-port allocator that hands out a scripted sequence. */
function scriptedFreePort(...ports: number[]) {
	let i = 0;
	const fn = async () => ports[Math.min(i++, ports.length - 1)];
	return Object.assign(fn, { calls: () => i });
}

describe('choosePort - the stable-port rule', () => {
	const freePort = async () => 40000;

	it('reuses the remembered port when it is free and nobody holds it', async () => {
		const r = await choosePort({
			remembered: 51348,
			sticky: true,
			canBind: async () => true,
			isUnavailable: () => false,
			freePort
		});
		expect(r).toEqual({ port: 51348, source: 'remembered' });
	});

	it('yields to a live registered instance rather than reclaiming its port', async () => {
		let probed = false;
		const r = await choosePort({
			remembered: 51348,
			sticky: true,
			// A bind probe would be a race we must not even enter.
			canBind: async () => {
				probed = true;
				return true;
			},
			isUnavailable: (p) => p === 51348,
			freePort
		});
		expect(r.source).toBe('fresh');
		expect(r.reason).toBe('held-by-live-instance');
		expect(r.port).toBe(40000);
		// Never probed: a port a live instance holds is settled without asking the OS.
		expect(probed).toBe(false);
	});

	it('falls back quietly when an unrelated process took the remembered port', async () => {
		const r = await choosePort({
			remembered: 51348,
			sticky: true,
			canBind: async () => false, // something else is listening
			isUnavailable: () => false, // ...but it is not a Cellar instance
			bindGraceMs: 0,
			freePort
		});
		expect(r).toEqual({ port: 40000, source: 'fresh', reason: 'port-unavailable' });
	});

	it('takes a fresh port when the folder has no preference yet', async () => {
		for (const remembered of [undefined, null]) {
			const r = await choosePort({ remembered, sticky: true, freePort });
			expect(r).toEqual({ port: 40000, source: 'fresh', reason: 'no-preference' });
		}
	});

	it('honours an explicit env pin over everything, without probing it', async () => {
		let probed = false;
		const r = await choosePort({
			pinned: '39587',
			remembered: 51348,
			sticky: true,
			canBind: async () => {
				probed = true;
				return true;
			},
			isUnavailable: () => true,
			freePort
		});
		// A pin is an instruction, not a preference: taken verbatim, never probed,
		// and it outranks both the remembered port and a live-instance conflict.
		expect(r).toEqual({ port: 39587, source: 'pinned' });
		expect(probed).toBe(false);
	});

	it('ignores a non-numeric pin, exactly as the launcher always has', async () => {
		const r = await choosePort({ pinned: 'auto', sticky: true, freePort });
		expect(r.source).toBe('fresh');
	});

	it('never uses the sticky path for an isolated / --new launch', async () => {
		let probed = false;
		const r = await choosePort({
			remembered: 51348,
			sticky: false,
			canBind: async () => {
				probed = true;
				return true;
			},
			freePort
		});
		// Concurrent instances exist precisely so they cannot collide; a remembered
		// port is the port another instance is most likely holding.
		expect(r).toEqual({ port: 40000, source: 'fresh', reason: 'not-sticky' });
		expect(probed).toBe(false);
	});

	it('refuses a corrupt / hand-edited preference instead of trying to bind it', async () => {
		for (const bad of [0, -1, 80, 70000, 1.5, '51348' as unknown as number, NaN]) {
			const r = await choosePort({ remembered: bad as number, sticky: true, freePort });
			expect(r.reason).toBe('no-preference');
		}
	});

	it('waits out the previous run still letting go of the remembered port', async () => {
		// The launcher SIGTERMs its children and exits immediately, so right after a
		// Ctrl-C the old app still holds the port. Without this grace the everyday
		// stop-and-start would abandon the very address stickiness exists to keep.
		let attempts = 0;
		const slept: number[] = [];
		const r = await choosePort({
			remembered: 51348,
			sticky: true,
			canBind: async () => ++attempts >= 3, // frees up on the third probe
			freePort,
			sleep: async (ms: number) => {
				slept.push(ms);
			}
		});
		expect(r).toEqual({ port: 51348, source: 'remembered' });
		expect(attempts).toBe(3);
		expect(slept.length).toBe(2); // it really waited between probes
	});

	it('gives up on the grace rather than blocking the launch forever', async () => {
		let attempts = 0;
		let clock = 0;
		const r = await choosePort({
			remembered: 51348,
			sticky: true,
			canBind: async () => {
				attempts++;
				return false; // never comes back
			},
			freePort,
			// Advance a fake clock so the deadline is reached without real waiting.
			sleep: async () => {
				clock += 10_000;
				const orig = Date.now;
				Date.now = () => orig() + clock;
			}
		});
		expect(r.source).toBe('fresh');
		expect(r.reason).toBe('port-unavailable');
		expect(attempts).toBeGreaterThanOrEqual(1);
		expect(PORT_RELEASE_GRACE_MS).toBeGreaterThan(0);
	});

	it('never spends the grace on a port a live instance holds - that answer is settled', async () => {
		let slept = false;
		const r = await choosePort({
			remembered: 51348,
			sticky: true,
			isUnavailable: () => true,
			canBind: async () => false,
			freePort,
			sleep: async () => {
				slept = true;
			}
		});
		expect(r.reason).toBe('held-by-live-instance');
		expect(slept).toBe(false);
	});

	it('does not hand the same port to two roles in one launch', async () => {
		// freePort probes and releases, so two calls could in principle agree; and a
		// hand-edited preference can name one port twice. The fallback skips a port
		// this launch already claimed.
		const fp = scriptedFreePort(40000, 40000, 40001);
		const taken = new Set<number>([40000]);
		const r = await choosePort({
			remembered: 40000,
			sticky: true,
			canBind: async () => true,
			isUnavailable: (p) => taken.has(p),
			freePort: fp
		});
		expect(r.port).toBe(40001);
		expect(r.source).toBe('fresh');
	});
});

describe('canBindPort - the real availability probe', () => {
	// Squatter and probe both name loopback: this block is about the probe, not
	// about the wildcard-vs-loopback split (which has its own test above).
	it('is true for a free port and false for one an unrelated process is listening on', async () => {
		const held = await listenOn(0, '127.0.0.1');
		try {
			expect(await canBindPort(held.port, '127.0.0.1')).toBe(false);
		} finally {
			await held.close();
		}
		// Once released it is bindable again - this is the "Cellar went down, its
		// port came back" case that makes a restart reuse the same address.
		expect(await canBindPort(held.port, '127.0.0.1')).toBe(true);
	});

	it('refuses a port it would never have handed out', async () => {
		expect(await canBindPort(0, '127.0.0.1')).toBe(false);
		expect(await canBindPort(80, '127.0.0.1')).toBe(false);
	});
});

describe('choosePort against a REAL bound port', () => {
	it('moves off the remembered port only while something actually holds it', async () => {
		const held = await listenOn(0, '127.0.0.1');
		const freePort = scriptedFreePort(40000);
		const opts = { remembered: held.port, sticky: true, freePort, bindGraceMs: 0, host: '127.0.0.1' };

		const busy = await choosePort(opts);
		expect(busy).toEqual({ port: 40000, source: 'fresh', reason: 'port-unavailable' });

		await held.close();
		const free = await choosePort(opts);
		expect(free).toEqual({ port: held.port, source: 'remembered' });
	});
});

describe('portsHeldByLiveInstances', () => {
	const entries = [
		{ launcherPid: 1, appPort: 100, mcpPort: 101, jupyterPort: 102 },
		{ launcherPid: 2, appPort: 200, mcpPort: 201, jupyterPort: 202 },
		{ launcherPid: 3, appPort: 300, mcpPort: 301, jupyterPort: 302 }
	];

	it('collects every port of every live instance', () => {
		const held = portsHeldByLiveInstances(entries, { isAlive: () => true });
		expect([...held].sort((a, b) => a - b)).toEqual([
			100, 101, 102, 200, 201, 202, 300, 301, 302
		]);
	});

	it('ignores dead instances - their ports are free to take back', () => {
		const held = portsHeldByLiveInstances(entries, { isAlive: (e) => e.launcherPid === 2 });
		expect([...held].sort((a, b) => a - b)).toEqual([200, 201, 202]);
	});

	it('excludes our own entry so a relaunch never blocks itself', () => {
		const held = portsHeldByLiveInstances(entries, { isAlive: () => true, excludePid: 2 });
		expect(held.has(200)).toBe(false);
		expect(held.has(100)).toBe(true);
	});

	it('tolerates a registry entry with missing ports', () => {
		const held = portsHeldByLiveInstances(
			[{ launcherPid: 1 }, { launcherPid: 2, appPort: 500 }, null as never],
			{ isAlive: () => true }
		);
		expect([...held]).toEqual([500]);
	});
});

describe('the durable per-workspace preference file', () => {
	let ws: string;
	beforeEach(() => {
		ws = mkdtempSync(join(tmpdir(), 'cellar-ports-'));
	});
	afterEach(() => {
		rmSync(ws, { recursive: true, force: true });
	});

	it('lives in .cellar/ and round-trips', () => {
		expect(portPrefsPath(ws)).toBe(join(ws, '.cellar', 'ports.json'));
		expect(readPortPrefs(ws)).toEqual({});
		writePortPrefs(ws, { appPort: 51347, mcpPort: 51348 });
		expect(readPortPrefs(ws)).toEqual({ appPort: 51347, mcpPort: 51348 });
	});

	it('is NOT cleared the way runtime.json is - that is the whole point', async () => {
		writePortPrefs(ws, { appPort: 51347, mcpPort: 51348 });
		const { clearRuntime, writeRuntime } = await import('../../src/lib/server/runtime.js');
		writeRuntime(ws, { mcpPort: 51348, appPort: 51347, jupyterPort: 51346 });
		clearRuntime(ws);
		// The live-instance record is gone; the preference survives it.
		expect(existsSync(join(ws, '.cellar', 'runtime.json'))).toBe(false);
		expect(readPortPrefs(ws)).toEqual({ appPort: 51347, mcpPort: 51348 });
	});

	it('merges rather than replaces, so a pinned run cannot erase the other port', () => {
		writePortPrefs(ws, { appPort: 51347, mcpPort: 51348 });
		// A run that pinned the app port records nothing for it.
		writePortPrefs(ws, { mcpPort: 51999 });
		expect(readPortPrefs(ws)).toEqual({ appPort: 51347, mcpPort: 51999 });
	});

	it('writes nothing when the ports are unchanged', async () => {
		writePortPrefs(ws, { appPort: 51347, mcpPort: 51348 });
		const before = statSync(portPrefsPath(ws)).mtimeMs;
		await new Promise((r) => setTimeout(r, 12));
		const res = writePortPrefs(ws, { appPort: 51347, mcpPort: 51348 });
		expect(res.written).toBe(false);
		expect(statSync(portPrefsPath(ws)).mtimeMs).toBe(before);
	});

	it('degrades to "no preference" on a corrupt or hostile file, never throwing', () => {
		mkdirSync(join(ws, '.cellar'), { recursive: true });
		for (const body of ['', 'not json', '[]', 'null', '"51348"', '{"appPort":"51347"}', '{"appPort":80}']) {
			writeFileSync(portPrefsPath(ws), body);
			expect(readPortPrefs(ws)).toEqual({});
		}
		// A partially-valid file yields only the keys that survive validation.
		writeFileSync(portPrefsPath(ws), JSON.stringify({ appPort: 51347, mcpPort: 'x' }));
		expect(readPortPrefs(ws)).toEqual({ appPort: 51347 });
	});

	it('does not remember the Jupyter port', () => {
		expect([...REMEMBERED_PORTS]).toEqual(['appPort', 'mcpPort']);
		// Nothing outside the launcher + app ever sees it, so it earns no stickiness
		// and adds no startup race. An attempt to store it is simply dropped.
		writePortPrefs(ws, { appPort: 51347, jupyterPort: 51346 } as never);
		expect(readPortPrefs(ws)).toEqual({ appPort: 51347 });
	});

	it('never fails a launch when the preference cannot be written', () => {
		// Something is squatting the `.cellar` name, so the write cannot land.
		// Stickiness is a convenience: losing it must cost the launch nothing.
		const blocked = mkdtempSync(join(tmpdir(), 'cellar-ports-blocked-'));
		try {
			writeFileSync(join(blocked, '.cellar'), 'not a directory');
			expect(() => writePortPrefs(blocked, { appPort: 51347 })).not.toThrow();
			expect(writePortPrefs(blocked, { appPort: 51347 }).written).toBe(false);
			expect(readPortPrefs(blocked)).toEqual({});
		} finally {
			rmSync(blocked, { recursive: true, force: true });
		}
	});

	it('isRememberablePort is stricter than the pin rule, deliberately', () => {
		expect(isRememberablePort(51348)).toBe(true);
		expect(isRememberablePort(1024)).toBe(true);
		expect(isRememberablePort(65535)).toBe(true);
		// Our allocator can only ever produce an unprivileged port, so anything
		// below 1024 is a corrupt file rather than a preference.
		expect(isRememberablePort(1023)).toBe(false);
		expect(isRememberablePort(65536)).toBe(false);
		expect(isRememberablePort(0)).toBe(false);
	});
});

describe('resolveWorkspacePorts - a whole launch, without booting one', () => {
	let ws: string;
	/** A real ephemeral-port allocator, exactly like the launcher's `freePort`. */
	const freePort = () =>
		new Promise<number>((resolve, reject) => {
			const srv = createServer();
			srv.unref();
			srv.on('error', reject);
			srv.listen(0, '127.0.0.1', () => {
				const addr = srv.address();
				const port = typeof addr === 'object' && addr ? addr.port : 0;
				srv.close(() => resolve(port));
			});
		});

	beforeEach(() => {
		ws = mkdtempSync(join(tmpdir(), 'cellar-launch-'));
	});
	afterEach(() => {
		rmSync(ws, { recursive: true, force: true });
	});

	const launch = (opts: Record<string, unknown> = {}) =>
		// bindGraceMs 0 unless a test is specifically about the release grace: a
		// squatted port would otherwise make every such test wait it out.
		resolveWorkspacePorts({ workspace: ws, sticky: true, env: {}, freePort, bindGraceMs: 0, ...opts });

	it('gives the SAME folder the SAME app/MCP ports on the next restart', async () => {
		const first = await launch();
		// Nothing is competing: the second launch must land on the same address.
		const second = await launch();
		expect(second.appPort).toBe(first.appPort);
		expect(second.mcpPort).toBe(first.mcpPort);
		expect(second.app.source).toBe('remembered');
		expect(second.mcp.source).toBe('remembered');
	});

	it('never re-uses the Jupyter port - it is deliberately not sticky', async () => {
		const first = await launch();
		const second = await launch();
		expect(second.jupyter.source).toBe('fresh');
		expect(readPortPrefs(ws)).toEqual({ appPort: first.appPort, mcpPort: first.mcpPort });
		expect(readFileSync(portPrefsPath(ws), 'utf8')).not.toContain('jupyter');
	});

	it('a DIFFERENT folder never collides with the first, and never disturbs it', async () => {
		const a = await launch();
		const other = mkdtempSync(join(tmpdir(), 'cellar-launch-b-'));
		try {
			// Folder A is live and registered while folder B starts.
			const live = [{ launcherPid: 4242, appPort: a.appPort, mcpPort: a.mcpPort, jupyterPort: a.jupyterPort }];
			const b = await resolveWorkspacePorts({
				workspace: other,
				sticky: true,
				env: {},
				freePort,
				instances: live,
				isAlive: () => true
			});
			expect(b.appPort).not.toBe(a.appPort);
			expect(b.mcpPort).not.toBe(a.mcpPort);
			expect(b.jupyterPort).not.toBe(a.jupyterPort);
			// A's own preference file is untouched by B starting.
			expect(readPortPrefs(ws)).toEqual({ appPort: a.appPort, mcpPort: a.mcpPort });
		} finally {
			rmSync(other, { recursive: true, force: true });
		}
	});

	it('starts anyway on a new port when the remembered one is taken, and remembers THAT', async () => {
		const first = await launch();
		// An unrelated process grabbed the app port while Cellar was down. It has to
		// hold the WILDCARD, because that is what adapter-node binds and therefore
		// what the app role probes; a loopback-only squatter genuinely would not
		// stop the app starting there.
		const squatter = await listenOn(first.appPort, '0.0.0.0');
		try {
			const second = await launch();
			expect(second.appPort).not.toBe(first.appPort);
			expect(second.app.source).toBe('fresh');
			expect(second.app.reason).toBe('port-unavailable');
			// The MCP port was free, so it is still stable.
			expect(second.mcpPort).toBe(first.mcpPort);
			// The new choice is persisted, so the NEXT restart is stable again.
			expect(readPortPrefs(ws)).toEqual({ appPort: second.appPort, mcpPort: first.mcpPort });
		} finally {
			await squatter.close();
		}
		const third = await launch();
		expect(third.app.source).toBe('remembered');
	});

	it('probes each role on the host that role really binds', async () => {
		const first = await launch();
		// Loopback-only squatters. The MCP server binds 127.0.0.1, so its port is
		// genuinely taken; the app binds the wildcard, so its port is genuinely
		// still free - probing both on one host would get one of them wrong, and
		// getting the APP one wrong hands adapter-node a port it cannot listen on.
		const onApp = await listenOn(first.appPort, '127.0.0.1');
		const onMcp = await listenOn(first.mcpPort, '127.0.0.1');
		try {
			const second = await launch();
			expect(second.app.source).toBe('remembered');
			expect(second.appPort).toBe(first.appPort);
			expect(second.mcp.source).toBe('fresh');
			expect(second.mcp.reason).toBe('port-unavailable');
		} finally {
			await onApp.close();
			await onMcp.close();
		}
	});

	it('yields to a live registered instance holding the remembered port', async () => {
		const first = await launch();
		const notes: string[] = [];
		const second = await launch({
			instances: [{ launcherPid: 999, mcpPort: first.mcpPort }],
			isAlive: () => true,
			log: (m: string) => notes.push(m)
		});
		expect(second.mcpPort).not.toBe(first.mcpPort);
		expect(second.mcp.reason).toBe('held-by-live-instance');
		// The move is announced: a silently different address is the confusion
		// this feature exists to remove.
		expect(notes.join('\n')).toContain(`MCP port ${first.mcpPort} was unavailable`);
	});

	it('lets an explicit env pin win, and does not record it as a preference', async () => {
		const first = await launch();
		const pinned = await launch({ env: { CELLAR_MCP_PORT: '39587' } });
		expect(pinned.mcpPort).toBe(39587);
		expect(pinned.mcp.source).toBe('pinned');
		// A pin is an instruction for THIS run. Recording it would let it reappear
		// on a later launch that pinned nothing - so the remembered MCP port is the
		// last one Cellar actually chose, untouched.
		expect(readPortPrefs(ws)).toEqual({ appPort: first.appPort, mcpPort: first.mcpPort });
		// ...and unpinning restores it.
		const after = await launch();
		expect(after.mcpPort).toBe(first.mcpPort);
	});

	it('ISOLATED / --new never touches the sticky path', async () => {
		const first = await launch(); // an ordinary launch remembered its ports
		const remembered = readPortPrefs(ws);

		const isolated = await resolveWorkspacePorts({
			workspace: ws,
			sticky: false, // === the launcher's `!forceNew`; CELLAR_ISOLATED implies it
			env: {},
			freePort
		});

		// It must not ADOPT the folder's ports: that is the port the instance this
		// one is deliberately running beside is most likely holding - the collision
		// e2e at workers:2 and mkdtemp workspaces exist to avoid.
		expect(isolated.appPort).not.toBe(first.appPort);
		expect(isolated.mcpPort).not.toBe(first.mcpPort);
		expect(isolated.app.source).toBe('fresh');
		expect(isolated.app.reason).toBe('not-sticky');
		expect(isolated.mcp.reason).toBe('not-sticky');
		// ...and it must not OVERWRITE the folder's memory with its throwaway ports.
		expect(readPortPrefs(ws)).toEqual(remembered);
	});

	it('an isolated launch in a never-launched folder writes no preference at all', async () => {
		await resolveWorkspacePorts({ workspace: ws, sticky: false, env: {}, freePort });
		expect(existsSync(portPrefsPath(ws))).toBe(false);
	});

	it('gives the three roles three distinct ports', async () => {
		// A hand-edited preference naming one port twice must not produce a clash.
		writePortPrefs(ws, { appPort: 45678, mcpPort: 45678 });
		const r = await launch();
		expect(new Set([r.appPort, r.mcpPort, r.jupyterPort]).size).toBe(3);
	});
});

describe('the launcher wiring', () => {
	// `sticky: !forceNew` is the one link the behavioral tests above cannot reach
	// without booting a server, and it is the link that decides whether an e2e /
	// isolated instance can steal a folder's port. e2e is deliberately absent from
	// CI and the no-mistakes gate, so it is pinned here at the source level.
	const src = readFileSync(new URL('../../bin/cellar.js', import.meta.url), 'utf8');

	// `bindHosts` MIRRORS the three real listen sites, and a probe on the wrong
	// host silently answers a different question - it reported the app port free
	// while adapter-node still held it on the wildcard, which would hand the app a
	// port its own listen() cannot take. So the mirror is pinned to its sources.
	it('probes the MCP port on the host startMcpServer actually binds', () => {
		const mcpSrc = readFileSync(new URL('../../src/lib/server/mcp/server.ts', import.meta.url), 'utf8');
		expect(mcpSrc).toContain("process.env.CELLAR_MCP_HOST || '127.0.0.1'");
		expect(bindHosts({}).mcp).toBe('127.0.0.1');
		expect(bindHosts({ CELLAR_MCP_HOST: '0.0.0.0' }).mcp).toBe('0.0.0.0');
	});

	it('probes the app port on the WILDCARD, because the launcher sets PORT and not HOST', () => {
		// adapter-node defaults to 0.0.0.0; if the launcher ever starts pinning HOST
		// this must follow it, which is what the second assertion keeps honest.
		expect(src).toContain('PORT: String(appPort)');
		expect(src).not.toMatch(/\bHOST:\s/);
		expect(bindHosts({}).app).toBe('0.0.0.0');
		expect(bindHosts({ HOST: '127.0.0.1' }).app).toBe('127.0.0.1');
	});

	it('probes the Jupyter port on the ip the sidecar spawn pins', () => {
		expect(src).toContain('--ServerApp.ip=127.0.0.1');
		expect(bindHosts({}).jupyter).toBe('127.0.0.1');
	});

	it('drives the sticky path from !forceNew (which CELLAR_ISOLATED implies)', () => {
		expect(src).toMatch(/resolveWorkspacePorts\(\{[\s\S]{0,200}?sticky:\s*!forceNew/);
	});

	it('has exactly one port-resolution site', () => {
		expect(src.match(/resolveWorkspacePorts\(/g)).toHaveLength(1);
	});

	it('excludes our own pid so a relaunch never blocks itself', () => {
		expect(src).toMatch(/excludePid:\s*process\.pid/);
	});
});
