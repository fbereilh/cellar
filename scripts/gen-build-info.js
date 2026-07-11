/**
 * Generate `build/build-info.json` at BUILD time so `cellar --version` reports a
 * meaningful build identity on every install method — including a Homebrew
 * *stable* install, which builds from a source tarball with no `.git`, so a
 * runtime `git rev-parse` would come back blank.
 *
 * Runs as the `postbuild` npm hook (after `vite build`, which produces `build/`).
 * Node-builtins only. Written into `build/` — gitignored, shipped via the
 * package.json `files` glob, and read at runtime by src/lib/server/selfupdate.js.
 *
 * Resolution order (robust across install methods):
 *   version — CELLAR_BUILD_VERSION env (release / formula path), else package.json.
 *   sha     — 1. CELLAR_BUILD_SHA env (release automation);
 *             2. git short sha, when available (dev clone, Homebrew `--HEAD`);
 *             3. "release" (a Homebrew stable tarball build: no git, no sha env).
 *
 * Version and sha resolve independently, so a Homebrew `--HEAD` build (which
 * sets CELLAR_BUILD_VERSION but still has a `.git`) keeps its real git sha.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = join(REPO, 'build');
const OUT_FILE = join(OUT_DIR, 'build-info.json');

/** Trimmed stdout of a command, or null on any failure. */
function capture(cmd, args) {
	try {
		const r = spawnSync(cmd, args, {
			cwd: REPO,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore']
		});
		if (r.status !== 0 || r.error) return null;
		return (r.stdout || '').trim() || null;
	} catch {
		return null;
	}
}

function pkgVersion() {
	try {
		return JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version || 'unknown';
	} catch {
		return 'unknown';
	}
}

/** ISO date (YYYY-MM-DD) without pulling a runtime clock into determinism. */
function today() {
	return new Date().toISOString().slice(0, 10);
}

function resolveBuildInfo() {
	const version = process.env.CELLAR_BUILD_VERSION || pkgVersion();

	// 1) Explicit sha env override (release automation).
	if (process.env.CELLAR_BUILD_SHA) {
		return {
			version,
			sha: process.env.CELLAR_BUILD_SHA,
			branch: process.env.CELLAR_BUILD_BRANCH || null,
			date: today(),
			dirty: false,
			source: 'env'
		};
	}

	// 2) git, when this is a real checkout (dev, Homebrew --HEAD). Kept even when
	//    CELLAR_BUILD_VERSION is set, so a --HEAD build keeps its real git sha.
	const sha = capture('git', ['rev-parse', '--short', 'HEAD']);
	if (sha) {
		const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
		const date = capture('git', ['show', '-s', '--format=%cs', 'HEAD']) || today();
		const dirty = !!capture('git', ['status', '--porcelain']);
		return {
			version,
			sha,
			branch: branch && branch !== 'HEAD' ? branch : null,
			date,
			dirty,
			source: process.env.CELLAR_BUILD_VERSION ? 'release' : 'git'
		};
	}

	// 3) No sha env, no git (a stable tarball build): stamp the tag/version only.
	return { version, sha: 'release', branch: null, date: today(), dirty: false, source: 'release' };
}

const info = resolveBuildInfo();
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_FILE, JSON.stringify(info, null, '\t') + '\n');
console.log(
	`[cellar] build-info: ${info.version} (${info.source} ${info.sha}${info.branch ? ` ${info.branch}` : ''})`
);
