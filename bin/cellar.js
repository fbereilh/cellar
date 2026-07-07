#!/usr/bin/env node
/**
 * Cellar spike launcher.
 *
 * One command, run in a folder:
 *   1. start a headless Jupyter kernel service (Python sidecar) scoped to the folder
 *   2. start the SvelteKit server (Node backend + UI), pointed at that sidecar
 *   3. open the default browser to the notebook UI
 *
 * This is the "launcher shape" from the spec: `cellar` in a directory boots
 * both runtimes and opens the browser. Dev-mode (vite) by default; pass
 * --build to serve the production build via the Node adapter.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const WORKSPACE = process.cwd();
const useBuild = process.argv.includes('--build');

const VENV_PY = join(REPO, '.venv', 'bin', 'python');
if (!existsSync(VENV_PY)) {
	console.error(`[cellar] Python venv not found at ${VENV_PY}.`);
	console.error('[cellar] Run:  python3 -m venv .venv && ./.venv/bin/pip install jupyter-server ipykernel');
	console.error('[cellar]  and: ./.venv/bin/python -m ipykernel install --sys-prefix --name python3');
	process.exit(1);
}

const children = [];
function shutdown(code = 0) {
	for (const c of children) {
		try {
			c.kill('SIGTERM');
		} catch {}
	}
	process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

function freePort() {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.unref();
		srv.on('error', reject);
		srv.listen(0, '127.0.0.1', () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
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

async function openBrowser(url) {
	const cmd =
		process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
	spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
}

async function main() {
	const jupyterPort = await freePort();
	const appPort = await freePort();
	const token = randomBytes(24).toString('hex');
	const jupyterUrl = `http://127.0.0.1:${jupyterPort}`;

	console.log(`[cellar] workspace: ${WORKSPACE}`);

	// 1) Jupyter kernel sidecar
	const jupyter = spawn(
		VENV_PY,
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
		{ cwd: REPO, stdio: ['ignore', 'inherit', 'inherit'] }
	);
	children.push(jupyter);
	jupyter.on('exit', (c) => {
		console.error(`[cellar] jupyter sidecar exited (${c})`);
		shutdown(1);
	});

	console.log(`[cellar] starting Jupyter sidecar on ${jupyterUrl} …`);
	await waitFor(`${jupyterUrl}/api`, { headers: { Authorization: `token ${token}` } });
	console.log('[cellar] Jupyter sidecar up.');

	// 2) SvelteKit server
	const env = {
		...process.env,
		CELLAR_JUPYTER_URL: jupyterUrl,
		CELLAR_JUPYTER_TOKEN: token,
		CELLAR_WORKSPACE: WORKSPACE,
		PORT: String(appPort)
	};

	let app;
	if (useBuild) {
		app = spawn('node', [join(REPO, 'build', 'index.js')], { cwd: REPO, env, stdio: 'inherit' });
	} else {
		app = spawn(
			join(REPO, 'node_modules', '.bin', 'vite'),
			['dev', '--port', String(appPort), '--strictPort'],
			{ cwd: REPO, env, stdio: 'inherit' }
		);
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
	console.log(`[cellar] ready → opening ${openUrl}`);
	await openBrowser(openUrl);
	console.log('[cellar] running. Ctrl-C to stop.');
}

main().catch((err) => {
	console.error('[cellar] launch failed:', err);
	shutdown(1);
});
