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
