/**
 * The Kernels-sidebar card keeps every control VISIBLE whenever it is CLICKABLE,
 * and the other way round.
 *
 * SOURCE SHAPE ONLY - read before trusting it. vitest runs without the SvelteKit
 * plugin (`vitest.config.ts`), so `Sidebar.svelte` cannot be mounted here and
 * nothing below is rendered or clicked. The behavioural proof - the invariant
 * measured in a real browser in both directions, at rest, under hover and under
 * keyboard focus, plus no overflow at the 180/200/256px sidebar widths - is
 * `tests/e2e/kernel-card-narrow-width.spec.ts`. That spec is absent from the
 * pre-push no-mistakes gate (vitest only), which is the whole reason this guard
 * exists: without it the hover-reveal could come back and clear the gate.
 *
 * WHY THIS PARTICULAR SHAPE. The card's controls used to sit at `opacity-0` at
 * rest and fade in on row hover / focus-within. Invisible is not inert: an
 * opacity-0 button is still hit-testable, so a click on the empty end of a row
 * fired Restart or Shut down. A floating variant of the same reveal was tried and
 * reverted after three rounds of the same defect class (clickable while
 * invisible, inert while visible at the transition midpoint, overlap on
 * hover-out). The card now has no reveal at all: a control is rendered, and so
 * both seen and clickable, or it is not rendered. These guards forbid every
 * class that would decouple the two again, anywhere in the row.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SIDEBAR = readFileSync(join(process.cwd(), 'src/lib/Sidebar.svelte'), 'utf8');

/** The `{#snippet kernelRow(...)}` body. A missing anchor FAILS rather than widening. */
function kernelRowSource(): string {
	const start = SIDEBAR.indexOf('{#snippet kernelRow(');
	expect(start, 'kernelRow snippet not found').toBeGreaterThan(-1);
	const end = SIDEBAR.indexOf('{/snippet}', start);
	expect(end, 'kernelRow snippet has no end').toBeGreaterThan(start);
	return SIDEBAR.slice(start, end);
}

/** Every `class="..."` attribute value in the row, comments stripped first. */
function rowClassLists(): string[] {
	const row = kernelRowSource().replace(/<!--[\s\S]*?-->/g, '');
	return [...row.matchAll(/class="([^"]*)"/g)].map((m) => m[1]);
}

/**
 * Tailwind utilities that make an element invisible while leaving it hit-testable,
 * hit-untestable while leaving it visible, or that switch either per interaction
 * state. Any of them on the row is the decoupling this guard exists to stop.
 */
const DECOUPLING: Array<[string, RegExp]> = [
	['opacity-0 (invisible but still hit-testable)', /(^|\s)([\w-]+:)*opacity-0(\s|$)/],
	['invisible / visibility toggles', /(^|\s)([\w-]+:)*(invisible|visible)(\s|$)/],
	['pointer-events toggles (visible but inert)', /(^|\s)([\w-]+:)*pointer-events-/],
	['an opacity transition (a visible-but-inert midpoint)', /(^|\s)([\w-]+:)*transition-opacity(\s|$)/],
	['a group-hover / group-focus reveal', /(^|\s)group-(hover|focus|focus-within|focus-visible|active):/],
	['a hover / focus opacity change', /(^|\s)(hover|focus|focus-within|focus-visible):opacity-/]
];

describe('SOURCE-SHAPE GUARD: the kernel card has no hover/focus reveal', () => {
	it('finds the row and its controls (so the guards below are not vacuous)', () => {
		const row = kernelRowSource();
		for (const id of ['kernel-notebook', 'kernel-controls', 'kernel-interrupt', 'kernel-restart', 'kernel-shutdown', 'kernel-wipe-vars']) {
			expect(row, `row lost data-testid="${id}"`).toContain(`data-testid="${id}"`);
		}
		expect(rowClassLists().length).toBeGreaterThan(10);
	});

	for (const [what, re] of DECOUPLING) {
		it(`no class in the row uses ${what}`, () => {
			const offending = rowClassLists().filter((c) => re.test(c));
			expect(offending, `offending class lists: ${JSON.stringify(offending)}`).toEqual([]);
		});
	}

	it('the predicate itself catches the reverted shapes (guards against a vacuous regex)', () => {
		const reverted = [
			'flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100',
			'absolute right-0 invisible group-hover:visible',
			'pointer-events-none group-hover:pointer-events-auto'
		];
		for (const c of reverted) {
			expect(DECOUPLING.some(([, re]) => re.test(c)), c).toBe(true);
		}
		// ...and a real class list from the row passes.
		expect(DECOUPLING.some(([, re]) => re.test('ml-auto flex shrink-0 items-center gap-0.5'))).toBe(false);
	});
});

describe('SOURCE-SHAPE GUARD: the name owns line 1, everything else wraps on line 2', () => {
	it('the controls, memory figure and state words sit inside the wrapping meta line, not beside the name', () => {
		const row = kernelRowSource();
		const meta = row.indexOf('data-testid="kernel-card-meta"');
		expect(meta, 'the second line (kernel-card-meta) is gone').toBeGreaterThan(-1);
		const metaOpen = row.lastIndexOf('<div', meta);
		expect(row.slice(metaOpen, meta)).toMatch(/flex-wrap/);
		for (const id of ['kernel-controls', 'kernel-memory', 'kernel-not-started', 'kernel-wipe-confirm', 'kernel-acting']) {
			const at = row.indexOf(`data-testid="${id}"`);
			expect(at, `${id} missing`).toBeGreaterThan(-1);
			expect(at, `${id} must sit on the wrapping second line, after the name`).toBeGreaterThan(meta);
		}
		// The name button is on line 1, before the meta line.
		expect(row.indexOf('data-testid="kernel-notebook"')).toBeLessThan(meta);
	});
});
