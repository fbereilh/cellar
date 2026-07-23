/**
 * Stale-build detection (src/lib/server/build-freshness.js).
 *
 * The launcher serves `build/index.js` unless `--dev` is passed, so a build that
 * is older than `src/` runs OLD server code against NEW source. That once cost an
 * e2e run ~18 minutes of false-failure timeouts, and — worse — made every result
 * untrustworthy in both directions. These pin the rule that now refuses it:
 * missing / stale / fresh, plus the `unknown` case a PACKAGED install must land
 * in (it ships `build/` without the source tree, where "stale" is unanswerable
 * and must never block a launch).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFreshness, stalenessReason } from '../../src/lib/server/build-freshness.js';

let repo: string;

/** Stamp an absolute mtime so the tests never race the filesystem clock. */
function touch(path: string, secondsFromEpoch: number) {
	utimesSync(path, secondsFromEpoch, secondsFromEpoch);
}

const OLD = 1_000_000;
const NEW = 2_000_000;

function writeAt(path: string, contents: string, seconds: number) {
	writeFileSync(path, contents);
	touch(path, seconds);
}

/**
 * Writing files leaves every containing directory at wall-clock time; since the
 * classifier now folds directory mtimes in (to catch delete-only changes), freeze
 * them to a controlled baseline so only the mtimes a test sets on purpose matter.
 */
function freezeDirs(root: string, seconds: number) {
	let entries;
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) if (e.isDirectory()) freezeDirs(join(root, e.name), seconds);
	touch(root, seconds);
}

beforeEach(() => {
	repo = mkdtempSync(join(tmpdir(), 'cellar-freshness-'));
	mkdirSync(join(repo, 'src', 'lib'), { recursive: true });
	mkdirSync(join(repo, 'build'), { recursive: true });
	// A `.git` marks this as a real source checkout (dev clone / CI / e2e harness),
	// which is what makes "stale" an answerable question. Packaged-install cases
	// remove it below.
	mkdirSync(join(repo, '.git'));
	writeAt(join(repo, 'package.json'), '{}', OLD);
});

afterEach(() => {
	rmSync(repo, { recursive: true, force: true });
});

describe('buildFreshness', () => {
	it('reports missing when there is no build/index.js', () => {
		writeAt(join(repo, 'src', 'lib', 'a.ts'), 'export const a = 1;', OLD);
		expect(buildFreshness(repo).state).toBe('missing');
	});

	it('reports fresh when the build is newer than every source', () => {
		writeAt(join(repo, 'src', 'lib', 'a.ts'), 'export const a = 1;', OLD);
		freezeDirs(join(repo, 'src'), OLD);
		writeAt(join(repo, 'build', 'index.js'), '// built', NEW);
		expect(buildFreshness(repo).state).toBe('fresh');
	});

	it('reports stale when any source file is newer than the build', () => {
		writeAt(join(repo, 'build', 'index.js'), '// built', OLD);
		writeAt(join(repo, 'src', 'lib', 'a.ts'), 'export const a = 1;', NEW);
		freezeDirs(join(repo, 'src'), OLD);
		touch(join(repo, 'src', 'lib', 'a.ts'), NEW);

		const result = buildFreshness(repo);
		expect(result.state).toBe('stale');
		// The message must name the offending file, so "rebuild" is actionable.
		expect(stalenessReason(repo, result)).toContain(join('src', 'lib', 'a.ts'));
	});

	it('finds a stale file nested deep in the source tree', () => {
		mkdirSync(join(repo, 'src', 'lib', 'server', 'mcp'), { recursive: true });
		writeAt(join(repo, 'src', 'lib', 'a.ts'), 'export const a = 1;', OLD);
		writeAt(join(repo, 'build', 'index.js'), '// built', OLD + 1);
		writeAt(join(repo, 'src', 'lib', 'server', 'mcp', 'image.ts'), 'export {};', NEW);
		freezeDirs(join(repo, 'src'), OLD);
		touch(join(repo, 'src', 'lib', 'server', 'mcp', 'image.ts'), NEW);

		expect(buildFreshness(repo).state).toBe('stale');
	});

	it('reports stale when a source file was deleted (dir mtime moved, no survivor did)', () => {
		// A delete-only change: the containing directory's mtime advances past the
		// build, but no surviving file is newer. A files-only walk would miss it.
		writeAt(join(repo, 'src', 'lib', 'a.ts'), 'export const a = 1;', OLD);
		writeAt(join(repo, 'build', 'index.js'), '// built', OLD + 1);
		freezeDirs(join(repo, 'src'), OLD);
		touch(join(repo, 'src', 'lib'), NEW);

		const result = buildFreshness(repo);
		expect(result.state).toBe('stale');
		expect(stalenessReason(repo, result)).toContain(join('src', 'lib'));
	});

	it('treats a changed root config file as staleness too', () => {
		writeAt(join(repo, 'src', 'lib', 'a.ts'), 'export const a = 1;', OLD);
		writeAt(join(repo, 'build', 'index.js'), '// built', OLD + 1);
		freezeDirs(join(repo, 'src'), OLD);
		writeAt(join(repo, 'vite.config.js'), 'export default {};', NEW);

		const result = buildFreshness(repo);
		expect(result.state).toBe('stale');
		expect(stalenessReason(repo, result)).toContain('vite.config.js');
	});

	it('ignores node_modules and dotfiles — they are not build inputs', () => {
		writeAt(join(repo, 'src', 'lib', 'a.ts'), 'export const a = 1;', OLD);
		writeAt(join(repo, 'build', 'index.js'), '// built', OLD + 1);

		mkdirSync(join(repo, 'src', 'node_modules'), { recursive: true });
		writeAt(join(repo, 'src', 'node_modules', 'dep.js'), '// vendored', NEW);
		writeAt(join(repo, 'src', '.DS_Store'), 'junk', NEW);
		freezeDirs(join(repo, 'src'), OLD);
		// node_modules is skipped in the walk, but its own dir mtime must not leak in.
		touch(join(repo, 'src', 'node_modules'), NEW);

		expect(buildFreshness(repo).state).toBe('fresh');
	});

	it('reports unknown for a packaged release install even when a shipped src file is newer', () => {
		// A real npm/brew install DOES ship src/lib/server/*.js, so absence of src/
		// is NOT how a packaged install is detected. The positive signal is the
		// build-info release stamp + no .git. Even a shipped src file whose mtime
		// beats the build must never be classified 'stale' — a launcher must not
		// refuse to start on a packaged install.
		rmSync(join(repo, '.git'), { recursive: true, force: true });
		mkdirSync(join(repo, 'src', 'lib', 'server'), { recursive: true });
		writeAt(join(repo, 'src', 'lib', 'server', 'venv.js'), '// shipped', NEW);
		writeAt(join(repo, 'build', 'index.js'), '// built', OLD);
		writeFileSync(join(repo, 'build', 'build-info.json'), JSON.stringify({ source: 'release' }));

		expect(buildFreshness(repo).state).toBe('unknown');
	});

	it('reports unknown when there is no .git and no build stamp (ambiguous → launch)', () => {
		// A source tarball with no .git and an unreadable/absent stamp: bias to
		// launching rather than a false stale refusal.
		rmSync(join(repo, '.git'), { recursive: true, force: true });
		writeAt(join(repo, 'src', 'lib', 'a.ts'), 'export const a = 1;', NEW);
		writeAt(join(repo, 'build', 'index.js'), '// built', OLD);

		expect(buildFreshness(repo).state).toBe('unknown');
	});
});
