/**
 * Perf finding A1: `LiveNotebook` memoizes `headingNumbers` on the SAME heading
 * signature the fold cache uses (`foldSignature(cells)`) + the enabled-levels set
 * identity, so an unrelated `cells` change (a code-cell edit-flush, a streaming
 * output tick) no longer produces a fresh `headingNumbers` object. A fresh object
 * identity would fan out as a prop into every Cell and re-run markdown-it +
 * DOMPurify on every markdown cell (Cell.svelte `segments`) — a re-sanitize storm.
 *
 * The memo is only correct if:
 *   (1) the signature captures EXACTLY what `computeHeadingNumbers(outlineHeadings(cells))`
 *       reads (heading layout), so a code edit / output arriving is a cache hit, and
 *   (2) equal signature ⇒ identical numbering (value-identical to the unmemoized derived).
 *
 * This file pins (1)+(2) on the pure functions, then re-implements the component's
 * tiny memo closure verbatim to prove the observable behavior: stable OBJECT
 * IDENTITY across a code-cell edit, and a correct NEW value on a heading/level change.
 */
import { describe, it, expect } from 'vitest';
import { foldSignature, computeHeadingNumbers, outlineHeadings } from '../../src/lib/headings';

type Cell = { id: string; cell_type: string; source: string; outputs?: unknown[]; execution_count?: number | null };
const md = (id: string, source: string): Cell => ({ id, cell_type: 'markdown', source });
const code = (id: string, source: string, extra: Partial<Cell> = {}): Cell => ({ id, cell_type: 'code', source, ...extra });

// The exact memo from LiveNotebook.svelte, extracted so the invariant is testable
// without a component harness. Keyed on the fold signature + the levels-set identity.
function makeHeadingNumbersMemo() {
	let cache: { sig: string; levels: Set<number>; value: Record<string, string> } | null = null;
	return (cells: Cell[], levels: Set<number>) => {
		const sig = foldSignature(cells);
		if (cache && cache.sig === sig && cache.levels === levels) return cache.value;
		const value = computeHeadingNumbers(outlineHeadings(cells), levels);
		cache = { sig, levels, value };
		return value;
	};
}

describe('headingNumbers memo — foldSignature is the correct cache key', () => {
	const base: Cell[] = [
		md('h1', '# Intro'),
		code('c1', 'x = 1'),
		md('h2', '## Setup'),
		code('c2', 'y = 2'),
		md('h3', '## Analysis')
	];

	it('is INVARIANT to a code cell being run (outputs / execution_count change)', () => {
		const after = foldSignature([
			base[0],
			{ ...base[1], outputs: [{ output_type: 'stream', name: 'stdout', text: 'noise'.repeat(1000) }], execution_count: 7 },
			base[2],
			base[3],
			base[4]
		]);
		expect(after).toBe(foldSignature(base));
	});

	it('is INVARIANT to a CODE cell being edited', () => {
		const after = foldSignature([base[0], code('c1', 'x = 42  # edited'), base[2], base[3], base[4]]);
		expect(after).toBe(foldSignature(base));
	});

	it('CHANGES when a heading (markdown) is edited', () => {
		const after = foldSignature([md('h1', '# Introduction'), base[1], base[2], base[3], base[4]]);
		expect(after).not.toBe(foldSignature(base));
	});

	it('equal signature ⇒ identical numbering (memo serves the right value)', () => {
		const levels = new Set([1, 2]);
		const edited: Cell[] = [
			base[0],
			code('c1', 'x = 99', { outputs: [{ output_type: 'stream', text: 'noise' }], execution_count: 3 }),
			base[2],
			base[3],
			base[4]
		];
		expect(foldSignature(edited)).toBe(foldSignature(base));
		expect(computeHeadingNumbers(outlineHeadings(edited), levels)).toEqual(
			computeHeadingNumbers(outlineHeadings(base), levels)
		);
	});
});

describe('headingNumbers memo — observable identity behavior', () => {
	const base: Cell[] = [md('h1', '# Intro'), code('c1', 'x = 1'), md('h2', '## Setup')];
	const levels = new Set([1, 2]);

	it('produces the correct numbers (value-identical to the unmemoized derived)', () => {
		const memo = makeHeadingNumbersMemo();
		const got = memo(base, levels);
		expect(got).toEqual(computeHeadingNumbers(outlineHeadings(base), levels));
		// h1 = '1', h2 = '1.1' under H1+H2 numbering.
		expect(got).toEqual({ [outlineHeadings(base)[0].key]: '1', [outlineHeadings(base)[1].key]: '1.1' });
	});

	it('returns the SAME object across a code-cell edit (no re-render fan-out)', () => {
		const memo = makeHeadingNumbersMemo();
		const first = memo(base, levels);
		// A code-cell edit-flush: new `cells` array + new code source, same headings.
		const editedCells: Cell[] = [base[0], code('c1', 'x = 2  # typed', { execution_count: 5 }), base[2]];
		const second = memo(editedCells, levels);
		expect(second).toBe(first); // stable identity ⇒ markdown cells do not re-sanitize
	});

	it('returns a NEW, correct object when a heading changes', () => {
		const memo = makeHeadingNumbersMemo();
		const first = memo(base, levels);
		const withNewHeading: Cell[] = [...base, md('h3', '# Conclusion')];
		const second = memo(withNewHeading, levels);
		expect(second).not.toBe(first);
		expect(second).toEqual(computeHeadingNumbers(outlineHeadings(withNewHeading), levels));
	});

	it('returns a NEW, correct object when the enabled levels change', () => {
		const memo = makeHeadingNumbersMemo();
		const first = memo(base, levels);
		const onlyH2 = new Set([2]); // a fresh Set identity — a numbering-setting change
		const second = memo(base, onlyH2);
		expect(second).not.toBe(first);
		expect(second).toEqual(computeHeadingNumbers(outlineHeadings(base), onlyH2));
	});
});
