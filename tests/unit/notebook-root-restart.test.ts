/**
 * The RESTART CONTRACT of a code-root change.
 *
 * A kernel's working directory is fixed when its process spawns, so applying a
 * new root means FREEING that notebook's kernel (the existing `rebindKernel`
 * teardown) rather than restarting it in place — a `restart()` would re-inject
 * the new root onto `sys.path` while the process still ran in the old directory.
 * These tests pin the pairing and the honesty of what it reports:
 *
 *   - a real change frees THAT notebook's kernel and says the namespace is gone,
 *   - an unchanged declaration frees nothing (re-declaring the root you are
 *     already on must not cost you your variables),
 *   - a REFUSED root writes nothing and frees nothing,
 *   - other notebooks are untouched.
 *
 * The kernel module is mocked to a recorder: what matters here is which notebook
 * is rebound and when, not what a real kernel does with it (that is
 * `kernel-root.test.ts`).
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const h = vi.hoisted(() => ({
	/** Notebooks that currently "have" a kernel — rebinding one frees it. */
	live: new Set<string>(),
	rebound: [] as string[]
}));

vi.mock('../../src/lib/server/kernel', () => ({
	rebindKernel: vi.fn(async (nb: string) => {
		h.rebound.push(nb);
		const had = h.live.delete(nb);
		return { status: 'not_started', id: null, session_id: null, rebound: had ? 1 : 0 };
	})
}));

let OUTER: string;
let WS: string;
let SIBLING: string;
let nbmod: typeof import('../../src/lib/server/notebook');
let actions: typeof import('../../src/lib/server/notebook-root-actions');

/** A real repo, so the two SPELLINGS of one external worktree can be exercised. */
function git(cwd: string, ...args: string[]) {
	execFileSync('git', ['-C', cwd, ...args], {
		stdio: 'pipe',
		env: {
			...process.env,
			GIT_AUTHOR_NAME: 'Ada L',
			GIT_AUTHOR_EMAIL: 'ada@example.com',
			GIT_COMMITTER_NAME: 'Ada L',
			GIT_COMMITTER_EMAIL: 'ada@example.com'
		}
	});
}

beforeAll(async () => {
	OUTER = mkdtempSync(join(tmpdir(), 'cellar-root-restart-'));
	WS = join(OUTER, 'workspace');
	SIBLING = join(OUTER, 'pr-398');
	mkdirSync(WS, { recursive: true });
	process.env.CELLAR_WORKSPACE = WS;
	mkdirSync(join(WS, 'roots', 'pr-482'), { recursive: true });
	mkdirSync(join(WS, 'roots', 'main'), { recursive: true });
	// A registered SIBLING worktree outside the workspace: the only way to have one
	// directory with two legal declarations (absolute, and `../pr-398`).
	git(WS, 'init', '-q', '-b', 'main');
	writeFileSync(join(WS, 'f.txt'), 'x\n');
	git(WS, 'add', 'f.txt');
	git(WS, 'commit', '-q', '-m', 'init');
	git(WS, 'worktree', 'add', '-q', SIBLING, '-b', 'under-review');
	nbmod = await import('../../src/lib/server/notebook');
	actions = await import('../../src/lib/server/notebook-root-actions');
});

beforeEach(() => {
	h.rebound.length = 0;
	h.live.clear();
});

describe('changing a notebook’s root', () => {
	it('frees THAT notebook’s kernel and reports the namespace cleared', async () => {
		const nb = nbmod.createNotebook('review.ipynb').path;
		h.live.add(nb);
		const r = await actions.setNotebookRootAndRestart('roots/pr-482', nb);
		expect(r).toMatchObject({
			root: 'roots/pr-482',
			absolute: join(WS, 'roots', 'pr-482'),
			changed: true,
			kernel_restarted: true,
			namespace_cleared: true
		});
		expect(h.rebound).toEqual([nb]);
		expect(nbmod.getNotebookRoot(nb)).toBe('roots/pr-482');
	});

	it('leaves every OTHER notebook’s kernel alone', async () => {
		const mine = nbmod.createNotebook('mine.ipynb').path;
		const theirs = nbmod.createNotebook('theirs.ipynb').path;
		h.live.add(mine);
		h.live.add(theirs);
		await actions.setNotebookRootAndRestart('roots/main', mine);
		expect(h.rebound).toEqual([mine]);
		expect(h.live.has(theirs)).toBe(true);
	});

	it('reports honestly when the notebook had no kernel to free', async () => {
		const nb = nbmod.createNotebook('never-ran.ipynb').path;
		const r = await actions.setNotebookRootAndRestart('roots/main', nb);
		expect(r.changed).toBe(true);
		// The declaration took, but nothing was executing: claiming a cleared
		// namespace would assert more than happened.
		expect(r.kernel_restarted).toBe(false);
		expect(r.namespace_cleared).toBe(false);
	});

	it('is a genuine NO-OP when the declaration already says this', async () => {
		const nb = nbmod.createNotebook('stable.ipynb').path;
		await actions.setNotebookRootAndRestart('roots/pr-482', nb);
		const bytes = readFileSync(nb, 'utf8');
		h.rebound.length = 0;
		h.live.add(nb);
		// Same root, spelled differently: meaning is what counts, so no kernel is
		// freed and the file is not rewritten.
		const r = await actions.setNotebookRootAndRestart('./roots/pr-482/', nb);
		expect(r).toMatchObject({ changed: false, kernel_restarted: false, namespace_cleared: false });
		expect(h.rebound).toEqual([]);
		expect(h.live.has(nb)).toBe(true);
		expect(readFileSync(nb, 'utf8')).toBe(bytes);
	});

	it('clearing a root returns to the workspace and frees the kernel once', async () => {
		const nb = nbmod.createNotebook('clearing.ipynb').path;
		await actions.setNotebookRootAndRestart('roots/pr-482', nb);
		h.rebound.length = 0;
		h.live.add(nb);
		const r = await actions.setNotebookRootAndRestart('', nb);
		expect(r).toMatchObject({ root: null, changed: true, namespace_cleared: true });
		expect(r.absolute).toBe(WS);
		expect(h.rebound).toEqual([nb]);
		expect(nbmod.getNotebookRoot(nb)).toBeNull();
	});

	it('is a NO-OP across the two SPELLINGS of one external worktree', async () => {
		// The case a pure text comparison cannot see: `/abs/path/pr-398` and
		// `../pr-398` are one directory, and re-declaring the root you are already on
		// must not free the kernel. Getting this wrong costs the user their namespace
		// on every re-declare — which is why the resolved DIRECTORIES decide.
		const nb = nbmod.createNotebook('two-spellings.ipynb').path;
		const first = await actions.setNotebookRootAndRestart(SIBLING, nb);
		// Stored ..-relative whichever form was typed.
		expect(first.root).toBe('../pr-398');
		const bytes = readFileSync(nb, 'utf8');
		h.rebound.length = 0;
		h.live.add(nb);

		for (const spelling of [SIBLING, '../pr-398', `${SIBLING}/`]) {
			const again = await actions.setNotebookRootAndRestart(spelling, nb);
			expect(again).toMatchObject({ root: '../pr-398', changed: false, namespace_cleared: false });
		}
		expect(h.rebound).toEqual([]);
		expect(h.live.has(nb)).toBe(true);
		expect(readFileSync(nb, 'utf8')).toBe(bytes);
	});

	it('a REFUSED root writes nothing and frees nothing', async () => {
		const nb = nbmod.createNotebook('refused.ipynb').path;
		await actions.setNotebookRootAndRestart('roots/main', nb);
		h.rebound.length = 0;
		h.live.add(nb);
		for (const bad of ['../outside', 'roots/does-not-exist', '/etc']) {
			await expect(actions.setNotebookRootAndRestart(bad, nb)).rejects.toThrow();
		}
		// The working kernel and the previous declaration both survive: a refusal must
		// never be a half-applied change.
		expect(h.rebound).toEqual([]);
		expect(h.live.has(nb)).toBe(true);
		expect(nbmod.getNotebookRoot(nb)).toBe('roots/main');
	});
});
