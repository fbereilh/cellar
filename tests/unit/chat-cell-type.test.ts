/**
 * The 'chat' logical cell type: identity truth table, its exclusion from
 * staleness (n/a) and from the Python dataflow probe (prose never reaches
 * `ast`), and the source guards for the Svelte halves - vitest runs without the
 * SvelteKit plugin, so the component rules e2e alone would prove are pinned
 * here, the only layer CI and the no-mistakes gate see.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
	CHAT_LANGUAGE,
	cellLanguage,
	isChatCell,
	isLogicalCellType,
	isLogicalCellTypeName,
	languageTagFor,
	logicalCellType,
	nbCellType,
	LOGICAL_CELL_TYPES
} from '../../src/lib/cellLanguage';
import { computeStaleness, STALE_STATE } from '../../src/lib/staleness';
import type { Cell, CellView } from '../../src/lib/server/types';

// The dataflow probe spawns `projectPython() || 'python3'` (stdlib-only), the
// dataflow-load-before-store precedent.
vi.mock('../../src/lib/server/databricks', () => ({ projectPython: () => null }));
import { analyzeDataflow } from '../../src/lib/server/dataflow';

const chatCell = (id = 'c1', source = 'What changed?'): Cell => ({
	id,
	cell_type: 'code',
	source,
	outputs: [],
	metadata: { cellar: { language: 'chat' } }
});

const codeCell = (id: string, source: string): Cell => ({ id, cell_type: 'code', source, outputs: [], metadata: {} });

describe('identity (the cellLanguage truth table)', () => {
	it('a chat cell is an nbformat code cell tagged cellar.language=chat', () => {
		const c = chatCell();
		expect(isChatCell(c)).toBe(true);
		expect(cellLanguage(c)).toBe('chat');
		expect(logicalCellType(c)).toBe('chat');
		// The tag needs the code type: a markdown/raw cell wearing it is NOT chat.
		expect(isChatCell({ ...c, cell_type: 'markdown' })).toBe(false);
		expect(isChatCell({ ...c, cell_type: 'raw' })).toBe(false);
		expect(isChatCell(codeCell('x', 'y'))).toBe(false);
	});

	it('the one nbformat mapping and the one tag rule both know chat', () => {
		expect(nbCellType('chat')).toBe('code');
		expect(languageTagFor('chat')).toBe(CHAT_LANGUAGE);
		expect(languageTagFor('sql')).toBe('sql');
		expect(languageTagFor('code')).toBeNull();
		expect(languageTagFor('markdown')).toBeNull();
		expect(languageTagFor('raw')).toBeNull();
		expect(LOGICAL_CELL_TYPES).toContain('chat');
		expect(isLogicalCellTypeName('chat')).toBe(true);
	});

	it("the bulk-retype 'already' predicate distinguishes chat from code and sql", () => {
		expect(isLogicalCellType(chatCell(), 'chat')).toBe(true);
		expect(isLogicalCellType(chatCell(), 'code')).toBe(false); // a retype-to-code really converts
		expect(isLogicalCellType(chatCell(), 'sql')).toBe(false);
		expect(isLogicalCellType(codeCell('x', 'y'), 'chat')).toBe(false);
	});
});

describe('staleness: a chat cell is n/a, never fresh/stale', () => {
	it('reports n/a while its python siblings get real verdicts', () => {
		const ran = { at: 100, durationMs: 1, actor: 'user' as const, status: 'ok', session: 1 };
		const cells: Cell[] = [
			{ ...codeCell('up', 'x = 1'), metadata: { cellar: { lastRun: ran } } },
			{ ...chatCell('chat1'), metadata: { cellar: { language: 'chat', lastRun: ran } } },
			{ ...codeCell('down', 'print(x)'), metadata: { cellar: { lastRun: ran } } }
		];
		const df = { up: { defines: ['x'], uses: [] }, down: { defines: [], uses: ['x'] } };
		const map = computeStaleness(cells, df, 1);
		expect(map.up.state).toBe(STALE_STATE.FRESH);
		expect(map.down.state).toBe(STALE_STATE.FRESH);
		// A reply is nondeterministic: no re-run restores anything, so no verdict.
		expect(map.chat1.state).toBe(STALE_STATE.NA);
	});
});

describe('dataflow: chat prose never reaches the Python probe', () => {
	it('the python sibling parses fine and the chat cell contributes nothing', async () => {
		const cells = [
			codeCell('py', 'x = 1'),
			chatCell('chat1', 'Why is x one? This prose is not Python at all -- def not!')
		] as unknown as CellView[];
		const df = await analyzeDataflow(cells);
		expect(df.py).toMatchObject({ defines: ['x'], uses: [] });
		expect(df.chat1).toBeUndefined();
	});
});

describe('source guards on the Svelte/client halves', () => {
	const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

	it('the ONE tag rule is used everywhere - no site keeps a sql-only ternary', () => {
		for (const rel of ['../../src/lib/server/notebook.ts', '../../src/lib/LiveNotebook.svelte']) {
			const src = read(rel);
			expect(src).toContain('languageTagFor');
			// The drifting shorthand this rule replaced: a per-site sql-or-null pick.
			expect(src).not.toMatch(/\?\s*SQL_LANGUAGE\s*:\s*null/);
			expect(src).not.toMatch(/===\s*'sql'\s*\?\s*'sql'\s*:\s*null/);
		}
	});

	it('LiveNotebook does not report a chat run to the shell kernel counters', () => {
		// The badge forces {started:true, status:'busy'} while a run is in flight and
		// `markKernelStarted()` asserts a live kernel optimistically, both on the
		// premise that a run boots one. A chat run retires that premise, so it must
		// not fire either - and the two callbacks must stay PAIRED, or the in-flight
		// count is left standing and the badge reads busy forever.
		const src = read('../../src/lib/LiveNotebook.svelte');
		expect(src).toMatch(/const kernelRun = !isChatCell\(cell\)/);
		expect(src).toMatch(/if \(kernelRun\) onRunStart\?\.\(path, id\)/);
		expect(src).toMatch(/if \(kernelRun\) onRunEnd\?\.\(\)/);
		// Neither callback may be reached on an ungated path in `runCell`.
		const run = src.slice(src.indexOf('async function runCell('));
		const body = run.slice(0, run.indexOf('\n\tfunction ') > 0 ? run.indexOf('\n\tfunction ') : 8000);
		expect(body.match(/onRunStart\?\./g) ?? []).toHaveLength(1);
		expect(body.match(/onRunEnd\?\./g) ?? []).toHaveLength(1);
	});

	it('Cell.svelte offers the Chat type, renders text/markdown by CONTENT CLASS, and edits chat as markdown', () => {
		const src = read('../../src/lib/Cell.svelte');
		expect(src).toContain("{ v: 'chat', label: 'Chat', hint: 'claude' }");
		expect(src).toContain('chat-badge');
		expect(src).toContain("d['text/markdown']");
		// The renderer is picked by the CELL, not the mime: a chat reply is authored
		// prose (math on) sanitized through the profile that lets nothing in a
		// MODEL-generated reply fetch on render, while any other cell's text/markdown
		// is kernel OUTPUT - arbitrary data, where `display(Markdown('Revenue: $5 vs
		// $1,200'))` must keep its dollar amounts - so it takes the math-free
		// renderer. Both go through the shared sanitize funnel; the renderers' own
		// behavior is pinned in markdown-math.test.ts.
		expect(src).toMatch(/isChat \? renderChatReply\(md\) : renderOutputMarkdown\(md\)/);
		expect(src).toMatch(/if \(isChat\) return markdown\(\)/); // question edits as prose
	});

	it('the sidebar has a chat section and ChatPanel withholds sign-out from the borrowed login', async () => {
		const { DEFAULT_SECTION_ORDER } = await import('../../src/lib/sidebarSections');
		expect(DEFAULT_SECTION_ORDER).toContain('chat');
		const panel = read('../../src/lib/ChatPanel.svelte');
		// Sign-out exists ONLY on slot rows (inside the slots {#each}), and the
		// ambient/borrowed state carries its explanation instead of a control.
		const signoutAt = panel.indexOf('chat-slot-signout');
		expect(signoutAt).toBeGreaterThan(panel.indexOf('{#each slots'));
		expect(panel.slice(0, panel.indexOf('{#each slots'))).not.toContain('signout');
		expect(panel).toContain('chat-borrowed-note');
		expect(panel).toContain('never signs it out');
		// The panel's sign-out always names a slot; there is no slotless logout call.
		expect(panel).toMatch(/signOut\(slot: string\)/);
		expect(panel).toMatch(/\/api\/chat\/logout/);
		expect(panel).toContain('JSON.stringify({ slot })');
	});
});
