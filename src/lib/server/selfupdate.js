/**
 * `cellar --version` and `cellar --update` support.
 *
 * Node-builtins only (like venv.js / runtime.js) so it can be imported by the
 * launcher (bin/cellar.js) without pulling in the SvelteKit bundle. Both entry
 * points run BEFORE the normal launch path and never boot a server.
 *
 * Install-method aware: cellar is distributed two ways —
 *   1. Homebrew (a HEAD formula from the fbereilh/homebrew-cellar tap), where
 *      the running code lives under Homebrew's prefix and updates flow through
 *      `brew upgrade --fetch-HEAD cellar`;
 *   2. a git clone (the dev / Makefile path), updated by `git pull` + reinstall
 *      + rebuild — the exact steps `make update` runs.
 * `--update` detects which and runs the right one, so `cellar` tracks LATEST
 * regardless of how it was installed.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** Read the packaged version from package.json (repo root). */
function readVersion(repoDir) {
	try {
		const pkg = JSON.parse(readFileSync(join(repoDir, 'package.json'), 'utf8'));
		return pkg.version || 'unknown';
	} catch {
		return 'unknown';
	}
}

/** Run a command, capturing stdout; returns trimmed stdout or null on any failure. */
function capture(cmd, args, opts = {}) {
	try {
		const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
		if (r.status !== 0 || r.error) return null;
		return (r.stdout || '').trim() || null;
	} catch {
		return null;
	}
}

/** Best-effort git build metadata for the running tree (null if not a git repo). */
function gitInfo(repoDir) {
	const opts = { cwd: repoDir, stdio: ['ignore', 'pipe', 'ignore'] };
	const sha = capture('git', ['rev-parse', '--short', 'HEAD'], opts);
	if (!sha) return null;
	const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD'], opts);
	const date = capture('git', ['show', '-s', '--format=%cs', 'HEAD'], opts);
	const dirty = capture('git', ['status', '--porcelain'], opts);
	return { sha, branch: branch && branch !== 'HEAD' ? branch : null, date, dirty: !!dirty, source: 'git' };
}

/**
 * Build identity stamped at BUILD time into build/build-info.json
 * (scripts/gen-build-info.js runs as the `postbuild` hook). This is the source
 * of truth for `--version` on a shipped build: it works even when there is no
 * `.git` and no `git` on PATH (a Homebrew *stable* tarball install), where a
 * runtime `git rev-parse` would return blank. Returns null for a dev checkout
 * that has never been built, so callers fall back to live git.
 */
function buildInfo(repoDir) {
	try {
		const raw = readFileSync(join(repoDir, 'build', 'build-info.json'), 'utf8');
		const info = JSON.parse(raw);
		if (!info || typeof info !== 'object' || !info.version) return null;
		return info;
	} catch {
		return null;
	}
}

/**
 * Detect how this cellar was installed.
 * Returns 'homebrew' | 'git' | 'unknown' plus the detected install dir (repoDir).
 *
 * Homebrew keeps installed kegs under `<prefix>/Cellar/<name>/...` and symlinks
 * the `cellar` bin into `<prefix>/bin`. The running launcher therefore lives
 * under that prefix — a reliable, brew-free static check — which we corroborate
 * with `brew list cellar` when brew is on PATH.
 */
export function detectInstall(repoDir) {
	// Static signal: our own path sits inside a Homebrew Cellar dir.
	// (The literal "/Cellar/cellar/" is Homebrew's keg dir, coincidentally the
	// same word as the app name.)
	const underBrewCellar = /[\\/]Cellar[\\/]cellar[\\/]/.test(repoDir);
	const brewPrefix = capture('brew', ['--prefix']);
	const underBrewPrefix = brewPrefix ? repoDir.startsWith(brewPrefix) : false;
	if (underBrewCellar || underBrewPrefix) return 'homebrew';

	// Corroborate with the formula list only if the path check was inconclusive
	// (brew present and it knows about cellar → treat as brew-managed).
	if (brewPrefix) {
		const listed = capture('brew', ['list', '--formula', 'cellar']);
		if (listed !== null) return 'homebrew';
	}

	if (existsSync(join(repoDir, '.git'))) return 'git';
	// A git clone without a running `git`? Fall back to git steps if a package.json
	// is present (it always is for a source checkout).
	if (existsSync(join(repoDir, 'package.json'))) return 'git';
	return 'unknown';
}

/** Print `cellar --version` output. */
export function printVersion(repoDir) {
	const method = detectInstall(repoDir);

	// Prefer the build-time stamp (works with no `.git` — e.g. a Homebrew stable
	// install); only fall back to live git for an unbuilt dev checkout.
	const b = buildInfo(repoDir) || gitInfo(repoDir);
	const version = (b && b.version) || readVersion(repoDir);

	console.log(`cellar ${version}`);
	if (b) {
		const bits = [b.sha];
		if (b.branch) bits.push(`(${b.branch})`);
		if (b.date) bits.push(b.date);
		if (b.dirty) bits.push('[dirty]');
		console.log(`build: ${bits.join(' ')}`);
	} else {
		console.log('build: (no build metadata)');
	}
	console.log(`install: ${method}${method === 'git' ? ` (${repoDir})` : ''}`);
}

/** Run a command inheriting stdio; returns its exit status (0 = success). */
function run(cmd, args, opts = {}) {
	console.log(`[cellar] $ ${cmd} ${args.join(' ')}`);
	const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
	if (r.error) {
		if (r.error.code === 'ENOENT') {
			console.error(`[cellar] '${cmd}' not found on PATH.`);
		} else {
			console.error(`[cellar] ${cmd} failed: ${r.error.message}`);
		}
		return 127;
	}
	return r.status ?? 1;
}

/**
 * `cellar --update` — fetch + install the latest cellar, then exit (never
 * launches). Install-method aware. Returns a process exit code.
 */
export function runUpdate(repoDir) {
	const method = detectInstall(repoDir);
	console.log(`[cellar] update: detected install method '${method}'.`);

	if (method === 'homebrew') return updateViaBrew();
	if (method === 'git') return updateViaGit(repoDir);

	console.error('[cellar] could not determine how cellar was installed.');
	console.error('[cellar] If you installed via Homebrew: `brew upgrade --fetch-HEAD cellar`.');
	console.error('[cellar] If you installed from a git clone: `git pull && npm ci && npm run build` in that clone.');
	return 1;
}

function updateViaBrew() {
	console.log('[cellar] updating via Homebrew …');
	let status = run('brew', ['update']);
	if (status !== 0) {
		console.error('[cellar] `brew update` failed; aborting.');
		return status;
	}
	// --fetch-HEAD forces a re-fetch of the formula's HEAD (git main); without it
	// `brew upgrade` on a --HEAD keg is a no-op even when main has moved.
	status = run('brew', ['upgrade', '--fetch-HEAD', 'cellar']);
	if (status !== 0) {
		console.error('[cellar] `brew upgrade cellar` failed.');
		return status;
	}
	console.log('[cellar] update complete. Restart cellar to use the new version.');
	return 0;
}

function updateViaGit(repoDir) {
	console.log(`[cellar] updating the git clone at ${repoDir} …`);
	const opts = { cwd: repoDir };

	// 1) Pull latest (fast-forward only — never create a merge from an update).
	let status = run('git', ['pull', '--ff-only'], opts);
	if (status !== 0) {
		console.error('[cellar] `git pull --ff-only` failed (local changes or diverged history?).');
		console.error('[cellar] Resolve it in the clone, then re-run `cellar --update`.');
		return status;
	}

	// 2) Reinstall deps. Prefer `npm ci` (clean, lockfile-exact); fall back to
	//    `npm install` when there is no lockfile.
	const hasLock = existsSync(join(repoDir, 'package-lock.json'));
	status = run('npm', hasLock ? ['ci'] : ['install'], opts);
	if (status !== 0) {
		console.error('[cellar] dependency install failed.');
		return status;
	}

	// 3) Rebuild the production server.
	status = run('npm', ['run', 'build'], opts);
	if (status !== 0) {
		console.error('[cellar] `npm run build` failed.');
		return status;
	}

	console.log('[cellar] update complete. Restart cellar to use the new version.');
	return 0;
}
