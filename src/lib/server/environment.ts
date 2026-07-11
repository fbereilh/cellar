/**
 * Cellar - Python environment / requirements inspection.
 *
 * The sidebar's Environment section shows, and lets a teammate reproduce, the
 * exact interpreter the kernel is bound to: its path + version, the venv it
 * lives in, and every installed distribution with its version. That is the
 * reproducibility surface - a pinned `requirements.txt` recreates the env.
 *
 * ## Why a subprocess, not the kernel
 * The installed-package set is a property of the *interpreter*, not of the live
 * kernel namespace, and we want it before a single cell has run (the kernel only
 * boots on the first run). So - exactly like the Databricks metadata listing -
 * this runs a short-lived subprocess of the project venv's python
 * (`projectPython()`), never occupying the one shared kernel.
 *
 * ## Why importlib.metadata, not `pip list`
 * uv-created venvs do not ship `pip`, so `pip list` would simply fail. The probe
 * uses `importlib.metadata`, which is stdlib and always present, so it works in
 * any venv the kernel could run in. The probe always prints exactly one
 * `SENTINEL`-prefixed JSON line and never raises, so a broken interpreter arrives
 * as a structured result rather than a traceback we have to guess at.
 */
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isValidVenv, venvPython } from './venv.js';

/** Line prefix the subprocess prints its one JSON result line on. */
const SENTINEL = '__CELLAR_ENV__';

/** How long the probe may run before it is killed. Reading metadata is fast. */
const PROBE_TIMEOUT_MS = 30_000;

function workspace(): string {
	return process.env.CELLAR_WORKSPACE || process.cwd();
}

/**
 * The interpreter the kernel is bound to. `CELLAR_PROJECT_VENV` holds the python
 * executable path the launcher / Settings rebind established; under a bare
 * `vite dev` (no launcher) fall back to the conventional `<workspace>/.venv`.
 * Returns null when nothing is resolvable - the "no venv" state the UI renders.
 */
export function projectPython(): string | null {
	const bound = process.env.CELLAR_PROJECT_VENV;
	if (bound && existsSync(bound)) return bound;
	const local = join(workspace(), '.venv');
	return isValidVenv(local) ? venvPython(local) : null;
}

/**
 * The probe: interpreter facts + the installed distributions. Deduplicates by
 * normalized (lowercased) name - `importlib.metadata` can surface the same
 * distribution twice when more than one metadata directory is on the path - and
 * sorts case-insensitively so the list and the exported requirements are stable.
 */
const PROBE = `
import json, sys

def main():
    packages = []
    try:
        import importlib.metadata as md
        seen = {}
        for dist in md.distributions():
            try:
                name = dist.metadata['Name']
                version = dist.version
            except Exception:
                continue
            if not name:
                continue
            key = name.lower().replace('_', '-')
            if key in seen:
                continue
            seen[key] = True
            packages.append({'name': name, 'version': version})
    except Exception as e:
        return {'ok': False, 'code': 'metadata_failed',
                'message': '%s: %s' % (type(e).__name__, e)}
    packages.sort(key=lambda p: p['name'].lower())
    v = sys.version_info
    impl = sys.implementation.name
    return {
        'ok': True,
        'executable': sys.executable,
        'prefix': sys.prefix,
        'python_version': '%d.%d.%d' % (v.major, v.minor, v.micro),
        'python_version_full': sys.version.split('\\n')[0].strip(),
        'implementation': impl,
        'packages': packages,
    }

try:
    result = main()
except Exception as e:  # never let a traceback be the only answer
    result = {'ok': False, 'code': 'error', 'message': '%s: %s' % (type(e).__name__, e)}
sys.stdout.write('${SENTINEL}' + json.dumps(result) + '\\n')
`;

/** One installed distribution, as reported by the probe. */
export interface PackageInfo {
	name: string;
	version: string;
}

/** The probe's successful JSON payload (see the embedded `PROBE` script). */
interface ProbeSuccess {
	ok: true;
	executable: string;
	prefix: string;
	python_version: string;
	python_version_full: string;
	implementation: string;
	packages: PackageInfo[];
}

/** The probe's failure JSON payload. */
interface ProbeFailure {
	ok: false;
	code?: string;
	message: string;
}

/** The probe always prints exactly one of these two shapes. */
type ProbeResult = ProbeSuccess | ProbeFailure;

/** Run the probe in the project venv python and return its parsed result. */
function probe(python: string): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const child = spawn(python, ['-c', PROBE], {
			cwd: workspace(),
			stdio: ['ignore', 'pipe', 'pipe']
		});
		let stdout = '';
		let stderr = '';
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			reject(new Error(`the Python environment probe did not respond within ${PROBE_TIMEOUT_MS / 1000}s`));
		}, PROBE_TIMEOUT_MS);
		child.stdout.on('data', (d) => (stdout += d));
		child.stderr.on('data', (d) => (stderr += d));
		child.on('error', (err) => {
			clearTimeout(timer);
			reject(new Error(`could not run ${python}: ${err.message}`));
		});
		child.on('exit', () => {
			clearTimeout(timer);
			const line = stdout.split('\n').find((l) => l.startsWith(SENTINEL));
			if (!line) {
				reject(new Error(stderr.trim() || 'the environment probe produced no result'));
				return;
			}
			try {
				resolve(JSON.parse(line.slice(SENTINEL.length)));
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				reject(new Error(`unparseable probe result: ${message}`));
			}
		});
	});
}

/** Successful shape returned by {@link getEnvironment}. */
export interface EnvironmentOk {
	ok: true;
	workspace: string;
	python: string;
	venvDir: string;
	executable: string;
	prefix: string;
	pythonVersion: string;
	pythonVersionFull: string;
	implementation: string;
	packages: PackageInfo[];
}

/** Failure shape returned by {@link getEnvironment}. */
export interface EnvironmentError {
	ok: false;
	code: string;
	message: string;
	workspace: string;
	python: string | null;
	venvDir?: string;
	defaultVenv?: string;
}

/** Result of {@link getEnvironment}. */
export type EnvironmentResult = EnvironmentOk | EnvironmentError;

/**
 * Everything the Environment section renders in one read: the bound interpreter,
 * the venv it lives in, the workspace, and the installed packages. Never boots a
 * kernel and never mutates anything, so it is safe to fetch on open / refresh.
 *
 * When no interpreter is resolvable, returns `{ok:false, code:'no_venv'}` with
 * the workspace + the default venv path so the UI can guide the user.
 */
export async function getEnvironment(): Promise<EnvironmentResult> {
	const python = projectPython();
	const ws = workspace();
	if (!python) {
		return {
			ok: false,
			code: 'no_venv',
			message: 'No Python environment is bound to this workspace.',
			workspace: ws,
			defaultVenv: join(ws, '.venv'),
			python: null
		};
	}
	// The venv dir is the parent of the `bin`/`Scripts` dir the python lives in.
	const venvDir = dirname(dirname(python));
	try {
		// Dynamic boundary: child-process stdout JSON, narrowed to the probe's own shape.
		const result = (await probe(python)) as ProbeResult;
		if (!result.ok) {
			return { ok: false, code: result.code || 'error', message: result.message, workspace: ws, python, venvDir };
		}
		return {
			ok: true,
			workspace: ws,
			python,
			venvDir,
			executable: result.executable,
			prefix: result.prefix,
			pythonVersion: result.python_version,
			pythonVersionFull: result.python_version_full,
			implementation: result.implementation,
			packages: result.packages
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, code: 'probe_failed', message, workspace: ws, python, venvDir };
	}
}

/**
 * Render a pinned `requirements.txt` from a package list. `name==version`, one
 * per line, sorted case-insensitively - the exact bytes a teammate feeds to
 * `pip install -r` / `uv pip install -r` to recreate the environment.
 */
export function requirementsText(packages: PackageInfo[] = []): string {
	const lines = packages
		.filter((p) => p && p.name && p.version)
		.map((p) => `${p.name}==${p.version}`)
		.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
	return lines.join('\n') + (lines.length ? '\n' : '');
}

/** Result of {@link saveRequirements}. */
export interface SaveRequirementsResult {
	ok: true;
	path: string;
	count: number;
}

/**
 * Write a pinned `requirements.txt` into the workspace root from a fresh probe
 * (authoritative - never trusts a client-supplied package list). Returns the
 * absolute path written and the package count.
 */
export async function saveRequirements(): Promise<SaveRequirementsResult> {
	const env = await getEnvironment();
	if (!env.ok) {
		const err: Error & { code?: string } = new Error(env.message || 'no Python environment to export');
		// Attach the environment error code for callers (e.g. the API route) to branch on.
		err.code = env.code;
		throw err;
	}
	const path = join(env.workspace, 'requirements.txt');
	writeFileSync(path, requirementsText(env.packages));
	return { ok: true, path, count: env.packages.length };
}
