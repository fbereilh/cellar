import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BOOT_TIMEOUT_MS, REPO, killCellar, removeWorkspace, runtimeAvailable } from './harness';

/**
 * The launcher must connect to the port the Jupyter sidecar ACTUALLY bound.
 *
 * Built from the reproduction of the CI failure where the sidecar logged
 * `running at 127.0.0.1:39656` while the launcher timed out on 39655: the
 * launcher picks a free port and closes its probe, and if anything takes that
 * port before the sidecar binds it, jupyter_server's `port_retries` walks to a
 * nearby port. The reproduction is exact rather than simulated - a squatter
 * binds the requested port the moment the launcher announces it, which is well
 * inside the ~1s python boot before the sidecar's own bind. The squatter ACCEPTS
 * connections and never answers, which is the harsher shape: before the fix the
 * launcher's poll had no per-request bound, so it did not even time out - it
 * hung for good (reproduced past 45s against its own 30s limit).
 *
 * This boots its own launcher rather than using `bootCellar`, because the
 * squatter has to be armed from the launcher's output BEFORE the URL is printed.
 */

test.skip(!runtimeAvailable(), 'needs uv + python3 + the cached Jupyter host venv');

const LAUNCH_TIMEOUT_MS = BOOT_TIMEOUT_MS;

function launch(ws: string, env: Record<string, string>, onLine: (buf: string) => void) {
	const shim = join(ws, '.shim');
	mkdirSync(shim, { recursive: true });
	for (const name of ['open', 'xdg-open']) {
		writeFileSync(join(shim, name), '#!/bin/sh\nexit 0\n');
		chmodSync(join(shim, name), 0o755);
	}
	const proc = spawn('node', [join(REPO, 'bin', 'cellar.js'), '-w', ws, '--new', '--no-mcp-config', '-y'], {
		cwd: REPO,
		env: {
			...process.env,
			PATH: `${shim}:${process.env.PATH}`,
			CI: '1',
			CELLAR_USER_SETTINGS: join(ws, '.cellar', 'user-settings.json'),
			...env
		},
		stdio: ['ignore', 'pipe', 'pipe'],
		detached: true
	});
	let buf = '';
	const exited = new Promise<number | null>((r) => proc.on('exit', (code) => r(code)));
	const scan = (d: Buffer) => {
		buf += d.toString();
		process.stdout.write(`[cellar-e2e] ${d}`);
		onLine(buf);
	};
	proc.stdout?.on('data', scan);
	proc.stderr?.on('data', scan);
	return { proc, exited, output: () => buf };
}

/** A server that accepts connections on `port` and never answers them. */
function squat(port: number): Promise<Server> {
	return new Promise((resolve, reject) => {
		const srv = createServer(() => {});
		srv.once('error', reject);
		srv.listen(port, '127.0.0.1', () => resolve(srv));
	});
}

/** Resolve once `pattern` matches the launcher output, or reject on exit/timeout. */
function waitForOutput(
	l: { exited: Promise<number | null>; output: () => string },
	pattern: RegExp,
	timeoutMs: number
): Promise<RegExpMatchArray> {
	return new Promise((resolve, reject) => {
		const t0 = Date.now();
		let done = false;
		l.exited.then((code) => {
			if (!done) {
				done = true;
				reject(new Error(`launcher exited (${code}) before printing ${pattern}\n${l.output().slice(-3000)}`));
			}
		});
		const tick = () => {
			if (done) return;
			const m = l.output().match(pattern);
			if (m) {
				done = true;
				return resolve(m);
			}
			if (Date.now() - t0 > timeoutMs) {
				done = true;
				return reject(new Error(`launcher did not print ${pattern} within ${timeoutMs}ms\n${l.output().slice(-3000)}`));
			}
			setTimeout(tick, 50);
		};
		tick();
	});
}

test.describe('launcher and a Jupyter port taken before the sidecar binds it', () => {
	test.describe.configure({ timeout: Math.max(120_000, BOOT_TIMEOUT_MS + 60_000) });

	let ws: string | undefined;
	let proc: ChildProcess | undefined;
	let squatter: Server | undefined;

	test.afterEach(() => {
		if (proc) killCellar(proc);
		squatter?.close();
		removeWorkspace(ws);
		ws = proc = squatter = undefined;
	});

	test('connects to the port Jupyter actually bound, and a cell runs through it', async ({ request }) => {
		ws = mkdtempSync(join(tmpdir(), 'cellar-e2e-jport-'));
		let arming: Promise<{ server: Server } | { error: string }> | undefined;
		const l = launch(ws, {}, (buf) => {
			const m = buf.match(/starting Jupyter sidecar \(asking for port (\d+)\)/);
			if (m && !arming) {
				const port = Number(m[1]);
				arming = squat(port).then(
					(server) => {
						squatter = server;
						return { server };
					},
					(err: Error) => ({ error: `squatter could not take port ${port} before the sidecar did: ${err.message}` })
				);
			}
		});
		proc = l.proc;

		const url = (await waitForOutput(l, /app → (http:\/\/localhost:\d+)/, LAUNCH_TIMEOUT_MS))[1];
		expect(arming, 'the launcher never announced the Jupyter port it asked for').toBeDefined();
		const armed = await arming!;
		if ('error' in armed) throw new Error(armed.error);
		const requested = Number(l.output().match(/asking for port (\d+)/)![1]);

		// The sidecar really did walk, and the launcher says where to.
		const moved = l.output().match(/port (\d+) was taken before the Jupyter sidecar could bind it; it is serving on port (\d+) instead/);
		expect(moved, 'the launcher did not report the move').not.toBeNull();
		expect(Number(moved![1])).toBe(requested);
		const bound = Number(moved![2]);
		expect(bound).not.toBe(requested);
		expect(l.output()).toContain(`Jupyter sidecar up on http://127.0.0.1:${bound}.`);

		// runtime.json records the port that is really serving, not the request.
		const runtime = JSON.parse(readFileSync(join(ws, '.cellar', 'runtime.json'), 'utf8'));
		expect(runtime.jupyterPort).toBe(bound);

		// End to end: the app reaches the kernel through the bound port.
		const add = await request.post(`${url}/api/cells`, { data: { source: '' } });
		expect(add.ok()).toBe(true);
		const { cell } = await add.json();
		const run = await request.post(`${url}/api/cells/${cell.id}/run`, {
			data: { source: 'print(6 * 7)' },
			timeout: 60_000
		});
		expect(run.ok()).toBe(true);
		expect(await run.text()).toContain('42');
	});

	test('a PINNED Jupyter port that is taken fails fast, naming the port and the pin', async () => {
		ws = mkdtempSync(join(tmpdir(), 'cellar-e2e-jpin-'));
		// Take a free port and hold it, then pin the sidecar to it.
		squatter = await squat(0);
		const pinned = (squatter.address() as { port: number }).port;
		const l = launch(ws, { CELLAR_JUPYTER_PORT: String(pinned) }, () => {});
		proc = l.proc;

		const t0 = Date.now();
		const code = await Promise.race([
			l.exited,
			new Promise<'hung'>((r) => setTimeout(() => r('hung'), BOOT_TIMEOUT_MS))
		]);
		expect(code, `launcher did not exit within ${BOOT_TIMEOUT_MS}ms\n${l.output().slice(-3000)}`).not.toBe('hung');
		expect(code).not.toBe(0);
		expect(Date.now() - t0).toBeLessThan(BOOT_TIMEOUT_MS);
		const out = l.output();
		expect(out).toContain('launch failed: the Jupyter sidecar exited');
		expect(out).toContain(`asked for port ${pinned}`);
		expect(out).toContain('pinned by CELLAR_JUPYTER_PORT');
		proc = undefined;
	});
});
