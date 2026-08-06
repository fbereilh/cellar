/**
 * The shell's FOREIGN-action handlers must refresh the same panels its OWN
 * actions do.
 *
 * Two bugs of one shape lived here: an action the tab performed itself refreshed
 * a sidebar panel, and the identical action arriving from an AGENT (or another
 * tab) over SSE refreshed less - or nothing. Neither is visible to a test that
 * performs the action ITSELF, which is exactly why they survived: a self-run goes
 * through `onRunEnd`, which already refreshes variables.
 *
 *   1. the foreign `run:end` branch refreshed the kernel badge but not the
 *      variable inspector, so on a page that loaded before any kernel existed the
 *      Variables panel stayed empty for the whole session;
 *   2. the `notebook:opened` branch never bumped `fsRefreshSignal`, so a notebook
 *      an agent created never appeared in the file tree (nor its git decoration),
 *      while every other new-file path in the same file bumps it.
 *
 * These are SOURCE guards: `+page.svelte` is the app shell and vitest runs
 * without the SvelteKit plugin (see vitest.config.ts), so it cannot be mounted
 * here. The behavioural proof - driven by a real `cellar mcp` agent, never by a
 * self-action - is `tests/e2e/foreign-action-refresh.spec.ts`, which E2E-only CI
 * does not run; that is why the call sites are pinned here too.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { toWorkspaceRel } from '../../src/lib/workspacePath';

const SHELL = join(process.cwd(), 'src/routes/+page.svelte');
const src = readFileSync(SHELL, 'utf8');

/**
 * The brace-balanced block that opens at `marker`'s FIRST `{`.
 * Reading the real block - not a window of N lines - is what keeps the guard
 * honest when the surrounding code is reshuffled.
 *
 * The scan starts at the marker's own first `{` rather than at its last
 * character, so a marker whose brace is INTERIOR (one that reaches past the
 * opening line to disambiguate which of several identical openers it means) is
 * measured from the same brace as a marker that ends in one. Scanning from the
 * end instead let such a marker open at depth 0, so the first `}` drove it
 * negative and the block silently ran on to wherever a later `}` restored the
 * balance - a slice covering unrelated code, which is a guard that passes by
 * accident.
 */
function blockAt(marker: string): string {
	const start = src.indexOf(marker);
	expect(start, `anchor not found in +page.svelte: ${marker}`).toBeGreaterThan(-1);
	const brace = marker.indexOf('{');
	expect(brace, `anchor opens no block: ${marker}`).toBeGreaterThan(-1);
	let depth = 0;
	for (let i = start + brace; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') {
			depth--;
			if (depth === 0) return src.slice(start, i + 1);
		}
	}
	throw new Error(`unbalanced block at anchor: ${marker}`);
}

describe('a run this tab did NOT initiate refreshes what its own run does', () => {
	const foreign = blockAt("if (ev.type === 'run:end' && ev.originId !== originId) {");
	const own = blockAt('function onRunEnd() {');
	const debounced = blockAt('function scheduleForeignVariablesRefresh() {');
	// The foreign branch reaches the inspector THROUGH the coalescing helper (a
	// foreign `run:end` arrives once per cell of an agent batch, and the probe runs
	// real python), so resolve that one level of indirection before comparing the
	// refresh SETS - what must match is which panels get refreshed, not how.
	const foreignEffective = foreign.includes('scheduleForeignVariablesRefresh()')
		? foreign + debounced
		: foreign;

	it('refreshes the kernel badge AND the variable inspector', () => {
		expect(foreign).toContain('refreshKernel()');
		expect(foreignEffective).toContain('refreshVariables()');
	});

	it('refreshes every panel the own-run path refreshes', () => {
		// The own-run path is the proven one; the foreign branch must not be a
		// subset of it. Compare the refresh calls, not the whole body.
		const refreshes = (block: string) =>
			[...block.matchAll(/\brefresh[A-Za-z]+\(/g)].map((m) => m[0]).sort();
		for (const call of new Set(refreshes(own))) expect(refreshes(foreignEffective)).toContain(call);
	});

	it('coalesces the inspector probe but never the kernel badge', () => {
		// The badge is a cheap READ (`/api/kernel` never probes), so it stays
		// immediate and ungated; the inspector probe must not be reachable directly
		// from this branch, or a burst would cost one kernel execution per cell.
		expect(foreign).toContain('scheduleForeignVariablesRefresh()');
		expect(foreign).not.toMatch(/(?<!scheduleForeign)\brefreshVariables\(/);
		expect(foreign.indexOf('refreshKernel()')).toBeLessThan(
			foreign.indexOf('foreignRunTouchesActiveNotebook(')
		);
	});

	it('restarts the pending timer so a burst collapses into one probe', () => {
		// A trailing debounce that did not CLEAR the pending timer would fire once per
		// event after a fixed delay - i.e. N probes, exactly what this exists to stop.
		expect(debounced).toContain('clearTimeout(foreignVarsTimer)');
		expect(debounced.indexOf('clearTimeout(foreignVarsTimer)')).toBeLessThan(
			debounced.indexOf('setTimeout(')
		);
		expect(debounced).toContain('FOREIGN_VARS_REFRESH_MS');
	});

	it('probes only for a run in the notebook the inspector reflects', () => {
		// `inspectVariables` probes the ACTIVE notebook's kernel, so a run elsewhere
		// can only ever probe the wrong one. Undecidable cases must fall back to
		// refreshing - a missed refresh is the bug this whole path exists to fix.
		const gate = blockAt('function foreignRunTouchesActiveNotebook(nb: unknown): boolean {');
		const failsOpen = [
			/typeof nb !== 'string' \|\| !nb\) return true/, // no path on the event
			// The SERVER's active notebook (what the probe reads) moves only when a
			// LiveNotebook becomes active, so a plain FILE tab holding focus leaves it
			// pointing elsewhere while `activeNotebookPath` falls back to the canonical
			// notebook. Comparing there answers about the wrong notebook - and answers
			// FALSE, i.e. the missed refresh this path exists to fix.
			/!activeTabIsNotebook\) return true/, // the tab is not the notebook it names
			/!activeNotebookPath\) return true/, // no notebook active
			// Outside the workspace - and, since the rule is boundary-aware, a sibling
			// merely sharing its name as a prefix lands here too rather than being
			// decided as a mismatch.
			/!rel\) return true/
		];
		for (const fallback of failsOpen) expect(gate).toMatch(fallback);
		// The only verdict that may SKIP is a decided mismatch, so no other path here
		// is allowed to answer false.
		expect(gate).not.toMatch(/return false/);
	});
});

describe('an inspector response that is no longer the newest is dropped', () => {
	// Several probes can be in flight at once and responses are unordered, so an
	// older namespace landing last would stick - the `kernelReqSeq` convention.
	const refresh = blockAt('async function refreshVariables() {');

	it('guards every write with a monotonic generation', () => {
		expect(refresh).toContain('const seq = ++varsReqSeq;');
		expect(refresh.indexOf('const seq = ++varsReqSeq;')).toBeLessThan(refresh.indexOf('await fetch('));
		expect(refresh).toMatch(/if \(seq !== varsReqSeq\) return;[\s\S]*variables = body\.variables/);
		expect(refresh).toMatch(/if \(seq !== varsReqSeq\) return;[\s\S]*varsError =/);
		expect(refresh).toContain('if (seq === varsReqSeq) varsLoading = false;');
	});

	it('supersedes an in-flight probe when a restart/shutdown wipes the namespace', () => {
		// A LOCAL write to `variables` is the other half of the same guard - the
		// `markKernelStarted` convention. Without the bump, a probe issued a moment
		// before the restart lands after the wipe and repopulates the inspector with
		// the dead session's namespace, and nothing is scheduled to correct it.
		const wipe = blockAt('function wipeVariablesLocally() {');
		expect(wipe).toContain('varsReqSeq++');
		expect(wipe.indexOf('varsReqSeq++')).toBeLessThan(wipe.indexOf('variables = []'));
		for (const anchor of ['async function restartKernel(path: string) {', 'async function shutdownKernel(path: string) {']) {
			const block = blockAt(anchor);
			expect(block, anchor).toContain('/api/kernel/'); // the slice really is this control
			expect(block, anchor).toContain('wipeVariablesLocally()');
		}
	});

	it('routes EVERY local wipe through that one helper', () => {
		// Scoping this per known call site let a THIRD one (the venv rebind, which
		// tears down every live kernel) bypass the generation entirely, so an
		// in-flight probe repopulated the inspector with the DEAD interpreter's
		// namespace. Asserted over the whole file so a future fourth site cannot
		// quietly do the same: the only raw `variables = []` is the helper's own.
		const raw = [...src.matchAll(/variables = \[\]/g)];
		expect(raw.length, 'expected exactly one raw wipe - the helper itself').toBe(1);
		const wipe = blockAt('function wipeVariablesLocally() {');
		expect(wipe).toContain('variables = []');
		expect(blockAt('onVenvRebound={() => {')).toContain('wipeVariablesLocally()');
	});

	it('does not strand the spinner when it supersedes an in-flight probe', () => {
		// The bump issues no replacement request, and `refreshVariables`'s `finally`
		// clears `varsLoading` only while it is still the newest generation - so a
		// probe superseded by a wipe would leave a permanent spinner (and a stale
		// error) in the Variables header, with nothing scheduled to clear it.
		const wipe = blockAt('function wipeVariablesLocally() {');
		expect(wipe).toMatch(/varsLoading = false/);
		expect(wipe).toMatch(/varsError = ''/);
	});
});

describe('the absolute → workspace-relative rule has ONE boundary-aware owner', () => {
	it('is derived by the shared helper at both call sites', () => {
		// Two copies of this rule lived here and both were a bare `startsWith`. That
		// is not merely duplication: a SIBLING sharing the workspace name as a prefix
		// (/tmp/ws vs /tmp/ws2/x.ipynb) read as INSIDE the workspace, so the gate
		// decided it as a MISMATCH and skipped the refresh - the missed-refresh
		// failure its fail-open doctrine exists to prevent, reached through the one
		// path that did not fail open.
		expect(src).toContain("import { toWorkspaceRel } from '$lib/workspacePath';");
		expect(src).toContain('const canonicalNotebookRel = toWorkspaceRel(workspace, notebookPath) ?? notebookName;');
		expect(blockAt('function foreignRunTouchesActiveNotebook(nb: unknown): boolean {')).toContain(
			'toWorkspaceRel(workspace, nb)'
		);
		// No hand-rolled copy may come back alongside it.
		expect(src).not.toMatch(/\.slice\(workspace\.length\)/);
		expect(src).not.toMatch(/startsWith\(workspace\)/);
	});

	it('treats a prefix-sharing sibling as undecidable, not as a mismatch', () => {
		const ws = '/tmp/ws';
		expect(toWorkspaceRel(ws, '/tmp/ws/a/x.ipynb')).toBe('a/x.ipynb');
		expect(toWorkspaceRel(ws + '/', '/tmp/ws/a/x.ipynb')).toBe('a/x.ipynb');
		expect(toWorkspaceRel(ws, '/tmp/ws2/x.ipynb')).toBe(null); // the sibling
		expect(toWorkspaceRel(ws, '/tmp/other/x.ipynb')).toBe(null);
		expect(toWorkspaceRel(ws, ws)).toBe(null); // the root is no file in itself
		expect(toWorkspaceRel('C:\\ws', 'C:\\ws\\a\\x.ipynb')).toBe('a\\x.ipynb');
		expect(toWorkspaceRel('C:\\ws', 'C:\\ws2\\x.ipynb')).toBe(null);
	});
});

describe('the initial inspect is not gated on a kernel this page already knows about', () => {
	// `inspectVariables` short-circuits a not-started kernel server-side (it reads
	// the status, it never boots one), so the gate protected nothing and hid the
	// case where an AGENT booted the kernel.
	const restore = blockAt('onMount(() => {\n\t\tconst saved = getUi(');
	const mountTail = restore.slice(restore.indexOf('LOGS_HEIGHT_KEY'));

	it('is anchored on the restore block, not a slice running past it', () => {
		// The marker's `{` is INTERIOR, so a scan starting at its last character
		// opened at depth 0 and ran on into the NEXT `onMount`'s SSE callback. That
		// silently unscoped the guard below - it would have passed with the mount
		// inspect re-gated, which is precisely what it exists to prevent.
		expect(restore).toContain('LOGS_OPEN_KEY');
		expect(restore).not.toContain('subscribeEvents');
	});

	it('inspects variables unconditionally on mount', () => {
		expect(mountTail).toContain('refreshVariables();');
		expect(mountTail).not.toMatch(/kernelInfo\.started/);
	});
});

describe('a notebook opened elsewhere refreshes the file tree', () => {
	const handler = blockAt('subscribeEvents((ev: ClientEvent) => {');
	const openedBranch = handler.slice(handler.indexOf("if (ev.type !== 'notebook:opened') return;"));

	it('bumps fsRefreshSignal before surfacing the tab', () => {
		expect(openedBranch).toContain('fsRefreshSignal++');
		expect(openedBranch.indexOf('fsRefreshSignal++')).toBeLessThan(
			openedBranch.indexOf('surfaceFilePermanent(')
		);
	});

	it('bumps it only for a foreign event - our own echo returns first', () => {
		// The own-origin guard must stay ABOVE the bump: our own create already
		// bumps at its call site, and re-bumping on the echo is a wasted refetch.
		expect(openedBranch.indexOf('ev.originId === originId')).toBeLessThan(
			openedBranch.indexOf('fsRefreshSignal++')
		);
	});
});
