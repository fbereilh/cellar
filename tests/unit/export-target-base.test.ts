/**
 * Export-target BASES: the (path, base) pair behind the notebook's export
 * section.
 *
 * The contract under test, in the order the brief cares about it:
 *
 *  1. BACKWARD COMPATIBILITY IS PERMANENT. A notebook written before bases
 *     existed stores only `metadata.cellar.export_target`, and the ABSENCE of
 *     `export_base` must forever mean workspace-relative - resolved to the
 *     identical file, with no migration and no metadata rewrite on open or on
 *     save. The legacy-pin test drives a hand-written on-disk artifact (the
 *     exact bytes a pre-base notebook holds) through the real doc layer and
 *     asserts both the resolution AND that the file never grows a base key.
 *  2. A base changes how the path is EXPRESSED, never what may be written:
 *     every base resolves through the same workspace containment guard.
 *  3. Switching bases RE-EXPRESSES the same file (never reinterprets the typed
 *     text against the new base), and `workspace` is spelled by DELETING the
 *     key, so a round trip back to workspace restores the legacy shape.
 *  4. Unknown/unresolvable states fail closed and by name: an unknown stored
 *     base, a `git` base with no enclosing repository, an escape - none of
 *     them silently degrade to workspace-relative.
 *
 * The suite builds a REAL git repo whose workspace is a SUBDIRECTORY of it
 * (`cd repo/analysis && cellar`), because that is the case where the three
 * bases genuinely disagree: the git root sits ABOVE the workspace, so a
 * git-relative spelling must reach back down inside it.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let PARENT: string; // the enclosing git repo
let WS: string; // the workspace = PARENT/analysis
let NOREPO: string; // a directory with no repository anywhere above it
let WT: string; // a linked worktree (its .git is a pointer FILE)

let nbmod: typeof import('../../src/lib/server/notebook');
let expy: typeof import('../../src/lib/server/export-py');
let gitmod: typeof import('../../src/lib/server/git');
let events: typeof import('../../src/lib/server/events');
let exportTargetLib: typeof import('../../src/lib/exportTarget');

function git(cwd: string, ...args: string[]) {
	execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, stdio: 'pipe' });
}

beforeAll(async () => {
	PARENT = mkdtempSync(join(tmpdir(), 'cellar-export-base-repo-'));
	git(PARENT, 'init', '-q', '-b', 'main');
	writeFileSync(join(PARENT, 'seed.txt'), 'seed\n');
	git(PARENT, 'add', 'seed.txt');
	git(PARENT, 'commit', '-q', '-m', 'seed');
	WS = join(PARENT, 'analysis');
	mkdirSync(WS);
	mkdirSync(join(WS, 'sub'));
	NOREPO = mkdtempSync(join(tmpdir(), 'cellar-export-base-norepo-'));
	WT = join(mkdtempSync(join(tmpdir(), 'cellar-export-base-wtpool-')), 'wt');
	git(PARENT, 'worktree', 'add', '-q', '-b', 'wt-branch', WT, 'main');

	process.env.CELLAR_WORKSPACE = WS;
	nbmod = await import('../../src/lib/server/notebook');
	expy = await import('../../src/lib/server/export-py');
	gitmod = await import('../../src/lib/server/git');
	events = await import('../../src/lib/server/events');
	exportTargetLib = await import('../../src/lib/exportTarget');
});

// A minimal on-disk .ipynb, written BY HAND so the doc layer meets exactly the
// artifact an older Cellar (or another tool) produced - never one this build's
// own setter shaped.
function writeIpynb(relPath: string, nbCellar: Record<string, unknown>, cellCellar?: Record<string, unknown>) {
	const abs = join(WS, relPath);
	const nb = {
		cells: [
			{
				id: 'aaaa1111',
				cell_type: 'code',
				source: ['def marked():\n', '    return 1'],
				metadata: cellCellar ? { cellar: cellCellar } : {},
				outputs: [],
				execution_count: null
			}
		],
		metadata: { cellar: nbCellar },
		nbformat: 4,
		nbformat_minor: 5
	};
	writeFileSync(abs, JSON.stringify(nb));
	return abs;
}

function diskCellar(absPath: string): Record<string, unknown> {
	return JSON.parse(readFileSync(absPath, 'utf8')).metadata?.cellar ?? {};
}

describe('gitRootOf', () => {
	it('finds the enclosing repo root from a nested subdirectory', () => {
		const deep = join(WS, 'sub');
		expect(gitmod.gitRootOf(deep)).toBe(PARENT);
		expect(gitmod.gitRootOf(PARENT)).toBe(PARENT);
	});

	it('treats a linked worktree (a .git pointer FILE) as a root of its own', () => {
		expect(gitmod.gitRootOf(WT)).toBe(WT);
		const inner = join(WT, 'inner');
		mkdirSync(inner, { recursive: true });
		expect(gitmod.gitRootOf(inner)).toBe(WT);
	});

	it('answers null outside any repository - a first-class state, never a throw', () => {
		expect(gitmod.gitRootOf(NOREPO)).toBeNull();
	});
});

describe('the legacy pin: an absent base permanently means workspace-relative', () => {
	it('a pre-base notebook resolves to the identical file, and no save ever mints a base key', () => {
		const abs = writeIpynb('legacy.ipynb', { export_target: 'lib/legacy_mod.py' });

		// Resolution is byte-for-byte the legacy semantics: the stored form IS the
		// workspace-relative target.
		const info = nbmod.exportTargetInfo('legacy.ipynb');
		expect(info).toMatchObject({
			ok: true,
			base: 'workspace',
			path: 'lib/legacy_mod.py',
			target: 'lib/legacy_mod.py',
			source: 'metadata'
		});
		expect(info && info.ok ? info.abs : null).toBe(join(WS, 'lib/legacy_mod.py'));

		// Loading did not rewrite the artifact (loading never writes at all).
		expect(diskCellar(abs)).toEqual({ export_target: 'lib/legacy_mod.py' });

		// Marking a cell persists the doc AND regenerates the module at the legacy
		// location - and the persisted metadata still carries NO base key: the
		// absent-key spelling survives every ordinary save.
		mkdirSync(join(WS, 'lib'), { recursive: true });
		const changed = nbmod.setCellExports(['aaaa1111'], true, 'legacy.ipynb');
		expect(changed).toEqual(['aaaa1111']);
		const module = join(WS, 'lib/legacy_mod.py');
		expect(existsSync(module)).toBe(true);
		expect(readFileSync(module, 'utf8')).toContain('def marked():');
		const cellar = diskCellar(abs);
		expect(cellar.export_target).toBe('lib/legacy_mod.py');
		expect('export_base' in cellar).toBe(false);
	});

	it('an explicit workspace base is stored as the SAME absent-key legacy shape', () => {
		const nb = nbmod.createNotebook('explicit-ws.ipynb').path;
		const state = nbmod.setExportTarget('lib/explicit.py', nb, undefined, 'workspace');
		expect(state).toEqual({
			target: 'lib/explicit.py',
			base: 'workspace',
			resolved: 'lib/explicit.py',
			resolveError: null
		});
		const cellar = diskCellar(nb);
		expect(cellar.export_target).toBe('lib/explicit.py');
		expect('export_base' in cellar).toBe(false);
	});
});

describe('the notebook base', () => {
	it('stores relative to the notebook folder and resolves back workspace-relative', () => {
		const nb = nbmod.createNotebook('sub/nb-rel.ipynb').path;
		const state = nbmod.setExportTarget('helpers.py', nb, undefined, 'notebook');
		expect(state).toEqual({
			target: 'helpers.py',
			base: 'notebook',
			resolved: 'sub/helpers.py',
			resolveError: null
		});
		expect(diskCellar(nb)).toMatchObject({ export_target: 'helpers.py', export_base: 'notebook' });

		// The notebook VIEW carries the same three facts, so the UI cannot drift.
		const view = nbmod.getNotebook(nb);
		expect(view.exportTarget).toBe('helpers.py');
		expect(view.exportBase).toBe('notebook');
		expect(view.exportResolved).toBe('sub/helpers.py');
		expect(view.exportResolveError).toBeNull();
	});

	it('normalizes a pasted absolute path into the base-relative stored form', () => {
		const nb = nbmod.createNotebook('sub/nb-abs.ipynb').path;
		const state = nbmod.setExportTarget(join(WS, 'sub', 'pasted.py'), nb, undefined, 'notebook');
		expect(state.target).toBe('pasted.py');
		expect(state.resolved).toBe('sub/pasted.py');
	});

	it('refuses an escape, naming the base it was measured from', () => {
		const nb = nbmod.createNotebook('sub/nb-esc.ipynb').path;
		expect(() => nbmod.setExportTarget('../../outside.py', nb, undefined, 'notebook')).toThrow(
			/relative to the notebook's folder.*outside the workspace/
		);
		// Nothing was stored by the refusal.
		expect(diskCellar(nb).export_target).toBeUndefined();
	});
});

describe('the git base', () => {
	it('measures from the repo enclosing the notebook - which may sit ABOVE the workspace', () => {
		const nb = nbmod.createNotebook('nb-git.ipynb').path;
		const state = nbmod.setExportTarget('analysis/lib/gitmod.py', nb, undefined, 'git');
		expect(state).toEqual({
			target: 'analysis/lib/gitmod.py',
			base: 'git',
			resolved: 'lib/gitmod.py',
			resolveError: null
		});
		expect(diskCellar(nb)).toMatchObject({
			export_target: 'analysis/lib/gitmod.py',
			export_base: 'git'
		});
	});

	it('containment still decides: a git-relative path landing outside the workspace is refused', () => {
		const nb = nbmod.createNotebook('nb-git-esc.ipynb').path;
		// PARENT/other/x.py is inside the REPO but outside the workspace.
		expect(() => nbmod.setExportTarget('other/x.py', nb, undefined, 'git')).toThrow(
			/relative to the notebook's git root.*outside the workspace/
		);
	});

	it('a notebook with no enclosing repository refuses the git base by name', () => {
		// Resolution side (a hand-edited artifact met on open) - pure, over a doc
		// whose path lives outside any repo.
		const doc = {
			path: join(NOREPO, 'n.ipynb'),
			cells: [],
			metadata: { cellar: { export_target: 'x.py', export_base: 'git' } }
		};
		const info = expy.resolveExportTarget(doc as never);
		expect(info).toMatchObject({ ok: false, base: 'git', path: 'x.py' });
		expect(info && !info.ok ? info.error : '').toMatch(/not inside a git repository/);
	});
});

describe('failing closed', () => {
	it('an unknown stored base is refused by the resolver, never read as workspace', () => {
		const doc = {
			path: join(WS, 'weird.ipynb'),
			cells: [],
			metadata: { cellar: { export_target: 'x.py', export_base: 'weird' } }
		};
		const info = expy.resolveExportTarget(doc as never);
		expect(info).toMatchObject({ ok: false, base: 'weird', path: 'x.py' });
		expect(info && !info.ok ? info.error : '').toMatch(/unknown export base "weird"/);
	});

	it('the exporter refuses an unresolvable target outright once a cell is marked', () => {
		const doc = {
			path: join(WS, 'weird2.ipynb'),
			cells: [
				{ id: 'c1', cell_type: 'code', source: 'X = 1', metadata: { cellar: { export: true } } }
			],
			metadata: { cellar: { export_target: 'x.py', export_base: 'weird' } }
		};
		expect(() => expy.exportNotebookToPy(doc as never)).toThrow(/unknown export base/);
	});

	it('an unresolvable target with NOTHING marked stays the no-cells no-op (a save must survive it)', () => {
		const doc = {
			path: join(WS, 'weird3.ipynb'),
			cells: [{ id: 'c1', cell_type: 'code', source: 'X = 1', metadata: {} }],
			metadata: { cellar: { export_target: 'x.py', export_base: 'weird' } }
		};
		expect(expy.exportNotebookToPy(doc as never)).toMatchObject({ written: false, reason: 'no-cells' });
	});

	it('the setter refuses an unknown base with a typed error', () => {
		const nb = nbmod.createNotebook('nb-badbase.ipynb').path;
		expect(() => nbmod.setExportTarget('x.py', nb, undefined, 'weird')).toThrow(
			/unknown export base "weird"/
		);
	});

	it('a #|default_exp directive keeps its own workspace semantics whatever base is stored', () => {
		// The base is a fact about the STORED target; a directive lives in a cell
		// and resolves by nbdev's rule. A stray `export_base` beside it (a
		// hand-edit) must not bend the directive.
		const doc = {
			path: join(WS, 'directive.ipynb'),
			cells: [{ id: 'c1', cell_type: 'code', source: '#|default_exp pkg.mod\nX = 1', metadata: {} }],
			metadata: { cellar: { export_base: 'notebook' } }
		};
		const info = expy.resolveExportTarget(doc as never);
		expect(info).toMatchObject({
			ok: true,
			base: 'workspace',
			source: 'default_exp',
			target: 'pkg/mod.py'
		});
	});
});

describe('re-expressing with setExportBase', () => {
	it('switching bases re-expresses the SAME file; workspace restores the legacy key shape', async () => {
		const nb = nbmod.createNotebook('sub/nb-switch.ipynb').path;
		nbmod.setExportTarget('helpers2.py', nb, undefined, 'notebook');

		const seen: unknown[] = [];
		const un = events.subscribe((ev) => {
			if ((ev as { type?: string }).type === 'notebook:export-target') seen.push(ev);
		});
		try {
			// notebook -> git: same file, git-root spelling.
			const toGit = nbmod.setExportBase('git', nb);
			expect(toGit).toEqual({
				target: 'analysis/sub/helpers2.py',
				base: 'git',
				resolved: 'sub/helpers2.py',
				resolveError: null
			});
			expect(diskCellar(nb)).toMatchObject({
				export_target: 'analysis/sub/helpers2.py',
				export_base: 'git'
			});

			// git -> workspace: same file, and the base key is DELETED (the legacy
			// spelling of the default, so the round trip ends in the legacy shape).
			const toWs = nbmod.setExportBase('workspace', nb);
			expect(toWs).toEqual({
				target: 'sub/helpers2.py',
				base: 'workspace',
				resolved: 'sub/helpers2.py',
				resolveError: null
			});
			const cellar = diskCellar(nb);
			expect(cellar.export_target).toBe('sub/helpers2.py');
			expect('export_base' in cellar).toBe(false);

			// Both switches announced themselves (the SSE event carries the full state).
			expect(seen.length).toBe(2);
			expect(seen[1]).toMatchObject({ base: 'workspace', resolved: 'sub/helpers2.py' });
		} finally {
			un();
		}
	});

	it('re-picking the current base is a no-op (no persist, no event)', () => {
		const nb = nbmod.createNotebook('sub/nb-noop.ipynb').path;
		nbmod.setExportTarget('h3.py', nb, undefined, 'notebook');
		const before = readFileSync(nb, 'utf8');
		const seen: unknown[] = [];
		const un = events.subscribe((ev) => {
			if ((ev as { type?: string }).type === 'notebook:export-target') seen.push(ev);
		});
		try {
			const state = nbmod.setExportBase('notebook', nb);
			expect(state.target).toBe('h3.py');
			expect(readFileSync(nb, 'utf8')).toBe(before);
			expect(seen.length).toBe(0);
		} finally {
			un();
		}
	});

	it('with no stored target there is nothing to re-express: an honest no-op, nothing minted', () => {
		const nb = nbmod.createNotebook('nb-notarget.ipynb').path;
		const before = readFileSync(nb, 'utf8');
		const state = nbmod.setExportBase('notebook', nb);
		expect(state).toEqual({ target: null, base: 'workspace', resolved: null, resolveError: null });
		expect(readFileSync(nb, 'utf8')).toBe(before);
	});

	it('clearing the target clears the base with it', () => {
		const nb = nbmod.createNotebook('nb-clear.ipynb').path;
		nbmod.setExportTarget('analysis-clear.py', nb, undefined, 'notebook');
		expect(diskCellar(nb).export_base).toBe('notebook');
		const state = nbmod.setExportTarget(null, nb);
		expect(state).toEqual({ target: null, base: 'workspace', resolved: null, resolveError: null });
		const cellar = diskCellar(nb);
		expect('export_target' in cellar).toBe(false);
		expect('export_base' in cellar).toBe(false);
	});
});

describe('clearing is the universal repair (an unresolvable base is never a dead end)', () => {
	// The tab keeps NO copy of server state: it seeds its base select from the
	// stored value and sends that value back with every path commit. So a notebook
	// carrying a base nothing can resolve - a hand edit, or a `git` base whose
	// repository has gone - is only repairable if CLEARING is exempt from base
	// validation: re-expression cannot help (the file cannot be located) and
	// retyping the path under the stored base is refused, so a refused clear leaves
	// a target silently generating no module on every save with no in-app way out.
	it('clears a target stored under an UNKNOWN hand-edited base, deleting both keys', () => {
		const abs = writeIpynb('repair-unknown.ipynb', { export_target: 'x.py', export_base: 'weird' });
		// The state the user is stuck in: configured, shown, and unresolvable.
		expect(nbmod.exportTargetInfo('repair-unknown.ipynb')).toMatchObject({ ok: false, base: 'weird' });

		// The tab's own commit shape - the HELD base rides back with the clear.
		const state = nbmod.setExportTarget('', 'repair-unknown.ipynb', undefined, 'weird');
		expect(state).toEqual({ target: null, base: 'workspace', resolved: null, resolveError: null });
		const cellar = diskCellar(abs);
		expect('export_target' in cellar).toBe(false);
		expect('export_base' in cellar).toBe(false);

		// ...and the notebook is usable again immediately afterwards.
		expect(nbmod.setExportTarget('lib/repaired.py', 'repair-unknown.ipynb').target).toBe('lib/repaired.py');
	});

	it('a null clear works the same way, whatever base the caller names', () => {
		const abs = writeIpynb('repair-null.ipynb', { export_target: 'x.py', export_base: 'weird' });
		expect(nbmod.setExportTarget(null, 'repair-null.ipynb', undefined, 'weird').target).toBeNull();
		expect(diskCellar(abs)).toEqual({});
	});

	it('an unknown base is still refused for a real STORE, and never coerced to workspace', () => {
		const nb = nbmod.createNotebook('repair-store.ipynb').path;
		expect(() => nbmod.setExportTarget('x.py', nb, undefined, 'weird')).toThrow(
			nbmod.InvalidExportTargetError
		);
		expect(diskCellar(nb).export_target).toBeUndefined();
		expect(diskCellar(nb).export_base).toBeUndefined();
	});

	it('both remaining refusals on that path NAME clearing as the repair', () => {
		writeIpynb('repair-messages.ipynb', { export_target: 'x.py', export_base: 'weird' });
		// Retyping the path (the tab sends the stored base back with every commit).
		expect(() => nbmod.setExportTarget('y.py', 'repair-messages.ipynb', undefined, 'weird')).toThrow(
			/clear the export target/
		);
		// Switching base: re-expression is impossible here, so the message must point
		// at the clear - not at setting the path again, which is what fails above.
		expect(() => nbmod.setExportBase('workspace', 'repair-messages.ipynb')).toThrow(
			/clear the export target/
		);
	});
});

describe('exportImportWarning (the importability rule)', () => {
	it('is silent with no code root, or with the module under the root', () => {
		const { exportImportWarning } = exportTargetLib;
		expect(exportImportWarning(null, 'roots/pr1')).toBeNull();
		expect(exportImportWarning('lib/x.py', null)).toBeNull();
		expect(exportImportWarning('roots/pr1/lib/x.py', 'roots/pr1')).toBeNull();
	});

	it('warns when the module lands outside the declared root - external roots included', () => {
		const { exportImportWarning } = exportTargetLib;
		expect(exportImportWarning('lib/x.py', 'roots/pr1')).toMatch(/cannot import/);
		// An external worktree root can never contain a workspace file.
		expect(exportImportWarning('lib/x.py', '../wt')).toMatch(/cannot import/);
		expect(exportImportWarning('lib/x.py', '..')).toMatch(/cannot import/);
	});

	it('respects the path-segment boundary (pr10 is not under pr1)', () => {
		const { exportImportWarning } = exportTargetLib;
		expect(exportImportWarning('roots/pr10/x.py', 'roots/pr1')).toMatch(/cannot import/);
	});

	it('asks the one root-shape owner, so a canonicalizable declaration still matches', () => {
		const { exportImportWarning } = exportTargetLib;
		// `classifyRootPath` unifies separators and drops `.` segments, so these are
		// the SAME root as `roots/pr1` and must not warn.
		expect(exportImportWarning('roots/pr1/lib/x.py', './roots/pr1')).toBeNull();
		expect(exportImportWarning('roots/pr1/lib/x.py', 'roots/pr1/')).toBeNull();
		// `.` IS the workspace root, i.e. no declaration at all.
		expect(exportImportWarning('lib/x.py', '.')).toBeNull();
	});

	it('never throws on a declaration the shape owner REFUSES, and warns instead', () => {
		const { exportImportWarning } = exportTargetLib;
		// A hand-edited `~` root reaches the browser verbatim (`readRoot` returns an
		// unnormalizable value as-is) and this runs inside a render-time $derived, which
		// mounts no error boundary - so a throw here would blank the whole notebook.
		expect(() => exportImportWarning('lib/x.py', '~/elsewhere')).not.toThrow();
		expect(exportImportWarning('lib/x.py', '~/elsewhere')).toMatch(/cannot import/);
	});
});
