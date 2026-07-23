/**
 * Is the production build (`build/index.js`) newer than the sources that produced it?
 *
 * The launcher serves `build/index.js` unless `--dev` is passed, and it used to
 * guard only the MISSING case. A STALE build passed silently, so `cellar` (and
 * every e2e spec, which boots the real launcher without `--dev`) could run OLD
 * server code against NEW source. That is worse than slow: a green run certifies
 * code that was never compiled, and a red run sends you chasing failures that do
 * not exist. It cost one measured e2e run ~18 minutes of false-failure timeouts
 * (see data/cellar-test-timing-scout-t7/report.md).
 *
 * So this is the single staleness rule, shared by the two callers that must agree:
 *   - `bin/cellar.js` — refuses to serve a stale build (with a clear rebuild hint);
 *   - `scripts/ensure-build.js` — the `pretest:e2e` hook, which rebuilds when stale
 *     and is a no-op when fresh (so a fresh e2e run pays nothing).
 *
 * mtime-based, deliberately: it needs no build system, no hashing pass, and no
 * state file, and every way the sources legitimately change (an edit, a
 * `git pull`, a `git checkout`) moves an mtime forward.
 *
 * Node builtins only — `bin/cellar.js` imports it directly (like venv.js), so it
 * must not reach for anything the packaged launcher cannot resolve.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Trees whose contents `vite build` compiles into `build/`. */
const SOURCE_DIRS = ['src', 'static'];

/** Root files that change what a build produces. */
const CONFIG_FILES = ['package.json', 'vite.config.js', 'svelte.config.js', 'tsconfig.json'];

/** Never walked: not inputs, and huge. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.svelte-kit', 'build']);

/** Escape hatch for anyone who knowingly wants the stale build served anyway. */
export const SKIP_ENV = 'CELLAR_SKIP_BUILD_CHECK';

/**
 * Newest mtime under `dir`, stopping early once anything beats `threshold`.
 * Returns `{ mtimeMs, path }` for the newest file seen, or null for an empty /
 * absent tree. The early exit is what keeps the stale case cheap; the fresh case
 * walks the whole tree, which is a few milliseconds for cellar's ~1k files.
 */
function newestUnder(dir, threshold) {
	let best = null;
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return null;
	}
	for (const entry of entries) {
		if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			const nested = newestUnder(full, threshold);
			if (nested && (!best || nested.mtimeMs > best.mtimeMs)) best = nested;
		} else if (entry.isFile()) {
			let mtimeMs;
			try {
				mtimeMs = statSync(full).mtimeMs;
			} catch {
				continue;
			}
			if (!best || mtimeMs > best.mtimeMs) best = { mtimeMs, path: full };
		}
		if (best && threshold != null && best.mtimeMs > threshold) return best;
	}
	return best;
}

/**
 * Classify `<repo>/build/index.js` against the repo's sources.
 *
 * @param {string} repo absolute path to the cellar checkout / install root
 * @returns {{ state: 'missing'|'stale'|'fresh'|'unknown', buildEntry: string,
 *             newest?: string, buildMs?: number, newestMs?: number }}
 *
 * `unknown` means there is nothing to compare against — a packaged install
 * (`package.json` `files` ships `build/` and `bin/`, not the source tree), where
 * "stale" is not a meaningful question and must never block a launch.
 */
export function buildFreshness(repo) {
	const buildEntry = join(repo, 'build', 'index.js');
	if (!existsSync(buildEntry)) return { state: 'missing', buildEntry };

	let buildMs;
	try {
		buildMs = statSync(buildEntry).mtimeMs;
	} catch {
		return { state: 'unknown', buildEntry };
	}

	const roots = SOURCE_DIRS.map((d) => join(repo, d)).filter((d) => existsSync(d));
	if (roots.length === 0) return { state: 'unknown', buildEntry };

	let newest = null;
	for (const root of roots) {
		const candidate = newestUnder(root, buildMs);
		if (candidate && (!newest || candidate.mtimeMs > newest.mtimeMs)) newest = candidate;
		if (newest && newest.mtimeMs > buildMs) break;
	}
	for (const name of CONFIG_FILES) {
		const full = join(repo, name);
		try {
			const mtimeMs = statSync(full).mtimeMs;
			if (!newest || mtimeMs > newest.mtimeMs) newest = { mtimeMs, path: full };
		} catch {
			/* absent config file: not an input */
		}
	}

	if (!newest) return { state: 'unknown', buildEntry };
	if (newest.mtimeMs <= buildMs) {
		return { state: 'fresh', buildEntry, newest: newest.path, buildMs, newestMs: newest.mtimeMs };
	}
	return { state: 'stale', buildEntry, newest: newest.path, buildMs, newestMs: newest.mtimeMs };
}

/** Human-readable "why is this stale", with the repo-relative offending file. */
export function stalenessReason(repo, result) {
	const rel = result.newest ? relative(repo, result.newest) || result.newest : 'a source file';
	return `${rel} is newer than build/index.js`;
}
