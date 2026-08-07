/**
 * The Git sidebar panel's own client-side rules (`src/lib/GitNotebooks.svelte`).
 *
 * Vitest deliberately runs without the SvelteKit plugin, so the component cannot
 * be MOUNTED here (see vitest.config.ts); each rule below is one expression wide,
 * which is exactly the case that file says gets a SOURCE guard instead — the same
 * shape as `dataframe-grid.test.ts`'s key guard and `html-preview.test.ts`'s
 * sandbox guard. What the panel RENDERS end to end is proved by
 * `tests/e2e/git-notebook-commits.spec.ts`; what is pinned here is the handful of
 * decisions whose regression would be silent there: a label that repeats itself,
 * a placeholder that asserts a root nobody read, a request nothing consumes, and
 * a burst of duplicate requests that still returns the right answer.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = readFileSync(fileURLToPath(new URL('../../src/lib/GitNotebooks.svelte', import.meta.url)), 'utf8');

/** The body of a named top-level function in the component's `<script>`. */
function fnBody(name: string): string {
	const at = SRC.indexOf(`function ${name}(`);
	expect(at, `${name}() not found — it was renamed or removed`).toBeGreaterThan(-1);
	const open = SRC.indexOf('{', SRC.indexOf(')', at));
	let depth = 0;
	for (let i = open; i < SRC.length; i++) {
		if (SRC[i] === '{') depth++;
		else if (SRC[i] === '}' && --depth === 0) return SRC.slice(open, i + 1);
	}
	throw new Error(`unbalanced braces reading ${name}()`);
}

describe('GitNotebooks — the detached row', () => {
	it('names the ref "detached" and leaves the SHA to its own chip', () => {
		// The row renders `git-sha` a few pixels to the right of this label, so the
		// file tree's parenthesised-SHA convention printed the same seven characters
		// twice side by side. Borrowing it back is the regression.
		const body = fnBody('refLabel');
		expect(body).toContain("'detached'");
		expect(body).not.toMatch(/`\(\$\{/);
		expect(body).not.toMatch(/\(.*shortSha.*\)/);
	});

	it('still names the SHA in the branch tooltip, which is where it belongs', () => {
		expect(SRC).toContain('detached HEAD @ ${git.shortSha}');
	});
});

describe('GitNotebooks — a checkout with no commits yet', () => {
	it('decides it off the COMMIT, not off a missing branch', () => {
		// `symbolic-ref` SUCCEEDS on an unborn HEAD — only `log -1` fails — so this row
		// carries a real branch name. Keying the hint off `refLabel` returning null
		// therefore never fired for the case it was written for, and the row rendered a
		// bare branch with no SHA and no subject: indistinguishable from a commit line
		// that half-failed to load.
		const body = fnBody('unbornHead');
		expect(body).toContain('git.isRepo');
		expect(body).toContain('!git.commit');
	});

	it('keeps the branch in its own slot and marks the missing commit where the SHA goes', () => {
		// The two halves of "this branch, no commits": the label must NOT be replaced.
		expect(SRC).toContain('{:else if unbornHead(git)}');
		expect(SRC).toContain('data-testid="git-unborn"');
		expect(SRC).toContain('{label}');
	});

	it('leaves no second, unreachable place deciding the same thing', () => {
		// The dead `?? 'no commits yet'` fallback inside the branch slot: it could only
		// fire when git named neither a branch nor a SHA, which is not this state.
		expect(fnBody('refLabel')).not.toContain('no commits yet');
		expect(SRC).not.toContain("refLabel(git) ?? 'no commits yet'");
	});
});

describe('GitNotebooks — a notebook the route never opened', () => {
	it('asserts nothing about it: no root chip, no commit', () => {
		// Past the route's path cap, so it was named but never read. Unlike a row still
		// in flight, nothing is coming — so the root slot is withheld outright rather
		// than placeheld, and it must not fall through to the real chip's "workspace".
		const from = SRC.indexOf('{:else if row.notRead}');
		const to = SRC.indexOf('{:else if !row.unreadable}');
		expect(from, 'the not-read root-slot branch is gone').toBeGreaterThan(-1);
		expect(to, 'the loaded-row branch is gone').toBeGreaterThan(from);
		const slot = SRC.slice(from, to);
		expect(slot).not.toContain('workspace');
		expect(slot).not.toContain('data-testid=');
	});

	it('is structurally distinct from BOTH the pending row and the unreadable one', () => {
		// Three different facts, three different markers — a reused flag would make the
		// panel say one of them about a notebook in a different state entirely.
		for (const id of ['git-root-pending', 'git-not-read', 'git-notebook-error']) {
			expect(SRC.match(new RegExp(`data-testid="${id}"`, 'g')), id).toHaveLength(1);
		}
		// The not-read row's own line is checked FIRST, so it can never be reported as
		// an unreadable document (which would blame the notebook for a request cap).
		expect(SRC.indexOf('{#if row?.notRead}')).toBeLessThan(SRC.indexOf('{:else if row?.unreadable}'));
	});

	it('states the reason ONCE, below the list, not on every dropped row', () => {
		const row = SRC.slice(SRC.indexOf('{#if row?.notRead}'), SRC.indexOf('{:else if row?.unreadable}'));
		expect(row).not.toMatch(/Too many|Close some/);
		expect(SRC.match(/data-testid="git-not-read-notice"/g)).toHaveLength(1);
		// …and it names the remedy, since closing a tab is the only thing that brings
		// those rows back.
		expect(SRC).toContain('Close some to see them.');
	});
});

describe('GitNotebooks — the root chip has THREE states', () => {
	it('marks only the REAL chip `git-root`, so the pending one cannot be asserted on', () => {
		// The e2e asserts EXACT text on `git-root`; a second element wearing it would
		// make that assertion ambiguous rather than failing outright.
		expect(SRC.match(/data-testid="git-root"/g)).toHaveLength(1);
		expect(SRC).toContain('data-testid="git-root-pending"');
	});

	it('claims nothing while a row has not arrived', () => {
		// `row === null` means the fetch is still out, so this notebook's root is
		// unknown — NOT "workspace", and emphatically not the tooltip stating that no
		// root is declared. Both of those live strictly after the `{#if !row}` branch.
		// The two ends are asserted present first: read off an indexOf miss the slice
		// below is empty, and every `not.toContain` on it passes for the wrong reason.
		const from = SRC.indexOf('{#if !row}');
		const to = SRC.indexOf('{:else if !row.unreadable}');
		expect(from, 'the not-yet-arrived branch is gone').toBeGreaterThan(-1);
		expect(to, 'the loaded-row branch is gone').toBeGreaterThan(from);
		const pending = SRC.slice(from, to);
		expect(pending).not.toContain('workspace');
		expect(pending).not.toContain('No code root declared');
		expect(pending).not.toContain('title=');
	});

	it('keeps the real "workspace" chip for a LOADED row that declares no root', () => {
		// The opposite error: that row genuinely has no root, which is a fact worth
		// stating, so the placeholder must not swallow it.
		const at = SRC.indexOf('{:else if !row.unreadable}');
		expect(at, 'the loaded-row branch is gone').toBeGreaterThan(-1);
		const real = SRC.slice(at);
		expect(real).toContain("{row.root ?? 'workspace'}");
		expect(real).toContain('No code root declared');
	});
});

describe('GitNotebooks — what it asks the server for', () => {
	it('does not fetch at all when no notebook is open', () => {
		// The template short-circuits to `git-empty` and discards every field, so the
		// request would buy nothing and still cost the workspace probe's three spawns.
		const body = fnBody('load');
		const guard = body.indexOf('if (!notebooks.length)');
		expect(guard).toBeGreaterThan(-1);
		expect(guard).toBeLessThan(body.indexOf('fetchRoots'));
		// The generation guard still advances, so a reply from a request issued while
		// a tab WAS open cannot land afterwards and repopulate the emptied list…
		const empty = body.slice(guard, body.indexOf('}', body.indexOf('return Promise.resolve()')));
		expect(empty).toContain('seq++');
		// …and the loading flag is not left stuck on.
		expect(empty).toContain('loading = false');
	});

	it('coalesces concurrent triggers onto ONE in-flight request, keyed by the query', () => {
		// Mount racing `sse:open`, focus racing an fs-refresh bump: the seq guard
		// discards the loser's REPLY but never stopped its request, and `gitCommitAt`
		// writes its cache entry only after its spawns finish, so both re-spawned.
		const body = fnBody('load');
		expect(body).toContain('if (inFlight?.key === key) return inFlight.done');
		// Keyed, so a request for a DIFFERENT notebook set is never handed back as
		// this one's answer, and cleared only by its own settle so a later request
		// cannot be cancelled by an earlier one finishing.
		expect(body).toContain('inFlight = { key, done }');
		expect(body).toContain('if (inFlight?.done === done) inFlight = null');
	});
});
