/**
 * Project-venv resolution + `uv`-driven venv/kernel plumbing.
 *
 * This module is the single source of truth for how Cellar binds the Python
 * kernel to a project's virtualenv. It is deliberately written against **Node
 * builtins only** (no `$lib`/SvelteKit imports, no `uv` assumptions beyond the
 * CLI) so it can be imported from BOTH runtimes that need it:
 *
 *   - the launcher `bin/cellar.js` (plain `node bin/cellar.js`), and
 *   - the SvelteKit server (`$lib/server/venv.js`) behind the Settings API.
 *
 * The core design decision (see data/cellar-pkg-r7/report.md §4): the kernel
 * runs in the *project's* venv, which only ever needs the lightweight
 * `ipykernel`. Cellar's own heavy Jupyter host env (`~/.cellar/host-venv`,
 * `jupyter-server`) is kept entirely separate. Binding is a one-lever change:
 * a per-run `python3` kernelspec whose `argv[0]` points at the project python,
 * discovered by the sidecar via `JUPYTER_PATH`. `kernel.js` needs no change.
 *
 * All venv creation and package installs go through `uv` — never
 * `python -m venv` / `pip`. If `uv` is absent we fail fast (see requireUv).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const isWin = process.platform === 'win32';

/** Error thrown when the required `uv` tool is not on PATH. */
export class UvMissingError extends Error {
	constructor() {
		super(
			'uv is required but was not found on PATH.\n' +
				'Cellar uses uv for all virtualenv creation and package installs.\n' +
				'Install it, then re-run:\n' +
				'  macOS/Linux:  curl -LsSf https://astral.sh/uv/install.sh | sh\n' +
				'  Homebrew:     brew install uv\n' +
				'  docs:         https://docs.astral.sh/uv/getting-started/installation/'
		);
		this.name = 'UvMissingError';
	}
}

/**
 * Spawn a command and resolve with `{ code, out }`. When `stdio: 'inherit'`
 * (launcher) output streams to the terminal; when `'pipe'` (server) it is
 * captured into `out` so callers can surface it in an API response.
 */
function run(cmd, args, { stdio = 'pipe', env } = {}) {
	return new Promise((resolveRun) => {
		const child = spawn(cmd, args, {
			stdio,
			env: env ? { ...process.env, ...env } : process.env
		});
		let out = '';
		if (stdio === 'pipe') {
			child.stdout?.on('data', (d) => (out += d));
			child.stderr?.on('data', (d) => (out += d));
		}
		child.on('error', (e) => resolveRun({ code: -1, out: out + String(e) }));
		child.on('exit', (code) => resolveRun({ code: code ?? -1, out }));
	});
}

/** The bin/ (POSIX) or Scripts/ (Windows) dir inside a venv. */
export function venvBinDir(venvPath) {
	return join(venvPath, isWin ? 'Scripts' : 'bin');
}

/** The python executable inside a venv. */
export function venvPython(venvPath) {
	return join(venvBinDir(venvPath), isWin ? 'python.exe' : 'python');
}

/** A venv is "valid" if it has a python executable. */
export function isValidVenv(venvPath) {
	return !!venvPath && existsSync(venvPython(venvPath));
}

/** True iff `uv` is available on PATH. */
export async function hasUv() {
	const r = await run('uv', ['--version']);
	return r.code === 0;
}

/** Throw {@link UvMissingError} unless `uv` is available. */
export async function requireUv() {
	if (!(await hasUv())) throw new UvMissingError();
}

/** True iff the given interpreter can `import ipykernel`. */
export async function hasIpykernel(python) {
	if (!existsSync(python)) return false;
	const r = await run(python, ['-c', 'import ipykernel']);
	return r.code === 0;
}

/**
 * Resolve which project interpreter to bind — PURE (no filesystem mutation).
 * Resolution order, first match wins (report §4):
 *   1. explicit `--python` escape hatch → use verbatim, no create/install
 *   2. `--venv` / `CELLAR_VENV` override
 *   3. active `$VIRTUAL_ENV` (if valid)
 *   4. `<workspace>/.venv` (if valid)
 *   5. else: create `<workspace>/.venv`
 *
 * @returns {{mode:'python'|'venv', venv:string|null, python:string,
 *            needsCreate:boolean, source:string}}
 */
export function resolveProjectVenv({ workspace, venvOverride, pythonOverride } = {}) {
	if (pythonOverride) {
		return {
			mode: 'python',
			venv: null,
			python: resolve(pythonOverride),
			needsCreate: false,
			source: '--python'
		};
	}
	if (venvOverride) {
		const venv = resolve(venvOverride);
		return {
			mode: 'venv',
			venv,
			python: venvPython(venv),
			needsCreate: !isValidVenv(venv),
			source: 'override'
		};
	}
	const active = process.env.VIRTUAL_ENV;
	if (active && isValidVenv(active)) {
		const venv = resolve(active);
		return { mode: 'venv', venv, python: venvPython(venv), needsCreate: false, source: 'VIRTUAL_ENV' };
	}
	const local = join(workspace, '.venv');
	if (isValidVenv(local)) {
		return { mode: 'venv', venv: local, python: venvPython(local), needsCreate: false, source: '.venv' };
	}
	return { mode: 'venv', venv: local, python: venvPython(local), needsCreate: true, source: 'create' };
}

/** Create a venv at `venvPath` via `uv venv`. Throws on failure. */
export async function createVenv(venvPath, { python, stdio = 'pipe' } = {}) {
	const args = ['venv'];
	if (python) args.push('--python', python);
	args.push(venvPath);
	const r = await run('uv', args, { stdio });
	if (r.code !== 0) throw new Error(`\`uv venv ${venvPath}\` failed:\n${r.out}`);
	return r;
}

/**
 * Install packages into the given interpreter's environment via `uv pip`.
 * The one place Cellar adds anything to a project venv - `ipykernel` at bind
 * time, the Databricks packages when the user asks for them.
 */
export async function installPackages(python, packages, { stdio = 'pipe' } = {}) {
	const r = await run('uv', ['pip', 'install', '--python', python, ...packages], { stdio });
	if (r.code !== 0) throw new Error(`installing ${packages.join(', ')} into ${python} failed:\n${r.out}`);
	return r;
}

/** Install `ipykernel` into the given interpreter's environment via `uv pip`. */
export async function installIpykernel(python, opts = {}) {
	return installPackages(python, ['ipykernel'], opts);
}

/** Probe for ipykernel; install only if missing. Returns `{ installed }`. */
export async function ensureIpykernel(python, { stdio = 'pipe' } = {}) {
	if (await hasIpykernel(python)) return { installed: false };
	await installIpykernel(python, { stdio });
	return { installed: true };
}

/**
 * Ensure Cellar's private Jupyter host env exists (`~/.cellar/host-venv` with
 * `jupyter-server`). Created + cached on first run so the project venv only
 * ever gets `ipykernel`. Returns the host interpreter path.
 */
export async function ensureHostEnv({ stdio = 'pipe' } = {}) {
	const hostVenv = join(homedir(), '.cellar', 'host-venv');
	const py = venvPython(hostVenv);
	const marker = join(hostVenv, '.cellar-host-ready');
	if (existsSync(py) && existsSync(marker)) return { hostVenv, python: py, created: false };
	await createVenv(hostVenv, { stdio });
	const r = await run('uv', ['pip', 'install', '--python', py, 'jupyter-server'], { stdio });
	if (r.code !== 0) throw new Error(`setting up cellar host env failed:\n${r.out}`);
	writeFileSync(marker, 'ok');
	return { hostVenv, python: py, created: true };
}

/**
 * Write the per-run `python3` kernelspec whose `argv[0]` is the project python.
 * The sidecar discovers it via `JUPYTER_PATH`, so `manager.startNew({name:
 * 'python3'})` in kernel.js launches the project interpreter, unchanged.
 */
export function writeKernelspec(kernelDir, projectPython, displayName = 'Python 3 (Cellar)') {
	mkdirSync(kernelDir, { recursive: true });
	const spec = {
		argv: [projectPython, '-m', 'ipykernel_launcher', '-f', '{connection_file}'],
		display_name: displayName,
		language: 'python',
		metadata: { cellar: true }
	};
	writeFileSync(join(kernelDir, 'kernel.json'), JSON.stringify(spec, null, 2) + '\n');
}
