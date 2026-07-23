import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeNotebook } from '../../src/lib/server/ipynb';
import {
	gitHeadFile,
	gitBlameFile,
	gitBlameNotebookCells,
	gitSpawnCount,
	gitSpawnLog,
	resetGitSpawnCount,
	invalidateGitCaches,
	MAX_DECORATION_BYTES
} from '../../src/lib/server/git';
import { MAX_FILE_BYTES, MAX_HTML_FILE_BYTES } from '../../src/lib/server/limits.js';

/**
 * Line-level git decorations are refused above `MAX_DECORATION_BYTES`, which is
 * what keeps the raised HTML read cap from routing a multi-MB export through a
 * `--line-porcelain` blame (seconds of git, tens of MB of stdout) on every mount,
 * save and window focus.
 *
 * Both directions are pinned, and the refusing half asserts WHICH git
 * subcommands ran: the fix is not paying for the blame, so a test that only
 * checked "no blame came back" would pass while the cost still happened.
 *
 * The refusal also has to name the right fact. `tooLarge` is reserved for a
 * TRACKED file; the generated `report.html` this ceiling exists for is usually
 * untracked or gitignored, and that has no blame for an ordinary reason — so all
 * three states are pinned below.
 */

function git(cwd: string, args: string[]) {
	const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (${r.status}): ${r.stderr}`);
	return r.stdout;
}

function initRepo(dir: string) {
	git(dir, ['init', '-q']);
	git(dir, ['config', 'user.email', 'a@b.c']);
	git(dir, ['config', 'user.name', 'Ada']);
}

/** `bytes` of newline-terminated filler — a real multi-line tracked file. */
function filler(bytes: number): string {
	const line = 'x'.repeat(63) + '\n';
	return line.repeat(Math.ceil(bytes / line.length));
}

describe('line-level git decorations are size-gated', () => {
	let dir: string;
	const savedWs = process.env.CELLAR_WORKSPACE;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'cellar-gitsize-'));
		process.env.CELLAR_WORKSPACE = dir;
		invalidateGitCaches();
		initRepo(dir);
	});

	afterEach(() => {
		if (savedWs === undefined) delete process.env.CELLAR_WORKSPACE;
		else process.env.CELLAR_WORKSPACE = savedWs;
		rmSync(dir, { recursive: true, force: true });
	});

	// The threshold is the ordinary text-file cap, so nothing that could be opened
	// before the HTML exception loses its decorations.
	it('is the ordinary file cap, well under the HTML one', () => {
		expect(MAX_DECORATION_BYTES).toBe(MAX_FILE_BYTES);
		expect(MAX_DECORATION_BYTES).toBeLessThan(MAX_HTML_FILE_BYTES);
	});

	it('an ordinary tracked file still gets its blame and its HEAD baseline', async () => {
		writeFileSync(join(dir, 'small.html'), '<html>\n<body>hi</body>\n</html>\n');
		git(dir, ['add', '-A']);
		git(dir, ['commit', '-q', '-m', 'first']);
		resetGitSpawnCount();

		const blame = await gitBlameFile('small.html');
		expect(blame.tracked).toBe(true);
		expect(blame.tooLarge).toBe(false);
		expect(blame.lines.length).toBe(3);
		expect(blame.lines[0].author).toBe('Ada');

		const head = await gitHeadFile('small.html');
		expect(head.tracked).toBe(true);
		expect(head.tooLarge).toBe(false);
		expect(head.content).toContain('<body>hi</body>');

		// An under-threshold file pays nothing for the tracked/too-large
		// distinction: that lookup happens only once the size gate has tripped.
		expect(gitSpawnLog()).not.toContain('ls-files');
	});

	it('an over-threshold TRACKED file is refused without blaming it, and says why', async () => {
		writeFileSync(join(dir, 'report.html'), filler(MAX_DECORATION_BYTES + 64 * 1024));
		writeFileSync(join(dir, 'small.html'), '<html></html>\n');
		git(dir, ['add', '-A']);
		git(dir, ['commit', '-q', '-m', 'first']);

		// Warm the repo-detection preflight on the small file, so the log below
		// records only what answering for `report.html` cost.
		await gitBlameFile('small.html');
		resetGitSpawnCount();

		const blame = await gitBlameFile('report.html');
		expect(blame.tooLarge).toBe(true);
		expect(blame.tracked).toBe(false); // no records to show…
		expect(blame.lines).toEqual([]);

		const head = await gitHeadFile('report.html');
		expect(head.tooLarge).toBe(true);
		expect(head.content).toBe(null);

		// …and neither answer ran the expensive call. This is the whole fix: what
		// it cost is index lookups, never the `--line-porcelain` blame or the
		// whole-blob `git show`.
		expect(gitSpawnLog()).toEqual(['ls-files', 'ls-files']);
	});

	/**
	 * The shape this ceiling exists for is a GENERATED `report.html`, which is
	 * normally gitignored or simply never added. That file has no blame for an
	 * entirely different reason, and VS Code shows nothing for it — so it must
	 * read as untracked, not as "too large for blame".
	 */
	it('an over-threshold UNTRACKED file reads as untracked, not as too-large', async () => {
		writeFileSync(join(dir, 'seed.txt'), 'seed\n');
		git(dir, ['add', '-A']);
		git(dir, ['commit', '-q', '-m', 'first']);
		writeFileSync(join(dir, 'report.html'), filler(MAX_DECORATION_BYTES + 64 * 1024));

		await gitBlameFile('seed.txt'); // warm the preflight
		resetGitSpawnCount();

		const blame = await gitBlameFile('report.html');
		expect(blame.tracked).toBe(false);
		expect(blame.tooLarge).toBe(false);
		expect(blame.lines).toEqual([]);

		const head = await gitHeadFile('report.html');
		expect(head.tracked).toBe(false);
		expect(head.tooLarge).toBe(false);

		// Still never blamed — the distinction is one index lookup, not the stall.
		expect(gitSpawnLog()).toEqual(['ls-files', 'ls-files']);
	});

	it('an over-threshold GITIGNORED file reads as untracked too', async () => {
		writeFileSync(join(dir, '.gitignore'), 'report.html\n');
		git(dir, ['add', '-A']);
		git(dir, ['commit', '-q', '-m', 'first']);
		writeFileSync(join(dir, 'report.html'), filler(MAX_DECORATION_BYTES + 64 * 1024));

		await gitBlameFile('.gitignore'); // warm the preflight
		resetGitSpawnCount();

		const blame = await gitBlameFile('report.html');
		expect(blame.tracked).toBe(false);
		expect(blame.tooLarge).toBe(false);
		expect(gitSpawnLog()).toEqual(['ls-files']);
		expect(gitSpawnCount()).toBe(1);
	});

	// Notebook decorations are per CELL and their blame is already `-L`-scoped to
	// source lines, so an output-heavy `.ipynb` keeps them — gating on file size
	// would strip the change bars off an ordinary plot-heavy notebook.
	it('notebook cell decorations are NOT gated by file size', async () => {
		const nb = 'big.ipynb';
		const fatOutput = Array.from({ length: 4000 }, (_, i) => ({
			output_type: 'stream' as const,
			name: 'stdout',
			text: `${'y'.repeat(600)} ${i}\n`
		}));
		writeNotebook(join(dir, nb), {
			path: nb,
			cells: [{ id: 'cell-a', cell_type: 'code', source: 'a = 1', outputs: fatOutput, metadata: {} }]
		});
		git(dir, ['add', '-A']);
		git(dir, ['commit', '-q', '-m', 'first']);
		// The notebook is genuinely past the ceiling — otherwise this proves nothing.
		expect(statSync(join(dir, nb)).size).toBeGreaterThan(MAX_DECORATION_BYTES);

		const head = await gitHeadFile(nb, { sizeGuard: false });
		expect(head.tracked).toBe(true);
		expect(head.content).toContain('cell-a');

		const cells = await gitBlameNotebookCells(nb);
		expect(cells.tracked).toBe(true);
		expect(cells.cells['cell-a'].author).toBe('Ada');
	});

	// Source-level, like the sandbox guard: a refusal the UI renders as an empty
	// bar is indistinguishable from "untracked", which is a different fact.
	it('the shell says WHY rather than going blank', () => {
		const repo = join(import.meta.dirname, '../..');
		const tab = readFileSync(join(repo, 'src/lib/FileTab.svelte'), 'utf8');
		// The tab distinguishes the refusal from "no records" and reports it up.
		expect(tab).toContain('body.tooLarge');
		expect(tab).toContain("{ unavailable: 'too_large' }");

		const shell = readFileSync(join(repo, 'src/routes/+page.svelte'), 'utf8');
		expect(shell).toContain('isBlameUnavailable(activeBlame)');
		expect(shell).toContain('too large for blame');
	});
});
