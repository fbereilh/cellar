/**
 * Notebook CODE ROOTS: the declaration, its refusals, and its round-trip.
 *
 * A root is a directory inside the workspace (normally a git worktree) that a
 * notebook's kernel runs in and imports from, declared as
 * `notebook.metadata.cellar.root`. The feature is a pure superset: a notebook
 * that declares none must be byte-for-byte what it always was.
 *
 * These tests drive the REAL modules against a scratch workspace on the REAL
 * filesystem — the whole point of the resolver is what it does with directories
 * that exist, do not exist, or are not directories, and a mocked `fs` could not
 * see any of it. The kernel is deliberately absent: `notebookRoot.ts` never
 * touches it, which is what lets a root be validated with no Python at all.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { classifyRootPath, normalizeRootPath, sameRoot, NotebookRootError, ROOTS_DIR } from '../../src/lib/notebookRoot';

let WS: string;
let nbmod: typeof import('../../src/lib/server/notebook');
let rootmod: typeof import('../../src/lib/server/notebookRoot');

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-nb-root-'));
	process.env.CELLAR_WORKSPACE = WS;
	mkdirSync(join(WS, ROOTS_DIR, 'pr-482'), { recursive: true });
	mkdirSync(join(WS, ROOTS_DIR, 'main'), { recursive: true });
	writeFileSync(join(WS, 'a-file.txt'), 'not a directory\n');
	nbmod = await import('../../src/lib/server/notebook');
	rootmod = await import('../../src/lib/server/notebookRoot');
});

/** A fresh notebook with two cells, so each test starts from a clean declaration. */
function freshNotebook(rel: string): string {
	const doc = nbmod.createNotebook(rel);
	return doc.path;
}

describe('normalizeRootPath — the pure shape rules', () => {
	it('treats absent / empty / "." as the workspace root (no declaration)', () => {
		for (const v of [undefined, null, '', '   ', '.', './', '././']) {
			expect(normalizeRootPath(v)).toBeNull();
		}
	});

	it('canonicalizes an ordinary declaration, idempotently', () => {
		expect(normalizeRootPath('roots/pr-482')).toBe('roots/pr-482');
		expect(normalizeRootPath('./roots/pr-482/')).toBe('roots/pr-482');
		expect(normalizeRootPath('roots//pr-482')).toBe('roots/pr-482');
		expect(normalizeRootPath('roots\\pr-482')).toBe('roots/pr-482');
		// Idempotent: the normalized value is what gets persisted and re-read, so
		// re-normalizing it must never churn the file.
		expect(normalizeRootPath(normalizeRootPath('./roots/pr-482/'))).toBe('roots/pr-482');
	});

	// The pure half CLASSIFIES; it can no longer refuse an out-of-workspace shape,
	// because deciding whether one is a registered worktree needs git. These are the
	// deliberate updates that come with the second admission rule — the refusal
	// still happens, one layer down, and is asserted in `worktree-roots.test.ts`.
	it('classifies an absolute path as an OUTSIDE candidate, never an admission', () => {
		expect(classifyRootPath('/etc')).toEqual({ kind: 'outside', raw: '/etc' });
		expect(classifyRootPath('C:/Windows')).toEqual({ kind: 'outside', raw: 'C:/Windows' });
		// Carried through verbatim by the text normalizer, so the SERVER decides.
		expect(normalizeRootPath('/etc')).toBe('/etc');
	});

	it('still REFUSES a home-relative path outright: Cellar never expands "~"', () => {
		expect(() => normalizeRootPath('~/elsewhere')).toThrow(NotebookRootError);
		expect(() => normalizeRootPath('~/elsewhere')).toThrow(/home-relative/i);
	});

	it('classifies a traversal as OUTSIDE, wherever the ".." sits', () => {
		for (const v of ['../outside', 'roots/../../outside', 'roots/pr-482/..']) {
			expect(classifyRootPath(v).kind).toBe('outside');
		}
		// `..` segments are deliberately NOT collapsed here: only the resolver knows
		// the workspace, and `a/../b` and `b` can differ once symlinks are involved.
		expect(normalizeRootPath('../outside')).toBe('../outside');
	});

	it('sameRoot compares MEANING, so re-declaring the same root is a no-op', () => {
		expect(sameRoot('roots/a', './roots/a/')).toBe(true);
		expect(sameRoot(null, '')).toBe(true);
		expect(sameRoot(null, '.')).toBe(true);
		expect(sameRoot('roots/a', 'roots/b')).toBe(false);
		expect(sameRoot('roots/a', null)).toBe(false);
	});
});

describe('resolveRootDir — the filesystem rules', () => {
	it('resolves a real directory inside the workspace to its absolute path', () => {
		expect(rootmod.resolveRootDir('roots/pr-482')).toEqual({
			rel: 'roots/pr-482',
			dir: join(WS, 'roots', 'pr-482'),
			// `apiPath` equals `rel` for an in-workspace root, and `kind` says WHICH
			// admission rule let it through — the workspace guard, untouched.
			apiPath: 'roots/pr-482',
			kind: 'workspace'
		});
	});

	it('folds an outside-SHAPED declaration that lands back inside into the workspace form', () => {
		// `roots/../roots/pr-482` carries a `..`, so the pure half calls it `outside`
		// — but it resolves INSIDE, so it goes through the unchanged guard and is
		// stored in the one canonical spelling. One directory, one declaration.
		expect(rootmod.resolveRootDir('roots/../roots/pr-482')).toMatchObject({
			rel: 'roots/pr-482',
			kind: 'workspace'
		});
		expect(rootmod.resolveRootDir(join(WS, 'roots', 'pr-482'))).toMatchObject({
			rel: 'roots/pr-482',
			kind: 'workspace'
		});
	});

	it('no declaration resolves to null (the workspace — unchanged behavior)', () => {
		expect(rootmod.resolveRootDir(null)).toBeNull();
		expect(rootmod.resolveRootDir('')).toBeNull();
		expect(rootmod.resolveRootDir('.')).toBeNull();
	});

	it('REFUSES a root outside the workspace that is not a registered worktree', async () => {
		// Both spellings of "outside": a traversal, and an absolute path elsewhere.
		// This workspace is not a git repo at all, so the listing is empty and NOTHING
		// outside it is admitted — the message says so instead of the old, now-false
		// "roots live inside the workspace".
		expect(() => rootmod.resolveRootDir('../escape')).toThrow(/not a registered git worktree/i);
		expect(() => rootmod.resolveRootDir(resolve(tmpdir()))).toThrow(/not a registered git worktree/i);
		// The shared guard itself is untouched: it still admits only in-workspace paths.
		const { resolveInWorkspace } = await import('../../src/lib/server/fstree');
		expect(() => resolveInWorkspace('../escape')).toThrow(/escapes workspace/i);
	});

	it('REFUSES a root that does not exist, rather than silently degrading', () => {
		// This is the load-bearing refusal: jupyter_server's `cwd_for_path` walks a
		// missing path UP to root_dir, so accepting it would run the notebook in the
		// workspace while it claimed to run in the root under review.
		expect(() => rootmod.resolveRootDir('roots/never-created')).toThrow(/does not exist/i);
	});

	it('REFUSES a root that is a file, not a directory', () => {
		expect(() => rootmod.resolveRootDir('a-file.txt')).toThrow(/not a directory/i);
	});
});

describe('the declaration on the document', () => {
	let nb: string;
	beforeEach(() => {
		nb = freshNotebook(`decl-${Math.random().toString(36).slice(2, 8)}.ipynb`);
	});

	it('a notebook declares no root by default', () => {
		expect(nbmod.getNotebookRoot(nb)).toBeNull();
		expect(nbmod.getNotebook(nb).root).toBeNull();
		expect(rootmod.notebookRoot(nb)).toBeNull();
	});

	it('setting a root persists it in the cellar namespace and reads back resolved', () => {
		expect(nbmod.setNotebookRoot('./roots/pr-482/', nb)).toBe('roots/pr-482');
		expect(nbmod.getNotebookRoot(nb)).toBe('roots/pr-482');
		expect(nbmod.getNotebook(nb).root).toBe('roots/pr-482');
		expect(rootmod.notebookRoot(nb)).toEqual({
			rel: 'roots/pr-482',
			dir: join(WS, 'roots', 'pr-482'),
			apiPath: 'roots/pr-482',
			kind: 'workspace'
		});
		const onDisk = JSON.parse(readFileSync(nb, 'utf8'));
		expect(onDisk.metadata.cellar.root).toBe('roots/pr-482');
	});

	it('clearing it removes the key entirely (no `root: null` left behind)', () => {
		nbmod.setNotebookRoot('roots/pr-482', nb);
		expect(nbmod.setNotebookRoot('', nb)).toBeNull();
		const onDisk = JSON.parse(readFileSync(nb, 'utf8'));
		expect(onDisk.metadata.cellar ?? {}).not.toHaveProperty('root');
		expect(nbmod.getNotebookRoot(nb)).toBeNull();
	});

	it('ROUND-TRIPS through clean-on-save with zero git diff', () => {
		nbmod.setNotebookRoot('roots/pr-482', nb);
		const first = readFileSync(nb, 'utf8');
		// Re-declaring the same root, and any other mutation, must reproduce the same
		// bytes for the metadata: the namespace survives the clean untouched.
		nbmod.setNotebookRoot('roots/pr-482', nb);
		expect(readFileSync(nb, 'utf8')).toBe(first);
		// A round trip through disk (drop the doc, re-read) preserves it too.
		nbmod.dropDocs(nb);
		expect(nbmod.getNotebookRoot(nb)).toBe('roots/pr-482');
		nbmod.setNotebookRoot('roots/pr-482', nb);
		expect(readFileSync(nb, 'utf8')).toBe(first);
	});

	it('REFUSES to write a root it would then be unable to resolve', async () => {
		// Asserted at the layer that OWNS the rule. Deciding whether an
		// out-of-workspace path is a registered worktree needs git, so the low-level
		// writer (pure text canonicalization) can no longer refuse by shape — the
		// public entry point resolves FIRST, which is what keeps a refusal from ever
		// landing a declaration in the user's `.ipynb`.
		const actions = await import('../../src/lib/server/notebook-root-actions');
		await expect(actions.setNotebookRootAndRestart('../escape', nb)).rejects.toThrow(/not a registered git worktree/i);
		const onDisk = JSON.parse(readFileSync(nb, 'utf8'));
		expect(onDisk.metadata?.cellar ?? {}).not.toHaveProperty('root');
	});

	it('a hand-edited unusable declaration is reported, never read as "no root"', () => {
		// Reading it as null would run the notebook at the workspace root — exactly
		// the checkout it declined. It must reach the resolver and be refused by name.
		const doc = JSON.parse(readFileSync(nb, 'utf8'));
		doc.metadata.cellar = { ...(doc.metadata.cellar ?? {}), root: '/somewhere/else' };
		writeFileSync(nb, JSON.stringify(doc));
		nbmod.dropDocs(nb);
		expect(nbmod.getNotebookRoot(nb)).toBe('/somewhere/else');
		expect(() => rootmod.notebookRoot(nb)).toThrow(/not a registered git worktree/i);
		// This test deliberately poisons a live document, and `listWorkspaceRoots`
		// reads declarations off the LIVE documents — so the poison must not leak into
		// a later test's listing. (It used to be swallowed by the shape refusal.)
		nbmod.setNotebookRoot(null, nb);
	});

	it('emits notebook:root so open tabs follow the change', async () => {
		const events = await import('../../src/lib/server/events');
		const seen: unknown[] = [];
		const off = events.subscribe((e) => {
			if (e.type === 'notebook:root') seen.push(e);
		});
		nbmod.setNotebookRoot('roots/main', nb);
		nbmod.setNotebookRoot(null, nb);
		off();
		expect(seen).toEqual([
			expect.objectContaining({ type: 'notebook:root', nb, root: 'roots/main' }),
			expect.objectContaining({ type: 'notebook:root', nb, root: null })
		]);
	});
});

describe('listWorkspaceRoots', () => {
	it('lists the conventional roots/ directories plus any declared elsewhere', async () => {
		const { listWorkspaceRoots } = await import('../../src/lib/server/notebook-root-actions');
		const nb = freshNotebook('lister.ipynb');
		mkdirSync(join(WS, 'vendor', 'other-tree'), { recursive: true });
		nbmod.setNotebookRoot('vendor/other-tree', nb);
		const roots = await listWorkspaceRoots();
		const byPath = Object.fromEntries(roots.map((r) => [r.path, r]));
		expect(Object.keys(byPath).sort()).toEqual(['roots/main', 'roots/pr-482', 'vendor/other-tree']);
		expect(byPath['roots/pr-482'].declared).toBe(false); // came from the convention
		expect(byPath['vendor/other-tree'].declared).toBe(true); // only from a notebook
		expect(byPath['vendor/other-tree'].notebooks).toEqual([nbmod.workspaceRelative(nb)]);
		expect(byPath['roots/main'].exists).toBe(true);
		nbmod.setNotebookRoot(null, nb);
		rmSync(join(WS, 'vendor'), { recursive: true, force: true });
	});

	it('reports a declared root whose directory is GONE, rather than hiding it', async () => {
		const { listWorkspaceRoots } = await import('../../src/lib/server/notebook-root-actions');
		const nb = freshNotebook('ghost.ipynb');
		mkdirSync(join(WS, 'ghost-tree'), { recursive: true });
		nbmod.setNotebookRoot('ghost-tree', nb);
		rmSync(join(WS, 'ghost-tree'), { recursive: true, force: true });
		const roots = await listWorkspaceRoots();
		const ghost = roots.find((r) => r.path === 'ghost-tree');
		// It is the state a run is about to refuse, so the picker must show it.
		expect(ghost?.exists).toBe(false);
		nbmod.setNotebookRoot(null, nb);
	});

	it('a workspace with no roots/ and no declarations lists nothing', async () => {
		const { listWorkspaceRoots } = await import('../../src/lib/server/notebook-root-actions');
		const bare = mkdtempSync(join(tmpdir(), 'cellar-bare-ws-'));
		const prev = process.env.CELLAR_WORKSPACE;
		process.env.CELLAR_WORKSPACE = bare;
		try {
			expect(await listWorkspaceRoots()).toEqual([]);
		} finally {
			process.env.CELLAR_WORKSPACE = prev;
		}
	});
});
