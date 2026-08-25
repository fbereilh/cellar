/**
 * A Kernels-sidebar card opens its notebook.
 *
 * TWO layers, and they do NOT prove the same thing - read which is which before
 * trusting either.
 *
 * BEHAVIOUR (the first describe): `kernelCardName` is pure and is EXECUTED here.
 * It is the rule that was silently wrong - every card whose tab was closed read
 * `python3`, the kernelspec name, naming no notebook at all - and this is
 * genuine coverage of it.
 *
 * SOURCE SHAPE (every other describe, and each is named so): these READ the
 * component source. vitest runs without the SvelteKit plugin
 * (`vitest.config.ts`), so neither `Sidebar.svelte` nor `+page.svelte` can be
 * mounted here and nothing below can be clicked, focused or rendered. They
 * witness only that the wiring is DECLARED. They therefore PASS against code
 * that is never reached, and they can FAIL on a refactor that preserves the
 * behaviour exactly (extracting a URL into a helper, renaming a local).
 *
 * The behavioural proof - a click and a keypress really opening the notebook, an
 * already-open one surfaced rather than duplicated, the per-kernel controls
 * unaffected, and a card whose file is gone reporting instead of minting a
 * broken tab - is `tests/e2e/kernel-card-open-notebook.spec.ts` against a real
 * kernel. That spec runs in NEITHER CI nor the no-mistakes gate (both run the
 * vitest suite only), which is the entire reason the shape guards exist: without
 * them these invariants could be deleted and merge green with no signal at all.
 *
 * Deliberately narrow for that reason: markup SHAPE (which is what an accessible
 * name and a valid tab order rest on) and which function a handler reaches -
 * never the text of a class list or a tooltip, which break on a reword and pass
 * on dead code just the same.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { kernelCardName } from '../../src/lib/kernelBadge';

const SIDEBAR = readFileSync(join(process.cwd(), 'src/lib/Sidebar.svelte'), 'utf8');
const SHELL = readFileSync(join(process.cwd(), 'src/routes/+page.svelte'), 'utf8');

/** The `{#snippet kernelRow(...)}` body - every guard below is scoped to it. */
function kernelRowSource(): string {
	const start = SIDEBAR.indexOf('{#snippet kernelRow(');
	expect(start, 'no kernelRow snippet').toBeGreaterThan(-1);
	const end = SIDEBAR.indexOf('{/snippet}', start);
	expect(end).toBeGreaterThan(start);
	return SIDEBAR.slice(start, end);
}

describe('kernelCardName - what a card calls its notebook', () => {
	it('prefers the tab title, so a card and its open tab read alike', () => {
		expect(kernelCardName('sub/dir/analysis.ipynb', 'analysis.ipynb')).toBe('analysis.ipynb');
	});

	it('falls back to the BASENAME for a card whose tab is closed', () => {
		// The regression this replaced fell back to `KernelListEntry.name`, which is
		// the kernelspec (`python3`) - a label naming no notebook at all, on exactly
		// the card whose one job is to open one.
		expect(kernelCardName('sub/dir/analysis.ipynb')).toBe('analysis.ipynb');
		expect(kernelCardName('analysis.ipynb', null)).toBe('analysis.ipynb');
		expect(kernelCardName('analysis.ipynb', '')).toBe('analysis.ipynb');
		expect(kernelCardName('notes.py')).toBe('notes.py');
	});

	it('never yields an empty label', () => {
		expect(kernelCardName('')).toBe('');
		expect(kernelCardName('dir/')).toBe('dir/');
	});
});

describe('SOURCE-SHAPE GUARD: the kernel row declares a real control that opens its notebook', () => {
	const row = kernelRowSource();

	it('names the notebook with ONE element, a <button>, in both open and closed states', () => {
		// One `kernel-notebook` element, not one per branch: the open/closed split
		// is what left a closed card as an inert <span>, i.e. unreachable by mouse
		// AND keyboard. A <button> is also what makes Enter/Space work for free.
		const hits = row.split('data-testid="kernel-notebook"').length - 1;
		expect(hits, 'expected exactly one kernel-notebook element').toBe(1);
		const at = row.indexOf('data-testid="kernel-notebook"');
		const open = row.lastIndexOf('<button', at);
		const closeSpan = row.lastIndexOf('<span', at);
		expect(open, 'kernel-notebook is not on a <button>').toBeGreaterThan(-1);
		expect(open).toBeGreaterThan(closeSpan);
	});

	it('carries an explicit accessible name (the visible text is only a filename)', () => {
		const at = row.indexOf('data-testid="kernel-notebook"');
		const el = row.slice(row.lastIndexOf('<button', at), at);
		expect(el).toMatch(/aria-label=/);
		expect(el).toMatch(/card\.name/);
	});

	it('opens by PATH, through the shared handler', () => {
		const at = row.indexOf('data-testid="kernel-notebook"');
		const el = row.slice(row.lastIndexOf('<button', at), at);
		expect(el).toContain('onOpenNotebook?.(card.path)');
	});

	it('does not nest the per-kernel controls inside the name button', () => {
		// A <button> wrapping the Interrupt/Restart/Shut-down buttons is invalid
		// markup and gives a tab order nobody can follow; it is also how a click on
		// a control comes to trigger the open action.
		const at = row.indexOf('data-testid="kernel-notebook"');
		const close = row.indexOf('</button>', at);
		expect(close).toBeGreaterThan(at);
		const inside = row.slice(at, close);
		for (const id of ['kernel-interrupt', 'kernel-restart', 'kernel-shutdown', 'kernel-wipe-vars']) {
			expect(inside, `${id} must not be inside the name button`).not.toContain(id);
		}
	});

	it('keeps every per-kernel control a button of its own with its own label', () => {
		for (const id of ['kernel-interrupt', 'kernel-restart', 'kernel-shutdown', 'kernel-wipe-vars']) {
			const at = row.indexOf(`data-testid="${id}"`);
			expect(at, `${id} missing`).toBeGreaterThan(-1);
			const open = row.lastIndexOf('<button', at);
			expect(open, `${id} is not on a <button>`).toBeGreaterThan(-1);
			expect(row.slice(open, at)).toMatch(/aria-label=/);
		}
	});
});

describe('SOURCE-SHAPE GUARD: the shell declares the row’s route through the file tree’s open path', () => {
	it('hands the Sidebar an onOpenNotebook handler', () => {
		expect(SHELL).toContain('onOpenNotebook={openKernelNotebook}');
	});

	it('routes it through openFilePermanent rather than a second open implementation', () => {
		const start = SHELL.indexOf('async function openKernelNotebook(');
		expect(start, 'no openKernelNotebook').toBeGreaterThan(-1);
		const body = SHELL.slice(start, SHELL.indexOf('\n\tfunction promoteTab(', start));
		expect(body).toContain('openFilePermanent(path)');
		// It must ASK before minting a tab: a card can outlive its file (a rename
		// rekeys the document and leaves the kernel registered at the old path), and
		// opening blind leaves an error-only tab.
		//
		// These two witness that the pre-flight and the report are WRITTEN, nothing
		// more: neither runs the handler, so both pass against a branch that can
		// never be reached, and moving the URL into a helper or renaming the notice
		// fails them without changing what a user sees. That the stale card really
		// reports the server's own reason and mints no tab is asserted for real by
		// `tests/e2e/kernel-card-open-notebook.spec.ts` (not run in CI or the gate).
		expect(body).toContain('/api/notebooks?path=');
		expect(body).toMatch(/showNotice\(/);
	});

	it('never labels a card with the kernelspec name', () => {
		const start = SHELL.indexOf('const kernelCards =');
		expect(start).toBeGreaterThan(-1);
		const body = SHELL.slice(start, SHELL.indexOf('\n\tfunction tabIdFor(', start));
		// The rule ITSELF is executed by the `kernelCardName` describe above; this
		// only witnesses that BOTH card-construction branches are declared to call
		// it (the closed-card branch is the one that read `python3`). It is source
		// text, so it survives a rename of the `cardName` alias no better than it
		// would survive the branch becoming unreachable. The rendered label is
		// asserted against a real closed card in the e2e spec named above.
		expect(body).not.toMatch(/name:\s*tab\?\.title\s*\|\|\s*k\.name/);
		expect(body.match(/name: cardName\(/g)?.length).toBe(2);
	});
});
