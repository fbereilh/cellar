/**
 * Guarantee `build/` matches the current sources, then get out of the way.
 *
 * The e2e harness boots the REAL launcher without `--dev`, so every spec runs
 * against the production build; without this, a run silently tested whatever was
 * compiled last (see src/lib/server/build-freshness.js for the full cost of that).
 *
 * It runs from Playwright's own `globalSetup` (tests/e2e/global-setup.ts) rather
 * than from an npm hook, so EVERY invocation is covered - `npm run test:e2e` and a
 * bare `npx playwright test <spec>` typed by a developer or an agent alike. It is
 * deliberately wired in exactly ONE of those places: an npm `pretest:e2e` hook on
 * top would re-walk the source tree on every `npm run test:e2e` for an answer
 * globalSetup is about to compute again. `make run` calls it directly.
 *
 * Rebuilds ONLY when stale or incomplete, so the already-fresh case - the common
 * one in a re-run loop - costs a directory walk (single-digit ms), not a 45 s
 * `vite build`.
 *
 * Node builtins only; no dev dependency of its own.
 */
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFreshness, missingReason, stalenessReason } from '../src/lib/server/build-freshness.js';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Bring `<repo>/build` up to date if it is stale, absent or incomplete.
 *
 * Never throws: the caller decides what a failure means (globalSetup aborts the
 * run with the reason; the CLI form exits non-zero).
 *
 * @param {{ repo?: string, log?: (msg: string) => void }} [opts]
 * @returns {{ ok: boolean, state: string, rebuilt: boolean, reason: string }}
 */
export function ensureFreshBuild({ repo = REPO, log = console.log } = {}) {
	const result = buildFreshness(repo);

	if (result.state === 'fresh') {
		log('[cellar] build is up to date with src/ — skipping rebuild.');
		return { ok: true, state: result.state, rebuilt: false, reason: 'build is up to date' };
	}

	const why =
		result.state === 'missing'
			? missingReason(repo, result)
			: result.state === 'stale'
				? `stale build (${stalenessReason(repo, result)})`
				: 'build freshness could not be determined';

	log(`[cellar] ${why} — running \`npm run build\` …`);

	const isWin = process.platform === 'win32';
	const npm = isWin ? 'npm.cmd' : 'npm';
	const build = spawnSync(npm, ['run', 'build'], { cwd: repo, stdio: 'inherit', shell: isWin });

	if (build.error) {
		return {
			ok: false,
			state: result.state,
			rebuilt: false,
			reason: `${why}, and \`npm run build\` could not be started: ${build.error.message}`
		};
	}
	if (build.status !== 0) {
		return {
			ok: false,
			state: result.state,
			rebuilt: false,
			reason: `${why}, and \`npm run build\` failed (exit ${build.status ?? 'null'})`
		};
	}
	return { ok: true, state: result.state, rebuilt: true, reason: why };
}

const SELF = fileURLToPath(import.meta.url);

/**
 * A path resolved as far as the filesystem allows, so two spellings of one file
 * compare equal. One that cannot be realpath'd (already gone) falls back to its
 * lexical resolution rather than throwing, so the answer is still decided.
 */
function realOrResolved(path) {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

/**
 * Was this module RUN (`node scripts/ensure-build.js`, i.e. `make run`) rather
 * than imported (globalSetup, the unit tests)?
 *
 * Compared by RESOLVED path, never by `pathToFileURL(process.argv[1])`: Node
 * resolves an ESM entry through realpath but leaves `argv[1]` exactly as typed,
 * so for a checkout reached through a symlinked directory (`~/code` ->
 * `/Volumes/dev/code`) the two spellings differ and the equality is false. That
 * fails in the SILENT direction - `make run` would import this module, match
 * nothing, exit 0 having built nothing, and the user would meet the launcher's
 * stale refusal instead of the rebuild `make run` advertises.
 *
 * @param {string | undefined} entry `process.argv[1]`
 */
export function invokedAsCli(entry) {
	if (!entry) return false;
	return realOrResolved(entry) === realOrResolved(SELF);
}

// CLI form (`make run`): same work, exit code carries the verdict.
if (invokedAsCli(process.argv[1])) {
	const outcome = ensureFreshBuild();
	if (!outcome.ok) {
		console.error(`[cellar] ${outcome.reason}`);
		process.exit(1);
	}
	process.exit(0);
}
