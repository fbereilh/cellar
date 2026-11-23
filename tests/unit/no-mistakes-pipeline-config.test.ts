/**
 * The no-mistakes Test step must RUN cellar's suite, or fail visibly. It must
 * never report success having executed nothing.
 *
 * no-mistakes builds every pipeline run in a fresh `git worktree` holding
 * TRACKED files only, so the gitignored `node_modules` is absent there. With
 * `commands.test` configured and no `commands.prepare`, `npm test` died with
 * exit 127 (`sh: vitest: command not found`) on every run, and the Test step
 * was approved over that failure. The suite never ran, and the run still ended
 * `passed-with-override`.
 *
 * `commands.prepare` closes it: no-mistakes runs it once per run worktree,
 * before the test command, and a non-zero exit FAILS the Test step outright,
 * with no approval gate. That pairing is a single line of YAML that nothing
 * else exercises before merge (no-mistakes reads `commands` from the default
 * branch, not from the pushed one), so it is pinned here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(import.meta.url), '../../..');
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8');

/**
 * The scalar entries of one top-level mapping in a simple YAML file. Enough for
 * `.no-mistakes.yaml`, whose `commands` block is flat `key: 'value'` lines; a
 * shape it does not understand reads as absent, which fails the assertions
 * below rather than passing them.
 */
function topLevelMapping(yaml: string, key: string): Record<string, string> {
	const out: Record<string, string> = {};
	let inside = false;
	for (const raw of yaml.split('\n')) {
		const line = raw.replace(/\s+#.*$/, '').replace(/^#.*$/, '');
		if (!line.trim()) continue;
		if (!/^\s/.test(line)) {
			inside = line.trim() === `${key}:`;
			continue;
		}
		if (!inside) continue;
		const m = /^ {2}([a-z_]+):\s*(.*)$/.exec(line);
		if (!m) continue;
		out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
	}
	return out;
}

describe('the no-mistakes Test step runs the real suite', () => {
	const commands = topLevelMapping(read('.no-mistakes.yaml'), 'commands');

	it('configures a test command', () => {
		expect(commands.test).toBe('npm test');
	});

	it('installs dependencies before it, because the run worktree has no node_modules', () => {
		// The premise: node_modules is gitignored, so a tracked-files-only
		// checkout cannot contain it.
		expect(read('.gitignore').split('\n')).toContain('node_modules/');
		expect(commands.prepare, 'commands.prepare is what puts vitest in the run worktree').toBeTruthy();
	});

	it('installs exactly the lockfile, so a broken install fails instead of drifting', () => {
		// `npm ci` refuses when package.json and the lockfile disagree, and a
		// failing prepare fails the Test step. `npm install` would quietly
		// re-resolve and pass.
		expect(commands.prepare).toMatch(/^npm ci(\s|$)/);
	});

	it('runs vitest once rather than watching, and an empty run does not pass', () => {
		const pkg = JSON.parse(read('package.json'));
		expect(pkg.scripts.test).toBe('vitest run');
		const run = spawnSync('npm', ['test', '--', '__cellar_no_such_test_file__'], {
			cwd: REPO,
			encoding: 'utf8',
			env: { ...process.env, CI: '1' },
			timeout: 60_000
		});
		expect(run.status).not.toBe(0);
		expect(`${run.stdout}${run.stderr}`).toMatch(/No test files found/i);
	}, 90_000);
});

describe('topLevelMapping', () => {
	it('reads one block and ignores comments and the blocks around it', () => {
		const yaml = [
			'# header',
			'commands:',
			"  # a comment",
			"  prepare: 'npm ci --prefer-offline'  # trailing",
			'  test: "npm test"',
			'test:',
			'  prepare: true'
		].join('\n');
		expect(topLevelMapping(yaml, 'commands')).toEqual({
			prepare: 'npm ci --prefer-offline',
			test: 'npm test'
		});
	});

	it('reads a missing block as empty', () => {
		expect(topLevelMapping('test:\n  evidence: x\n', 'commands')).toEqual({});
	});
});
