/**
 * Cellar - learning which port the Jupyter sidecar ACTUALLY bound.
 *
 * The launcher picks a free port, closes its probe socket and hands the number
 * to `jupyter_server --ServerApp.port=<p>`. Between that close and Jupyter's own
 * bind the port is unclaimed, and under concurrent launches something else can
 * take it. Jupyter does not fail in that case: its `port_retries` (default 50)
 * quietly walks to `p+1 … p+4` and then to random ports nearby. A launcher that
 * goes on polling the port it ASKED for waits on an address nothing will ever
 * answer - observed on CI as a sidecar "running at 127.0.0.1:39656" beside a
 * launcher timing out on 39655, and reported to the user as nothing more than
 * `launcher exited early (1)`.
 *
 * So the launcher does not trust the number it asked for. It reads the number
 * back from the sidecar itself: jupyter_server writes a server-info JSON
 * (`jpserver-<pid>.json` in its runtime dir - the file `jupyter server list`
 * reads) carrying the port it settled on. That is structured output rather than
 * a log line, so neither log formatting nor Jupyter's i18n of "is running at"
 * can break it. The path is not configurable (`ServerApp.info_file` and
 * `runtime_dir` are plain traits, and a `--ServerApp.info_file` flag is ignored
 * with a warning - measured), so the runtime dir is asked of the host python
 * with the sidecar's own environment rather than re-derived here. The file is
 * found by the one fact that identifies it - THIS launch's random token - and
 * never by the spawned pid: on Windows a venv `python.exe` is a launcher that
 * runs the real interpreter as a CHILD process, so the file is named after a pid
 * the launcher never sees. Matching on the token also means a stale file left by
 * an earlier, killed server (whatever its pid) cannot be mistaken for it. Jupyter writes the file in `start_app`, AFTER `_find_http_port` has settled
 * the port and BEFORE the io loop runs the real listen, so the HTTP poll that
 * follows can see a refused connection for a beat; `waitForHttp` retries through
 * that, and if that final listen fails Jupyter exits.
 *
 * Every failure here says what was actually observed - the sidecar exited, it
 * never reported a port, it reported one this launch had reserved for another
 * server, or the port it reported never answered - because the whole bug was a
 * failure that named nothing true.
 *
 * Node builtins only (plus global fetch), so `bin/cellar.js` can import it like
 * `ports.js`; it is in `package.json` `files` for the same reason.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

/**
 * The directory jupyter_server writes its server-info file into, asked of the
 * interpreter that runs the sidecar, with the sidecar's environment (it honours
 * JUPYTER_RUNTIME_DIR / JUPYTER_DATA_DIR / platform dirs, which is exactly why it
 * is asked rather than re-derived). Bounded: a probe that does not answer within
 * `timeoutMs` is killed and reported, so it can never hang the launch.
 *
 * @param {string} python
 * @param {NodeJS.ProcessEnv} env
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<string>}
 */
export function jupyterRuntimeDir(python, env, { timeoutMs = 15_000 } = {}) {
	return new Promise((resolveDir, reject) => {
		const child = spawn(python, ['-c', 'from jupyter_core.paths import jupyter_runtime_dir; print(jupyter_runtime_dir())'], {
			env,
			stdio: ['ignore', 'pipe', 'pipe']
		});
		let out = '';
		let err = '';
		let settled = false;
		const settle = (fn, v) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			fn(v);
		};
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			settle(
				reject,
				new Error(`could not ask ${python} for Jupyter's runtime dir: it did not answer within ${Math.round(timeoutMs / 1000)}s.`)
			);
		}, timeoutMs);
		child.stdout.on('data', (d) => (out += d));
		child.stderr.on('data', (d) => (err += d));
		child.on('error', (e) => settle(reject, new Error(`could not ask ${python} for Jupyter's runtime dir: ${e.message}`)));
		child.on('close', (code) => {
			const dir = out.trim();
			if (code === 0 && dir) settle(resolveDir, dir);
			else settle(reject, new Error(`could not ask ${python} for Jupyter's runtime dir (exit ${code}): ${err.trim() || 'no output'}`));
		});
	});
}

/** A usable TCP port number, or null. */
function portOf(v) {
	return Number.isInteger(v) && v > 0 && v < 65536 ? v : null;
}

/** A jupyter_server server-info file name (not its `-open.html` sibling). */
const INFO_FILE = /^jpserver-.+\.json$/;

/**
 * The port recorded by the server-info file in `runtimeDir` that carries this
 * launch's token, or null when no such file exists yet. Files written by other
 * servers (another token), half-written or unparseable files, and files with
 * no usable port are skipped. Never throws: an unreadable directory or file is
 * "not reported yet".
 *
 * @param {string} runtimeDir
 * @param {string} token this launch's `--ServerApp.token`
 * @returns {number | null}
 */
export function readSidecarPort(runtimeDir, token) {
	let names;
	try {
		names = readdirSync(runtimeDir);
	} catch {
		return null;
	}
	for (const name of names) {
		if (!INFO_FILE.test(name)) continue;
		let info;
		try {
			info = JSON.parse(readFileSync(join(runtimeDir, name), 'utf8'));
		} catch {
			continue;
		}
		if (!info || typeof info !== 'object' || info.token !== token) continue;
		const port = portOf(info.port);
		if (port != null) return port;
	}
	return null;
}

/**
 * Wait for the sidecar to report the port it bound.
 *
 * Two signals, whichever confirms first:
 * - the server-info file in `runtimeDir` carrying this launch's token (the
 *   primary one: it names the port even after a walk), and
 * - the REQUESTED port answering `GET /api` with a 2xx under this launch's
 *   token. jupyter_server writes the info file best-effort (a filesystem that
 *   refuses its permission check only logs a warning), so a sidecar that did not
 *   walk must not depend on that write. Only a 2xx counts: the token is this
 *   launch's secret, so a 2xx proves it is our server, while a 403 from another
 *   Jupyter or a squatter that never answers proves nothing. Every probe is
 *   bounded so a silent squatter cannot stall this loop.
 *
 * Rejects when the child exits first (it exited before it started serving) or
 * when the timeout passes (it never confirmed a port). `isPinned` only changes
 * the wording of the exit case: a pinned port runs with `port_retries=0`, so an
 * exit there most likely means that exact port was unavailable.
 *
 * @param {{
 *   runtimeDir: string | null,
 *   token: string,
 *   child: import('node:child_process').ChildProcess,
 *   requestedPort: number,
 *   host?: string,
 *   isPinned?: boolean,
 *   timeoutMs?: number,
 *   pollMs?: number,
 *   probeTimeoutMs?: number
 * }} opts
 * @returns {Promise<number>}
 */
export function waitForSidecarPort({
	runtimeDir,
	token,
	child,
	requestedPort,
	host = '127.0.0.1',
	isPinned = false,
	timeoutMs = 30_000,
	pollMs = 100,
	probeTimeoutMs = 1_000
}) {
	return new Promise((resolvePort, reject) => {
		let settled = false;
		let timer = null;
		let probeTimer = null;
		let deadline = null;
		let lastProbe = 'not attempted';
		const finish = (fn, v) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearTimeout(probeTimer);
			clearTimeout(deadline);
			child.off('exit', onExit);
			fn(v);
		};
		const onExit = (code, signal) => {
			const how = signal ? `signal ${signal}` : `code ${code}`;
			const why = isPinned
				? ` Port ${requestedPort} is pinned by CELLAR_JUPYTER_PORT, so the sidecar does not try another; if it is already in use, free it or unset the pin.`
				: '';
			finish(
				reject,
				new Error(
					`the Jupyter sidecar exited (${how}) before it started serving (it was asked for port ${requestedPort}); its own output above says why.${why}`
				)
			);
		};
		const poll = () => {
			if (settled) return;
			const port = runtimeDir ? readSidecarPort(runtimeDir, token) : null;
			if (port != null) return finish(resolvePort, port);
			timer = setTimeout(poll, pollMs);
		};
		const probe = async () => {
			if (settled) return;
			try {
				const res = await fetch(`http://${host}:${requestedPort}/api`, {
					headers: { Authorization: `token ${token}` },
					signal: AbortSignal.timeout(probeTimeoutMs)
				});
				await res.body?.cancel().catch(() => {});
				if (res.ok) return finish(resolvePort, requestedPort);
				lastProbe = `HTTP ${res.status}`;
			} catch (err) {
				lastProbe = err?.name === 'TimeoutError' ? `no response within ${probeTimeoutMs}ms` : (err?.cause?.code ?? err?.message ?? String(err));
			}
			if (!settled) probeTimer = setTimeout(probe, pollMs);
		};
		if (child.exitCode != null || child.signalCode != null) return onExit(child.exitCode, child.signalCode);
		child.on('exit', onExit);
		deadline = setTimeout(() => {
			const file = runtimeDir
				? `no server-info file carrying this launch's token appeared in ${runtimeDir}`
				: `its runtime dir could not be determined, so no server-info file was read`;
			finish(
				reject,
				new Error(
					`the Jupyter sidecar did not report which port it bound within ${Math.round(timeoutMs / 1000)}s (it was asked for port ${requestedPort}; ${file}, and port ${requestedPort} did not accept this launch's token - last attempt: ${lastProbe}).`
				)
			);
		}, timeoutMs);
		poll();
		void probe();
	});
}

/**
 * Why a bound sidecar port cannot be used, or null when it can.
 *
 * Jupyter's walk is not coordinated with the other ports this launch reserved:
 * the app and MCP ports are chosen but not yet bound while the sidecar starts,
 * so a walk can land on one of them. Letting that stand would make the app fail
 * to bind (Linux) or - where a loopback bind beside a wildcard one succeeds
 * (macOS) - silently serve the Jupyter API at the app's URL. Refusing, with the
 * cause named, is the honest outcome; a relaunch picks new ports.
 *
 * @param {number} boundPort
 * @param {number} requestedPort
 * @param {Record<string, number>} reserved role label -> port this launch reserved
 * @returns {string | null}
 */
export function sidecarPortConflict(boundPort, requestedPort, reserved) {
	for (const [role, port] of Object.entries(reserved)) {
		if (port === boundPort)
			return `port ${requestedPort} was taken before the Jupyter sidecar could bind it, and the sidecar moved to port ${boundPort}, which this launch had reserved for the ${role} server. Launch again to pick fresh ports.`;
	}
	return null;
}

/**
 * Poll `url` until it answers, with EVERY request bounded.
 *
 * The per-request bound is not decoration: `fetch` has no default timeout, so a
 * port held by a process that accepts the connection and never responds parks a
 * single request for minutes, and an outer loop deadline is never re-checked -
 * reproduced as a launch hanging past its own 30s limit on a squatted port.
 *
 * Resolves on any 2xx or a 403 (up but auth-gated). Rejects with `describe()`'s
 * text, or a generic one, once `timeoutMs` has passed.
 *
 * @param {string} url
 * @param {{ headers?: Record<string, string>, timeoutMs?: number, requestTimeoutMs?: number, intervalMs?: number, describe?: (lastError: string) => string }} [opts]
 */
export async function waitForHttp(
	url,
	{ headers = {}, timeoutMs = 30_000, requestTimeoutMs = 2_000, intervalMs = 300, describe } = {}
) {
	const start = Date.now();
	let last = 'no response';
	while (Date.now() - start < timeoutMs) {
		const budget = Math.max(1, Math.min(requestTimeoutMs, timeoutMs - (Date.now() - start)));
		try {
			const res = await fetch(url, { headers, signal: AbortSignal.timeout(budget) });
			if (res.ok || res.status === 403) return;
			last = `HTTP ${res.status}`;
		} catch (err) {
			last = err?.name === 'TimeoutError' ? `no response within ${budget}ms` : (err?.cause?.code ?? err?.message ?? String(err));
		}
		await new Promise((r) => setTimeout(r, intervalMs));
	}
	throw new Error(describe ? describe(last) : `timed out waiting for ${url} (last attempt: ${last})`);
}
