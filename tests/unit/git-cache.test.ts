import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeNotebook } from '../../src/lib/server/ipynb';
import {
	gitStatus,
	gitHeadFile,
	gitBlameFile,
	gitBlameNotebookCells,
	cellSourceLines,
	gitSpawnCount,
	resetGitSpawnCount,
	invalidateGitCaches,
	invalidateGitStatusCache
} from '../../src/lib/server/git';
import type { CellOutput } from '../../src/lib/server/types';

/**
 * The perf/resilience work: memoized repo-detection preflights, a status/blame/HEAD
 * cache keyed by (file mtime + git index mtime) with a TTL backstop, and blame
 * scoped to source-line ranges with `-L` instead of the whole `.ipynb`. These tests
 * pin the three properties that matter: the fan-out actually collapses (spawn
 * counter), the cache invalidates on a real change, and the `-L` scoping produces
 * the SAME per-cell attribution as a whole-file blame (parity), output-heavy
 * notebooks included.
 */

const NB = 'nb.ipynb';

function git(cwd: string, args: string[], extraEnv: Record<string, string> = {}) {
	// 64 MB: a whole-file `--line-porcelain` blame of an output-heavy notebook is
	// tens of thousands of lines (exactly the bloat `-L` scoping avoids), well over
	// spawnSync's 1 MB default.
	const r = spawnSync('git', args, {
		cwd,
		env: { ...process.env, ...extraEnv },
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024
	});
	if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (status ${r.status}): ${r.stderr}`);
	return r.stdout;
}

function commitAt(cwd: string, message: string, iso: string) {
	git(cwd, ['add', '-A']);
	git(cwd, ['commit', '-m', message], { GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso });
}

function initRepo(dir: string) {
	git(dir, ['init', '-q']);
	git(dir, ['config', 'user.email', 'a@b.c']);
	git(dir, ['config', 'user.name', 'Ada']);
}

function cell(id: string, source: string, outputs: CellOutput[] = []) {
	return { id, cell_type: 'code' as const, source, outputs, metadata: {} };
}

/**
 * `n` separate stream outputs — a genuinely output-heavy cell in PHYSICAL FILE
 * LINES (a single stream `text` escapes its newlines onto one line, so it is the
 * count of output *items*, each ~5 lines, that inflates the file). These are the
 * lines the `-L` scoping must skip when blaming.
 */
function bigOutput(n: number): CellOutput[] {
	return Array.from({ length: n }, (_, i) => ({ output_type: 'stream' as const, name: 'stdout', text: `line ${i}\n` }));
}

const ZERO_SHA = '0000000000000000000000000000000000000000';

/**
 * Reference implementation of per-cell blame using a WHOLE-FILE `git blame`
 * (the pre-`-L` algorithm), for parity comparison. Parses the whole-file
 * porcelain into a line→commit map, then applies the same most-recent-line
 * reduction the production code uses — via the independently-parsed source-line
 * map. If the new `-L`-scoped path agrees with this for every cell, the line
 * numbering is proven correct.
 */
function wholeFileCellCommits(dir: string, rel: string): Record<string, { commit: string; notCommitted: boolean }> {
	const out = git(dir, ['blame', '--line-porcelain', '-w', '--', rel]);
	const byLine = new Map<number, { commit: string; authorTime: number; notCommitted: boolean }>();
	let cur: { commit: string; line: number; authorTime: number; notCommitted: boolean } | null = null;
	for (const raw of out.split('\n')) {
		const m = /^([0-9a-f]{40}) \d+ (\d+)/.exec(raw);
		if (m) {
			cur = { commit: m[1], line: Number(m[2]), authorTime: 0, notCommitted: m[1] === ZERO_SHA };
			continue;
		}
		if (!cur) continue;
		if (raw.startsWith('author-time ')) cur.authorTime = Number(raw.slice(12)) * 1000;
		else if (raw.startsWith('\t')) {
			byLine.set(cur.line, { commit: cur.commit, authorTime: cur.authorTime, notCommitted: cur.notCommitted });
			cur = null;
		}
	}

	const cellLines = cellSourceLines(readFileSync(join(dir, rel), 'utf8'));
	const cells: Record<string, { commit: string; notCommitted: boolean }> = {};
	for (const [id, lineNums] of cellLines ?? new Map<string, number[]>()) {
		let bestCommit: string | null = null;
		let bestTime = -1;
		let dirty = false;
		for (const ln of lineNums) {
			const rec = byLine.get(ln);
			if (!rec) continue;
			if (rec.notCommitted) { dirty = true; break; }
			if (rec.authorTime > bestTime) { bestTime = rec.authorTime; bestCommit = rec.commit; }
		}
		cells[id] = dirty || bestCommit == null ? { commit: ZERO_SHA, notCommitted: true } : { commit: bestCommit, notCommitted: false };
	}
	return cells;
}

describe('git caches + -L blame scoping', () => {
	let dir: string;
	const savedWs = process.env.CELLAR_WORKSPACE;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'cellar-gitcache-'));
		process.env.CELLAR_WORKSPACE = dir;
		invalidateGitCaches(); // start every test from a clean cache
	});

	afterEach(() => {
		if (savedWs === undefined) delete process.env.CELLAR_WORKSPACE;
		else process.env.CELLAR_WORKSPACE = savedWs;
		rmSync(dir, { recursive: true, force: true });
	});

	it('memoizes the repo-detection preflight across calls (no re-spawn)', async () => {
		initRepo(dir);
		writeNotebook(join(dir, NB), { path: NB, cells: [cell('cell-a', 'a = 1')] });
		commitAt(dir, 'first', '2020-01-01T00:00:00');

		// Warm the preflight cache for this workspace root.
		await gitStatus();

		// A HEAD fetch for a FRESH file (nothing cached for it) must spawn ONLY the
		// `git show` — no `--is-inside-work-tree` / `--show-prefix` re-derivation.
		resetGitSpawnCount();
		await gitHeadFile(NB);
		expect(gitSpawnCount()).toBe(1);

		// Likewise a fresh blame is exactly one `git blame`, preflight reused.
		resetGitSpawnCount();
		await gitBlameFile(NB);
		expect(gitSpawnCount()).toBe(1);
	});

	it('caches status and refreshes on an index bump or an explicit save event', async () => {
		initRepo(dir);
		writeNotebook(join(dir, NB), { path: NB, cells: [cell('cell-a', 'a = 1')] });
		commitAt(dir, 'first', '2020-01-01T00:00:00');
		await gitStatus(); // warm preflight + status

		// Repeated status for an unchanged repo is served from cache: zero spawns.
		resetGitSpawnCount();
		await gitStatus();
		await gitStatus();
		expect(gitSpawnCount()).toBe(0);

		// An explicit save-event invalidation forces a fresh status spawn.
		invalidateGitStatusCache();
		resetGitSpawnCount();
		await gitStatus();
		expect(gitSpawnCount()).toBe(1);

		// A real change that touches the index (a new staged file) also refreshes,
		// because the cache signature includes the git index mtime.
		writeNotebook(join(dir, 'other.ipynb'), { path: 'other.ipynb', cells: [cell('c', 'x = 1')] });
		git(dir, ['add', 'other.ipynb']);
		const st = await gitStatus();
		expect(st.files['other.ipynb']).toBe('A');
	});

	it('caches notebook blame and invalidates when the file mtime changes', async () => {
		initRepo(dir);
		writeNotebook(join(dir, NB), { path: NB, cells: [cell('cell-a', 'a = 1')] });
		commitAt(dir, 'first', '2020-01-01T00:00:00');
		await gitBlameNotebookCells(NB); // warm

		// Same unchanged file → served from cache, no git spawn.
		resetGitSpawnCount();
		await gitBlameNotebookCells(NB);
		await gitBlameNotebookCells(NB);
		expect(gitSpawnCount()).toBe(0);

		// Bump the file's mtime (as an edit-autosave would): the signature changes,
		// so the next blame re-spawns and reflects the new content.
		const future = Date.now() / 1000 + 5;
		utimesSync(join(dir, NB), future, future);
		resetGitSpawnCount();
		await gitBlameNotebookCells(NB);
		expect(gitSpawnCount()).toBeGreaterThan(0);
	});

	it('-L blame matches whole-file blame per cell (parity), output-heavy notebook included', async () => {
		initRepo(dir);

		// Commit 1 (older): both cells, each with a fat output block.
		writeNotebook(join(dir, NB), {
			path: NB,
			cells: [cell('cell-a', 'a = 1\naa = 2', bigOutput(400)), cell('cell-b', 'b = 1', bigOutput(600))]
		});
		commitAt(dir, 'first', '2020-01-01T00:00:00');

		// Commit 2 (newer, different author): only cell B's source changes; outputs stay fat.
		git(dir, ['config', 'user.name', 'Grace']);
		git(dir, ['config', 'user.email', 'g@h.i']);
		writeNotebook(join(dir, NB), {
			path: NB,
			cells: [cell('cell-a', 'a = 1\naa = 2', bigOutput(400)), cell('cell-b', 'b = 2', bigOutput(600))]
		});
		commitAt(dir, 'second', '2021-06-15T00:00:00');

		// A third cell, edited-but-uncommitted (the dirty case).
		writeNotebook(join(dir, NB), {
			path: NB,
			cells: [
				cell('cell-a', 'a = 1\naa = 2', bigOutput(400)),
				cell('cell-b', 'b = 2', bigOutput(600)),
				cell('cell-c', 'c = 3', bigOutput(300))
			]
		});

		const got = await gitBlameNotebookCells(NB);
		const ref = wholeFileCellCommits(dir, NB);

		expect(got.tracked).toBe(true);
		expect(Object.keys(got.cells).sort()).toEqual(['cell-a', 'cell-b', 'cell-c']);
		for (const id of Object.keys(ref)) {
			expect(got.cells[id].commit).toBe(ref[id].commit); // same commit as whole-file blame
			expect(got.cells[id].notCommitted).toBe(ref[id].notCommitted);
		}
		// And the attribution is genuinely per-cell across the fat outputs.
		expect(got.cells['cell-a'].author).toBe('Ada');
		expect(got.cells['cell-b'].author).toBe('Grace');
		expect(got.cells['cell-c'].notCommitted).toBe(true);
	});

	it('maps a cell to the exact physical file lines of its source', () => {
		writeNotebook(join(dir, NB), {
			path: NB,
			cells: [cell('cell-a', 'a = 1\naa = 2', bigOutput(30)), cell('cell-b', 'b = 1')]
		});
		const text = readFileSync(join(dir, NB), 'utf8');
		const map = cellSourceLines(text);
		expect(map).toBeTruthy();

		const fileLines = text.split('\n');
		// Every mapped line must literally contain its source fragment on that exact
		// physical file line — this is what makes the `-L a,b` numbering sound.
		const [la1, la2] = map!.get('cell-a')!;
		expect(la2).toBe(la1 + 1);
		expect(fileLines[la1 - 1]).toContain('a = 1');
		expect(fileLines[la2 - 1]).toContain('aa = 2');
		const [lb] = map!.get('cell-b')!;
		expect(fileLines[lb - 1]).toContain('b = 1');
		// cell-b's source sits well AFTER cell-a's output block: many output lines lie
		// between the two source ranges, proving output lines are not conflated with
		// source (and are exactly what `-L` scoping skips).
		expect(lb - la2).toBeGreaterThan(30);
	});
});
