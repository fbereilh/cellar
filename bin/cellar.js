#!/usr/bin/env node
/**
 * Cellar launcher — run `cellar` in any project directory.
 *
 * One command, run in a folder:
 *   1. resolve the project's Python venv (reuse `.venv`, or create one via uv),
 *      ensuring `ipykernel` is present there;
 *   2. ensure Cellar's private Jupyter host env (`~/.cellar/host-venv`);
 *   3. write a per-run `python3` kernelspec pointing at the project python and
 *      start the headless Jupyter sidecar (host env) with JUPYTER_PATH → it;
 *   4. start the SvelteKit server pointed at that sidecar, scoped to the folder;
 *   5. open the browser to the notebook UI.
 *
 * Distribution: npm package (see package.json `files`/`prepublishOnly`).
 * Default serves the production build (`build/index.js`); `--dev` uses Vite.
 *
 * Subcommands:
 *   cellar mcp [--workspace <dir>]  stdio ↔ HTTP MCP bridge for the running
 *                                   instance (zero-config agent connection; see
 *                                   src/lib/server/mcp-bridge.js). Fails fast if
 *                                   no cellar is running in the workspace.
 *
 * Flags:
 *   [path] / --workspace <dir>  open another repo without cd-ing (default cwd)
 *   --venv <dir>                explicit project venv (or CELLAR_VENV)
 *   --python <path>             escape hatch: bind an arbitrary interpreter,
 *                               no venv create / ipykernel install
 *   --yes / -y                  auto-approve venv create / ipykernel install
 *   --dev                       run the Vite dev server instead of the build
 *   --no-mcp-config             do not write/merge <workspace>/.mcp.json
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import {
	requireUv,
	resolveProjectVenv,
	createVenv,
	ensureIpykernel,
	hasIpykernel,
	ensureHostEnv,
	writeKernelspec,
	venvPython,
	UvMissingError
} from '../src/lib/server/venv.js';
import { writeRuntime, clearRuntime, writeMcpConfig } from '../src/lib/server/runtime.js';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

// ---- Arg parsing ----------------------------------------------------------
const argv = process.argv.slice(2);

// `cellar mcp` — stdio bridge to the running instance. Handled before the
// normal launcher arg parsing so its own flags never trip the unknown-flag
// guard, and it never boots servers.
if (argv[0] === 'mcp') {
	const sub = argv.slice(1);
	const wsIdx = sub.findIndex((a) => a === '--workspace' || a === '-w');
	const wsArg = wsIdx !== -1 ? sub[wsIdx + 1] : undefined;
	const workspace = resolve(wsArg || process.cwd());
	const { runMcpBridge } = await import('../src/lib/server/mcp-bridge.js');
	// Resolves only on clean shutdown (stdin close / signal / upstream close).
	await runMcpBridge({ workspace });
	process.exit(0);
}

function flagValue(...names) {
	for (const name of names) {
		const i = argv.indexOf(name);
		if (i !== -1 && i + 1 < argv.length) return argv[i + 1];
	}
	return undefined;
}
function hasFlag(...names) {
	return names.some((n) => argv.includes(n));
}
const KNOWN_FLAGS = new Set(['--workspace', '-w', '--venv', '--python', '--yes', '-y', '--dev', '--build', '--no-mcp-config']);
const VALUE_FLAGS = new Set(['--workspace', '-w', '--venv', '--python']);
// First non-flag, non-flag-value token is the positional workspace path.
let positional;
for (let i = 0; i < argv.length; i++) {
	const tok = argv[i];
	if (VALUE_FLAGS.has(tok)) {
		i++; // skip its value
		continue;
	}
	if (tok.startsWith('-')) {
		if (!KNOWN_FLAGS.has(tok)) {
			console.error(`[cellar] unknown flag: ${tok}`);
			process.exit(1);
		}
		continue;
	}
	positional = tok;
	break;
}

const WORKSPACE = resolve(flagValue('--workspace', '-w') || positional || process.cwd());
const venvOverride = flagValue('--venv') || process.env.CELLAR_VENV;
const pythonOverride = flagValue('--python');
const autoYes = hasFlag('--yes', '-y') || !!process.env.CI || !process.stdin.isTTY;
// Production build is the default; --dev opts into Vite (--build kept as alias).
const useDev = hasFlag('--dev') && !hasFlag('--build');
const writeMcpConfigOptIn = !hasFlag('--no-mcp-config');

// ---- Lifecycle ------------------------------------------------------------
const children = [];
let jupyterDir = null;
let runtimeWorkspace = null;
function cleanup() {
	if (jupyterDir) {
		try {
			rmSync(jupyterDir, { recursive: true, force: true });
		} catch {}
		jupyterDir = null;
	}
	if (runtimeWorkspace) {
		clearRuntime(runtimeWorkspace);
		runtimeWorkspace = null;
	}
}
function shutdown(code = 0) {
	for (const c of children) {
		try {
			c.kill('SIGTERM');
		} catch {}
	}
	cleanup();
	process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

function freePort() {
	return new Promise((resolvePort, reject) => {
		const srv = createServer();
		srv.unref();
		srv.on('error', reject);
		srv.listen(0, '127.0.0.1', () => {
			const { port } = srv.address();
			srv.close(() => resolvePort(port));
		});
	});
}

async function waitFor(url, { headers = {}, timeoutMs = 30000 } = {}) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const res = await fetch(url, { headers });
			if (res.ok || res.status === 403) return; // 403 = up but auth-gated
		} catch {}
		await new Promise((r) => setTimeout(r, 300));
	}
	throw new Error(`timed out waiting for ${url}`);
}

function confirm(question) {
	if (autoYes) return Promise.resolve(true);
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((res) => {
		rl.question(`${question} [Y/n] `, (ans) => {
			rl.close();
			res(!/^\s*n/i.test(ans));
		});
	});
}

async function openBrowser(url) {
	const cmd =
		process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
	spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
}

/**
 * Resolve (and, with consent, create) the project venv + ensure ipykernel.
 * Returns the interpreter to bind and the venv dir (null for --python).
 */
async function resolveInterpreter() {
	const r = resolveProjectVenv({ workspace: WORKSPACE, venvOverride, pythonOverride });

	if (r.mode === 'python') {
		if (!existsSync(r.python)) {
			console.error(`[cellar] --python interpreter not found: ${r.python}`);
			process.exit(1);
		}
		console.log(`[cellar] binding interpreter (--python, no venv/ipykernel management): ${r.python}`);
		if (!(await hasIpykernel(r.python))) {
			console.warn('[cellar] warning: ipykernel not importable from that interpreter; the kernel may fail to start.');
		}
		return { python: r.python, venv: null };
	}

	if (r.needsCreate) {
		console.log(`[cellar] No usable virtualenv found for ${WORKSPACE}.`);
		console.log('[cellar] Will run:');
		console.log(`[cellar]   uv venv ${r.venv}`);
		console.log(`[cellar]   uv pip install --python ${r.python} ipykernel`);
		if (!(await confirm(`[cellar] Create ${r.venv} and install ipykernel?`))) {
			console.error('[cellar] aborted (no venv). Pass --venv <dir> or --python <path> to choose one.');
			process.exit(1);
		}
		await createVenv(r.venv, { stdio: 'inherit' });
		await ensureIpykernel(r.python, { stdio: 'inherit' });
		console.log(`[cellar] created ${r.venv} with ipykernel.`);
		return { python: r.python, venv: r.venv };
	}

	// Existing venv (source: override / VIRTUAL_ENV / .venv).
	if (r.source === 'VIRTUAL_ENV') console.log(`[cellar] using active $VIRTUAL_ENV: ${r.venv}`);
	else console.log(`[cellar] using project venv: ${r.venv}`);

	if (!(await hasIpykernel(r.python))) {
		console.log(`[cellar] ipykernel is missing from ${r.venv}.`);
		console.log(`[cellar] Will run:  uv pip install --python ${r.python} ipykernel`);
		if (!(await confirm('[cellar] Install ipykernel into that venv?'))) {
			console.error('[cellar] aborted (ipykernel required to run a kernel).');
			process.exit(1);
		}
		await ensureIpykernel(r.python, { stdio: 'inherit' });
	}
	return { python: r.python, venv: r.venv };
}

async function main() {
	// uv is mandatory — fail fast with an actionable message, no silent fallback.
	try {
		await requireUv();
	} catch (err) {
		if (err instanceof UvMissingError) {
			console.error(`[cellar] ${err.message}`);
			process.exit(1);
		}
		throw err;
	}

	console.log(`[cellar] workspace: ${WORKSPACE}`);

	// 1) Project interpreter (reuse/create the venv, ensure ipykernel).
	const { python: projectPython } = await resolveInterpreter();

	// 2) Cellar's private Jupyter host env (jupyter-server), cached in ~/.cellar.
	console.log('[cellar] preparing Jupyter host env (~/.cellar/host-venv) …');
	const host = await ensureHostEnv({ stdio: 'inherit' });
	if (host.created) console.log('[cellar] host env created.');
	const hostPython = venvPython(host.hostVenv);

	// 3) Per-run python3 kernelspec pointing at the project interpreter.
	jupyterDir = mkdtempSync(join(tmpdir(), 'cellar-jup-'));
	const kernelDir = join(jupyterDir, 'kernels', 'python3');
	writeKernelspec(kernelDir, projectPython);
	console.log(`[cellar] kernel bound to: ${projectPython}`);

	// 4) Ports (app + jupyter already dynamic; MCP now dynamic too — fixes the
	//    concurrent-instance collision on the previously-fixed 39587).
	const jupyterPort = await freePort();
	const appPort = await freePort();
	const mcpPort = await freePort();
	const token = randomBytes(24).toString('hex');
	const jupyterUrl = `http://127.0.0.1:${jupyterPort}`;

	// Zero-config agent wiring: record the live port map so `cellar mcp` can
	// discover this instance, and point the project's .mcp.json at that bridge
	// (a stdio command, not a URL) so the dynamic port never leaks into config.
	runtimeWorkspace = WORKSPACE;
	writeRuntime(WORKSPACE, { mcpPort, appPort, jupyterPort });
	if (writeMcpConfigOptIn) {
		const status = writeMcpConfig(WORKSPACE);
		console.log(`[cellar] .mcp.json: ${status} (agent connects via \`cellar mcp\`)`);
	}

	// 5) Jupyter sidecar (host env), discovering our kernelspec via JUPYTER_PATH.
	const jupyter = spawn(
		hostPython,
		[
			'-m',
			'jupyter_server',
			`--ServerApp.token=${token}`,
			`--ServerApp.port=${jupyterPort}`,
			'--ServerApp.ip=127.0.0.1',
			'--ServerApp.open_browser=False',
			`--ServerApp.root_dir=${WORKSPACE}`,
			'--ServerApp.disable_check_xsrf=True'
		],
		{ cwd: REPO, env: { ...process.env, JUPYTER_PATH: jupyterDir }, stdio: ['ignore', 'inherit', 'inherit'] }
	);
	children.push(jupyter);
	jupyter.on('exit', (c) => {
		console.error(`[cellar] jupyter sidecar exited (${c})`);
		shutdown(1);
	});

	console.log(`[cellar] starting Jupyter sidecar on ${jupyterUrl} …`);
	await waitFor(`${jupyterUrl}/api`, { headers: { Authorization: `token ${token}` } });
	console.log('[cellar] Jupyter sidecar up.');

	// 6) SvelteKit server. The venv/kernelspec env vars let the Settings API
	//    re-resolve, create, and rebind venvs at runtime.
	const env = {
		...process.env,
		CELLAR_JUPYTER_URL: jupyterUrl,
		CELLAR_JUPYTER_TOKEN: token,
		CELLAR_WORKSPACE: WORKSPACE,
		CELLAR_MCP_PORT: String(mcpPort),
		CELLAR_PROJECT_VENV: projectPython,
		CELLAR_KERNELSPEC_DIR: kernelDir,
		PORT: String(appPort)
	};

	let app;
	if (useDev) {
		app = spawn(
			join(REPO, 'node_modules', '.bin', 'vite'),
			['dev', '--port', String(appPort), '--strictPort'],
			{ cwd: REPO, env, stdio: 'inherit' }
		);
	} else {
		const buildEntry = join(REPO, 'build', 'index.js');
		if (!existsSync(buildEntry)) {
			console.error(`[cellar] production build not found at ${buildEntry}.`);
			console.error('[cellar] Run `npm run build` first, or pass --dev to use the Vite dev server.');
			shutdown(1);
			return;
		}
		app = spawn('node', [buildEntry], { cwd: REPO, env, stdio: 'inherit' });
	}
	children.push(app);
	app.on('exit', (c) => {
		console.error(`[cellar] app server exited (${c})`);
		shutdown(1);
	});

	const appUrl = `http://localhost:${appPort}`;
	console.log(`[cellar] starting SvelteKit app on ${appUrl} …`);
	await waitFor(appUrl);
	const openUrl = `${appUrl}/?ws=${encodeURIComponent(WORKSPACE)}`;
	console.log(`[cellar] ready:`);
	console.log(`[cellar]   app → ${openUrl}`);
	console.log(`[cellar]   MCP → http://127.0.0.1:${mcpPort}/mcp`);
	await openBrowser(openUrl);
	console.log('[cellar] running. Ctrl-C to stop.');
}

main().catch((err) => {
	console.error('[cellar] launch failed:', err?.message ?? err);
	shutdown(1);
});
