/**
 * Guarantee `build/index.js` matches the current sources, then get out of the way.
 *
 * Wired as the `pretest:e2e` npm hook. The e2e harness boots the REAL launcher
 * without `--dev`, so every spec runs against the production build; without this,
 * `npm run test:e2e` silently tested whatever was compiled last (see
 * src/lib/server/build-freshness.js for the full cost of that).
 *
 * Rebuilds ONLY when stale, so the already-fresh case — the common one in a
 * re-run loop — costs a directory walk (single-digit ms), not a 45 s `vite build`.
 *
 * Node builtins only; no dev dependency of its own.
 */
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFreshness, stalenessReason } from '../src/lib/server/build-freshness.js';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

const result = buildFreshness(REPO);

if (result.state === 'fresh') {
	console.log('[cellar] build is up to date with src/ — skipping rebuild.');
	process.exit(0);
}

const why =
	result.state === 'missing'
		? 'no production build found'
		: result.state === 'stale'
			? `stale build (${stalenessReason(REPO, result)})`
			: 'build freshness could not be determined';

console.log(`[cellar] ${why} — running \`npm run build\` …`);

const isWin = process.platform === 'win32';
const npm = isWin ? 'npm.cmd' : 'npm';
const build = spawnSync(npm, ['run', 'build'], { cwd: REPO, stdio: 'inherit', shell: isWin });

if (build.error) {
	console.error(`[cellar] failed to run \`npm run build\`: ${build.error.message}`);
	process.exit(1);
}
process.exit(build.status ?? 1);
