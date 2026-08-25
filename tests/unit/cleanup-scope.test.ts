import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planCleanup, workspaceKey, CONFIRM_PHRASE } from '../../src/lib/server/cleanup-plan';

/**
 * `cellar cleanup --all` must not be able to stop a live session in a workspace
 * the caller is not working in.
 *
 * The observed failure (two real instances, two folders, `cellar cleanup --all`
 * run from the first): the second folder's live launcher was killed, taking its
 * kernel and namespace with it. Worse than reported — `-y` was not required at
 * all, because the confirmation was auto-approved by a non-TTY stdin, which is
 * every script and every agent.
 *
 * These pin the DECISION (which processes a scope may reach). The CLI half — the
 * phrase that `-y` cannot supply — is pinned by tests/e2e/cleanup-scope.spec.ts
 * against real instances.
 */

/** An annotated registry entry: live launcher, serving `workspace`. */
const liveIn = (workspace: string, launcherPid = 1000) => ({
	launcherPid,
	appPid: launcherPid + 1,
	appPort: 40000 + launcherPid,
	workspace,
	startedAt: Date.now(),
	launcherAlive: true,
	appAlive: true,
	appResponds: true
});

/** An orphan: launcher gone, app still listening. Nobody's live session. */
const orphanIn = (workspace: string, launcherPid = 2000) => ({
	...liveIn(workspace, launcherPid),
	launcherAlive: false
});

describe('workspaceKey', () => {
	it('reads two spellings of one directory as the same workspace', () => {
		// The registry records the path resolved at launch; cleanup resolves the
		// caller's cwd. On macOS every /tmp and /var/folders workspace has a
		// symlinked and a real spelling, so a lexical compare would read one
		// directory as two.
		const real = mkdtempSync(join(realpathSync(tmpdir()), 'cellar-wskey-'));
		const link = join(real, 'link');
		const target = join(real, 'target');
		mkdirSync(target);
		symlinkSync(target, link);
		try {
			expect(workspaceKey(link)).toBe(workspaceKey(target));
		} finally {
			rmSync(real, { recursive: true, force: true });
		}
	});

	it('normalises a trailing separator', () => {
		expect(workspaceKey('/a/b/')).toBe(workspaceKey('/a/b'));
	});

	it('falls back to the lexical path when the directory does not exist', () => {
		// Fails in the SAFE direction: two different directories can never collide
		// on a lexical path, so the worst case is under-reaching, never over-.
		expect(workspaceKey('/definitely/not/here')).toBe('/definitely/not/here');
		expect(workspaceKey(undefined)).toBe('');
		expect(workspaceKey('')).toBe('');
	});
});

describe('planCleanup — scope', () => {
	const here = '/ws/mine';
	const there = '/ws/theirs';

	it('REGRESSION: --all does not reach a live instance in another workspace', () => {
		const mine = liveIn(here, 1001);
		const theirs = liveIn(there, 1002);
		const plan = planCleanup({ entries: [mine, theirs], workspace: here, scope: 'workspace' });

		expect(plan.reap).toContain(mine);
		expect(plan.reap).not.toContain(theirs);
		// And it is REPORTED, not silently dropped — the old command's blast radius
		// being invisible is what made it dangerous.
		expect(plan.skippedElsewhere).toEqual([theirs]);
		// No phrase needed: nothing here belongs to anyone else.
		expect(plan.crossWorkspace).toBe(false);
	});

	it('REGRESSION: the default scope reaches no live instance at all', () => {
		const mine = liveIn(here, 1001);
		const theirs = liveIn(there, 1002);
		const plan = planCleanup({ entries: [mine, theirs], workspace: here, scope: 'orphans' });

		expect(plan.reap).toEqual([]);
		// Split by whose it is: the remedy differs (`--all` vs `--all-workspaces`).
		expect(plan.skippedHere).toEqual([mine]);
		expect(plan.skippedElsewhere).toEqual([theirs]);
	});

	it('still reaps orphans at every scope — the tidy case stays easy', () => {
		const orphanHere = orphanIn(here, 2001);
		const orphanThere = orphanIn(there, 2002);
		for (const scope of ['orphans', 'workspace', 'everywhere'] as const) {
			const plan = planCleanup({
				entries: [orphanHere, orphanThere],
				workspace: here,
				scope
			});
			expect(plan.reap).toContain(orphanHere);
			expect(plan.reap).toContain(orphanThere);
		}
	});

	it('--all-workspaces reaches everything, and flags itself as cross-workspace', () => {
		const mine = liveIn(here, 1001);
		const theirs = liveIn(there, 1002);
		const plan = planCleanup({ entries: [mine, theirs], workspace: here, scope: 'everywhere' });

		expect(plan.reap).toEqual(expect.arrayContaining([mine, theirs]));
		expect(plan.skippedHere).toEqual([]);
		expect(plan.skippedElsewhere).toEqual([]);
		expect(plan.crossWorkspace).toBe(true);
	});

	it('does not demand the phrase when --all-workspaces finds nothing of anyone else’s', () => {
		// Widest scope, but only this workspace's own instance is live: nothing is
		// being taken from anyone, so the phrase would be pure friction.
		const plan = planCleanup({ entries: [liveIn(here, 1001)], workspace: here, scope: 'everywhere' });
		expect(plan.reap).toHaveLength(1);
		expect(plan.crossWorkspace).toBe(false);
	});

	it('treats an entry with no recorded workspace as somebody else’s', () => {
		const nameless = { ...liveIn('', 1003), workspace: undefined };
		const plan = planCleanup({ entries: [nameless], workspace: here, scope: 'workspace' });
		expect(plan.reap).toEqual([]);
		expect(plan.skippedElsewhere).toEqual([nameless]);
	});

	it('matches the caller’s workspace through a symlinked spelling', () => {
		const real = mkdtempSync(join(realpathSync(tmpdir()), 'cellar-scope-'));
		const target = join(real, 'target');
		const link = join(real, 'link');
		mkdirSync(target);
		symlinkSync(target, link);
		try {
			// Registered under one spelling, cleaned up from the other.
			const e = liveIn(link, 1001);
			const plan = planCleanup({ entries: [e], workspace: workspaceKey(target), scope: 'workspace' });
			expect(plan.reap).toEqual([e]);
		} finally {
			rmSync(real, { recursive: true, force: true });
		}
	});

	it('an unknown scope value degrades to the safest tier', () => {
		const plan = planCleanup({
			entries: [liveIn(here, 1001)],
			workspace: here,
			scope: 'nonsense' as never
		});
		expect(plan.reap).toEqual([]);
	});
});

describe('planCleanup — untracked processes', () => {
	const here = '/ws/mine';
	const orphanProc = { pid: 3001, ppid: 1, command: 'node /opt/cellar/build/index.js' };
	const liveProc = { pid: 3002, ppid: 999, command: 'node /opt/cellar/build/index.js' };

	it('REGRESSION: --all does not kill an untracked LIVE cellar process', () => {
		// This is the shape a user's real instance takes whenever the registry is
		// isolated (a temp HOME — every CI run, every agent run): not in the
		// registry we can see, launcher alive, workspace unknowable from `ps`. It
		// was killed by --all; an unattributable live process is now somebody
		// else's until proven otherwise.
		const plan = planCleanup({
			untracked: [orphanProc, liveProc],
			workspace: here,
			scope: 'workspace'
		});
		expect(plan.killPids).toEqual([orphanProc.pid]);
		expect(plan.skippedUntracked).toEqual([liveProc]);
		expect(plan.crossWorkspace).toBe(false);
	});

	it('reaps untracked orphans (ppid 1) at the default scope', () => {
		const plan = planCleanup({ untracked: [orphanProc], workspace: here, scope: 'orphans' });
		expect(plan.killPids).toEqual([orphanProc.pid]);
	});

	it('--all-workspaces reaches an untracked live process, and needs the phrase', () => {
		const plan = planCleanup({ untracked: [liveProc], workspace: here, scope: 'everywhere' });
		expect(plan.killPids).toEqual([liveProc.pid]);
		expect(plan.crossWorkspace).toBe(true);
	});
});

describe('CONFIRM_PHRASE', () => {
	it('is the exact literal the help text and docs hand out', () => {
		// A contract pin: `--help`, the refusal message and docs/SETUP.md all spell
		// this out, so it may not drift silently. That no auto-approval can SUPPLY
		// it is a property of the command, pinned against the real CLI in
		// cleanup-command.test.ts (`-y` / `CI=1` do NOT unlock --all-workspaces).
		expect(CONFIRM_PHRASE).toBe('stop-all-workspaces');
	});
});
