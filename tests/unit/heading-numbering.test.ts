import { describe, it, expect } from 'vitest';
import {
	computeHeadingNumbers,
	headingNumberPrefix,
	numberHeadingLine,
	outlineHeadings
} from '../../src/lib/headings';

// Build cells (one heading per markdown cell for clarity) and number them.
function numbersFor(headings: { id: string; level: number }[], enabled: number[]) {
	const cells = headings.map((h) => ({
		id: h.id,
		cell_type: 'markdown',
		source: `${'#'.repeat(h.level)} ${h.id}`
	}));
	return computeHeadingNumbers(outlineHeadings(cells), new Set(enabled));
}

describe('computeHeadingNumbers', () => {
	it('numbers a single enabled level flat', () => {
		const n = numbersFor(
			[
				{ id: 'a', level: 2 },
				{ id: 'b', level: 2 },
				{ id: 'c', level: 2 }
			],
			[2]
		);
		expect(n).toEqual({ a: '1', b: '2', c: '3' });
	});

	it('numbers two enabled levels hierarchically with resets', () => {
		const n = numbersFor(
			[
				{ id: 'h1a', level: 1 },
				{ id: 'h2a', level: 2 },
				{ id: 'h2b', level: 2 },
				{ id: 'h1b', level: 1 },
				{ id: 'h2c', level: 2 }
			],
			[1, 2]
		);
		expect(n).toEqual({ h1a: '1', h2a: '1.1', h2b: '1.2', h1b: '2', h2c: '2.1' });
	});

	it('skips disabled levels entirely (no number, no counter effect)', () => {
		const n = numbersFor(
			[
				{ id: 'h1', level: 1 },
				{ id: 'h2', level: 2 }, // disabled → skipped
				{ id: 'h3a', level: 3 },
				{ id: 'h3b', level: 3 }
			],
			[1, 3]
		);
		// H2 gets no number; H1 is slot 0, H3 is slot 1.
		expect(n).toEqual({ h1: '1', h3a: '1.1', h3b: '1.2' });
	});

	it('drops leading zeros when a deeper heading precedes its parent', () => {
		const n = numbersFor(
			[
				{ id: 'orphan', level: 2 }, // no H1 yet → "1", not "0.1"
				{ id: 'h1', level: 1 },
				{ id: 'child', level: 2 }
			],
			[1, 2]
		);
		expect(n).toEqual({ orphan: '1', h1: '1', child: '1.1' });
	});

	it('returns nothing when no levels are enabled', () => {
		expect(numbersFor([{ id: 'a', level: 1 }], [])).toEqual({});
	});

	it('numbers multiple headings living in one cell in document order', () => {
		const cells = [{ id: 'c1', cell_type: 'markdown', source: '# Intro\n## Setup\n## Details' }];
		const n = computeHeadingNumbers(outlineHeadings(cells), new Set([1, 2]));
		// leading heading keyed by cell id, the rest by `<cellId>#<segIndex>`.
		expect(n).toEqual({ c1: '1', 'c1#1': '1.1', 'c1#2': '1.2' });
	});
});

describe('headingNumberPrefix', () => {
	it('keeps a trailing period for flat numbers, drops it for dotted ones', () => {
		expect(headingNumberPrefix('1')).toBe('1. ');
		expect(headingNumberPrefix('2.3')).toBe('2.3 ');
	});
});

describe('numberHeadingLine', () => {
	it('injects the number into a heading line, preserving the level', () => {
		expect(numberHeadingLine('## Header', '1')).toBe('## 1. Header');
		expect(numberHeadingLine('### Deep', '2.3')).toBe('### 2.3 Deep');
	});
	it('returns the line unchanged with no number or on a non-heading', () => {
		expect(numberHeadingLine('## Header', undefined)).toBe('## Header');
		expect(numberHeadingLine('not a heading', '1')).toBe('not a heading');
	});
});
