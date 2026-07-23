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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
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

beforeEach(() => {
	repo = mkdtempSync(join(tmpdir(), 'cellar-freshness-'));
	mkdirSync(join(repo, 'src', 'lib'), { recursive: true });
	mkdirSync(join(repo, 'build'), { recursive: true });
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
		writeAt(join(repo, 'build', 'index.js'), '// built', NEW);
		expect(buildFreshness(repo).state).toBe('fresh');
	});

	it('reports stale when any source file is newer than the build', () => {
		writeAt(join(repo, 'build', 'index.js'), '// built', OLD);
		writeAt(join(repo, 'src', 'lib', 'a.ts'), 'export const a = 1;', NEW);

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

		expect(buildFreshness(repo).state).toBe('stale');
	});

	it('treats a changed root config file as staleness too', () => {
		writeAt(join(repo, 'src', 'lib', 'a.ts'), 'export const a = 1;', OLD);
		writeAt(join(repo, 'build', 'index.js'), '// built', OLD + 1);
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

		expect(buildFreshness(repo).state).toBe('fresh');
	});

	it('reports unknown for a packaged install (build/ present, no source tree)', () => {
		// package.json `files` ships build/ + bin/ + a few server modules — no src/.
		rmSync(join(repo, 'src'), { recursive: true, force: true });
		writeAt(join(repo, 'build', 'index.js'), '// built', OLD);

		// Never 'stale': a launcher must not refuse to start on an npm/brew install.
		expect(buildFreshness(repo).state).toBe('unknown');
	});
});
