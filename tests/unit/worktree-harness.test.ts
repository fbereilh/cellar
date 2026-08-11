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
import { agentConfigNotice } from '../../src/lib/notebookRoot';

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
	// `.cellar/` is runtime state Cellar gitignores in every real project (the harness
	// allow-list this suite writes lives there). Committed BEFORE the worktree is added
	// so both checkouts carry it — without it the clean-checkout assertions below hold
	// or not depending on which test last touched the allow-list.
	writeFileSync(join(WS, '.gitignore'), '.cellar/\n');
	git(WS, 'add', 'f.txt', '.gitignore');
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
		// writer, it only decides WHEN and WHERE (and, per rule 5, WITH WHICH ARGS).
		const cfg = JSON.parse(readFileSync(join(SIBLING, '.mcp.json'), 'utf8'));
		expect(cfg.mcpServers.cellar).toMatchObject({ command: 'cellar' });
	});

	it('NAMES THE INSTANCE: the worktree entry carries --workspace, the workspace’s does not', () => {
		// The whole point of writing at all. `cellar mcp` reads `<cwd>/.cellar/runtime.json`
		// and does NOT walk up, so the canonical bare `["mcp"]` entry — correct at the root
		// of the workspace Cellar runs in — is INERT in a worktree: the agent's cwd is the
		// worktree, no instance is running there, and the bridge exits 1. Cellar would have
		// dropped a file into a checkout the user did not open, added a repo-common ignore
		// rule for it, and left the agent with no Cellar tools.
		mod.configureAdoptedWorktree(SIBLING);
		const wt = JSON.parse(readFileSync(join(SIBLING, '.mcp.json'), 'utf8'));
		expect(wt.mcpServers.cellar.args).toEqual(['mcp', '--workspace', WS]);

		// …and the OTHER direction, which is what keeps today's zero-config behavior
		// byte-identical: the workspace's own config still gets the bare canonical entry,
		// because there `cellar mcp` resolves the instance from the cwd already.
		try {
			expect(harness.configureHarness('claude', WS).status).toBe('wrote');
			const own = JSON.parse(readFileSync(join(WS, '.mcp.json'), 'utf8'));
			expect(own.mcpServers.cellar.args).toEqual(['mcp']);
		} finally {
			rmSync(join(WS, '.mcp.json'), { force: true });
		}
	});

	it('the selector reaches EVERY harness format, not just JSON', () => {
		// A `.codex/config.toml` written without it is inert in exactly the same way, so
		// the override has to be a property of the writer rather than of one format.
		harness.allowHarness('codex', WS);
		try {
			mod.configureAdoptedWorktree(SIBLING);
			const toml = readFileSync(join(SIBLING, '.codex', 'config.toml'), 'utf8');
			expect(toml).toContain(`args = ["mcp", "--workspace", ${JSON.stringify(WS)}]`);
			// And a re-adoption is still idempotent against those args, not against the
			// canonical ones — else every launch would rewrite the file.
			expect(mod.configureAdoptedWorktree(SIBLING)?.status).toBe('already');
		} finally {
			harness.disallowHarness('codex', WS);
			harness.allowHarness('claude', WS);
			rmSync(join(SIBLING, '.codex'), { recursive: true, force: true });
		}
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

	it('is ANCHORED to the working-tree root: a NESTED .mcp.json stays visible', () => {
		// The other half of that scope, and the half a root-only assertion cannot see:
		// a gitignore pattern with no slash matches at ANY DEPTH, so an unanchored
		// entry in the repo-COMMON exclude made every untracked `.mcp.json` anywhere in
		// the clone invisible to `git status` and unaddable by `git add` — wider, and a
		// worse surprise, than the dirty checkout this mitigation removes.
		mod.configureAdoptedWorktree(SIBLING);
		const nested = join(SIBLING, 'sub', 'deeper');
		mkdirSync(nested, { recursive: true });
		writeFileSync(join(nested, '.mcp.json'), '{}\n');
		try {
			// Asserted through git itself, in BOTH directions at once, and BEFORE the
			// pattern is read back — the claim is about what git does, and an assertion
			// on the written text alone would pass any spelling that happened to look
			// anchored.
			expect(git(SIBLING, 'check-ignore', '-v', '.mcp.json')).toContain('info/exclude');
			expect(() => git(SIBLING, 'check-ignore', '-q', 'sub/deeper/.mcp.json')).toThrow();
			expect(git(SIBLING, 'status', '--porcelain', '-uall')).toContain('sub/deeper/.mcp.json');
		} finally {
			rmSync(join(SIBLING, 'sub'), { recursive: true, force: true });
		}
		expect(readFileSync(EXCLUDE, 'utf8')).toContain('/.mcp.json');
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

	it('does NOT blame --no-mcp-config when the allow-list was empty anyway', () => {
		// `cellar harness remove claude` leaves an explicitly EMPTY allow-list, so
		// nothing would have been written whatever the flag said - and this message
		// rides `agentConfigNotice` onto the root bar and the sidebar, where naming a
		// cause that did not happen is worse than saying nothing at all.
		harness.disallowHarness('claude', WS);
		process.env.CELLAR_NO_MCP_CONFIG = '1';
		try {
			expect(mod.configureAdoptedWorktree(SIBLING)).toBeUndefined();
			expect(existsSync(join(SIBLING, '.mcp.json'))).toBe(false);
		} finally {
			harness.allowHarness('claude', WS);
		}
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
		// Asserted through the SHARED notice, i.e. the sentence a human is really
		// shown, not merely through a field one of the two surfaces might read.
		expect(agentConfigNotice(r)).toMatch(/untracked/i);
		// And it names the file that is untracked, so with several harnesses it can
		// never point at the one that WAS excluded.
		expect(agentConfigNotice(r)).toContain('.mcp.json');
		rmSync(plain, { recursive: true, force: true });
	});

	it('keeps saying so on a RE-adoption, where the config is already correct', () => {
		// The state that must never be silent is "this checkout is dirty", which is a
		// fact about what is ON DISK — not about whether THIS call wrote it. Gated on
		// created/updated it was said exactly once, so a re-adoption (the `already`
		// path: a retry after a failed first attempt, or the entry deleted by hand)
		// reported nothing at all while `?? .mcp.json` really was there.
		const plain = join(ROOT, 'plain-again');
		mkdirSync(plain, { recursive: true });
		try {
			expect(mod.configureAdoptedWorktree(plain)?.status).toBe('created');
			const again = mod.configureAdoptedWorktree(plain);
			expect(again?.status).toBe('already');
			expect(agentConfigNotice(again)).toMatch(/untracked/i);
		} finally {
			rmSync(plain, { recursive: true, force: true });
		}
	});

	it('says NOTHING on an ordinary success — the notice reads the STATUS, not the message', () => {
		// `configureHarness` sets a message on every outcome it reports ("added the
		// cellar MCP server", "already configured"), so a notice gated on the message
		// being present appended a note to EVERY adoption — and buried the one case
		// this mechanism exists to surface in that chatter.
		const r = mod.configureAdoptedWorktree(SIBLING);
		expect(r?.status).toBe('created');
		expect(r?.message).toBeTruthy();
		expect(agentConfigNotice(r)).toBeNull();

		const again = mod.configureAdoptedWorktree(SIBLING);
		expect(again?.status).toBe('already');
		expect(agentConfigNotice(again)).toBeNull();
		rmSync(join(SIBLING, '.mcp.json'), { force: true });
	});

	it('with TWO harnesses, the summary claims only what happened and names each file', () => {
		// The aggregate used to be the FIRST written result plus `N harnesses
		// configured`: it claimed both were configured when one was refused, discarded
		// the refusal's reason — the actionable part — and, since the exclude verdict
		// was a single AND over both, named the file that WAS excluded as the untracked
		// one. In a module whose header is about not asserting more than was verified,
		// that is the honesty rule failing at the summary step.
		harness.allowHarness('codex', WS);
		// A plain directory, so nothing can ignore either file — both earn a warning,
		// and each must name its OWN file.
		const plain = join(ROOT, 'two-harnesses');
		mkdirSync(plain, { recursive: true });
		// `.codex` as a FILE: the writer refuses what it cannot edit confidently, which
		// is the `skipped` this must not summarise away.
		writeFileSync(join(plain, '.codex'), 'not a directory\n');
		try {
			const r = mod.configureAdoptedWorktree(plain);
			expect(r?.status).toBe('created');
			expect(existsSync(join(plain, '.mcp.json'))).toBe(true);

			const note = agentConfigNotice(r) ?? '';
			expect(note).not.toMatch(/\d+ harnesses configured/);
			// The refused harness is named, with its own reason…
			expect(note).toMatch(/codex/);
			// …and the untracked-file warning names the file it is about, so it can never
			// report the wrong one.
			expect(note).toContain('.mcp.json');
		} finally {
			harness.disallowHarness('codex', WS);
			harness.allowHarness('claude', WS);
			rmSync(plain, { recursive: true, force: true });
		}
	});

	it('TAKES THE EXCLUDE BACK when the config was not written', () => {
		// The exclude goes in FIRST (so the config is never momentarily untracked), which
		// means it is already in place before the writer says whether it will write
		// anything. When it REFUSES — here an existing `.mcp.json` it will not edit,
		// i.e. the user's OWN file — the entry would be left ignoring a file Cellar never
		// wrote; and since it lives in the repo-COMMON exclude, that hides their root
		// `.mcp.json` from `git status` in every working tree of the clone and makes
		// `git add` refuse it as ignored. Cellar must not leave an ignore rule behind for
		// a file it did not write.
		mkdirSync(join(WS, '.git', 'info'), { recursive: true });
		// A file that already has content, including an entry of the user's own: byte
		// identity is what proves only OUR bytes came back out.
		const before = '# git ls-files --others --exclude-from=.git/info/exclude\nbuild/\n';
		writeFileSync(EXCLUDE, before);
		writeFileSync(join(SIBLING, '.mcp.json'), 'not json at all\n');
		try {
			const r = mod.configureAdoptedWorktree(SIBLING);
			expect(r?.status).toBe('skipped');
			// Byte-identical, not merely "no `.mcp.json` line": the revert splices out the
			// exact slice it appended, so the user's file is untouched down to its newlines.
			expect(readFileSync(EXCLUDE, 'utf8')).toBe(before);
			// And git agrees — the user's own file is visible again, which is the whole point.
			expect(() => git(SIBLING, 'check-ignore', '-q', '.mcp.json')).toThrow();
			expect(git(SIBLING, 'status', '--porcelain', '-uall')).toContain('.mcp.json');
		} finally {
			rmSync(join(SIBLING, '.mcp.json'), { force: true });
		}
	});

	it('removes an exclude FILE it created, rather than leaving an empty one behind', () => {
		// The same rule at the other edge: with no `info/exclude` in the repo, the write
		// creates one, so a revert that only splices its own bytes out leaves a zero-byte
		// file where there was none. Git treats absent and empty the same, so this is the
		// header's byte-identity claim rather than behavior — and a claim that is asserted
		// has to hold literally, because that is what a future change relies on.
		rmSync(EXCLUDE, { force: true });
		expect(existsSync(EXCLUDE)).toBe(false);
		writeFileSync(join(SIBLING, '.mcp.json'), 'not json at all\n');
		try {
			expect(mod.configureAdoptedWorktree(SIBLING)?.status).toBe('skipped');
			expect(existsSync(EXCLUDE)).toBe(false);
		} finally {
			rmSync(join(SIBLING, '.mcp.json'), { force: true });
		}
	});

	it('removes a created exclude file with TWO harnesses skipped, where only ONE saw it absent', () => {
		// The multi-harness shape, and the ordinary one in a checkout that already holds
		// the user's own config files: the exclude loop runs for EVERY allow-listed
		// harness before any config is written, so with no `info/exclude` in the repo
		// claude's append CREATES the file and codex's appends to the now-existing one.
		// Recorded per harness, reverting both spliced claude's bytes out (leaving
		// codex's, so the file was rewritten) and then codex's with nothing left but
		// `created:false` — writing back a zero-byte `info/exclude` in a repo that had
		// none. The single-harness assertion above cannot see it, because there the one
		// append is also the one that created the file.
		harness.allowHarness('codex', WS);
		rmSync(EXCLUDE, { force: true });
		expect(existsSync(EXCLUDE)).toBe(false);
		// Both refused: an existing `.mcp.json` the writer will not edit, and a `.codex`
		// that is a FILE where the directory would go.
		writeFileSync(join(SIBLING, '.mcp.json'), 'not json at all\n');
		writeFileSync(join(SIBLING, '.codex'), 'not a directory\n');
		try {
			const r = mod.configureAdoptedWorktree(SIBLING);
			expect(r?.status).toBe('skipped');
			expect(existsSync(EXCLUDE)).toBe(false);
			// And git agrees the user's own file is theirs again — the point of reverting.
			expect(() => git(SIBLING, 'check-ignore', '-q', '.mcp.json')).toThrow();
		} finally {
			harness.disallowHarness('codex', WS);
			harness.allowHarness('claude', WS);
			rmSync(join(SIBLING, '.codex'), { force: true });
			rmSync(join(SIBLING, '.mcp.json'), { force: true });
		}
	});

	it('never removes an exclude entry it did not add', () => {
		// The revert is scoped to the bytes THIS call appended. An entry the user (or an
		// earlier adoption) already had is not ours to take back, and a skipped write
		// must not delete it.
		mkdirSync(join(WS, '.git', 'info'), { recursive: true });
		const before = '# mine\n/.mcp.json\n';
		writeFileSync(EXCLUDE, before);
		writeFileSync(join(SIBLING, '.mcp.json'), 'not json at all\n');
		try {
			expect(mod.configureAdoptedWorktree(SIBLING)?.status).toBe('skipped');
			expect(readFileSync(EXCLUDE, 'utf8')).toBe(before);
			expect(git(SIBLING, 'check-ignore', '-v', '.mcp.json')).toContain('info/exclude');
		} finally {
			rmSync(join(SIBLING, '.mcp.json'), { force: true });
		}
	});

	it('KEEPS an exclude it just re-added on the idempotent path — the config IS there', () => {
		// `already` is not a refusal: Cellar's config is on disk, so ignoring it is still
		// correct. The case that distinguishes keeping from reverting is a re-adoption
		// whose exclude entry was deleted by hand — this call appends it, so there is
		// something to take back, and taking it back would re-dirty the very checkout the
		// mitigation exists for.
		mod.configureAdoptedWorktree(SIBLING);
		writeFileSync(EXCLUDE, '# emptied by hand\n');
		const again = mod.configureAdoptedWorktree(SIBLING);
		expect(again?.status).toBe('already');
		expect(readFileSync(EXCLUDE, 'utf8')).toContain('/.mcp.json');
		expect(git(SIBLING, 'check-ignore', '-v', '.mcp.json')).toContain('info/exclude');
		expect(git(SIBLING, 'status', '--porcelain', '-uall').trim()).toBe('');
	});

	it('a SKIPPED harness still speaks, and its reason is never summarised away', () => {
		// The reason is the actionable part: an aggregate that reported a count claimed
		// every harness was configured and discarded the one explanation worth having.
		process.env.CELLAR_NO_MCP_CONFIG = '1';
		try {
			const r = mod.configureAdoptedWorktree(SIBLING);
			expect(r?.status).toBe('skipped');
			expect(agentConfigNotice(r)).toMatch(/--no-mcp-config/);
			expect(agentConfigNotice(r)).not.toMatch(/\d+ harnesses configured/);
		} finally {
			delete process.env.CELLAR_NO_MCP_CONFIG;
		}
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
