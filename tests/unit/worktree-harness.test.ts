/**
 * Agent config written into an ADOPTED external worktree.
 *
 * Four rules, each of which was a decision rather than an implementation detail,
 * and each asserted here: adoption-scoped (never on detection), through the
 * EXISTING harness writer, gated on the WORKSPACE's allow-list and on
 * `--no-mcp-config`, and never able to abort a root change.
 *
 * Plus the mitigation that makes writing by default defensible at all: the file
 * is added to the repository's `.git/info/exclude`, so the user's checkout does
 * not show it as an untracked change and it can never be committed onto the
 * branch under review. That is asserted through REAL `git status` and
 * `check-ignore`, because it is a claim about what git does, not about what we
 * wrote — and the `git()` helper runs with a THROWAWAY `HOME` and no global or
 * system config, because a developer's own `~/.config/git/ignore` naming
 * `.mcp.json` makes every one of those assertions pass vacuously. That is exactly
 * how a mitigation written to a location git never reads (a linked worktree's own
 * git dir, which is NOT where `info/exclude` resolves) once shipped looking
 * verified.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let ROOT: string;
let WS: string;
let SIBLING: string;
/** A throwaway HOME, so no global gitignore of the developer's can answer for git. */
let GIT_HOME: string;
/** The repo-COMMON exclude file — where git really reads `info/exclude` from. */
let EXCLUDE: string;
let mod: typeof import('../../src/lib/server/worktree-agent-config');
let uimod: typeof import('../../src/lib/server/ui-state');
let harness: typeof import('../../src/lib/server/harness.js');

/**
 * `git`, ISOLATED FROM THE DEVELOPER'S OWN CONFIG — which is load-bearing here,
 * not hygiene.
 *
 * The exclude assertions below measure what git DOES with an untracked
 * `.mcp.json`, and a global ignore rule for that exact filename is a perfectly
 * ordinary thing to have (the author of this feature had one). Inheriting `HOME`
 * and the global/system config therefore made `git status` empty whether or not
 * anything had been written to `info/exclude` at all — a vacuous pass, and the
 * reason a mitigation that did not work shipped looking verified.
 */
function git(cwd: string, ...args: string[]) {
	return execFileSync('git', ['-C', cwd, ...args], {
		stdio: 'pipe',
		encoding: 'utf8',
		env: {
			...process.env,
			HOME: GIT_HOME,
			XDG_CONFIG_HOME: join(GIT_HOME, '.config'),
			GIT_CONFIG_GLOBAL: '/dev/null',
			GIT_CONFIG_SYSTEM: '/dev/null',
			GIT_AUTHOR_NAME: 'Ada L',
			GIT_AUTHOR_EMAIL: 'ada@example.com',
			GIT_COMMITTER_NAME: 'Ada L',
			GIT_COMMITTER_EMAIL: 'ada@example.com'
		}
	});
}

beforeAll(async () => {
	ROOT = mkdtempSync(join(tmpdir(), 'cellar-wt-harness-'));
	WS = join(ROOT, 'workspace');
	SIBLING = join(ROOT, 'pr-398');
	GIT_HOME = join(ROOT, 'git-home');
	// `info/` is in git's common_list, so this is where git reads the exclude from
	// however many worktrees the repo has — see worktree-agent-config.ts's header.
	EXCLUDE = join(WS, '.git', 'info', 'exclude');
	mkdirSync(join(GIT_HOME, '.config'), { recursive: true });
	mkdirSync(WS, { recursive: true });
	git(WS, 'init', '-q', '-b', 'main');
	writeFileSync(join(WS, 'f.txt'), 'x\n');
	git(WS, 'add', 'f.txt');
	git(WS, 'commit', '-q', '-m', 'init');
	git(WS, 'worktree', 'add', '-q', SIBLING, '-b', 'under-review');

	process.env.CELLAR_WORKSPACE = WS;
	delete process.env.CELLAR_NO_MCP_CONFIG;
	mod = await import('../../src/lib/server/worktree-agent-config');
	uimod = await import('../../src/lib/server/ui-state');
	harness = await import('../../src/lib/server/harness.js');
});

afterAll(() => {
	if (ROOT) rmSync(ROOT, { recursive: true, force: true });
	delete process.env.CELLAR_NO_MCP_CONFIG;
});

beforeEach(() => {
	delete process.env.CELLAR_NO_MCP_CONFIG;
	uimod.setUiState({ [mod.WORKTREE_AGENT_CONFIG_KEY]: null });
	rmSync(join(SIBLING, '.mcp.json'), { force: true });
	if (existsSync(EXCLUDE)) rmSync(EXCLUDE, { force: true });
});

describe('what gets written into an adopted worktree', () => {
	it('writes .mcp.json and NOTHING else, through the existing harness writer', () => {
		const before = git(SIBLING, 'status', '--porcelain', '-uall');
		expect(before.trim()).toBe('');

		const r = mod.configureAdoptedWorktree(SIBLING);
		expect(r?.status).toBe('created');
		expect(r?.file).toBe(join(SIBLING, '.mcp.json'));

		// The content is the harness writer's, unchanged — this module adds no second
		// writer, it only decides WHEN and WHERE.
		const cfg = JSON.parse(readFileSync(join(SIBLING, '.mcp.json'), 'utf8'));
		expect(cfg.mcpServers.cellar).toMatchObject({ command: 'cellar' });
	});

	it('leaves the checkout CLEAN, via the repo-common .git/info/exclude', () => {
		mod.configureAdoptedWorktree(SIBLING);
		// The mitigation that makes on-by-default defensible: git itself must not see
		// the file. Asserted through real `git status` AND `check-ignore`, not by
		// reading back what we appended — the claim is about git's behavior, and the
		// whole defect this replaced was an entry written where git never looks.
		expect(git(SIBLING, 'status', '--porcelain', '-uall').trim()).toBe('');
		expect(git(SIBLING, 'check-ignore', '-v', '.mcp.json')).toContain('info/exclude');
		// WHERE it lands, stated as it really is: `info/` is in git's common_list, so
		// the entry is repo-COMMON, not per-worktree. An entry in the linked worktree's
		// own git dir is read by nothing, and this pins that we do not write one there.
		expect(readFileSync(EXCLUDE, 'utf8')).toContain('.mcp.json');
		expect(existsSync(join(WS, '.git', 'worktrees', 'pr-398', 'info', 'exclude'))).toBe(false);
		// And what the on-by-default decision actually rests on: `.git/` is not in any
		// working tree, so the entry is never a change anywhere and can never be
		// committed onto the branch under review.
		expect(git(WS, 'status', '--porcelain', '-uall')).not.toContain('info/exclude');
	});

	it('is IDEMPOTENT: a second adoption writes zero bytes and adds no duplicate line', () => {
		mod.configureAdoptedWorktree(SIBLING);
		const firstExclude = readFileSync(EXCLUDE, 'utf8');
		const firstConfig = readFileSync(join(SIBLING, '.mcp.json'), 'utf8');

		const again = mod.configureAdoptedWorktree(SIBLING);
		expect(again?.status).toBe('already');
		expect(readFileSync(join(SIBLING, '.mcp.json'), 'utf8')).toBe(firstConfig);
		// The exclude entry is matched on the ENTRY, so re-adopting cannot pile up
		// copies in a file the user can read.
		expect(readFileSync(EXCLUDE, 'utf8')).toBe(firstExclude);
	});

	it('excludes from the MAIN checkout too — the honest scope, not a per-worktree claim', () => {
		// Stated rather than glossed: git has no per-worktree exclude file, so the one
		// entry covers every worktree of this clone AND the main checkout. Pinned so
		// that scope is a decision someone has to revisit deliberately, and so the
		// copy in Settings and the module header can be trusted against it.
		mod.configureAdoptedWorktree(SIBLING);
		writeFileSync(join(WS, '.mcp.json'), '{}\n');
		try {
			expect(git(WS, 'status', '--porcelain', '-uall').trim()).toBe('');
		} finally {
			rmSync(join(WS, '.mcp.json'), { force: true });
		}
	});
});

describe('when it must NOT write', () => {
	it('writes nothing when the setting is OFF', () => {
		uimod.setUiState({ [mod.WORKTREE_AGENT_CONFIG_KEY]: false });
		expect(mod.configureAdoptedWorktree(SIBLING)).toBeUndefined();
		expect(existsSync(join(SIBLING, '.mcp.json'))).toBe(false);
	});

	it('writes nothing under --no-mcp-config, and SAYS so', () => {
		// A launch that deliberately writes no `.mcp.json` into the workspace must not
		// write one into a worktree either.
		process.env.CELLAR_NO_MCP_CONFIG = '1';
		const r = mod.configureAdoptedWorktree(SIBLING);
		expect(existsSync(join(SIBLING, '.mcp.json'))).toBe(false);
		expect(r?.status).toBe('skipped');
		expect(r?.message).toMatch(/--no-mcp-config/);
	});

	it('writes nothing for a harness the WORKSPACE does not allow', () => {
		// The workspace is where the user answered the harness question; a worktree
		// has no independent answer and cannot be prompted for one.
		harness.disallowHarness('claude', WS);
		try {
			expect(mod.configureAdoptedWorktree(SIBLING)).toBeUndefined();
			expect(existsSync(join(SIBLING, '.mcp.json'))).toBe(false);
		} finally {
			harness.allowHarness('claude', WS);
		}
	});

	it('is DEFAULT ON: an unset preference writes, and junk in the store still writes', () => {
		// Only an explicit `false` disables it, so a store holding an unexpected value
		// behaves as the documented default rather than silently opting out.
		uimod.setUiState({ [mod.WORKTREE_AGENT_CONFIG_KEY]: null });
		expect(mod.configureAdoptedWorktree(SIBLING)?.status).toBe('created');
		rmSync(join(SIBLING, '.mcp.json'), { force: true });
		uimod.setUiState({ [mod.WORKTREE_AGENT_CONFIG_KEY]: 'yes please' });
		expect(mod.configureAdoptedWorktree(SIBLING)?.status).toBe('created');
	});
});

describe('failure is REPORTED, never thrown', () => {
	it('reports an unwritable worktree instead of aborting the root change', () => {
		// Agent wiring is a convenience; the root change is the user's actual request.
		// A read-only mount or an EACCES must not fail it.
		const ro = join(ROOT, 'read-only');
		mkdirSync(ro, { recursive: true });
		chmodSync(ro, 0o500);
		try {
			const r = mod.configureAdoptedWorktree(ro);
			// Whatever it answers, it must ANSWER — the absence of a throw is the test.
			expect(r === undefined || typeof r.status === 'string').toBe(true);
			expect(existsSync(join(ro, '.mcp.json'))).toBe(false);
		} finally {
			chmodSync(ro, 0o700);
		}
	});

	it('says so when the exclude could not be arranged, rather than implying a clean checkout', () => {
		// A plain directory that is not a git worktree at all: the config can still be
		// written, but nothing can ignore it, and the result must not let the user
		// believe their checkout stays clean.
		const plain = join(ROOT, 'plain-dir');
		mkdirSync(plain, { recursive: true });
		const r = mod.configureAdoptedWorktree(plain);
		expect(r?.status).toBe('created');
		expect(r?.message).toMatch(/untracked/i);
		rmSync(plain, { recursive: true, force: true });
	});
});

describe('adoption-scoped: DETECTION never writes, ADOPTION does', () => {
	it('listing the workspace’s roots writes into no worktree', async () => {
		// Detection happens whenever a picker opens or an agent calls `list_roots`, so
		// writing there would drop untracked files into every checkout of the repo as
		// the side effect of a READ.
		const actions = await import('../../src/lib/server/notebook-root-actions');
		const gitmod = await import('../../src/lib/server/git');
		gitmod.invalidateGitCaches();

		const roots = await actions.listWorkspaceRoots();
		expect(roots.some((r) => r.external)).toBe(true);
		expect(existsSync(join(SIBLING, '.mcp.json'))).toBe(false);
	});

	it('SETTING a notebook’s root to the worktree writes it, and reports it', async () => {
		const actions = await import('../../src/lib/server/notebook-root-actions');
		const nbmod = await import('../../src/lib/server/notebook');
		const gitmod = await import('../../src/lib/server/git');
		gitmod.invalidateGitCaches();

		const nb = nbmod.createNotebook('adopter.ipynb').path;
		const res = await actions.setNotebookRootAndRestart('../pr-398', nb);
		expect(res.root).toBe('../pr-398');
		// Reported on the result, so both the REST route and the MCP tool surface it
		// without a second channel.
		expect(res.agent_config).toMatchObject({ status: 'created' });
		expect(existsSync(join(SIBLING, '.mcp.json'))).toBe(true);
		// …and the checkout it was written into is still clean.
		expect(git(SIBLING, 'status', '--porcelain', '-uall').trim()).toBe('');

		await actions.setNotebookRootAndRestart(null, nb);
	});

	it('an INTERNAL root carries no agent_config field at all', async () => {
		// An ordinary `roots/…` root is unchanged: the worktree write is for the
		// checkout the user did not open, and nothing else.
		const actions = await import('../../src/lib/server/notebook-root-actions');
		const nbmod = await import('../../src/lib/server/notebook');
		mkdirSync(join(WS, 'roots', 'plain'), { recursive: true });
		const nb = nbmod.createNotebook('internal.ipynb').path;
		const res = await actions.setNotebookRootAndRestart('roots/plain', nb);
		expect(res.root).toBe('roots/plain');
		expect(res.agent_config).toBeUndefined();
		expect(existsSync(join(WS, 'roots', 'plain', '.mcp.json'))).toBe(false);
		await actions.setNotebookRootAndRestart(null, nb);
	});

	it('a REFUSED root writes nothing: the resolve runs first', async () => {
		const actions = await import('../../src/lib/server/notebook-root-actions');
		const nbmod = await import('../../src/lib/server/notebook');
		const stranger = join(ROOT, 'stranger');
		mkdirSync(stranger, { recursive: true });
		const nb = nbmod.createNotebook('refused.ipynb').path;
		await expect(actions.setNotebookRootAndRestart(stranger, nb)).rejects.toThrow(/not a registered git worktree/i);
		expect(existsSync(join(stranger, '.mcp.json'))).toBe(false);
	});
});
