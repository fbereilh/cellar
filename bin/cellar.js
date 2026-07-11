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
 *   cellar ls                       list known cellar instances (registry +
 *                                   untracked orphans) with liveness.
 *   cellar cleanup [--all] [-y]     reap dead/orphaned instances (launcher gone,
 *                                   app still listening); --all also stops every
 *                                   live instance across all workspaces.
 *
 * Flags:
 *   --version / -v              print the version + build/git-sha and exit
 *   --update                    fetch + install the latest cellar and exit
 *                               (install-method aware: Homebrew or git clone;
 *                               see src/lib/server/selfupdate.js). Never launches.
 *   [path] / --workspace <dir>  open another repo without cd-ing (default cwd)
 *   --venv <dir>                explicit project venv (or CELLAR_VENV)
 *   --python <path>             escape hatch: bind an arbitrary interpreter,
 *                               no venv create / ipykernel install
 *   --yes / -y                  auto-approve venv create / ipykernel install
 *   --dev                       run the Vite dev server instead of the build
 *   --no-mcp-config             do not write/merge <workspace>/.mcp.json
 *   --new / --force             start a second instance in a folder that
 *                               already has a live one (power-user escape hatch;
 *                               normally a relaunch reaps + replaces the running one)
 *
 * Single-instance-per-folder + reap: a relaunch in a folder that already has a
 * live cellar TAKES OVER — it reaps the old instance and starts fresh, rather than
 * leaving the old one running with stale in-memory code (the pile-up this fixes:
 * old servers lingering after an update, still served to agents over MCP). An
 * `O_EXCL` lockfile (`.cellar/instance.lock`) still atomically gates ownership so
 * a rapid double-launch can't start two at once; whichever launcher wins the lock
 * runs, having reaped its predecessor. A global registry (`~/.cellar/instances/`,
 * see instances.js) records every instance so a launch can also reap orphaned
 * children (crashed launcher) and instances of deleted worktrees, and so
 * `cellar ls` / `cellar cleanup` can find and stop them. `--new`/`--force` skips
 * all of this to run a deliberate second instance.
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
import {
	writeRuntime,
	clearRuntime,
	writeMcpConfig,
	readRuntime,
	acquireInstanceLock,
	releaseInstanceLock
} from '../src/lib/server/runtime.js';
import {
	registerInstance,
	updateInstance,
	unregisterInstance,
	reapWorkspaceInstances,
	reapVanishedWorkspaces,
	pruneDeadInstances,
	listInstances,
	readInstance,
	annotateInstance,
	reapInstance,
	killPid,
	scanUntrackedCellarProcesses
} from '../src/lib/server/instances.js';

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

// `cellar --version` / `cellar --update` — handled before the normal launcher
// arg parsing (like `mcp`) so they never boot servers and their handling can't
// trip the unknown-flag guard. REPO (the launcher's own install dir) is what the
// version/update logic inspects to detect install method and rebuild in place.
if (argv.includes('--version') || argv.includes('-v')) {
	const { printVersion } = await import('../src/lib/server/selfupdate.js');
	printVersion(REPO);
	process.exit(0);
}
if (argv.includes('--update')) {
	const { runUpdate } = await import('../src/lib/server/selfupdate.js');
	process.exit(runUpdate(REPO));
}

// `cellar ls` / `cellar cleanup` — inspect and reap cellar instances. Handled
// before normal arg parsing so they never boot a server.
if (argv[0] === 'ls' || argv[0] === 'list') {
	await listInstancesCommand();
	process.exit(0);
}
if (argv[0] === 'cleanup' || argv[0] === 'kill') {
	const code = await cleanupCommand(argv.slice(1));
	process.exit(code);
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
const KNOWN_FLAGS = new Set(['--version', '-v', '--update', '--workspace', '-w', '--venv', '--python', '--yes', '-y', '--dev', '--build', '--no-mcp-config', '--new', '--force']);
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
// Power-user escape hatch: start a second, independent instance even if one is
// already live for this folder (normally a relaunch attaches to the running one).
const forceNew = hasFlag('--new', '--force');

// ---- Lifecycle ------------------------------------------------------------
const children = [];
let jupyterDir = null;
let runtimeWorkspace = null;
let lockWorkspace = null;
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
	// Release the single-instance lock only if we took it (never under --new,
	// where the first instance still owns the folder). Pid-guarded in releaseInstanceLock.
	if (lockWorkspace) {
		releaseInstanceLock(lockWorkspace);
		lockWorkspace = null;
	}
	// Drop our global registry entry (no-op if we never registered, e.g. --new).
	unregisterInstance();
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

// ---- `cellar ls` / `cellar cleanup` --------------------------------------
function fmtAge(startedAt) {
	if (!startedAt) return '?';
	const s = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.round(m / 60);
	if (h < 48) return `${h}h`;
	return `${Math.round(h / 24)}d`;
}

function promptYesNo(question) {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((res) => {
		rl.question(question, (ans) => {
			rl.close();
			res(/^\s*y/i.test(ans));
		});
	});
}

async function listInstancesCommand() {
	const entries = await Promise.all(listInstances().map(annotateInstance));
	if (entries.length === 0) {
		console.log('[cellar] no registered instances.');
	} else {
		console.log(`[cellar] ${entries.length} registered instance(s):`);
		for (const e of entries) {
			const state = e.launcherAlive ? 'live' : e.appAlive || e.appResponds ? 'ORPHAN' : 'dead';
			console.log(
				`  ${state.padEnd(6)} launcher=${e.launcherPid} app=${e.appPid ?? '?'} appPort=${e.appPort ?? '?'} mcpPort=${e.mcpPort ?? '?'} age=${fmtAge(e.startedAt)} ${e.workspace ?? ''}`
			);
		}
	}
	const untracked = scanUntrackedCellarProcesses();
	if (untracked.length) {
		console.log(`[cellar] ${untracked.length} untracked cellar process(es) (not in registry):`);
		for (const u of untracked) {
			console.log(`  ${u.ppid === 1 ? 'ORPHAN' : 'proc  '} pid=${u.pid} ppid=${u.ppid}  ${u.command}`);
		}
	}
}

async function cleanupCommand(flags) {
	const all = flags.includes('--all');
	const yes = flags.includes('--yes') || flags.includes('-y') || !!process.env.CI || !process.stdin.isTTY;
	const log = (m) => console.log(m);

	// 1) Prune fully-dead registry entries (no live process at all).
	const pruned = await pruneDeadInstances();
	if (pruned.length) console.log(`[cellar] pruned ${pruned.length} dead registry entr(ies).`);

	// 2) Decide what to reap.
	const entries = await Promise.all(listInstances().map(annotateInstance));
	const orphanRegistered = entries.filter((e) => !e.launcherAlive && (e.appAlive || e.appResponds));
	const liveRegistered = entries.filter((e) => e.launcherAlive);
	const untracked = scanUntrackedCellarProcesses();
	// Untracked orphans = reparented to init (ppid 1); safe — no launcher owns them.
	const untrackedOrphans = untracked.filter((u) => u.ppid === 1);
	const untrackedOther = untracked.filter((u) => u.ppid !== 1);

	const toReap = [...orphanRegistered];
	const toKillPids = untrackedOrphans.map((u) => u.pid);
	if (all) {
		toReap.push(...liveRegistered);
		toKillPids.push(...untrackedOther.map((u) => u.pid));
	}

	if (toReap.length === 0 && toKillPids.length === 0) {
		console.log(
			all
				? '[cellar] no cellar instances to stop.'
				: '[cellar] nothing to reap (no orphaned instances). Pass --all to also stop live instances.'
		);
		return 0;
	}

	console.log('[cellar] will stop:');
	for (const e of toReap)
		console.log(`  ${e.launcherAlive ? 'live  ' : 'orphan'} launcher=${e.launcherPid} app=${e.appPid ?? '?'} ${e.workspace ?? ''}`);
	for (const u of untrackedOrphans) console.log(`  orphan pid=${u.pid} (untracked)  ${u.command}`);
	if (all) for (const u of untrackedOther) console.log(`  proc   pid=${u.pid} (untracked)  ${u.command}`);

	if (!yes && !(await promptYesNo('[cellar] Stop these? [y/N] '))) {
		console.log('[cellar] aborted.');
		return 1;
	}

	for (const e of toReap) {
		console.log(`[cellar] stopping launcher ${e.launcherPid} …`);
		await reapInstance(e, { log });
	}
	for (const pid of toKillPids) {
		console.log(`[cellar] killing pid ${pid} …`);
		await killPid(pid);
	}
	console.log('[cellar] cleanup done.');
	return 0;
}

async function main() {
	console.log(`[cellar] workspace: ${WORKSPACE}`);

	// 0) Single-instance-per-folder + reap (unless --new/--force). The complaint
	//    this fixes: old cellar servers pile up (launcher crashed → orphaned app
	//    reparented to init; or a still-running instance after a code update), and
	//    an agent discovering a stale one over MCP gets outdated instructions. So a
	//    launch REAPS the old instance and takes over, rather than attaching to it.
	//    An O_EXCL lockfile (claimed before any slow toolchain work) still gates the
	//    folder so a rapid double-launch can't start two at once.
	const reapLog = (m) => console.log(m);
	if (!forceNew) {
		// Global hygiene (all workspaces): prune fully-dead registry entries, and
		// reap instances whose workspace directory no longer exists (deleted
		// worktrees). Both are always safe — nothing live for a real project is hit.
		await pruneDeadInstances();
		await reapVanishedWorkspaces({ excludePid: process.pid, log: reapLog });

		let lock = acquireInstanceLock(WORKSPACE);
		if (!lock.acquired && lock.ownerPid) {
			// A live instance owns this folder → TAKE OVER: reap it (gracefully:
			// SIGTERM cascades its own clean shutdown), then claim the lock. Reaping
			// the owner pid directly covers instances predating the registry; the
			// sweep then clears any other registered dupes/orphans for this folder.
			console.log(`[cellar] an instance (pid ${lock.ownerPid}) owns ${WORKSPACE} - taking over (reaping it).`);
			// Reap via the owner's real registry entry when present (so its recorded
			// app/jupyter children are killed explicitly, not just via the launcher's
			// SIGTERM cascade); fall back to a synthetic entry for a pre-registry owner.
			const ownerEntry = readInstance(lock.ownerPid) || { launcherPid: lock.ownerPid, workspace: WORKSPACE };
			await reapInstance(ownerEntry, { log: reapLog });
			await reapWorkspaceInstances(WORKSPACE, { excludePid: process.pid, log: reapLog });
			lock = acquireInstanceLock(WORKSPACE);
			for (let i = 0; !lock.acquired && i < 15; i++) {
				await new Promise((r) => setTimeout(r, 200));
				lock = acquireInstanceLock(WORKSPACE);
			}
			if (!lock.acquired) {
				console.error(
					`[cellar] could not claim ${WORKSPACE} after reaping the previous instance (pid ${lock.ownerPid}).`
				);
				console.error('[cellar] Another launcher may be racing it; retry, or pass --new to start a separate instance.');
				process.exit(1);
			}
		} else {
			// We won the lock (no live owner, or a dead owner's stale lock was
			// reclaimed inside acquireInstanceLock). A prior launcher that crashed may
			// still have orphaned app/jupyter children listening on old ports for THIS
			// workspace — reap them by the registry so only our instance survives.
			await reapWorkspaceInstances(WORKSPACE, { excludePid: process.pid, log: reapLog });
		}
		lockWorkspace = WORKSPACE; // cleanup() releases it on shutdown
		// Drop any stale runtime.json a prior crashed run left behind so discovery is
		// clean while we boot (writeRuntime overwrites it below regardless).
		const stale = readRuntime(WORKSPACE);
		if (stale && stale.pid !== process.pid) clearRuntime(WORKSPACE, stale.pid);
	}

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
	// Record in the global registry so a later launch / `cellar ls` / `cellar
	// cleanup` can discover and reap this instance (child pids filled in after the
	// sidecar + app spawn below). Registered even under --new so `ls`/`cleanup` see it.
	registerInstance({
		launcherPid: process.pid,
		workspace: WORKSPACE,
		appPort,
		mcpPort,
		jupyterPort,
		startedAt: Date.now(),
		mode: useDev ? 'dev' : 'build'
	});
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
		// cwd must agree with root_dir: a kernel started without a notebook path
		// (kernel.js `startNew({name:'python3'})`) inherits the sidecar's process
		// cwd, so anchoring it at WORKSPACE (not REPO) is what makes os.getcwd(),
		// relative reads/writes, and repo-root walks resolve in the user's project
		// rather than Cellar's install dir. All args/env here are absolute paths
		// (host python, JUPYTER_PATH temp dir), so they still resolve.
		{ cwd: WORKSPACE, env: { ...process.env, JUPYTER_PATH: jupyterDir }, stdio: ['ignore', 'inherit', 'inherit'] }
	);
	children.push(jupyter);
	updateInstance(process.pid, { jupyterPid: jupyter.pid });
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
		// Self-exit hook: the app watches this pid and exits if the launcher dies
		// uncleanly (parent-watch.js), so it never lingers orphaned serving stale code.
		CELLAR_LAUNCHER_PID: String(process.pid),
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
	updateInstance(process.pid, { appPid: app.pid });
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
