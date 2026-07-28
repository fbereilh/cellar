import { describe, it, expect } from 'vitest';
import {
	COLLAPSED_KEY_PREFIX,
	COLLAPSED_PREVIEW_CAP,
	collapsedKeyFor,
	collapsedPreview,
	sanitizeCollapsed,
	withCollapse,
	withoutCells,
	type CollapsedRecord
} from '../../src/lib/cellCollapse';
import { estimateHeight, COLLAPSED_CELL_PX, CARD_CHROME_PX, CODE_LINE_PX } from '../../src/lib/virtualization';

/**
 * The pure half of full-cell collapse (hide input + output, header only).
 *
 * The rendering half - which blocks disappear, the header keeping the cell id, the
 * chevron round-trip - needs a real browser and lives in
 * `tests/e2e/cell-collapse.spec.ts`; vitest runs without the SvelteKit plugin, so a
 * component cannot be mounted here.
 */

describe('collapsedKeyFor', () => {
	it('keys the record by the notebook, so two notebooks never share collapse state', () => {
		expect(collapsedKeyFor('/ws/a.ipynb')).toBe(`${COLLAPSED_KEY_PREFIX}/ws/a.ipynb`);
		expect(collapsedKeyFor('/ws/b.ipynb')).not.toBe(collapsedKeyFor('/ws/a.ipynb'));
	});

	it('is null before the notebook’s canonical id is known (nothing to key by)', () => {
		expect(collapsedKeyFor(null)).toBeNull();
		expect(collapsedKeyFor(undefined)).toBeNull();
		expect(collapsedKeyFor('')).toBeNull();
	});
});

describe('sanitizeCollapsed', () => {
	it('keeps explicit true entries', () => {
		expect(sanitizeCollapsed({ a: true, b: true })).toEqual({ a: true, b: true });
	});

	it('drops anything that is not an explicit true, rather than reading it for truthiness', () => {
		// The store is a hand-editable per-project JSON file and an older build may have
		// written another shape; a stray truthy value must never collapse a cell nobody
		// collapsed.
		expect(sanitizeCollapsed({ a: 'yes', b: 1, c: {}, d: false, e: null, f: true })).toEqual({ f: true });
	});

	it('degrades a missing / non-object / array value to an empty record', () => {
		expect(sanitizeCollapsed(null)).toEqual({});
		expect(sanitizeCollapsed(undefined)).toEqual({});
		expect(sanitizeCollapsed('nope')).toEqual({});
		expect(sanitizeCollapsed(['a', 'b'])).toEqual({});
	});
});

describe('withCollapse', () => {
	it('collapsing stores true; expanding DELETES the entry rather than storing false', () => {
		const collapsed = withCollapse({}, 'a', true);
		expect(collapsed).toEqual({ a: true });
		const expanded = withCollapse(collapsed, 'a', false);
		expect(expanded).toEqual({});
		expect(Object.prototype.hasOwnProperty.call(expanded, 'a')).toBe(false);
	});

	it('returns a NEW record on a change (Svelte reactivity) and leaves the old one alone', () => {
		const before: CollapsedRecord = { a: true };
		const after = withCollapse(before, 'b', true);
		expect(after).not.toBe(before);
		expect(before).toEqual({ a: true });
		expect(after).toEqual({ a: true, b: true });
	});

	it('is a no-op - same identity, so no re-render and no store write - when nothing changes', () => {
		const record: CollapsedRecord = { a: true };
		expect(withCollapse(record, 'a', true)).toBe(record);
		expect(withCollapse(record, 'z', false)).toBe(record);
	});
});

describe('withoutCells (the delete-path cleanup)', () => {
	it('drops every deleted cell’s entry in one pass', () => {
		expect(withoutCells({ a: true, b: true, c: true }, ['a', 'c'])).toEqual({ b: true });
	});

	it('keeps its identity when no deleted cell was collapsed', () => {
		const record: CollapsedRecord = { a: true };
		expect(withoutCells(record, ['x', 'y'])).toBe(record);
		expect(withoutCells(record, [])).toBe(record);
	});

	it('leaves no entry behind for a deleted cell (the persisted record cannot leak)', () => {
		const record = withoutCells({ a: true, b: true }, ['a', 'b']);
		expect(Object.keys(record)).toEqual([]);
	});
});

describe('collapsedPreview', () => {
	it('previews the first line of source', () => {
		expect(collapsedPreview('import pandas as pd\nimport numpy as np')).toBe('import pandas as pd');
	});

	it('skips leading blank lines - a preview of nothing identifies nothing', () => {
		expect(collapsedPreview('\n\n   \ndf = load()\n')).toBe('df = load()');
	});

	it('trims each candidate line', () => {
		expect(collapsedPreview('   ## Setup   ')).toBe('## Setup');
	});

	it('elides past the cap, so one pathological line cannot be handed to the DOM whole', () => {
		const long = 'x'.repeat(COLLAPSED_PREVIEW_CAP + 50);
		const preview = collapsedPreview(long);
		expect(preview).toHaveLength(COLLAPSED_PREVIEW_CAP + 1); // + the ellipsis
		expect(preview.endsWith('…')).toBe(true);
		expect(collapsedPreview('x'.repeat(COLLAPSED_PREVIEW_CAP))).not.toContain('…');
	});

	it('is empty (never throws) for an empty / whitespace-only / missing source', () => {
		expect(collapsedPreview('')).toBe('');
		expect(collapsedPreview('  \n\t\n ')).toBe('');
		expect(collapsedPreview(null)).toBe('');
		expect(collapsedPreview(undefined)).toBe('');
	});
});

describe('estimateHeight of a collapsed cell (the windowing half)', () => {
	const tall = { id: 'a', cell_type: 'code', source: 'x = 1\n'.repeat(80), outputs: [{}, {}, {}] };

	it('is the header row alone, whatever the cell contains', () => {
		expect(estimateHeight(tall, true)).toBe(COLLAPSED_CELL_PX);
		expect(estimateHeight({ id: 'b', cell_type: 'markdown', source: '# t\n'.repeat(40) }, true)).toBe(COLLAPSED_CELL_PX);
	});

	it('is far shorter than the same cell expanded, so the window reserves no phantom flow', () => {
		expect(estimateHeight(tall, true)).toBeLessThan(estimateHeight(tall) / 10);
	});

	it('leaves the expanded estimate untouched (collapse defaults to false)', () => {
		expect(estimateHeight({ id: 'c', cell_type: 'code', source: 'a\nb' })).toBe(CARD_CHROME_PX + 2 * CODE_LINE_PX);
		expect(estimateHeight({ id: 'c', cell_type: 'code', source: 'a\nb' }, false)).toBe(CARD_CHROME_PX + 2 * CODE_LINE_PX);
	});
});
