/**
 * Source guards for the notebook toolbar's three whole-notebook actions.
 *
 * WHAT THESE PROVE, AND WHAT THEY DO NOT. vitest runs without the SvelteKit
 * plugin (see `vitest.config.ts`), so `Notebook.svelte` cannot be mounted here —
 * these read the component source, so they can only witness that the wiring is
 * DECLARED, never that it behaves. The behavioural proof (the buttons render,
 * gate on real state, and really interrupt a batch / clear every cell's outputs
 * on disk) is `tests/e2e/toolbar-interrupt-clear-all.spec.ts`, against a real
 * kernel. These stay in the unit suite only because e2e runs in neither CI nor
 * the no-mistakes gate, so without them the two invariants below could regress
 * and merge green.
 *
 * Deliberately narrow: only what raw source text can honestly carry and what
 * survives a behaviour-preserving refactor — the controls exist and are
 * labelled, and the clear-all button reaches the SAME function the palette's
 * `clear-all-outputs` command does. Assertions on exact expressions (a
 * `$derived` line, an `onclick` body) belong to the e2e, not here: they break on
 * a rename and pass on dead code.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const NOTEBOOK = readFileSync(join(process.cwd(), 'src/lib/Notebook.svelte'), 'utf8');
const LIVE = readFileSync(join(process.cwd(), 'src/lib/LiveNotebook.svelte'), 'utf8');

const TOOLBAR_ACTIONS = ['run-all', 'interrupt-all', 'clear-all-outputs'];

/** The `<button …>` element whose `data-testid` is `id`. */
function buttonWith(testid: string): string {
	const marker = `data-testid="${testid}"`;
	const at = NOTEBOOK.indexOf(marker);
	expect(at, `no control carries data-testid="${testid}"`).toBeGreaterThan(-1);
	const open = NOTEBOOK.lastIndexOf('<button', at);
	const close = NOTEBOOK.indexOf('</button>', at);
	expect(open, `data-testid="${testid}" is not on a <button>`).toBeGreaterThan(-1);
	expect(close).toBeGreaterThan(at);
	return NOTEBOOK.slice(open, close);
}

/** The toolbar block, from its own marker to the element that follows it. */
const TOOLBAR = (() => {
	const at = NOTEBOOK.indexOf('data-testid="notebook-toolbar"');
	expect(at, 'the notebook toolbar is gone').toBeGreaterThan(-1);
	const end = NOTEBOOK.indexOf('</div>\n\t\t{#if showRootBar}', at);
	return NOTEBOOK.slice(at, end > at ? end : at + 4000);
})();

describe('notebook toolbar: the three whole-notebook actions', () => {
	it('renders Run all, Interrupt and Clear all outputs together', () => {
		for (const id of TOOLBAR_ACTIONS) {
			expect(TOOLBAR, `${id} is not in the toolbar`).toContain(`data-testid="${id}"`);
		}
	});

	it('gives each button a title and an aria-label', () => {
		for (const id of TOOLBAR_ACTIONS) {
			const btn = buttonWith(id);
			expect(btn, `${id} has no title`).toMatch(/title="/);
			expect(btn, `${id} has no aria-label`).toMatch(/aria-label="/);
		}
	});
});

describe('LiveNotebook wiring', () => {
	it('passes the palette command`s own clearAll in as onClearAll', () => {
		expect(LIVE).toContain('onClearAll={clearAll}');
		// The same function the `clear-all-outputs` command reaches through the
		// notebook API registry, so the button and the palette cannot diverge.
		expect(LIVE).toMatch(/onRegisterApi\?\.\([^)]*\bclearAll\b/);
	});

	it('passes the existing kernel interrupt in as onInterrupt', () => {
		expect(LIVE).toContain('onInterrupt={onInterruptKernel}');
	});
});
