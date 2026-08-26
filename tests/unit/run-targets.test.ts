import { describe, it, expect } from 'vitest';
import {
	chatSkipNotice,
	codeIdsAll,
	codeIdsAbove,
	runTargets,
	runTargetsAbove,
	type RunTargetCell
} from '../../src/lib/runTargets';

const nb: RunTargetCell[] = [
	{ id: 'a', cell_type: 'markdown' },
	{ id: 'b', cell_type: 'code' },
	{ id: 'c', cell_type: 'markdown' },
	{ id: 'd', cell_type: 'code' },
	{ id: 'e', cell_type: 'code' }
];

describe('codeIdsAll', () => {
	it('returns every code cell in document order, skipping non-code', () => {
		expect(codeIdsAll(nb)).toEqual(['b', 'd', 'e']);
	});
	it('is empty for a markdown-only notebook', () => {
		expect(codeIdsAll([{ id: 'x', cell_type: 'markdown' }])).toEqual([]);
	});
	it('is empty for an empty notebook', () => {
		expect(codeIdsAll([])).toEqual([]);
	});
});

describe('codeIdsAbove', () => {
	it('returns code cells strictly above the target (exclusive of it and below)', () => {
		// Above 'd' (index 3): a(md), b(code), c(md) -> only 'b'.
		expect(codeIdsAbove(nb, 'd')).toEqual(['b']);
		// Above 'e' (index 4): b and d.
		expect(codeIdsAbove(nb, 'e')).toEqual(['b', 'd']);
	});
	it('excludes the target cell itself even when it is code', () => {
		expect(codeIdsAbove(nb, 'b')).not.toContain('b');
	});
	it('is a no-op ([]) for the first cell', () => {
		expect(codeIdsAbove(nb, 'a')).toEqual([]);
	});
	it('is a no-op ([]) when the first cell is a code cell', () => {
		const nb2: RunTargetCell[] = [
			{ id: 'first', cell_type: 'code' },
			{ id: 'second', cell_type: 'code' }
		];
		expect(codeIdsAbove(nb2, 'first')).toEqual([]);
		expect(codeIdsAbove(nb2, 'second')).toEqual(['first']);
	});
	it('is a no-op ([]) for an unknown id', () => {
		expect(codeIdsAbove(nb, 'nope')).toEqual([]);
	});
	it('skips non-code cells above the target', () => {
		const nb3: RunTargetCell[] = [
			{ id: 'm1', cell_type: 'markdown' },
			{ id: 'm2', cell_type: 'markdown' },
			{ id: 'target', cell_type: 'code' }
		];
		expect(codeIdsAbove(nb3, 'target')).toEqual([]);
	});
});

/**
 * A CHAT cell is an nbformat code cell tagged `cellar.language='chat'`, so the
 * plain type test selected it - and running one is a billed model turn holding
 * the notebook's queue slot, not a kernel execution. A bulk run leaves it alone
 * and REPORTS it; a SQL cell (the other tagged code cell) still runs, since it
 * really is a kernel execution.
 */
const chat = (id: string): RunTargetCell => ({ id, cell_type: 'code', metadata: { cellar: { language: 'chat' } } });
const sql = (id: string): RunTargetCell => ({ id, cell_type: 'code', metadata: { cellar: { language: 'sql' } } });

const mixed: RunTargetCell[] = [
	{ id: 'md', cell_type: 'markdown' },
	{ id: 'py1', cell_type: 'code' },
	chat('chat1'),
	sql('sql1'),
	{ id: 'py2', cell_type: 'code' },
	chat('chat2'),
	{ id: 'rawc', cell_type: 'raw' }
];

describe('a bulk run skips chat cells and reports them', () => {
	it('partitions: python and SQL run, chat is skipped and named', () => {
		expect(runTargets(mixed)).toEqual({
			ids: ['py1', 'sql1', 'py2'],
			chatSkipped: ['chat1', 'chat2']
		});
	});

	it('the id-only halves agree with the partition, so no caller can disagree', () => {
		expect(codeIdsAll(mixed)).toEqual(runTargets(mixed).ids);
		expect(codeIdsAll(mixed)).not.toContain('chat1');
		expect(codeIdsAbove(mixed, 'py2')).toEqual(runTargetsAbove(mixed, 'py2').ids);
	});

	it('Run above reports only the chat cells ABOVE the target', () => {
		// Above 'py2' (index 4): md, py1, chat1, sql1.
		expect(runTargetsAbove(mixed, 'py2')).toEqual({ ids: ['py1', 'sql1'], chatSkipped: ['chat1'] });
		// Above the first cell: nothing at all, so nothing to report.
		expect(runTargetsAbove(mixed, 'md')).toEqual({ ids: [], chatSkipped: [] });
		expect(runTargetsAbove(mixed, 'nope')).toEqual({ ids: [], chatSkipped: [] });
	});

	it('a notebook with no chat cell reports nothing (an ordinary run is unchanged)', () => {
		expect(runTargets(nb)).toEqual({ ids: ['b', 'd', 'e'], chatSkipped: [] });
	});

	it('a batch of nothing BUT chat cells runs nothing and says why', () => {
		const sel = runTargets([chat('c1'), chat('c2')]);
		expect(sel.ids).toEqual([]);
		expect(sel.chatSkipped).toEqual(['c1', 'c2']);
	});
});

describe('the notice a skip is reported through', () => {
	it('names the count, agrees in number, and points at the deliberate route', () => {
		expect(chatSkipNotice(1)).toContain('1 chat cell');
		expect(chatSkipNotice(1)).not.toContain('1 chat cells');
		expect(chatSkipNotice(3)).toContain('3 chat cells');
		for (const n of [1, 3]) {
			expect(chatSkipNotice(n)).toMatch(/run/i);
			expect(chatSkipNotice(n)).toMatch(/Run button/);
		}
	});
});

describe('a mojo cell is a RUNNABLE cell, so a bulk run includes it', () => {
	// Deliberately unlike chat: a Mojo run costs a `mojo run` subprocess, not a
	// billed model turn, and re-running it is deterministic. So Run all / Run above
	// execute it exactly as they execute a SQL or Python cell, and it is never
	// reported as skipped.
	const mojoCell = (id: string) => ({ id, cell_type: 'code', metadata: { cellar: { language: 'mojo' } } });

	it('runTargets includes it and skips nothing', () => {
		const cells = [
			{ id: 'py', cell_type: 'code', metadata: {} },
			mojoCell('mj'),
			{ id: 'md', cell_type: 'markdown', metadata: {} },
			{ id: 'ch', cell_type: 'code', metadata: { cellar: { language: 'chat' } } }
		];
		const out = runTargets(cells as never);
		expect(out.ids).toEqual(['py', 'mj']);
		expect(out.chatSkipped).toEqual(['ch']);
	});

	it('runTargetsAbove includes it', () => {
		const cells = [mojoCell('mj'), { id: 'py', cell_type: 'code', metadata: {} }];
		expect(runTargetsAbove(cells as never, 'py').ids).toEqual(['mj']);
	});
});
