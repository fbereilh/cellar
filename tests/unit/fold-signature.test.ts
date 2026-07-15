/**
 * Perf Tier 3, item 3: `LiveNotebook` memoizes the O(N) `computeFolding` re-parse
 * on `foldSignature(cells)` so it recomputes only when the HEADING LAYOUT changes,
 * not on every unrelated `cells` mutation (a run streaming outputs, a code edit).
 *
 * The memo is only correct if the signature captures EXACTLY what `computeFolding`
 * reads. These tests pin that contract on the pure `foldSignature`:
 *   - invariant to outputs / execution counts / metadata / code-cell source, and
 *   - sensitive to markdown source, cell type, id, and order —
 * plus a parity check that identical signatures always fold identically.
 */
import { describe, it, expect } from 'vitest';
import { foldSignature, computeFolding } from '../../src/lib/headings';

type Cell = { id: string; cell_type: string; source: string; outputs?: unknown[]; execution_count?: number | null };
const md = (id: string, source: string): Cell => ({ id, cell_type: 'markdown', source });
const code = (id: string, source: string, extra: Partial<Cell> = {}): Cell => ({ id, cell_type: 'code', source, ...extra });

describe('foldSignature — the memo key for computeFolding', () => {
	const base: Cell[] = [md('h1', '# Intro'), code('c1', 'x = 1'), md('h2', '## Setup'), code('c2', 'y = 2')];

	it('is INVARIANT to a code cell being run (outputs / execution_count change)', () => {
		const before = foldSignature(base);
		const after = foldSignature([
			base[0],
			{ ...base[1], outputs: [{ output_type: 'stream', name: 'stdout', text: 'lots of output'.repeat(1000) }], execution_count: 7 },
			base[2],
			base[3]
		]);
		expect(after).toBe(before); // an output arriving must not invalidate the fold layout
	});

	it('is INVARIANT to a CODE cell being edited (folding ignores code source)', () => {
		const after = foldSignature([base[0], code('c1', 'x = 42  # edited'), base[2], base[3]]);
		expect(after).toBe(foldSignature(base));
	});

	it('CHANGES when a MARKDOWN cell (a heading) is edited', () => {
		const after = foldSignature([md('h1', '# Introduction'), base[1], base[2], base[3]]);
		expect(after).not.toBe(foldSignature(base));
	});

	it('CHANGES on a structural edit (add / delete / reorder / retype)', () => {
		expect(foldSignature([...base, code('c3', 'z = 3')])).not.toBe(foldSignature(base)); // add
		expect(foldSignature([base[0], base[2], base[3]])).not.toBe(foldSignature(base)); // delete c1
		expect(foldSignature([base[0], base[2], base[1], base[3]])).not.toBe(foldSignature(base)); // reorder
		expect(foldSignature([base[0], md('c1', 'x = 1'), base[2], base[3]])).not.toBe(foldSignature(base)); // retype
	});

	it('equal signatures ⇒ identical computeFolding output (memo correctness)', () => {
		const folded = new Set(['h1']);
		// Two arrays that differ ONLY in things foldSignature excludes (outputs, code src).
		const a = base;
		const b: Cell[] = [
			base[0],
			code('c1', 'x = 99', { outputs: [{ output_type: 'stream', text: 'noise' }], execution_count: 3 }),
			base[2],
			base[3]
		];
		expect(foldSignature(a)).toBe(foldSignature(b));
		// Same signature ⇒ the memo would serve `a`'s value for `b`; prove that's correct.
		expect(computeFolding(b, folded)).toEqual(computeFolding(a, folded));
	});

	it('handles empty / nullish input', () => {
		expect(foldSignature([])).toBe('');
		expect(foldSignature(null)).toBe('');
		expect(foldSignature(undefined)).toBe('');
	});
});
