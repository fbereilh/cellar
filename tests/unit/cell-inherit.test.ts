/**
 * A newly inserted CODE cell takes the language of the code cell above it.
 *
 * Until a notebook could hold more than one code LANGUAGE, "add a code cell" and
 * "add a Python cell" were the same thing. In a Mojo (or SQL) notebook the literal
 * reading makes every second cell the wrong language and forces a trip through the
 * type menu after every insert - so a plain code insertion INHERITS.
 *
 * Two halves, and both are load-bearing:
 *  - the RULE, exercised directly (nearest preceding code cell, prose skipped,
 *    chat never inherited, python the fallback);
 *  - a SOURCE GUARD over every human insertion path, because vitest runs without
 *    the SvelteKit plugin so `LiveNotebook.svelte` cannot be mounted here, and
 *    Playwright e2e is deliberately absent from CI and the no-mistakes gate. The
 *    guard is what makes "find them ALL" checkable: a new insertion path either
 *    routes through `codeTypeAt`/`codeTypeAfter` or names a non-code type, and
 *    anything else fails this file.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { INHERITABLE_CODE_TYPES, inheritedCodeType, inheritedCodeTypeAfter, isInheritableCodeType } from '../../src/lib/cellInherit';
import type { LogicalCellType } from '../../src/lib/server/types';

type C = { id: string; cell_type: string; metadata?: { cellar?: { language?: string } } };
const code = (id: string): C => ({ id, cell_type: 'code', metadata: {} });
const tagged = (id: string, language: string): C => ({ id, cell_type: 'code', metadata: { cellar: { language } } });
const md = (id: string): C => ({ id, cell_type: 'markdown', metadata: {} });
const raw = (id: string): C => ({ id, cell_type: 'raw', metadata: {} });

describe('the rule', () => {
	it('inherits the nearest PRECEDING code cell', () => {
		const cells = [code('a'), tagged('b', 'mojo')];
		expect(inheritedCodeType(cells, 2)).toBe('mojo'); // appended below the mojo cell
		expect(inheritedCodeType(cells, 1)).toBe('code'); // inserted between them
		expect(inheritedCodeType(cells, 0)).toBe('code'); // above everything ⇒ fallback
	});

	it('never looks BELOW the insertion point', () => {
		// Inserting above a Mojo cell in a Python notebook must stay Python.
		expect(inheritedCodeType([code('a'), tagged('b', 'mojo')], 1)).toBe('code');
		expect(inheritedCodeType([tagged('m', 'mojo')], 0)).toBe('code');
	});

	it('SKIPS markdown and raw cells rather than stopping at them', () => {
		// A documented notebook has prose between its code cells; stopping would flip
		// the language back to Python at every heading.
		expect(inheritedCodeType([tagged('m', 'mojo'), md('h'), raw('r')], 3)).toBe('mojo');
		expect(inheritedCodeType([tagged('s', 'sql'), md('h'), md('h2')], 3)).toBe('sql');
	});

	it('NEVER inherits chat - "+ Code" may not create a billed model turn', () => {
		expect(inheritedCodeType([tagged('c', 'chat')], 1)).toBe('code');
		// ...and a chat cell is SKIPPED, so a mojo cell above it still wins.
		expect(inheritedCodeType([tagged('m', 'mojo'), tagged('c', 'chat')], 2)).toBe('mojo');
		expect(isInheritableCodeType('chat')).toBe(false);
		expect(INHERITABLE_CODE_TYPES).not.toContain('chat');
	});

	it('falls back to python with nothing above, which is the common case unchanged', () => {
		expect(inheritedCodeType([], 0)).toBe('code');
		expect(inheritedCodeType([md('h')], 1)).toBe('code');
		expect(inheritedCodeType([code('a'), code('b'), code('c')], 3)).toBe('code');
	});

	it('an UNKNOWN tag (a hand edit, a newer Cellar) falls back rather than propagating', () => {
		expect(inheritedCodeType([{ id: 'x', cell_type: 'code', metadata: { cellar: { language: 'zig' } } } as C], 1)).toBe('code');
	});

	it('never throws on an out-of-range index or a malformed list - it runs inside a $derived', () => {
		expect(inheritedCodeType(null, 3)).toBe('code');
		expect(inheritedCodeType(undefined, -5)).toBe('code');
		expect(inheritedCodeType([tagged('m', 'mojo')], 99)).toBe('mojo');
		expect(inheritedCodeType([tagged('m', 'mojo')], -1)).toBe('code');
		expect(inheritedCodeType([null as never, tagged('m', 'mojo')], 2)).toBe('mojo');
		expect(inheritedCodeType([tagged('m', 'mojo')], 1.7)).toBe('mojo'); // floors to 1
		expect(inheritedCodeType([tagged('m', 'mojo')], Number.NaN)).toBe('code');
	});

	it('honours an explicit fallback (so a caller that means Python can say so)', () => {
		expect(inheritedCodeType([md('h')], 1, 'sql' as LogicalCellType)).toBe('sql');
	});
});

describe('the anchor form, which is how the add API names a position', () => {
	const cells = [code('a'), md('h'), tagged('m', 'mojo'), md('h2')];

	it('scans upward from the cell the insert is anchored AFTER', () => {
		expect(inheritedCodeTypeAfter(cells, 'm')).toBe('mojo');
		expect(inheritedCodeTypeAfter(cells, 'h2')).toBe('mojo'); // skips the prose
		expect(inheritedCodeTypeAfter(cells, 'a')).toBe('code');
		expect(inheritedCodeTypeAfter(cells, 'h')).toBe('code'); // only `a` is above it
	});

	it('an absent/unknown anchor APPENDS, so it reads the end of the notebook', () => {
		expect(inheritedCodeTypeAfter(cells, null)).toBe('mojo');
		expect(inheritedCodeTypeAfter(cells, undefined)).toBe('mojo');
		expect(inheritedCodeTypeAfter(cells, 'gone')).toBe('mojo');
		expect(inheritedCodeTypeAfter([], null)).toBe('code');
	});
});

describe('SOURCE GUARD: every human insertion path resolves the type', () => {
	const live = readFileSync(new URL('../../src/lib/LiveNotebook.svelte', import.meta.url), 'utf8');
	const book = readFileSync(new URL('../../src/lib/Notebook.svelte', import.meta.url), 'utf8');
	const cellSv = readFileSync(new URL('../../src/lib/Cell.svelte', import.meta.url), 'utf8');

	/**
	 * The BODY of `function <name>(`, by balanced-brace matching. The guards below
	 * ask WHICH rule a function consults, so they must not also pin how its
	 * expression is spelled or laid out - a prettier reflow is not a regression.
	 * Scoping to the body rather than to a character window is what keeps the answer
	 * about THAT function once it moves or grows.
	 */
	function bodyOf(src: string, name: string): string {
		const at = src.indexOf(`function ${name}(`);
		expect(at, `${name} must exist`).toBeGreaterThan(-1);
		const open = src.indexOf('{', src.indexOf(')', at));
		let depth = 0;
		for (let i = open; i < src.length; i++) {
			if (src[i] === '{') depth++;
			else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
		}
		throw new Error(`unbalanced body for ${name}`);
	}

	it('the rule has ONE home and LiveNotebook holds no copy of it', () => {
		expect(live).toMatch(/from '\$lib\/cellInherit'/);
		// The wiring only calls it; the scan itself lives in cellInherit.ts.
		expect(live).not.toMatch(/INHERITABLE_CODE_TYPES/);
	});

	it('the positional insert path (a/b, the toolbar buttons, the hover-between strip) resolves', () => {
		// ONE function serves all three affordances, so one guard covers them. Assert
		// that it REACHES the shared rule, not how the expression is spelled - a
		// reflow must not fail a guard about which function is consulted.
		expect(bodyOf(live, 'insertCell')).toContain('codeTypeAt(');
		// ...and the affordances really do route through it.
		expect(cellSv).toMatch(/onInsertCell\('above', cell\.id, 'code'\)/);
		expect(cellSv).toMatch(/onInsertCell\('below', cell\.id, 'code'\)/);
		expect(book).toMatch(/onInsertCell\(where, targetId, 'code'\)/);
		expect(live).toMatch(/onInsertCell=\{insertCell\}/);
		expect(live).toMatch(/'insert-above': \(\) => insertCell\('above'\)/);
		expect(live).toMatch(/'insert-below': \(\) => insertCell\('below'\)/);
	});

	it('the bottom add row resolves, and its markdown/chat buttons still name their type', () => {
		expect(bodyOf(live, 'addCellFromRow')).toContain('codeTypeAfter(');
		expect(live).toMatch(/onAddCell=\{addCellFromRow\}/);
		expect(live).not.toMatch(/onAddCell=\{addCell\}/);
		expect(book).toMatch(/onAddCell\(cells\.at\(-1\)\?\.id, 'markdown'\)/);
		expect(book).toMatch(/onAddCell\(cells\.at\(-1\)\?\.id, 'chat'\)/);
	});

	it('run-and-advance and run-and-insert-below resolve', () => {
		// Shift+Enter on the last cell, and Alt+Enter, both create a cell.
		expect(live.match(/await addCell\(id, codeTypeAfter\(id\)\)/g)?.length).toBe(2);
	});

	it('EVERY addCell / insertCellAt call site is accounted for', () => {
		// The list is exhaustive on purpose: a NEW insertion path shows up here as an
		// unrecognised call and fails, which is what "find them all" means once the
		// paths outlive whoever found them.
		const calls = [...live.matchAll(/await (addCell|insertCellAt)\(([^\n]*)/g)].map((m) => `${m[1]}(${m[2]}`);
		const allowed = [
			// Resolved through the shared rule.
			/^addCell\(id, codeTypeAfter\(id\)\)/,
			// Explicit, non-inheriting, each for a reason stated at the call site.
			/^addCell\(afterId \?\? cells\.at\(-1\)\?\.id, spec\.cell_type/, // insertCellAt: the SPEC names it (paste / undo / a resolved insert)
			/^addCell\(extractAnchor\(sourceId\), block\.cellType/, // an extracted fence names its own language
			/^addCell\(id, cell\.cell_type, source\.slice\(at\)/, // split: the SAME cell's second half
			/^insertCellAt\(index, \{ cell_type: type, source: '' \}\)/, // insertCell, after resolving
			/^insertCellAt\(cells\.length, \{ cell_type: 'code', source \}\)/, // the Databricks preview: literally Python
			/^insertCellAt\(index, pasteSpec\(entry\)\)/,
			/^insertCellAt\(group\[0\]\.index, group\[0\]\)/ // undo-delete restores the recorded type
		];
		for (const call of calls) {
			expect(allowed.some((re) => re.test(call)), `unrecognised insertion path: ${call}`).toBe(true);
		}
		expect(calls.length).toBe(9);
	});
});
