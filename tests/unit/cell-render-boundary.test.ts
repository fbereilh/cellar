/**
 * The per-cell render error boundary: one malformed kernel output must cost ONE
 * cell, not the whole notebook.
 *
 * Cellar renders arbitrary kernel output, so a renderer that throws is a recurring
 * failure class. Before the boundary, `Notebook.svelte` mounted every cell in one
 * Svelte flush with no isolation anywhere in `src/`, so an uncaught render throw took
 * the ENTIRE document's render tree with it - windowed, everything below the bad cell
 * stayed blank forever; with "Render all cells" on, NOTHING rendered at all
 * (`data/cellar-virt-55cell-bugs-w7/report.md` §7b).
 *
 * TWO HALVES, and read what each is worth before adding to either:
 *
 *  1. The EXECUTED rules (`$lib/cellRenderFailure`). The placeholder's reserved
 *     height is the load-bearing half of the fix - windowing plans the document's
 *     flow from a cache of measured heights, so a placeholder that collapsed to the
 *     height of its own message would trade a fatal bug for the height-cache mismatch
 *     class windowing exists to avoid - and it is a rule, so it lives in a pure module
 *     and is really run here.
 *
 *  2. SOURCE GUARDS on the wiring in `Notebook.svelte`. vitest deliberately runs
 *     without the SvelteKit plugin (see `vitest.config.ts`), so the component cannot
 *     be MOUNTED here; these witness only that the wiring is DECLARED, would survive
 *     dead markup, and break on a behaviour-preserving rename. They are kept for the
 *     same reason `notebook-toolbar-guards.test.ts` keeps its own: Playwright e2e runs
 *     in NEITHER CI nor the no-mistakes gate, so without them the boundary could be
 *     removed and merge green with no CI-visible coverage at all. The structural ones
 *     match balanced tags rather than raw substrings, so a `<Cell>` that moved OUT of
 *     the boundary fails instead of passing on a mention elsewhere.
 *
 * The BEHAVIOURAL proof - a genuinely malformed output rendering as a placeholder in
 * a real browser while its neighbours keep working, and the windowed scroll position
 * staying put as it fails and as it scrolls in and out of the window - is
 * `tests/e2e/cell-render-boundary.spec.ts`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	reservedFailureHeight,
	failureDetail,
	FAILURE_DETAIL_MAX
} from '../../src/lib/cellRenderFailure';
import { estimateHeight, COLLAPSED_CELL_PX, planWindow } from '../../src/lib/virtualization';

const NOTEBOOK = readFileSync(join(process.cwd(), 'src/lib/Notebook.svelte'), 'utf8');

const codeCell = (id: string, lines = 3, outputs = 1) => ({
	id,
	cell_type: 'code',
	source: Array.from({ length: lines }, (_, i) => `line ${i}`).join('\n'),
	outputs: Array.from({ length: outputs }, () => ({}))
});

describe('reservedFailureHeight - what a failed cell must occupy', () => {
	it('reuses the cell LAST MEASURED height, so the flow does not move when it fails', () => {
		const cell = codeCell('a');
		const heights = new Map([['a', 742]]);
		expect(reservedFailureHeight(cell, heights)).toBe(742);
	});

	it('falls back to the SAME estimate the window planned it at when it never mounted', () => {
		// A cell that throws on its very first mount is the common case: it has never
		// been measured, so the only honest number is the one its spacer was already
		// standing in for. Asserted against `estimateHeight` itself rather than a
		// literal, because the property is that the two agree.
		const cell = codeCell('a');
		expect(reservedFailureHeight(cell, new Map())).toBe(estimateHeight(cell));
		expect(reservedFailureHeight(cell, new Map())).toBeGreaterThan(0);
	});

	it('honours a fully collapsed cell, which draws only its header row', () => {
		const cell = codeCell('a', 40, 3);
		expect(reservedFailureHeight(cell, new Map(), true)).toBe(COLLAPSED_CELL_PX);
		// ...and a MEASURED height still wins: it is what the DOM really had.
		expect(reservedFailureHeight(cell, new Map([['a', 900]]), true)).toBe(900);
	});

	it('ignores a non-positive cached height rather than reserving nothing', () => {
		// `recordHeight` never stores one, but a zero here would collapse the row - the
		// exact failure this function exists to prevent - so it degrades to the estimate.
		const cell = codeCell('a');
		expect(reservedFailureHeight(cell, new Map([['a', 0]]))).toBe(estimateHeight(cell));
	});

	it('keeps the plan and the DOM agreeing: a spacer reproduces the reserved height', () => {
		// The coherence property stated as arithmetic. A failed cell's placeholder
		// reserves H; scrolled out of the window it becomes a spacer of H; so the
		// document's total extent is the same either way, and nothing below it moves.
		const cells = [codeCell('a'), codeCell('bad'), codeCell('c')];
		const heights = new Map<string, number>([
			['a', 100],
			['bad', 350],
			['c', 100]
		]);
		const reserved = reservedFailureHeight(cells[1], heights);
		const plan = planWindow({
			order: ['a', 'bad', 'c'],
			heights,
			estimate: (id) => estimateHeight(cells.find((c) => c.id === id)!),
			virtualize: true,
			viewportTop: 5000, // everything far above the window
			viewportHeight: 100,
			overscanPx: 0
		});
		const spacer = plan.find((p) => p.kind === 'spacer');
		expect(spacer).toBeDefined();
		// One coalesced spacer for all three: its height is Σ heights + the inter-cell
		// gaps, so the bad cell contributes exactly what its placeholder reserves.
		expect(spacer!.kind === 'spacer' && spacer!.px).toBe(100 + reserved + 100);
	});
});

describe('failureDetail - one line of cause, never a stack', () => {
	it('carries the error name and message', () => {
		expect(failureDetail(new TypeError('a(...).map is not a function'))).toBe(
			'TypeError: a(...).map is not a function'
		);
	});

	it('never leaks the stack', () => {
		const err = new Error('boom');
		err.stack = 'Error: boom\n    at Notebook.svelte:475:9\n    at flush';
		const detail = failureDetail(err);
		expect(detail).toBe('Error: boom');
		expect(detail).not.toContain('Notebook.svelte');
		expect(detail).not.toContain('\n');
	});

	it('elides a very long message rather than pushing the placeholder open', () => {
		const detail = failureDetail(new Error('x'.repeat(1000)));
		expect(detail.length).toBeLessThanOrEqual(FAILURE_DETAIL_MAX);
		expect(detail.endsWith('…')).toBe(true);
	});

	it('reports a non-Error throw, and nothing at all for an absent one', () => {
		expect(failureDetail('plain string')).toBe('plain string');
		expect(failureDetail(null)).toBe('');
		expect(failureDetail(undefined)).toBe('');
	});

	it('degrades to no detail rather than throwing on a value it cannot stringify', () => {
		// A placeholder that cannot render is the one failure this must never have.
		const hostile = Object.create(null) as unknown;
		expect(() => failureDetail(hostile)).not.toThrow();
		expect(failureDetail(hostile)).toBe('');
	});
});

// ---- Source guards on the wiring (see the header for what these are worth) ----

/** The source of the `<tag …>…</tag>` element opening at `open`, balanced by nesting. */
function elementBlock(src: string, tag: string, open: number): string {
	const openTag = new RegExp(`<${tag}(?=[\\s>])`, 'g');
	const closeTag = `</${tag}>`;
	let depth = 0;
	let i = open;
	while (i < src.length) {
		openTag.lastIndex = i;
		const nextOpen = openTag.exec(src)?.index ?? -1;
		const nextClose = src.indexOf(closeTag, i);
		if (nextClose === -1) throw new Error(`<${tag}> opened at ${open} is never closed`);
		if (nextOpen !== -1 && nextOpen < nextClose) {
			depth++;
			i = nextOpen + 1;
			continue;
		}
		depth--;
		if (depth === 0) return src.slice(open, nextClose + closeTag.length);
		i = nextClose + closeTag.length;
	}
	throw new Error(`<${tag}> opened at ${open} is never closed`);
}

describe('Notebook.svelte wiring', () => {
	// Search from `</script>` so the mention in the script block's own comment is not
	// mistaken for the markup element.
	const boundaryAt = NOTEBOOK.indexOf('<svelte:boundary', NOTEBOOK.indexOf('</script>'));
	const boundary = boundaryAt === -1 ? '' : elementBlock(NOTEBOOK, 'svelte:boundary', boundaryAt);

	it('wraps each cell row in a boundary', () => {
		expect(boundaryAt, 'no <svelte:boundary> in Notebook.svelte').toBeGreaterThan(-1);
	});

	it('puts EVERY <Cell> inside the boundary', () => {
		// The whole fix is the containment: a `<Cell>` that drifted out of the boundary
		// would still render, still pass every "the cells are there" check, and be
		// exactly as fatal as before. So the claim is about every `<Cell>` this
		// component mounts, not merely that one of them is wrapped - matched
		// structurally over comment-free markup, so a mention in prose cannot satisfy
		// it and a second, unwrapped one cannot hide behind the first.
		// Comments are stripped so the prose that mentions `<Cell>` cannot stand in for
		// the element, and both the count and the containment are asserted over that
		// same comment-free text so the offsets line up.
		const markup = NOTEBOOK.slice(NOTEBOOK.indexOf('</script>')).replace(/<!--[\s\S]*?-->/g, '');
		const cellUses = [...markup.matchAll(/<Cell(?=[\s>/])/g)];
		expect(cellUses.length, 'expected exactly one <Cell> element').toBe(1);
		const span = elementBlock(markup, 'svelte:boundary', markup.indexOf('<svelte:boundary'));
		const start = markup.indexOf(span);
		const at = cellUses[0].index!;
		expect(at, '<Cell> is outside the boundary').toBeGreaterThan(start);
		expect(at).toBeLessThan(start + span.length);
	});

	it('gives the boundary a `failed` snippet that renders the placeholder', () => {
		expect(boundary).toMatch(/\{#snippet failed\(/);
		expect(boundary).toContain('cellRenderFailure(cell, error)');
	});

	it('REPORTS the error rather than swallowing it', () => {
		// The boundary makes a broken renderer survivable, which is what risks making
		// it invisible: several e2e specs catch a render regression by asserting on
		// console errors, and a silent boundary would retire that assertion.
		expect(boundary).toContain('onerror=');
		expect(NOTEBOOK).toMatch(/function onCellRenderError[\s\S]{0,200}console\.error/);
	});

	it('reserves the placeholder height through the shared rule, not a literal', () => {
		const at = NOTEBOOK.indexOf('data-testid="cell-render-error"');
		expect(at, 'no cell-render-error placeholder').toBeGreaterThan(-1);
		const div = NOTEBOOK.slice(NOTEBOOK.lastIndexOf('<div', at), at);
		expect(div).toContain('min-height: {renderFailureHeight(cell)}');
		expect(NOTEBOOK).toMatch(/renderFailureHeight[\s\S]{0,300}reservedFailureHeight\(/);
	});

	it('MEASURES the placeholder back into the same height cache', () => {
		// Reserving alone freezes the cache at a height nothing occupies; measuring is
		// what makes the plan converge on what the DOM really renders.
		const at = NOTEBOOK.indexOf('data-testid="cell-render-error"');
		const div = NOTEBOOK.slice(at, NOTEBOOK.indexOf('>', NOTEBOOK.indexOf('{@attach', at)));
		expect(div).toContain('{@attach measureRenderFailure(cell.id)}');
		expect(NOTEBOOK).toMatch(/function measureRenderFailure[\s\S]{0,800}recordHeight\(id,/);
	});

	it('keeps the placeholder ADDRESSABLE but does not call it a cell', () => {
		// `ensureCellMounted` resolves nodes by `data-cell-id`, so without it every jump
		// path (find bar, outline, follow-running, j/k) would silently no-op on a failed
		// cell. It must NOT claim `data-testid="cell"`, or every "the cells are there"
		// assertion in the suite would pass over a notebook full of placeholders.
		const at = NOTEBOOK.indexOf('data-testid="cell-render-error"');
		const openAt = NOTEBOOK.lastIndexOf('<div', at);
		const tag = NOTEBOOK.slice(openAt, NOTEBOOK.indexOf('>', NOTEBOOK.indexOf('{@attach', at)));
		expect(tag).toContain('data-cell-id={cell.id}');
		expect(tag).not.toContain('data-testid="cell"');
	});
});
