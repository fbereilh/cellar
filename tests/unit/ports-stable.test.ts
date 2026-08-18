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
	bindHosts,
	MOVE_CAUSE
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

/**
 * A bind probe that records every port it was asked about and reports only the
 * named ones as busy. Per-port on purpose: a blanket `async () => false` would
 * say every port on the machine is taken, which no squatter ever means and which
 * the fresh-port fallback (which probes its candidate too) would rightly refuse.
 */
function probe(...busy: number[]) {
	const asked: number[] = [];
	const fn = async (port: number) => {
		asked.push(port);
		return !busy.includes(port);
	};
	return Object.assign(fn, { asked, sawPort: (p: number) => asked.includes(p) });
}

/** The claim predicate `resolveWorkspacePorts` builds, for a live instance. */
function heldByInstance(...ports: number[]) {
	return (p: number) => (ports.includes(p) ? ('held-by-live-instance' as const) : null);
}

describe('choosePort - the stable-port rule', () => {
	const freePort = async () => 40000;

	it('reuses the remembered port when it is free and nobody holds it', async () => {
		const r = await choosePort({
			remembered: 51348,
			sticky: true,
			canBind: probe(),
			claimedBy: () => null,
			freePort
		});
		expect(r).toEqual({ port: 51348, source: 'remembered' });
	});

	it('yields to a live registered instance rather than reclaiming its port', async () => {
		const canBind = probe();
		const r = await choosePort({
			remembered: 51348,
			sticky: true,
			canBind,
			claimedBy: heldByInstance(51348),
			freePort
		});
		expect(r.source).toBe('fresh');
		expect(r.reason).toBe('held-by-live-instance');
		expect(r.port).toBe(40000);
		// The REMEMBERED port is never probed: a port a live instance holds is
		// settled without asking the OS, and probing it would be a race we must not
		// even enter. (The replacement port is probed - see the fresh-fallback test.)
		expect(canBind.sawPort(51348)).toBe(false);
	});

	it('reports a port this launch already took for another role as its OWN conflict', async () => {
		// Same outcome, different CAUSE - and the launcher announces the cause. A
		// single "claimed" set told the user another running Cellar instance was
		// using a port that nothing but this very launch had taken.
		const r = await choosePort({
			remembered: 51348,
			sticky: true,
			canBind: probe(),
			claimedBy: (p) => (p === 51348 ? 'taken-by-this-launch' : null),
			freePort
		});
		expect(r).toEqual({ port: 40000, source: 'fresh', reason: 'taken-by-this-launch' });
	});

	it('falls back quietly when an unrelated process took the remembered port', async () => {
		const r = await choosePort({
			remembered: 51348,
			sticky: true,
			canBind: probe(51348), // something else is listening on that ONE port
			claimedBy: () => null, // ...but it is not a Cellar instance
			bindGraceMs: 0,
			freePort
		});
		expect(r).toEqual({ port: 40000, source: 'fresh', reason: 'port-unavailable' });
	});

	it('probes the fresh fallback on the role host too, and steps over an unbindable one', async () => {
		// The launcher's `freePort()` asks the kernel for a free 127.0.0.1 port
		// while adapter-node binds the wildcard, and on macOS a loopback bind
		// succeeds against a wildcard holder - so a kernel-assigned port can still
		// be one the role's own listen() cannot take. One probe per candidate.
		const canBind = probe(40000);
		const r = await choosePort({
			remembered: undefined,
			sticky: true,
			host: '0.0.0.0',
			canBind,
			freePort: scriptedFreePort(40000, 40001)
		});
		expect(r).toEqual({ port: 40001, source: 'fresh', reason: 'no-preference' });
		expect(canBind.asked).toEqual([40000, 40001]);
	});

	it('refuses to launch rather than hand back a fresh port it cannot bind', async () => {
		await expect(
			choosePort({
				sticky: true,
				canBind: probe(40000),
				freePort: async () => 40000
			})
		).rejects.toThrow(/free port/i);
	});

	it('takes a fresh port when the folder has no preference yet', async () => {
		for (const remembered of [undefined, null]) {
			const r = await choosePort({ remembered, sticky: true, canBind: probe(), freePort });
			expect(r).toEqual({ port: 40000, source: 'fresh', reason: 'no-preference' });
		}
	});

	it('honours an explicit env pin over everything, without probing it', async () => {
		const canBind = probe();
		const r = await choosePort({
			pinned: '39587',
			remembered: 51348,
			sticky: true,
			canBind,
			claimedBy: heldByInstance(51348, 39587),
			freePort
		});
		// A pin is an instruction, not a preference: taken verbatim, never probed,
		// and it outranks both the remembered port and a live-instance conflict.
		expect(r).toEqual({ port: 39587, source: 'pinned' });
		expect(canBind.asked).toEqual([]);
	});

	it('ignores a non-numeric pin, exactly as the launcher always has', async () => {
		const r = await choosePort({ pinned: 'auto', sticky: true, canBind: probe(), freePort });
		expect(r.source).toBe('fresh');
	});

	it('never uses the sticky path for an isolated / --new launch', async () => {
		const canBind = probe();
		const r = await choosePort({
			remembered: 51348,
			sticky: false,
			canBind,
			freePort
		});
		// Concurrent instances exist precisely so they cannot collide; a remembered
		// port is the port another instance is most likely holding - so it is not
		// even looked at.
		expect(r).toEqual({ port: 40000, source: 'fresh', reason: 'not-sticky' });
		expect(canBind.sawPort(51348)).toBe(false);
	});

	it('refuses a corrupt / hand-edited preference instead of trying to bind it', async () => {
		for (const bad of [0, -1, 80, 70000, 1.5, '51348' as unknown as number, NaN]) {
			const canBind = probe();
			const r = await choosePort({
				remembered: bad as number,
				sticky: true,
				canBind,
				freePort
			});
			expect(r.reason).toBe('no-preference');
			expect(canBind.sawPort(bad as number)).toBe(false);
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
		// Capture the REAL clock once and restore it in a finally: patched in place
		// from inside `sleep`, the offset compounded on every call and then leaked
		// into every later test in this file, where it would fail somewhere with no
		// visible cause.
		const realNow = Date.now;
		let r;
		try {
			r = await choosePort({
				remembered: 51348,
				sticky: true,
				canBind: async (p: number) => {
					if (p !== 51348) return true; // only the remembered port is squatted
					attempts++;
					return false; // ...and it never comes back
				},
				freePort,
				// Advance a fake clock so the deadline is reached without real waiting.
				sleep: async () => {
					clock += 10_000;
					Date.now = () => realNow() + clock;
				}
			});
		} finally {
			Date.now = realNow;
		}
		expect(r.source).toBe('fresh');
		expect(r.reason).toBe('port-unavailable');
		expect(attempts).toBeGreaterThanOrEqual(1);
		expect(PORT_RELEASE_GRACE_MS).toBeGreaterThan(0);
	});

	it('gives up on a remembered port the previous run is still holding, rather than stalling', async () => {
		// The measured hold on the MCP port is ~5-7s (nothing closes the in-process
		// MCP http server, so it goes only when the app process finally exits). This
		// window deliberately does NOT wait that out: the address appears in no
		// config and `cellar mcp` re-attaches by itself, so stalling every restart to
		// preserve it would trade real launch latency for nothing.
		const HOLD_MS = 6800;
		let clock = 0;
		const realNow = Date.now;
		let r;
		try {
			r = await choosePort({
				remembered: 51348,
				sticky: true,
				canBind: async (p: number) => p !== 51348 || clock >= HOLD_MS,
				freePort,
				sleep: async (ms: number) => {
					clock += ms;
					Date.now = () => realNow() + clock;
				}
			});
		} finally {
			Date.now = realNow;
		}
		expect(r).toEqual({ port: 40000, source: 'fresh', reason: 'port-unavailable' });
		// It gave up near its own window, nowhere near the hold.
		expect(clock).toBeLessThan(HOLD_MS / 2);
	});

	it('returns the moment the port frees rather than sleeping out the window', async () => {
		// The window is a bound, not a delay: a port that comes back inside it is
		// taken at once, so the everyday restart pays nothing for the app port.
		let clock = 0;
		const realNow = Date.now;
		let r;
		try {
			r = await choosePort({
				remembered: 51348,
				sticky: true,
				bindGraceMs: 5000,
				canBind: async (p: number) => p !== 51348 || clock >= 100,
				freePort,
				sleep: async (ms: number) => {
					clock += ms;
					Date.now = () => realNow() + clock;
				}
			});
		} finally {
			Date.now = realNow;
		}
		expect(r).toEqual({ port: 51348, source: 'remembered' });
		expect(clock).toBeLessThan(1000);
	});

	it('leaves the wall clock alone for every later test in this file', () => {
		// The guard for the leak above: a patch left in place shifts `Date.now` for
		// the rest of the file, so this must agree with an independent reading.
		expect(Math.abs(Date.now() - new Date().getTime())).toBeLessThan(1000);
	});

	it('never spends the grace on a port a live instance holds - that answer is settled', async () => {
		let slept = false;
		const r = await choosePort({
			remembered: 51348,
			sticky: true,
			// Exactly what the real predicate is: the claimant of that port, so the
			// remembered port is taken and the fallback still has room to land.
			claimedBy: heldByInstance(51348),
			canBind: probe(51348),
			freePort,
			sleep: async () => {
				slept = true;
			}
		});
		expect(r.reason).toBe('held-by-live-instance');
		expect(r.port).not.toBe(51348);
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
			canBind: probe(),
			claimedBy: (p) => (taken.has(p) ? 'taken-by-this-launch' : null),
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
		// A REAL ephemeral allocator for the fallback, so the default probe - which
		// now covers the fresh candidate too - is asked about a port the kernel has
		// just said is free, rather than a hardcoded one this machine may be using.
		const spare = await listenOn(0, '127.0.0.1');
		await spare.close();
		const freePort = scriptedFreePort(spare.port);
		const opts = { remembered: held.port, sticky: true, freePort, bindGraceMs: 0, host: '127.0.0.1' };

		const busy = await choosePort(opts);
		expect(busy).toEqual({ port: spare.port, source: 'fresh', reason: 'port-unavailable' });

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

	it('asks about each role on the host that role really binds', async () => {
		// The ROUTING is the portable claim, and asking it of the probe directly is
		// a stronger test than a real socket: it proves WHICH question was asked
		// rather than leaning on kernel behaviour to imply it, and it runs the same
		// on every platform.
		const asked: { port: number; host: string }[] = [];
		const r = await launch({
			canBind: async (port: number, host: string) => {
				asked.push({ port, host });
				return true;
			}
		});
		const hostFor = (port: number) => asked.find((a) => a.port === port)?.host;
		expect(hostFor(r.appPort)).toBe('0.0.0.0');
		expect(hostFor(r.mcpPort)).toBe('127.0.0.1');
		expect(hostFor(r.jupyterPort)).toBe('127.0.0.1');
		// ...and the app follows HOST / the MCP server CELLAR_MCP_HOST, so the probe
		// tracks a server that was told to bind somewhere else.
		const asked2: { port: number; host: string }[] = [];
		const other = mkdtempSync(join(tmpdir(), 'cellar-hosts-'));
		try {
			const r2 = await resolveWorkspacePorts({
				workspace: other,
				sticky: false,
				env: { HOST: '127.0.0.1', CELLAR_MCP_HOST: '0.0.0.0' },
				freePort,
				bindGraceMs: 0,
				canBind: async (port: number, host: string) => {
					asked2.push({ port, host });
					return true;
				}
			});
			expect(asked2.find((a) => a.port === r2.appPort)?.host).toBe('127.0.0.1');
			expect(asked2.find((a) => a.port === r2.mcpPort)?.host).toBe('0.0.0.0');
			expect(asked2.find((a) => a.port === r2.jupyterPort)?.host).toBe('127.0.0.1');
		} finally {
			rmSync(other, { recursive: true, force: true });
		}
	});

	it('probes the app port on LOOPBACK under --dev, because that is what vite binds', async () => {
		// The launcher spawns a different app server per branch: `node build/index.js`
		// (adapter-node, wildcard) by default, and `vite dev --port <p> --strictPort`
		// with no `--host` under `--dev`, where vite's own loopback default applies.
		// Probing the wildcard there answers a different question: on macOS it
		// succeeds while an unrelated process holds 127.0.0.1:P, so the remembered
		// port is kept, vite fails --strictPort and the launch dies - persistently,
		// since the "successful" remembered path rewrites the preference.
		const asked: { port: number; host: string }[] = [];
		const spy = async (port: number, host: string) => {
			asked.push({ port, host });
			return true;
		};
		const r = await launch({ dev: true, canBind: spy });
		expect(asked.find((a) => a.port === r.appPort)?.host).toBe('localhost');
		// The other two roles are unmoved by the branch.
		expect(asked.find((a) => a.port === r.mcpPort)?.host).toBe('127.0.0.1');
		expect(asked.find((a) => a.port === r.jupyterPort)?.host).toBe('127.0.0.1');

		// ...and HOST does not override it, because vite never reads HOST - only the
		// production branch does.
		const askedHost: { port: number; host: string }[] = [];
		const other = mkdtempSync(join(tmpdir(), 'cellar-devhost-'));
		try {
			const r2 = await resolveWorkspacePorts({
				workspace: other,
				sticky: false,
				dev: true,
				env: { HOST: '0.0.0.0' },
				freePort,
				bindGraceMs: 0,
				canBind: async (port: number, host: string) => {
					askedHost.push({ port, host });
					return true;
				}
			});
			expect(askedHost.find((a) => a.port === r2.appPort)?.host).toBe('localhost');
		} finally {
			rmSync(other, { recursive: true, force: true });
		}
	});

	// The CONSEQUENCE of getting that routing wrong is only observable where the
	// kernel lets a wildcard bind and a loopback bind of one port coexist. That
	// permissive overlap is BSD/macOS SO_REUSEADDR behaviour (measured); Linux
	// treats wildcard-vs-specific as a conflict once the holder is LISTENing, so
	// the app half would simply read as taken there and prove nothing about which
	// host was probed. The routing itself is covered unconditionally above.
	describe.skipIf(process.platform !== 'darwin')(
		'wildcard-vs-loopback overlap (darwin only: BSD SO_REUSEADDR lets these coexist)',
		() => {
			it('leaves the app on its remembered port while a loopback-only squatter holds it', async () => {
				const first = await launch();
				// Loopback-only squatters. The MCP server binds 127.0.0.1, so its port
				// is genuinely taken; the app binds the wildcard, so on this platform
				// its port is genuinely still free - probing both on one host would get
				// one of them wrong, and getting the APP one wrong hands adapter-node a
				// port it cannot listen on.
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
		}
	);

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
		// this feature exists to remove. And it names the real cause - there IS a
		// live instance here, so it may say so.
		expect(notes.join('\n')).toContain(`MCP port ${first.mcpPort} was unavailable`);
		expect(notes.join('\n')).toContain(MOVE_CAUSE['held-by-live-instance']);
		expect(notes.join('\n')).toContain(`using ${second.mcpPort} and remembering it`);
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

	it('an isolated launch still yields to a port a live registered instance holds', async () => {
		// The isolated guarantee is about the PREFERENCE (never read, never
		// written), not about the registry - and a bind probe cannot see everything
		// a registry can: it races, and on macOS a loopback probe does not even
		// notice a wildcard holder. So the read-only "who is live" lookup applies
		// here too, and only makes a collision less likely.
		const fp = scriptedFreePort(41000, 41001, 41002, 41003, 41004);
		const isolated = await resolveWorkspacePorts({
			workspace: ws,
			sticky: false,
			env: {},
			freePort: fp,
			instances: [{ launcherPid: 999, appPort: 41000, mcpPort: 41001 }],
			isAlive: () => true,
			canBind: async () => true,
			bindGraceMs: 0
		});
		for (const p of [isolated.appPort, isolated.mcpPort, isolated.jupyterPort]) {
			expect([41000, 41001]).not.toContain(p);
		}
		// The point of the test: three roles, three ports. A fallback that gave up
		// and handed back a port it knew was claimed would satisfy the check above
		// while binding two roles to one address.
		expect(new Set([isolated.appPort, isolated.mcpPort, isolated.jupyterPort]).size).toBe(3);
		// ...and it is still isolated: nothing was remembered.
		expect(existsSync(portPrefsPath(ws))).toBe(false);
	});

	it('refuses to launch rather than hand two roles the same port', async () => {
		// A free-port source that only ever offers one address. Silently returning
		// it twice is the one outcome the retry loop exists to prevent, and it would
		// surface much later as two servers racing for the same port.
		await expect(
			resolveWorkspacePorts({
				workspace: ws,
				sticky: false,
				env: {},
				freePort: async () => 41000,
				bindGraceMs: 0
			})
		).rejects.toThrow(/free port/i);
	});

	it('resolves the sticky roles before Jupyter, which never takes a remembered port', async () => {
		// Jupyter is never sticky, so it takes an ephemeral port - which can land on
		// the very address this folder remembers. Resolved first it claimed that
		// port, pushed the app off its stable address, blamed a live instance that
		// does not exist, and then persisted the replacement.
		writePortPrefs(ws, { appPort: 42000, mcpPort: 42001 });
		const notes: string[] = [];
		const r = await resolveWorkspacePorts({
			workspace: ws,
			sticky: true,
			env: {},
			// The first port offered is exactly the remembered app port.
			freePort: scriptedFreePort(42000, 42002, 42003),
			canBind: async () => true,
			bindGraceMs: 0,
			log: (m: string) => notes.push(m)
		});
		expect(r.app).toEqual({ port: 42000, source: 'remembered' });
		expect(r.mcp).toEqual({ port: 42001, source: 'remembered' });
		expect(r.jupyterPort).not.toBe(42000);
		expect(new Set([r.appPort, r.mcpPort, r.jupyterPort]).size).toBe(3);
		// Nothing moved, so nothing was announced - and the folder still remembers
		// the address it was told is stable.
		expect(notes).toEqual([]);
		expect(readPortPrefs(ws)).toEqual({ appPort: 42000, mcpPort: 42001 });
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

	it('says NOTHING when the MCP port moves on a routine self-restart', async () => {
		// The everyday gesture: Ctrl-C, then relaunch. The previous launcher has
		// already unregistered itself and cleared runtime.json, so the take-over sweep
		// finds nothing to await - and its orphaned app still holds the MCP port for
		// several seconds. That port is deliberately not waited out (it appears in no
		// config and the bridge re-attaches by itself), so it reliably MOVES here.
		// Announcing that made the commonest restart print an alarming
		// "was unavailable (another process is using it)" about a conflict the user
		// has no reason to care about, naming a holder the probe never identified.
		const first = await launch();
		const notes: string[] = [];
		const second = await resolveWorkspacePorts({
			workspace: ws,
			sticky: true,
			env: {},
			freePort,
			// The app port is back at once; only the MCP one is still held.
			canBind: async (port: number) => port !== first.mcpPort,
			bindGraceMs: 0,
			log: (m: string) => notes.push(m)
		});

		// The app port - the address a human actually holds onto - is unmoved.
		expect(second.appPort).toBe(first.appPort);
		expect(second.app.source).toBe('remembered');
		// The MCP port moved, silently, and the replacement is remembered so the next
		// launch is stable again.
		expect(second.mcpPort).not.toBe(first.mcpPort);
		expect(second.mcp.reason).toBe('port-unavailable');
		expect(notes).toEqual([]);
		expect(readPortPrefs(ws)).toEqual({ appPort: first.appPort, mcpPort: second.mcpPort });
	});

	it('still announces an APP port move, and a genuine MCP conflict', async () => {
		// Silence is scoped to the one routine case. The app port is the address the
		// user was told is stable, so ANY move of it speaks; and an MCP port a LIVE
		// REGISTERED instance holds is a fact `claimedBy` positively established, not
		// the everyday self-restart, so that speaks too.
		const first = await launch();
		const notes: string[] = [];
		const second = await launch({
			canBind: async (port: number) => port !== first.appPort,
			instances: [{ launcherPid: 999, mcpPort: first.mcpPort }],
			isAlive: () => true,
			log: (m: string) => notes.push(m)
		});

		expect(second.appPort).not.toBe(first.appPort);
		expect(second.mcp.reason).toBe('held-by-live-instance');
		const said = notes.join('\n');
		expect(said).toContain(`app port ${first.appPort} was unavailable`);
		expect(said).toContain(MOVE_CAUSE['port-unavailable']);
		expect(said).toContain(`MCP port ${first.mcpPort} was unavailable`);
		expect(said).toContain(MOVE_CAUSE['held-by-live-instance']);
	});

	it('blames THIS launch, not a live instance, when it already took the port itself', async () => {
		// One port named twice: the app takes it, so the MCP role has to move. The
		// announcement is the feature's honesty contract, and a single "claimed"
		// set reported "another running Cellar instance is using it" about a
		// conflict with nothing but this very launch - naming an instance that does
		// not exist, in the one message the user is meant to trust.
		const spare = await freePort();
		writePortPrefs(ws, { appPort: spare, mcpPort: spare });
		const notes: string[] = [];
		const r = await launch({ instances: [], log: (m: string) => notes.push(m) });

		expect(r.appPort).toBe(spare);
		expect(r.app.source).toBe('remembered');
		expect(r.mcpPort).not.toBe(spare);
		expect(r.mcp.reason).toBe('taken-by-this-launch');

		const said = notes.join('\n');
		expect(said).toContain(`MCP port ${spare} was unavailable`);
		expect(said).toContain(MOVE_CAUSE['taken-by-this-launch']);
		// ...and emphatically NOT the live-instance wording, which is the defect.
		expect(said).not.toContain(MOVE_CAUSE['held-by-live-instance']);
		expect(said).not.toContain('held-by-live-instance');
	});
});

describe('bindHosts - each role probes the address its own server binds', () => {
	// A probe on the wrong host silently answers a DIFFERENT question: on macOS a
	// SO_REUSEADDR bind of 127.0.0.1:P succeeds while another socket holds
	// 0.0.0.0:P, so probing loopback reported the app port free while adapter-node
	// still held it on the wildcard - which would hand the app a port its own
	// listen() cannot take. The end-to-end consequence is covered against real
	// listeners by the darwin-gated overlap suite above, and the routing itself is
	// covered unconditionally by 'asks about each role on the host that role really
	// binds';
	// this pins the mapping itself, in both directions, for each role.

	it('gives the app LOOPBACK under --dev, whatever HOST says', () => {
		// vite dev is spawned with no --host and does not read HOST, so the dev
		// branch has exactly one answer.
		expect(bindHosts({}, { dev: true }).app).toBe('localhost');
		expect(bindHosts({ HOST: '0.0.0.0' }, { dev: true }).app).toBe('localhost');
		// ...and it moves nothing else.
		expect(bindHosts({ CELLAR_MCP_HOST: '0.0.0.0' }, { dev: true })).toEqual({
			app: 'localhost',
			mcp: '0.0.0.0',
			jupyter: '127.0.0.1'
		});
	});

	it('gives the app the wildcard by default and follows HOST when it is set', () => {
		// adapter-node binds 0.0.0.0 unless HOST says otherwise, and the launcher
		// passes only PORT - so the default is what an ordinary launch really probes.
		expect(bindHosts({}).app).toBe('0.0.0.0');
		expect(bindHosts({ HOST: '127.0.0.1' }).app).toBe('127.0.0.1');
		expect(bindHosts({ HOST: '::1' }).app).toBe('::1');
	});

	it('gives the MCP server loopback by default and follows CELLAR_MCP_HOST', () => {
		expect(bindHosts({}).mcp).toBe('127.0.0.1');
		expect(bindHosts({ CELLAR_MCP_HOST: '0.0.0.0' }).mcp).toBe('0.0.0.0');
	});

	it('pins Jupyter to loopback whatever the environment says', () => {
		// The sidecar spawn passes --ServerApp.ip=127.0.0.1 unconditionally, so no
		// environment variable may move this one.
		expect(bindHosts({}).jupyter).toBe('127.0.0.1');
		expect(bindHosts({ HOST: '0.0.0.0', CELLAR_MCP_HOST: '0.0.0.0' }).jupyter).toBe('127.0.0.1');
	});

	it('reads an empty variable as unset, so a blank env var is never a host', () => {
		expect(bindHosts({ HOST: '', CELLAR_MCP_HOST: '' })).toEqual({
			app: '0.0.0.0',
			mcp: '127.0.0.1',
			jupyter: '127.0.0.1'
		});
	});

	it('reads the real process environment when none is passed', () => {
		const before = process.env.CELLAR_MCP_HOST;
		try {
			delete process.env.CELLAR_MCP_HOST;
			expect(bindHosts().mcp).toBe('127.0.0.1');
			process.env.CELLAR_MCP_HOST = '0.0.0.0';
			expect(bindHosts().mcp).toBe('0.0.0.0');
		} finally {
			if (before === undefined) delete process.env.CELLAR_MCP_HOST;
			else process.env.CELLAR_MCP_HOST = before;
		}
	});
});
