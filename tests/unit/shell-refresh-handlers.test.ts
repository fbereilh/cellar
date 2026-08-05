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

const SHELL = join(process.cwd(), 'src/routes/+page.svelte');
const src = readFileSync(SHELL, 'utf8');

/**
 * The brace-balanced block that opens at `marker` (which must end with `{`).
 * Reading the real block - not a window of N lines - is what keeps the guard
 * honest when the surrounding code is reshuffled.
 */
function blockAt(marker: string): string {
	const start = src.indexOf(marker);
	expect(start, `anchor not found in +page.svelte: ${marker}`).toBeGreaterThan(-1);
	let depth = 0;
	for (let i = start + marker.length - 1; i < src.length; i++) {
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

	it('refreshes the kernel badge AND the variable inspector', () => {
		expect(foreign).toContain('refreshKernel()');
		expect(foreign).toContain('refreshVariables()');
	});

	it('refreshes every panel the own-run path refreshes', () => {
		// The own-run path is the proven one; the foreign branch must not be a
		// subset of it. Compare the refresh calls, not the whole body.
		const refreshes = (block: string) =>
			[...block.matchAll(/\brefresh[A-Za-z]+\(/g)].map((m) => m[0]).sort();
		for (const call of new Set(refreshes(own))) expect(refreshes(foreign)).toContain(call);
	});
});

describe('the initial inspect is not gated on a kernel this page already knows about', () => {
	// `inspectVariables` short-circuits a not-started kernel server-side (it reads
	// the status, it never boots one), so the gate protected nothing and hid the
	// case where an AGENT booted the kernel.
	const restore = blockAt('onMount(() => {\n\t\tconst saved = getUi(');
	const mountTail = restore.slice(restore.indexOf('LOGS_HEIGHT_KEY'));

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
