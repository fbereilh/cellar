import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeNotebook } from '../../src/lib/server/ipynb';
import { gitBlameNotebookCells } from '../../src/lib/server/git';

/**
 * Per-CELL git blame for a notebook (the bottom status-bar blame shown for the
 * focused cell). These pin the line→cell mapping over the real clean-on-save
 * `.ipynb` bytes: a cell reduces to its most-recent contributing commit, an
 * uncommitted cell reads `notCommitted`, and a non-repo reports `tracked:false`.
 */

const NB = 'nb.ipynb';

function git(cwd: string, args: string[], extraEnv: Record<string, string> = {}) {
	const r = spawnSync('git', args, {
		cwd,
		env: { ...process.env, ...extraEnv },
		encoding: 'utf8'
	});
	if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
	return r.stdout;
}

/** Commit the whole worktree at a fixed author/committer time (ISO string). */
function commitAt(cwd: string, message: string, iso: string) {
	git(cwd, ['add', '-A']);
	git(cwd, ['commit', '-m', message], {
		GIT_AUTHOR_DATE: iso,
		GIT_COMMITTER_DATE: iso
	});
}

function cell(id: string, source: string) {
	return { id, cell_type: 'code' as const, source, outputs: [], metadata: {} };
}

describe('gitBlameNotebookCells', () => {
	let dir: string;
	const savedWs = process.env.CELLAR_WORKSPACE;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'cellar-blame-'));
		process.env.CELLAR_WORKSPACE = dir;
	});

	afterEach(() => {
		if (savedWs === undefined) delete process.env.CELLAR_WORKSPACE;
		else process.env.CELLAR_WORKSPACE = savedWs;
		rmSync(dir, { recursive: true, force: true });
	});

	it('maps each cell to its most-recent contributing commit', () => {
		git(dir, ['init', '-q']);
		git(dir, ['config', 'user.email', 'a@b.c']);
		git(dir, ['config', 'user.name', 'Ada']);

		// Commit 1 (older): both cells authored together.
		writeNotebook(join(dir, NB), {
			path: NB,
			cells: [cell('cell-a', 'a = 1\naa = 2'), cell('cell-b', 'b = 1')]
		});
		commitAt(dir, 'first', '2020-01-01T00:00:00');

		// Commit 2 (newer, by a different author): only cell B changes.
		git(dir, ['config', 'user.name', 'Grace']);
		git(dir, ['config', 'user.email', 'g@h.i']);
		writeNotebook(join(dir, NB), {
			path: NB,
			cells: [cell('cell-a', 'a = 1\naa = 2'), cell('cell-b', 'b = 2')]
		});
		commitAt(dir, 'second', '2021-06-15T00:00:00');

		return gitBlameNotebookCells(NB).then((res) => {
			expect(res.isRepo).toBe(true);
			expect(res.tracked).toBe(true);

			const a = res.cells['cell-a'];
			const b = res.cells['cell-b'];
			expect(a).toBeTruthy();
			expect(b).toBeTruthy();

			// Cell A untouched since commit 1; cell B most-recently touched in commit 2.
			expect(a.notCommitted).toBe(false);
			expect(b.notCommitted).toBe(false);
			expect(a.author).toBe('Ada');
			expect(b.author).toBe('Grace');
			expect(a.commit).not.toBe(b.commit); // genuinely per-cell
			expect((b.authorTime ?? 0)).toBeGreaterThan(a.authorTime ?? 0);
		});
	});

	it('reports an uncommitted (new / edited) cell as notCommitted', () => {
		git(dir, ['init', '-q']);
		git(dir, ['config', 'user.email', 'a@b.c']);
		git(dir, ['config', 'user.name', 'Ada']);

		writeNotebook(join(dir, NB), {
			path: NB,
			cells: [cell('cell-a', 'a = 1')]
		});
		commitAt(dir, 'first', '2020-01-01T00:00:00');

		// Add a brand-new cell and edit the existing one, without committing.
		writeNotebook(join(dir, NB), {
			path: NB,
			cells: [cell('cell-a', 'a = 999'), cell('cell-new', 'n = 1')]
		});

		return gitBlameNotebookCells(NB).then((res) => {
			expect(res.tracked).toBe(true);
			expect(res.cells['cell-a'].notCommitted).toBe(true);
			expect(res.cells['cell-new'].notCommitted).toBe(true);
		});
	});

	it('marks a cell dirty (notCommitted) when only SOME of its lines are uncommitted', () => {
		git(dir, ['init', '-q']);
		git(dir, ['config', 'user.email', 'a@b.c']);
		git(dir, ['config', 'user.name', 'Ada']);

		// A multi-line cell, fully committed.
		writeNotebook(join(dir, NB), {
			path: NB,
			cells: [cell('cell-a', 'a = 1\nb = 2\nc = 3')]
		});
		commitAt(dir, 'first', '2020-01-01T00:00:00');

		// Edit ONE line only; the other lines stay committed. The uncommitted line is
		// the most-recent contribution, so the whole cell must read notCommitted rather
		// than the stale committed author.
		writeNotebook(join(dir, NB), {
			path: NB,
			cells: [cell('cell-a', 'a = 1\nb = 999\nc = 3')]
		});

		return gitBlameNotebookCells(NB).then((res) => {
			expect(res.tracked).toBe(true);
			expect(res.cells['cell-a'].notCommitted).toBe(true);
		});
	});

	it('returns tracked:false for a non-git workspace', () => {
		writeNotebook(join(dir, NB), {
			path: NB,
			cells: [cell('cell-a', 'a = 1')]
		});
		return gitBlameNotebookCells(NB).then((res) => {
			expect(res.isRepo).toBe(false);
			expect(res.tracked).toBe(false);
			expect(res.cells).toEqual({});
		});
	});

	it('returns tracked:false for an untracked notebook in a repo', () => {
		git(dir, ['init', '-q']);
		git(dir, ['config', 'user.email', 'a@b.c']);
		git(dir, ['config', 'user.name', 'Ada']);
		// A committed placeholder so the repo has a HEAD, but nb.ipynb is untracked.
		git(dir, ['commit', '--allow-empty', '-m', 'init'], {
			GIT_AUTHOR_DATE: '2020-01-01T00:00:00',
			GIT_COMMITTER_DATE: '2020-01-01T00:00:00'
		});
		writeNotebook(join(dir, NB), {
			path: NB,
			cells: [cell('cell-a', 'a = 1')]
		});
		return gitBlameNotebookCells(NB).then((res) => {
			expect(res.isRepo).toBe(true);
			expect(res.tracked).toBe(false);
		});
	});
});
