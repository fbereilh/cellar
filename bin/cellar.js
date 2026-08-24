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
 *   cellar harness list             show every supported agent harness: whether
 *                                   Cellar manages it here, and whether its
 *                                   config currently has the cellar entry.
 *   cellar harness add <name…>      let Cellar manage a harness (`claude` →
 *                                   .mcp.json, `codex` → .codex/config.toml, or
 *                                   `all`) and configure it now. Merges
 *                                   idempotently; see src/lib/server/harness.js.
 *   cellar harness remove <name…>   stop managing one (its config entry is left
 *                                   in place; `--strip` also removes it).
 *   cellar ls                       list known cellar instances (registry +
 *                                   untracked orphans) with liveness.
 *   cellar cleanup [options]        reap dead/orphaned instances (launcher gone,
 *                                   app still listening) — anywhere, at every
 *                                   scope. `--all` additionally stops LIVE
 *                                   instances serving THIS workspace;
 *                                   `--all-workspaces` stops live instances in
 *                                   ANY workspace and needs an explicit typed
 *                                   confirmation (`-y` cannot supply it), because
 *                                   that is somebody's running session. See
 *                                   src/lib/server/cleanup-plan.js for the rule.
 *                                   `--dry-run` prints the plan and stops nothing.
 *
 * Flags:
 *   --help / -h                 print this usage message and exit
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
 * Environment:
 *   CELLAR_ISOLATED=1|true|yes  run isolated (no global registry entry, no
 *                               reaping, no single-instance lock) — for CI /
 *                               automated launches that must never see or reap a
 *                               user's real instance. Applies to every launch in
 *                               the environment (a superset of --new; --new still
 *                               registers, isolated does not). Unset = normal.
 *   CELLAR_APP_PORT / CELLAR_MCP_PORT / CELLAR_JUPYTER_PORT
 *                               pin these ports - needed to publish/map them in
 *                               Docker or any container. A pin always wins. Unset:
 *                               an ordinary launch REUSES the app/MCP ports this
 *                               folder had last time when they are still free
 *                               (`.cellar/ports.json`, see ports.js), falling back
 *                               to a fresh ephemeral port; Jupyter, and every
 *                               isolated / --new launch, is always ephemeral.
 *   CELLAR_NO_BROWSER=1|true|yes  do not try to open a browser (headless /
 *                               container launches; the user opens the printed URL).
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
 * all of this to run a deliberate second instance; `CELLAR_ISOLATED` does the same
 * and additionally skips the registry entry (so it is invisible to ls/cleanup too).
 */
import { spawn, spawnSync } from 'node:child_process';
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
	ensureIpywidgets,
	hasIpykernel,
	ensureHostEnv,
	writeKernelspec,
	venvPython,
	UvMissingError
} from '../src/lib/server/venv.js';
import {
	writeRuntime,
	clearRuntime,
	readRuntime,
	acquireInstanceLock,
	releaseInstanceLock,
	pidAlive
} from '../src/lib/server/runtime.js';
import {
	RUNNING_NOTE,
	allowHarness,
	configureHarness,
	disallowHarness,
	getHarness,
	harnessNames,
	harnessState,
	isHarnessAllowed,
	markHarnessPrompted,
	mcpJsonHarnessNames,
	parseHarnessAnswer,
	promptedHarnesses,
	readAllowList,
	reconcileHarnesses,
	shouldPromptHarnessSetup,
	stripHarness
} from '../src/lib/server/harness.js';
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
	processStartTime,
	scanUntrackedCellarProcesses,
	isIsolatedEnv
} from '../src/lib/server/instances.js';
import { CONFIRM_PHRASE, planCleanup, workspaceKey } from '../src/lib/server/cleanup-plan.js';
import { resolveWorkspacePorts } from '../src/lib/server/ports.js';
import { buildFreshness, stalenessReason, SKIP_ENV } from '../src/lib/server/build-freshness.js';

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
	// Resolves only on clean shutdown (stdin close / signal). An upstream that
	// goes away is NOT a shutdown: the bridge re-attaches to whatever instance
	// serves the folder next (see mcp-bridge.js).
	await runMcpBridge({ workspace });
	process.exit(0);
}

// `cellar --help` / `-h` — handled before the normal launcher arg parsing (like
// `mcp` / `--version`) so it never boots a server and can't trip the unknown-flag
// guard. Kept in sync with the top-of-file header JSDoc.
if (argv.includes('--help') || argv.includes('-h')) {
	printHelp();
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

// `cellar harness …` — configure an AI coding agent to use Cellar's MCP server.
// Handled before normal arg parsing (like `mcp` / `ls`) so it never boots a
// server and its own args can't trip the unknown-flag guard.
if (argv[0] === 'harness' || argv[0] === 'harnesses') {
	process.exit(harnessCommand(argv.slice(1)));
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

/**
 * Sidecar CLI args for idle-kernel culling (empty when disabled). Reads
 * CELLAR_KERNEL_IDLE_TIMEOUT (default 7200s / 2h; 0 or non-positive disables) and
 * CELLAR_KERNEL_CULL_INTERVAL (default min(300, timeout)). Logs the effective
 * policy so a stuck-alive kernel is diagnosable.
 */
function cullingArgs() {
	const raw = process.env.CELLAR_KERNEL_IDLE_TIMEOUT;
	const timeout = raw == null || raw === '' ? 7200 : Number(raw);
	if (!Number.isFinite(timeout) || timeout <= 0) {
		console.log('[cellar] idle-kernel culling: disabled');
		return [];
	}
	const t = Math.floor(timeout);
	const rawInterval = process.env.CELLAR_KERNEL_CULL_INTERVAL;
	const intervalNum = rawInterval == null || rawInterval === '' ? Math.min(300, t) : Number(rawInterval);
	const interval = Number.isFinite(intervalNum) && intervalNum > 0 ? Math.floor(intervalNum) : Math.min(300, t);
	console.log(`[cellar] idle-kernel culling: ${t}s idle, swept every ${interval}s`);
	return [
		`--MappingKernelManager.cull_idle_timeout=${t}`,
		`--MappingKernelManager.cull_interval=${interval}`,
		// Cellar always holds a websocket to each kernel, so a kernel is "connected"
		// even when idle; without this, jupyter's culler would never touch it.
		'--MappingKernelManager.cull_connected=True'
	];
}
const KNOWN_FLAGS = new Set(['--help', '-h', '--version', '-v', '--update', '--workspace', '-w', '--venv', '--python', '--yes', '-y', '--dev', '--build', '--no-mcp-config', '--new', '--force']);
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
// Isolated mode (env-driven): run fully independent — no global registry entry,
// no reaping, no single-instance lock — for CI / automated launches that must
// never see or reap a user's real instance. Set for every launch in the shell,
// so a test harness needn't remember a flag (see isIsolatedEnv). It is a strict
// superset of --new: --new skips reap+lock but still registers (so `ls`/`cleanup`
// see it); isolated additionally skips registerInstance.
const isolated = isIsolatedEnv();
// Power-user escape hatch: start a second, independent instance even if one is
// already live for this folder (normally a relaunch attaches to the running one).
// Isolated implies it — both skip the reap + single-instance-lock block.
const forceNew = hasFlag('--new', '--force') || isolated;

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
let shuttingDown = false;
function shutdown(code = 0, trigger = 'unknown') {
	if (shuttingDown) return; // a child exiting during our own teardown must not recurse
	shuttingDown = true;
	// Always name WHY we are stopping, so a killed instance is distinguishable
	// from one that crashed — the user asked to be able to see this in the log.
	console.log(`[cellar] shutting down (trigger: ${trigger}) - stopping ${children.length} child process(es)`);
	for (const c of children) {
		try {
			c.kill('SIGTERM');
		} catch {}
	}
	cleanup();
	process.exit(code);
}
// A SIGTERM here is almost always another `cellar` launch reaping this instance
// (take-over / cleanup) or the terminal/session ending. Naming it is what turns
// "my kernel just died" into an answerable question.
process.on('SIGINT', () => shutdown(0, 'SIGINT (Ctrl-C / interrupt)'));
process.on('SIGTERM', () => shutdown(0, 'SIGTERM received (another cellar reaped us, or the session ended)'));
// Belt-and-suspenders: drop our own registry entry on ANY normal exit (uncaught
// throw, natural end), not just the signal paths, so a throwaway-workspace
// instance never leaves a stale entry whose pid the OS could later reuse. Sync
// only (rmSync), pid-guarded, idempotent — safe to also run after cleanup().
process.on('exit', () => {
	try {
		unregisterInstance();
	} catch {}
});

// Known TOCTOU: the probe socket is closed before the returned port is handed to
// the app's real listen(), so the port is briefly unclaimed. Per-run instances use
// mkdtemp workspaces + dynamic ports, so collisions are near-impossible in practice;
// e2e runs at workers:2 (do NOT drop below 2). If a port-collision flake ever
// surfaces here, harden by holding the probe socket open until the child has bound,
// or by retrying the launch on EADDRINUSE — not by serializing the suite.
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

// Known, pre-existing: `inForegroundJob()` guards the harness prompt only, so a
// backgrounded `cellar &` can still be stopped by SIGTTIN here - deliberately
// left alone, since refusing to read would change what such a launch DOES.
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
	// Headless / container launches (CELLAR_NO_BROWSER) have no browser to open —
	// the user opens the printed URL on the host. Skip cleanly.
	if (/^(1|true|yes)$/i.test(process.env.CELLAR_NO_BROWSER ?? '')) return;
	const cmd =
		process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
	const child = spawn(cmd, [url], {
		stdio: 'ignore',
		detached: true,
		shell: process.platform === 'win32'
	});
	// A missing opener (e.g. no `xdg-open` in a minimal container) emits an 'error'
	// event; without this handler Node would throw it as an uncaught exception and
	// crash the launcher. Opening a browser is best-effort, never fatal.
	child.on('error', () => {});
	child.unref();
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
		await ensureWidgets(r.python);
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
	await ensureWidgets(r.python);
	return { python: r.python, venv: r.venv };
}

/**
 * Best-effort: enable Databricks-style parameter widgets (and any ipywidget) by
 * ensuring `ipywidgets` in the project venv. A soft feature dependency, unlike
 * `ipykernel` - it never prompts and never aborts (the kernel-side shim degrades
 * to value-only without it), so a failure is a quiet no-op.
 */
async function ensureWidgets(python) {
	const { installed } = await ensureIpywidgets(python, { stdio: 'pipe' });
	if (installed) console.log(`[cellar] installed ipywidgets into ${python} (parameter widgets).`);
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

/**
 * Decide, from `ps -o pgid=,tpgid=` for THIS process, whether we are the
 * terminal's FOREGROUND job. Pure so the parse is testable; `null` means the
 * question could not be answered (no controlling terminal, or a `ps` that does
 * not report `tpgid`), which callers must treat as unknown, never as a "no".
 */
function foregroundFromPs(text) {
	const [pgid, tpgid] = String(text ?? '')
		.trim()
		.split(/\s+/)
		.map(Number);
	if (!Number.isInteger(pgid) || !Number.isInteger(tpgid) || tpgid <= 0) return null;
	return pgid === tpgid;
}

/**
 * Is this process the controlling terminal's foreground job? `false` means a
 * backgrounded `cellar &`, which MUST NOT read stdin (see `maybePromptHarnessSetup`).
 * `null` = unknown (Windows has no such job control; a `ps` without `tpgid`).
 */
function inForegroundJob() {
	if (process.platform === 'win32') return null;
	try {
		const r = spawnSync('ps', ['-o', 'pgid=,tpgid=', '-p', String(process.pid)], { encoding: 'utf8' });
		if (r.error || r.status !== 0) return null;
		return foregroundFromPs(r.stdout);
	} catch {
		return null;
	}
}

/**
 * Free-text prompt (the harness picker needs a list, not a yes/no).
 *
 * Resolves `null` - "no answer" - rather than waiting forever, because this one
 * runs in the LAUNCH path: a stdin that closes (or errors) would otherwise leave
 * the promise pending and the notebook unstarted. A closed stdin, a read error and
 * `timeoutMs` elapsing are all one outcome, which the caller must treat as "not
 * answered" - never as a decision.
 *
 * The timeout does NOT cover a backgrounded job, and nothing here can: reading the
 * controlling terminal from a background process group raises SIGTTIN, whose default
 * disposition STOPS the process, and a stopped process runs no timers. Installing a
 * SIGTTIN listener to override that stop is worse, not better - measured: the read
 * then fails with EIO, libuv retries it, and the process spins at 100% CPU without
 * ever reaching the JS handler or the timer. So that case is kept out of here
 * entirely, by not calling this at all off the foreground (see `inForegroundJob`).
 *
 * Ctrl-C is its own outcome and needs its own listener: readline runs in terminal
 * mode here (stdout is a TTY), which puts stdin in raw mode and SWALLOWS ^C, so the
 * module-level `process.on('SIGINT')` never fires. Without the listener below the
 * keystroke read as "no answer" and the launch carried on booting the sidecar and
 * opening a browser - the opposite of what it means. It hands off to the launcher's
 * one shutdown path; nothing is recorded, since that path never returns.
 */
function ask(question, { timeoutMs } = {}) {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((res) => {
		let settled = false;
		let timer = null;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			rl.close();
			// Nothing more will be read: don't leave a resumed stdin holding the loop.
			if (value === null) process.stdin.pause();
			res(value);
		};
		// Deliberately NOT unref'd: the launch is awaiting this promise, so a timer the
		// loop is free to ignore would let the process fall out from under the prompt
		// instead of giving up and continuing. Cleared by `finish`, so it holds nothing
		// open once an answer (or any other outcome) arrives.
		if (timeoutMs) timer = setTimeout(() => finish(null), timeoutMs);
		// `close` covers a stdin that ends without answering; `error` covers a read
		// that fails - readline forwards its input stream's errors here, which is what
		// makes this the one listener that has to exist.
		rl.on('close', () => finish(null));
		rl.on('error', () => finish(null));
		// The user's explicit interrupt, not a prompt failure: close the interface
		// (restoring the terminal out of raw mode) and hand off to the launcher's
		// EXISTING teardown, which exits - so nothing after the prompt runs.
		rl.on('SIGINT', () => {
			if (timer) clearTimeout(timer);
			rl.close();
			shutdown(0, 'SIGINT (Ctrl-C at the harness prompt)');
		});
		rl.question(question, (ans) => finish(ans));
	});
}

function printHelp() {
	console.log(`cellar - run a live, agent-connected notebook in any project directory.

Usage:
  cellar [path] [options]     start Cellar in a folder (default: cwd)
  cellar mcp [options]        stdio <-> HTTP MCP bridge for the running instance
  cellar harness <cmd>        configure an AI coding agent to use Cellar's tools
  cellar ls                   list known cellar instances with liveness
  cellar cleanup [options]    reap dead / orphaned instances (see Cleanup options)

Subcommands:
  mcp        zero-config agent connection: bridge stdio to the live instance
             (fails fast if no cellar is running in the workspace)
  harness    list            what Cellar manages here + each config's state
             add <name…>     manage a harness and configure it now, e.g.
                             "cellar harness add codex" (claude | codex | all).
                             Managed harnesses are re-checked and repaired on
                             every start. Merges; never clobbers existing config.
             remove <name…>  stop managing one (--strip also removes its entry)
  ls         list registered + untracked cellar instances and whether each is alive
  cleanup    reap dead/orphaned instances anywhere; stopping a LIVE instance is
             opt-in and scoped to a workspace (see Cleanup options below)

Options:
  --help, -h              print this usage message and exit
  --version, -v           print the version + build/git-sha and exit
  --update                fetch + install the latest cellar and exit (never launches)
  [path] / --workspace <dir>  open another repo without cd-ing (default: cwd)
  --venv <dir>            explicit project venv (or CELLAR_VENV)
  --python <path>         bind an arbitrary interpreter (no venv create / install)
  --yes, -y               auto-approve venv create / ipykernel install
  --dev                   run the Vite dev server instead of the production build
  --no-mcp-config         do not write/merge <workspace>/.mcp.json
  --new / --force         start a second instance in a folder that already has one

Cleanup options (cellar cleanup …):
  (no flags)              reap dead + orphaned instances only; never stops a live one
  --all                   also stop LIVE instances serving THIS workspace
  --all-workspaces        also stop LIVE instances in ANY workspace. Someone else
                          may be working in them, so this needs an explicit
                          confirmation: type "stop-all-workspaces" when asked,
                          or pass --confirm=stop-all-workspaces to script it.
                          --yes / -y / CI / a piped stdin do NOT satisfy it.
  --confirm=<phrase>      supply that confirmation non-interactively
  --dry-run               print exactly what would be stopped, then exit
  --workspace <dir>, -w   treat <dir> as "this workspace" (default: cwd)
  --yes, -y               skip the y/N prompt for the routine (non-cross-workspace)
                          stops only

Environment:
  CELLAR_ISOLATED=1       run isolated (no global registry, no reaping) — for
                          CI / automated launches (applies to every launch; a
                          superset of --new that also skips registration)

Examples:
  cellar                    start Cellar in the current directory
  cellar ../other-repo      start Cellar scoped to another repo
  cellar harness add codex  point Codex at Cellar's MCP server for this project
  cellar --update           update Cellar to the latest version
  cellar cleanup            reap dead/orphaned instances (safe; touches no live one)
  cellar cleanup --all      also stop the live instance in this folder
  cellar cleanup --dry-run --all-workspaces
                            show every live instance cleanup could stop, stop none`);
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

/**
 * Prompt for a literal phrase (not y/N). Resolves the trimmed answer, or null
 * when stdin gives no answer at all. Deliberately distinct from `promptYesNo`:
 * a phrase is what makes the cross-workspace kill unreachable by a stray `-y`.
 */
function promptPhrase(question) {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((res) => {
		let settled = false;
		const finish = (v) => {
			if (settled) return;
			settled = true;
			rl.close();
			res(v);
		};
		rl.on('close', () => finish(null));
		rl.on('error', () => finish(null));
		rl.question(question, (ans) => finish(String(ans ?? '').trim()));
	});
}

/** One printable line describing a registry entry in the cleanup plan. */
function planLine(e) {
	const state = e.launcherAlive ? 'live  ' : 'orphan';
	return `  ${state} launcher=${e.launcherPid} app=${e.appPid ?? '?'} appPort=${e.appPort ?? '?'} age=${fmtAge(e.startedAt)} ${e.workspace ?? '(workspace unknown)'}`;
}

/**
 * `cellar cleanup` — reap dead / orphaned instances, and (only when asked)
 * stop live ones.
 *
 * The scope rule and the reasoning behind it live in
 * `src/lib/server/cleanup-plan.js`; this function is the CLI around it: parse
 * flags, gather facts, print the plan, obtain the right kind of consent, act.
 *
 * Two consent levels, because they are not the same question:
 *   - stopping orphans, or a live instance in THIS workspace, is routine
 *     housekeeping → an ordinary y/N, auto-approved by `-y`/`CI`/a non-TTY;
 *   - stopping a live instance in ANOTHER workspace is taking someone else's
 *     running session → the literal `CONFIRM_PHRASE`, which none of those
 *     auto-approvals can supply. That is the whole fix: `-y` used to be enough,
 *     and a non-TTY stdin was enough with no flag at all.
 */
async function cleanupCommand(flags) {
	const KNOWN = new Set(['--all', '--all-workspaces', '--dry-run', '--yes', '-y', '--workspace', '-w']);
	// Reject typos rather than silently falling through to a different scope: this
	// command stops processes, so an argument it does not understand must stop it.
	for (let i = 0; i < flags.length; i++) {
		const tok = flags[i];
		if (tok === '--workspace' || tok === '-w') {
			i++;
			continue;
		}
		if (tok.startsWith('--confirm=')) continue;
		if (tok.startsWith('-') && !KNOWN.has(tok)) {
			console.error(`[cellar] unknown flag for cleanup: ${tok}`);
			console.error('[cellar] run "cellar --help" for the cleanup options.');
			return 1;
		}
	}

	const wsIdx = flags.findIndex((a) => a === '--workspace' || a === '-w');
	const wsArg = wsIdx !== -1 ? flags[wsIdx + 1] : undefined;
	const here = workspaceKey(wsArg || process.cwd());

	const everywhere = flags.includes('--all-workspaces');
	const scope = everywhere ? 'everywhere' : flags.includes('--all') ? 'workspace' : 'orphans';
	const dryRun = flags.includes('--dry-run');
	const yes = flags.includes('--yes') || flags.includes('-y') || !!process.env.CI || !process.stdin.isTTY;
	const confirmFlag = flags.find((a) => a.startsWith('--confirm='))?.slice('--confirm='.length);
	const log = (m) => console.log(m);

	// 1) Prune fully-dead registry entries (no live process at all). Bookkeeping
	//    only — nothing is signalled — so it runs at every scope, dry run aside.
	if (!dryRun) {
		const pruned = await pruneDeadInstances({ log });
		if (pruned.length) console.log(`[cellar] pruned ${pruned.length} dead registry entr(ies).`);
	}

	// 2) Gather facts, then decide (the decision is pure and unit-tested).
	const entries = await Promise.all(listInstances().map(annotateInstance));
	const plan = planCleanup({ entries, untracked: scanUntrackedCellarProcesses(), workspace: here, scope });

	console.log(`[cellar] workspace: ${here || '(unknown)'}`);

	if (plan.reap.length === 0 && plan.killPids.length === 0) {
		console.log(
			scope === 'orphans'
				? '[cellar] nothing to reap (no dead or orphaned instances).'
				: '[cellar] nothing to stop.'
		);
		reportSkipped(plan);
		return 0;
	}

	// 3) Show what would die, always, before anything can die — including under
	//    -y and under a dry run.
	console.log(dryRun ? '[cellar] would stop:' : '[cellar] will stop:');
	for (const e of plan.reap) console.log(planLine(e));
	for (const u of plan.untrackedOrphans) console.log(`  orphan pid=${u.pid} (untracked)  ${u.command}`);
	if (scope === 'everywhere')
		for (const u of plan.untrackedLive) console.log(`  live   pid=${u.pid} (untracked, workspace unknown)  ${u.command}`);

	if (dryRun) {
		console.log('[cellar] dry run — nothing was stopped.');
		reportSkipped(plan);
		return 0;
	}

	// 4) Consent. A plan that reaches another workspace's live session needs the
	//    phrase; anything else takes the ordinary y/N.
	if (plan.crossWorkspace) {
		const supplied = confirmFlag ?? (process.stdin.isTTY ? await promptPhrase(`[cellar] This stops LIVE cellar sessions in other workspaces (running kernels and unsaved state will be lost).\n[cellar] Type "${CONFIRM_PHRASE}" to proceed: `) : null);
		if (supplied !== CONFIRM_PHRASE) {
			console.error(
				supplied == null
					? `[cellar] refusing: stopping other workspaces' live sessions needs an explicit confirmation.\n[cellar] Re-run with: cellar cleanup --all-workspaces --confirm=${CONFIRM_PHRASE}`
					: `[cellar] aborted (confirmation did not match "${CONFIRM_PHRASE}").`
			);
			return 1;
		}
	} else if (!yes && !(await promptYesNo('[cellar] Stop these? [y/N] '))) {
		console.log('[cellar] aborted.');
		return 1;
	}

	for (const e of plan.reap) {
		console.log(`[cellar] stopping launcher ${e.launcherPid} …`);
		await reapInstance(e, { log, reason: 'cleanup' });
	}
	for (const pid of plan.killPids) {
		console.log(`[cellar] killing pid ${pid} …`);
		await killPid(pid);
	}
	console.log('[cellar] cleanup done.');
	reportSkipped(plan);
	return 0;
}

/**
 * Say what was deliberately left running, and how to reach it.
 *
 * Silence here would make the narrowed `--all` look like it had stopped
 * everything, which is the failure this whole change is about — the old command
 * was dangerous precisely because its blast radius was invisible. Printed only
 * when something really was skipped, so an ordinary tidy stays quiet.
 */
function reportSkipped(plan) {
	const here = plan.skippedHere.length;
	const elsewhere = plan.skippedElsewhere.length + plan.skippedUntracked.length;
	if (!here && !elsewhere) return;

	const line = (e) =>
		`  live   launcher=${e.launcherPid} appPort=${e.appPort ?? '?'} ${e.workspace ?? '(workspace unknown)'}`;

	if (here) {
		console.log(`[cellar] left running in this workspace: ${here}`);
		for (const e of plan.skippedHere) console.log(line(e));
		console.log('[cellar]   stop these with: cellar cleanup --all');
	}
	if (elsewhere) {
		console.log(`[cellar] left running elsewhere: ${elsewhere} (someone may be working in them)`);
		for (const e of plan.skippedElsewhere) console.log(line(e));
		for (const u of plan.skippedUntracked)
			console.log(`  live   pid=${u.pid} (untracked, workspace unknown)  ${u.command}`);
		console.log(
			`[cellar]   stop these too with: cellar cleanup --all-workspaces --confirm=${CONFIRM_PHRASE}`
		);
	}
}

// ---- `cellar harness …` ---------------------------------------------------

/** Human-readable state for one harness row. */
function harnessStateLabel(s) {
	if (s.unreadable) return 'unreadable';
	if (s.configured) return 'configured';
	if (s.present) return 'other entry';
	return 'not configured';
}

/**
 * Report the outcome of one configure call, then (once per command) the
 * running-cellar note — a written config is inert on its own, because
 * `cellar mcp` bridges to a LIVE instance rather than starting one.
 */
function printHarnessResult(r) {
	if (!r.ok) {
		console.error(`[cellar] ${r.message}`);
		return false;
	}
	// A refusal says so in the status word, not only inside the explanation - and
	// the file is appended only when the message does not already name it, so a
	// refusal (which quotes the path) does not print it twice.
	const what = r.status === 'skipped' ? `skipped: ${r.message}` : r.message;
	const where = r.file && !what.includes(r.file) ? ` → ${r.file}` : '';
	const say = r.status === 'skipped' ? console.error : console.log;
	say(`[cellar] ${r.label}: ${what}${where}`);
	if (r.note && r.status !== 'skipped') console.log(`[cellar]   note: ${r.note}`);
	return r.status !== 'skipped';
}

/**
 * `cellar harness list|add|remove` — the explicit, any-time counterpart to the
 * first-run prompt. Both drive the SAME registry (src/lib/server/harness.js), so
 * neither can configure a harness the other cannot. Returns a process exit code;
 * never boots a server.
 *
 * `add`/`remove` operate on the workspace ALLOW-LIST — the standing instruction
 * the launcher reconciles on every start — not on a one-off write. Adding also
 * configures immediately so the command has a visible effect; removing only stops
 * the reconciling, and needs `--strip` to also take Cellar's entry out of the
 * harness's config (see `stripHarness`: "stop managing this" and "delete this"
 * are different requests, and only one of them edits the user's file).
 */
function harnessCommand(args) {
	// Accept `--workspace <dir>` / `-w <dir>` so a harness can be configured for
	// another repo without cd-ing, exactly like the launcher itself.
	const rest = [];
	let wsArg;
	let strip = false;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--workspace' || args[i] === '-w') {
			wsArg = args[++i];
			continue;
		}
		if (args[i] === '--strip') {
			strip = true;
			continue;
		}
		rest.push(args[i]);
	}
	const workspace = resolve(wsArg || process.cwd());
	const sub = (rest[0] ?? 'list').toLowerCase();
	const usage = `cellar harness list | cellar harness add <${harnessNames().join('|')}|all> | cellar harness remove <name…> [--strip]`;

	if (sub === 'list' || sub === 'ls' || sub === 'status') {
		const allowed = new Set(readAllowList(workspace));
		console.log(`[cellar] agent harnesses for ${workspace}:`);
		for (const name of harnessNames()) {
			const s = harnessState(name, workspace);
			// Two independent facts, so both are shown: whether Cellar is ALLOWED to
			// keep this harness wired up (the durable decision it reconciles every
			// start), and whether the config file says so RIGHT NOW. They differ
			// exactly while something is wrong - a deleted config on an allowed
			// harness is the case the next launch repairs.
			const managedLabel = allowed.has(name) ? 'managed' : 'not managed';
			console.log(`  ${name.padEnd(8)} ${managedLabel.padEnd(12)} ${harnessStateLabel(s).padEnd(15)} ${s.file}`);
		}
		console.log(`[cellar] managed harnesses are checked and repaired on every \`cellar\` start.`);
		console.log(`[cellar] ${usage}`);
		console.log(`[cellar] ${RUNNING_NOTE}`);
		return 0;
	}

	if (sub === 'add' || sub === 'set' || sub === 'install') {
		const names = rest.slice(1).flatMap((n) => (n.toLowerCase() === 'all' ? harnessNames() : [n]));
		if (names.length === 0) {
			console.error(`[cellar] usage: cellar harness add <${harnessNames().join('|')}|all> [--workspace <dir>]`);
			return 1;
		}
		let ok = true;
		let wrote = false;
		for (const name of names) {
			// The registry refuses whatever it cannot edit confidently, but the WRITE
			// itself can still fail on the filesystem (a read-only workspace, ENOSPC,
			// EACCES on `.codex/`), and so can the allow-list write. Report that in the
			// same one-line shape as every other outcome instead of exiting on an
			// unhandled exception: `add all` then continues past one bad harness, and
			// the exit code still says something failed.
			//
			// The allow-list goes FIRST: it is the standing instruction, and the write
			// is only its first reconcile. Ordered the other way, a filesystem failure
			// loses the user's explicit "manage this harness" entirely - nothing
			// recorded, so no later start repairs it either.
			try {
				const managedNow = allowHarness(name, workspace).changed;
				const r = configureHarness(name, workspace);
				// A REFUSAL is not success: without this, `cellar harness add codex`
				// printed "skipped (… could not be read …)" and exited 0, so a script
				// (or `add all`) reported success having configured nothing.
				if (!r.ok || r.status === 'skipped') ok = false;
				wrote = printHarnessResult(r) || wrote;
				if (r.ok && managedNow) {
					console.log(`[cellar]   (Cellar will keep ${r.label} wired up here - checked on every start)`);
				}
			} catch (err) {
				ok = false;
				const h = getHarness(name);
				const where = h ? ` → ${join(workspace, h.configPath)}` : '';
				console.error(`[cellar] ${h?.label ?? name}: skipped (${err?.message ?? err})${where}`);
			}
		}
		if (wrote) console.log(`[cellar] ${RUNNING_NOTE}`);
		return ok ? 0 : 1;
	}

	if (sub === 'remove' || sub === 'rm' || sub === 'forget') {
		const names = rest.slice(1).flatMap((n) => (n.toLowerCase() === 'all' ? harnessNames() : [n]));
		if (names.length === 0) {
			console.error(`[cellar] usage: cellar harness remove <${harnessNames().join('|')}> [--strip] [--workspace <dir>]`);
			return 1;
		}
		let ok = true;
		for (const name of names) {
			const h = getHarness(name);
			if (!h) {
				console.error(`[cellar] unknown harness "${name}" (supported: ${harnessNames().join(', ')})`);
				ok = false;
				continue;
			}
			try {
				const changed = disallowHarness(name, workspace).changed;
				console.log(
					changed
						? `[cellar] ${h.label}: no longer managed (Cellar stops checking it on start)`
						: `[cellar] ${h.label}: was not managed`
				);
				// The config itself is left alone unless asked: the entry keeps working,
				// which is what "stop managing" means. `--strip` is the destructive opt-in.
				if (strip) {
					const r = stripHarness(name, workspace);
					if (!r.ok || r.status === 'skipped') ok = false;
					printHarnessResult(r);
				} else {
					console.log(`[cellar]   its ${h.configPath} entry is left in place (\`--strip\` removes it)`);
				}
			} catch (err) {
				ok = false;
				console.error(`[cellar] ${h.label}: skipped (${err?.message ?? err}) → ${join(workspace, h.configPath)}`);
			}
		}
		return ok ? 0 : 1;
	}

	console.error(`[cellar] unknown harness command: ${sub}`);
	console.error(`[cellar] usage: ${usage}`);
	return 1;
}

/** How long the one-time question waits before giving up and launching anyway. */
const HARNESS_PROMPT_TIMEOUT_MS = 30_000;

/**
 * First run in a workspace: offer to ALSO wire up harnesses Cellar is not already
 * keeping in place.
 *
 * The question can only ADD. Every harness Cellar manages here is on the
 * workspace allow-list (Claude Code by default), the launch reconciles that list
 * whatever happens below, and nothing in this function ever removes from it - so
 * a bare Enter, a timeout, a closed stdin and a backgrounded job are all the same
 * harmless outcome: no new harness, everything already managed still managed.
 * That is the whole point of the allow-list model; a prompt that could take
 * capability away is one whose most reflexive answer is its most destructive.
 *
 * Four rules keep it safe in the launch path. It is asked ONCE per workspace (a
 * durable `.cellar/harness.json` marker), it NEVER prompts without a TTY (`-y`,
 * `$CI`, a piped stdin all fall through silently), it can never abort a launch
 * (any failure is caught and logged, exactly like the best-effort host-env prep),
 * and it can never STALL or SUSPEND one either.
 *
 * That last rule takes TWO mechanisms, because they cover different failures.
 * `ask` gives up on a closed stdin, a read error or `HARNESS_PROMPT_TIMEOUT_MS` -
 * a stdin that is merely silent. A BACKGROUNDED `cellar &` is not that case: it
 * reads `stdin.isTTY` as true (so `autoYes` stays false), and its first read of the
 * controlling terminal raises SIGTTIN, which STOPS the process - and a stopped
 * process runs no timers, so no timeout can rescue it. The only fix is not to read
 * at all, so the prompt is gated on `inForegroundJob()`: a proven background job is
 * skipped outright, recording nothing, and launches normally. Where that cannot be
 * determined (no `tpgid`; Windows, which has no such stop) the prompt still runs
 * behind its timeout, exactly as before.
 *
 * Ctrl-C is the ONE answer that stops the launch, and it does not weaken the rule
 * above: "can never abort" is about the prompt failing on its own (Enter, "no", a
 * typo, a closed stdin, the timeout, a background job - all of which record nothing
 * and launch normally), whereas ^C is the user's explicit interrupt. `ask` has to
 * catch it itself, because readline's terminal mode swallows it before the
 * process-level SIGINT handler; it records nothing either, and hands off to the
 * launcher's one shutdown path.
 *
 * It also offers only what the launch is actually willing to write: under
 * `--no-mcp-config` the `.mcp.json` harness is not on the list at all, and because
 * that is a filtered view the question is NOT recorded as asked (a later launch
 * without the flag still asks).
 */
async function maybePromptHarnessSetup() {
	try {
		// Every gate (asked-once, nothing-to-offer, non-interactive) lives in the
		// registry's `shouldPromptHarnessSetup` so it is unit-testable; `autoYes`
		// already folds in `-y`, `$CI` and a non-TTY stdin.
		const decision = shouldPromptHarnessSetup(WORKSPACE, {
			interactive: !autoYes,
			exclude: mcpConfigExcluded()
		});
		if (!decision.prompt) return;
		// A backgrounded job would be STOPPED by SIGTTIN on its first read, and no
		// timeout can undo that (a stopped process runs no timers). So it is never
		// asked, and - like every other unanswered outcome - records nothing, so the
		// next foreground launch still asks.
		if (inForegroundJob() === false) return;

		const { states, offered, record } = decision;
		const managed = readAllowList(WORKSPACE)
			.map((n) => getHarness(n)?.label)
			.filter(Boolean);
		// The question is settled per HARNESS, so this can also be a LATER launch
		// asking about one Cellar has since learned to configure. Say which it is
		// rather than greeting a long-standing workspace as a first run.
		console.log(
			promptedHarnesses(WORKSPACE).length
				? '[cellar] Cellar can now point more AI coding agents at its MCP tools.'
				: '[cellar] First run here. Cellar points your AI coding agent at its MCP tools.'
		);
		if (managed.length) {
			// Say what is ALREADY handled before asking, so the question reads as what
			// it is - purely additive - and Enter is visibly safe.
			console.log(`[cellar] Already set up and kept in place: ${managed.join(', ')}.`);
		}
		console.log('[cellar] Also set up:');
		states.forEach((s, i) => {
			const flag = s.configured ? ' (config already present)' : s.present ? ' (has another entry)' : '';
			console.log(`[cellar]   ${i + 1}) ${s.label.padEnd(12)} ${s.file}${flag}`);
		});
		const answer = await ask(`[cellar] Which? [numbers/names, "yes"/"all", or Enter for none] `, {
			timeoutMs: HARNESS_PROMPT_TIMEOUT_MS
		});
		// The already-managed names are named one line above the question, so typing
		// one is a natural reply - it is understood and needs no write, which is a
		// different fact from a token nothing recognized.
		const parsed = parseHarnessAnswer(answer, offered, { managed: readAllowList(WORKSPACE) });
		const { chosen, unknown, answered } = parsed;
		for (const u of unknown) console.log(`[cellar] ignoring unrecognized choice: ${u}`);
		for (const m of parsed.managed) {
			console.log(`[cellar] ${getHarness(m)?.label ?? m} is already set up here and kept in place - nothing to do.`);
		}
		for (const n of parsed.notOffered) {
			// A registered harness this offer does not carry - it was taken off the
			// allow-list, so the question is settled for it. Understood, just not
			// something this prompt will do; name the command that does.
			console.log(
				`[cellar] ${getHarness(n)?.label ?? n} is not on this offer (it was removed here) - \`cellar harness add ${n}\` puts it back.`
			);
		}
		if (!answered) {
			// No answer at all, or nothing in the reply resolved - not a decision, so
			// the question stands and the next interactive launch asks again.
			console.log(
				`[cellar] ${answer === null ? 'no answer' : 'nothing recognized'} - continuing (asked again next time; \`cellar harness add <${harnessNames().join('|')}>\` any time).`
			);
			return;
		}

		let wrote = false;
		for (const name of chosen) {
			// Caught PER harness, like `cellar harness add` and the launch reconcile: a
			// filesystem failure on one (read-only workspace, ENOSPC, EACCES on
			// `.codex/`) must not throw past the bookkeeping below, which would discard
			// both a successful sibling write and the answer itself - so the question
			// would come back on every later interactive launch.
			//
			// And the allow-list is recorded BEFORE the config is written, because the
			// write is only its first reconcile and it is the half that can fail. The
			// other order lost the user's explicit "wire up Codex" for good: nothing
			// recorded, yet the marker below still closed the question, so no later
			// start could repair it.
			try {
				allowHarness(name, WORKSPACE);
				wrote = printHarnessResult(configureHarness(name, WORKSPACE)) || wrote;
			} catch (err) {
				const h = getHarness(name);
				const where = h ? ` → ${join(WORKSPACE, h.configPath)}` : '';
				console.error(`[cellar] ${h?.label ?? name}: skipped (${err?.message ?? err})${where}`);
			}
		}
		if (wrote) console.log(`[cellar] ${RUNNING_NOTE}`);
		if (chosen.length === 0) {
			console.log(
				`[cellar] none added - \`cellar harness add <${harnessNames().join('|')}>\` any time (nothing was turned off).`
			);
		}
		// Only close the question when the offer covered everything it could. Under
		// `--no-mcp-config` the view was filtered, so a later ordinary launch asks.
		if (record) markHarnessPrompted(WORKSPACE);
	} catch (err) {
		// Never let agent wiring block a notebook launch.
		console.log(`[cellar] harness setup skipped: ${err?.message ?? err}`);
	}
}

/**
 * Harnesses this launch must not write, as names. `--no-mcp-config` is defined in
 * terms of the FILE it refuses, so the harness is derived from the registry
 * rather than pinned by name — and it is an exclusion for this launch only, never
 * a change to the allow-list.
 */
function mcpConfigExcluded() {
	return writeMcpConfigOptIn ? [] : mcpJsonHarnessNames();
}

/**
 * Refuse to launch on an unusable production build, BEFORE any slow toolchain
 * work (venv resolve/create, host venv, Jupyter sidecar) — a build we will not
 * serve should not cost a boot.
 *
 * A MISSING build was always caught here. A STALE one was not: it passed
 * silently and served OLD server code against NEW source, so `cellar` (and every
 * e2e spec, which boots this launcher without `--dev`) could validate code that
 * was never compiled. See src/lib/server/build-freshness.js.
 *
 * Returns true when the build is usable; otherwise it has already shut down.
 */
function assertUsableBuild() {
	if (useDev) return true;
	const freshness = buildFreshness(REPO);
	if (freshness.state === 'missing') {
		console.error(`[cellar] production build not found at ${freshness.buildEntry}.`);
		console.error('[cellar] Run `npm run build` first, or pass --dev to use the Vite dev server.');
		shutdown(1, 'production build missing');
		return false;
	}
	if (freshness.state === 'stale' && !process.env[SKIP_ENV]) {
		console.error(`[cellar] production build is STALE: ${stalenessReason(REPO, freshness)}.`);
		console.error('[cellar] Serving it would run OLD code against your current sources.');
		console.error(
			`[cellar] Run \`npm run build\` (or \`make build\`), pass --dev for the Vite dev server, or set ${SKIP_ENV}=1 to override.`
		);
		shutdown(1, 'production build stale');
		return false;
	}
	return true;
}

async function main() {
	console.log(`[cellar] workspace: ${WORKSPACE}`);

	if (!assertUsableBuild()) return;

	// First run in this workspace: offer to wire up the user's agent harness(es).
	// Placed BEFORE the single-instance takeover (and before the slow toolchain
	// work) for two reasons: the one-time question is answered while the terminal
	// is still quiet, and - load-bearing - a launch must not reap the instance
	// that owns this folder and then sit waiting for an answer, leaving the user
	// with no running Cellar at all. Non-interactive launches no-op.
	await maybePromptHarnessSetup();

	// 0) Single-instance-per-folder + reap (unless --new/--force). The complaint
	//    this fixes: old cellar servers pile up (launcher crashed → orphaned app
	//    reparented to init; or a still-running instance after a code update), and
	//    an agent discovering a stale one over MCP gets outdated instructions. So a
	//    launch REAPS the old instance and takes over, rather than attaching to it.
	//    An O_EXCL lockfile (claimed before any slow toolchain work) still gates the
	//    folder so a rapid double-launch can't start two at once.
	// Announce isolated / independent mode so "why didn't this reap / register?" is
	// answerable from the log (complements the per-reap + shutdown logging).
	if (isolated) {
		console.log(
			'[cellar] isolated mode (CELLAR_ISOLATED): not registered in the global registry, reaping disabled.'
		);
	} else if (forceNew) {
		console.log(
			'[cellar] --new: independent instance, reaping disabled (still registered for ls/cleanup).'
		);
	}
	const reapLog = (m) => console.log(m);
	if (!forceNew) {
		// Global hygiene (all workspaces): prune fully-dead registry entries, and
		// reap instances whose workspace directory no longer exists (deleted
		// worktrees). Both are always safe — nothing live for a real project is hit.
		await pruneDeadInstances({ log: reapLog });
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
			// A synthetic entry carries no recorded start time, so reapInstance can't
			// prove the lock's pid is still that instance and will SKIP-not-kill it
			// (the safe direction — never signal a pid we can't identify). Every
			// current-code instance registers with launcherStart, so the real
			// take-over path (a genuine same-workspace relaunch) is unaffected; only a
			// pre-registry / lost-entry owner degrades to prune-and-reclaim-the-lock.
			const ownerEntry = readInstance(lock.ownerPid) || { launcherPid: lock.ownerPid, workspace: WORKSPACE };
			await reapInstance(ownerEntry, { log: reapLog, reason: 'same-workspace-takeover' });
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

	// 4) Ports - pinned when the matching CELLAR_*_PORT env is set (Docker /
	//    container publishing), else the port this FOLDER used last time when it
	//    is still free, else a fresh ephemeral one. The remembered half (ports.js)
	//    is what stops a folder's address moving on every restart; it is a
	//    preference re-earned on each launch, never a claim, so it yields to any
	//    live instance and falls back cleanly. Jupyter is deliberately NOT sticky
	//    - nothing outside the launcher + app ever sees its port (see ports.js).
	//
	//    `sticky` is the SAME gate as the lock/reap block above (`!forceNew`, which
	//    `CELLAR_ISOLATED` implies): isolated / --new launches exist so concurrent
	//    instances never collide, and a remembered port is exactly the port another
	//    instance is most likely to be holding.
	const { appPort, mcpPort, jupyterPort } = await resolveWorkspacePorts({
		workspace: WORKSPACE,
		sticky: !forceNew,
		dev: useDev,
		freePort,
		instances: listInstances(),
		isAlive: (e) => pidAlive(e?.launcherPid) || pidAlive(e?.appPid),
		excludePid: process.pid,
		log: (m) => console.log(m)
	});
	const token = randomBytes(24).toString('hex');
	const jupyterUrl = `http://127.0.0.1:${jupyterPort}`;

	// Zero-config agent wiring: record the live port map so `cellar mcp` can
	// discover this instance, and point the project's .mcp.json at that bridge
	// (a stdio command, not a URL) so the dynamic port never leaks into config.
	runtimeWorkspace = WORKSPACE;
	writeRuntime(WORKSPACE, { mcpPort, appPort, jupyterPort });
	// Record in the global registry so a later launch / `cellar ls` / `cellar
	// cleanup` can discover and reap this instance (child pids filled in after the
	// sidecar + app spawn below). Registered even under --new so `ls`/`cleanup` see
	// it — but NOT under CELLAR_ISOLATED, whose whole point is invisibility: an
	// isolated instance must never appear in the shared registry (nor let the later
	// updateInstance calls re-create an entry — they're gated on `isolated` too).
	if (!isolated) {
		registerInstance({
			launcherPid: process.pid,
			workspace: WORKSPACE,
			appPort,
			mcpPort,
			jupyterPort,
			startedAt: Date.now(),
			// The launcher's real OS start time — the reuse-proof identity a later
			// reaper compares against before it dares signal this pid. Without it, a
			// reused pid would be indistinguishable from this instance.
			launcherStart: processStartTime(process.pid),
			mode: useDev ? 'dev' : 'build'
		});
	}
	// RECONCILE the workspace allow-list: every harness Cellar is allowed to manage
	// here gets its config checked and, if it is missing, stale or was deleted,
	// repaired. This runs on EVERY start, which is what makes the allow-list a
	// standing instruction rather than a one-off write - delete `.mcp.json` and the
	// next `cellar` puts it back, exactly as the zero-config promise implies.
	//
	// Claude Code is on that list by default, so a workspace that has never been
	// asked anything behaves precisely as it always did. `--no-mcp-config` excludes
	// the harness owning that file for THIS launch only - an exclusion, never a
	// removal, so the flag cannot quietly rewrite a durable decision.
	for (const r of reconcileHarnesses(WORKSPACE, { exclude: mcpConfigExcluded() })) {
		const h = getHarness(r.name);
		const status =
			r.status === 'already' ? 'up to date' : r.status === 'skipped' ? `skipped (${r.message})` : r.message;
		console.log(`[cellar] ${h?.configPath ?? r.name}: ${status} (agent connects via \`cellar mcp\`)`);
	}

	// Idle-kernel culling. With one kernel PER notebook, N idle Python processes
	// (100s of MB each with pandas/pyspark) can exhaust RAM. Lean on the sidecar's
	// own MappingKernelManager culler rather than a hand-rolled timer: it shuts a
	// kernel down after `cull_idle_timeout` of inactivity, and kernel.ts reconciles
	// the culled kernel out of its Map (via the manager's runningChanged poll).
	//   CELLAR_KERNEL_IDLE_TIMEOUT  seconds of idle before cull (default 7200 = 2h; 0 disables)
	//   CELLAR_KERNEL_CULL_INTERVAL seconds between cull sweeps (default min(300, timeout))
	// cull_connected MUST be true: Cellar holds a persistent websocket to every
	// kernel, so with jupyter's default (false) a kernel is never seen as idle.
	// NOT to be confused with the app-side, near-identically-named
	// CELLAR_KERNEL_IDLE_TIMEOUT_MS: that is kernel.ts's per-RUN liveness-probe
	// interval (it never culls anything), while this culls a whole idle kernel process.
	const cullArgs = cullingArgs();
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
			'--ServerApp.disable_check_xsrf=True',
			...cullArgs
		],
		// cwd must agree with root_dir: a kernel started without a path (kernel.ts
		// `startNew({name:'python3'})`, what a notebook that declares no code root
		// sends) inherits the sidecar's process cwd, so anchoring it at WORKSPACE
		// (not REPO) is what makes os.getcwd(), relative reads/writes, and repo-root
		// walks resolve in the user's project rather than Cellar's install dir. A
		// notebook that DOES declare a code root sends it as `path`, which
		// jupyter_server resolves under this same root_dir. All args/env here are
		// absolute paths (host python, JUPYTER_PATH temp dir), so they still resolve.
		{ cwd: WORKSPACE, env: { ...process.env, JUPYTER_PATH: jupyterDir }, stdio: ['ignore', 'inherit', 'inherit'] }
	);
	children.push(jupyter);
	// Skip under isolation — updateInstance would re-create the registry entry we
	// deliberately never wrote (it falls back to registerInstance when none exists).
	if (!isolated)
		updateInstance(process.pid, { jupyterPid: jupyter.pid, jupyterStart: processStartTime(jupyter.pid) });
	jupyter.on('exit', (c) => {
		console.error(`[cellar] jupyter sidecar exited (${c})`);
		shutdown(1, `jupyter sidecar exited (${c})`);
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
		// `--no-mcp-config` is a per-LAUNCH exclusion, not a change to the allow-list,
		// so the app cannot infer it from the workspace marker. Without it the
		// "Connect an agent" banner claimed the every-start repair over a `.mcp.json`
		// this instance deliberately leaves alone. Always set (never inherited), so a
		// stale value from the surrounding environment cannot answer for this run.
		CELLAR_NO_MCP_CONFIG: writeMcpConfigOptIn ? '0' : '1',
		// Self-exit hook: the app watches this pid and exits if the launcher dies
		// uncleanly (parent-watch.js), so it never lingers orphaned serving stale code.
		CELLAR_LAUNCHER_PID: String(process.pid),
		PORT: String(appPort)
		// The app-wide request-body ceiling is deliberately left alone here.
		// adapter-node applies it upstream of every route, so raising it for the
		// file-save PUT would raise how much memory ANY unauthenticated request can
		// make this process buffer. Its safe 512 K default stands; a document too
		// big to fit through it opens read-only instead (see $lib/saveLimit.ts). An
		// operator who sets BODY_SIZE_LIMIT still wins in full: the spread above
		// passes their environment through untouched, and the app reports the value
		// actually in force to each file tab, so their larger ceiling really does
		// widen the editable range.
	};

	let app;
	if (useDev) {
		app = spawn(
			join(REPO, 'node_modules', '.bin', 'vite'),
			['dev', '--port', String(appPort), '--strictPort'],
			{ cwd: REPO, env, stdio: 'inherit' }
		);
	} else {
		// Validated up front by assertUsableBuild() — missing/stale never gets here.
		const buildEntry = join(REPO, 'build', 'index.js');
		app = spawn('node', [buildEntry], { cwd: REPO, env, stdio: 'inherit' });
	}
	children.push(app);
	if (!isolated) updateInstance(process.pid, { appPid: app.pid, appStart: processStartTime(app.pid) });
	app.on('exit', (c) => {
		console.error(`[cellar] app server exited (${c})`);
		shutdown(1, `app server exited (${c})`);
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
