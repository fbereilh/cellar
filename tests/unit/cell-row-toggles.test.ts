/**
 * The cell row's two STATE toggles - nbdev export, and hidden-from-agent - and
 * the server half the second one needed built.
 *
 * Both were a menu open away from a control reached repeatedly while working:
 * export lived in the per-cell "⋮" menu, and hide-from-agent had no UI at all -
 * `cellar.hidden_from_agent`, the flag `isHiddenFromAgent` filters every agent
 * read through, was reachable only from MCP's `set_cell_visibility`. Putting
 * them in the row meant giving `setVisibility` what `setCellExport` already had:
 * change detection, an originId and an event.
 *
 * What is EXECUTED here is that server half, against real documents - the rules
 * an optimistic UI toggle and a second tab both depend on. What is SOURCE-GUARDED
 * at the bottom is the wiring in the row, for the reason `add-chat-cell-controls`
 * records: vitest runs WITHOUT the SvelteKit plugin (see `vite.config.js`), so no
 * component here can be mounted, and the e2e that drives the rendered controls
 * (`tests/e2e/cell-row-toggles.spec.ts`) is deliberately absent from CI and the
 * no-mistakes gate. Those guards assert WIRING only - which rule a control asks,
 * which gate it sits under, that geometry is shared between its two states -
 * never what a rule MEANS.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync as read } from 'node:fs';
import { isHiddenFromAgent } from '../../src/lib/agentVisibility';
import { canExportCell } from '../../src/lib/exportRole';
import { logicalCellType } from '../../src/lib/cellLanguage';

const PY_BYTES = '# Databricks notebook source\nprint(1)\n\n# COMMAND ----------\n\nprint(2)\n';

// Reading a real `.py` notebook shells out to the project venv's python; what is
// under test is the notebook layer's rule, not the converter (the
// `add-chat-cell-controls.test.ts` harness).
vi.mock('../../src/lib/server/jupytext', async () => {
	const actual = await vi.importActual<typeof import('../../src/lib/server/jupytext')>(
		'../../src/lib/server/jupytext'
	);
	return {
		...actual,
		readPyNotebook: () => ({
			format: 'databricks',
			cells: [
				{ id: null, cell_type: 'code', source: 'print(1)', outputs: [], metadata: {} },
				{ id: null, cell_type: 'code', source: 'print(2)', outputs: [], metadata: {} }
			]
		}),
		writePyNotebook: (path: string, cells: { cell_type: string; source: string }[]) => {
			writeFileSync(path, cells.map((c) => c.source).join('\n\n# COMMAND ----------\n\n') + '\n');
		}
	};
});

let nbmod: typeof import('../../src/lib/server/notebook');
let events: typeof import('../../src/lib/server/events');
let PATCH: (evt: { params: { id: string }; request: Request }) => Promise<Response>;
let NB: string;
let PY: string;

/** Collect every event published while `fn` runs. */
type Ev = Record<string, unknown> & { type: string };
async function captured(fn: () => void): Promise<Ev[]> {
	const seen: Ev[] = [];
	const off = events.subscribe((e) => seen.push(e as Ev));
	try {
		fn();
	} finally {
		off();
	}
	return seen;
}

beforeAll(async () => {
	const ws = mkdtempSync(join(tmpdir(), 'cellar-row-toggles-'));
	process.env.CELLAR_WORKSPACE = ws;
	PY = join(ws, 'dbx.py');
	writeFileSync(PY, PY_BYTES);
	nbmod = await import('../../src/lib/server/notebook');
	events = await import('../../src/lib/server/events');
	PATCH = (await import('../../src/routes/api/cells/[id]/+server.js')).PATCH as unknown as typeof PATCH;
	NB = nbmod.createNotebook('nb.ipynb').path;
});

/** A fresh cell of `type`, returned by id. */
function cellOf(type: 'code' | 'markdown' | 'sql' | 'raw' | 'chat'): string {
	return nbmod.addCell(null, type, NB).id;
}

afterEach(() => {
	// leave every cell visible, so one case cannot decide the next one's baseline
	for (const c of nbmod.listCells(NB)) nbmod.setVisibility(c.id, false, NB);
});

describe('setVisibility applies to EVERY cell type', () => {
	// The row toggle is UNGATED, unlike export and hide-code, and this is the rule
	// that has to hold for that to be honest: a markdown cell's prose is as much a
	// thing to withhold from an agent as a code cell's source.
	it('hides a code, markdown, sql, raw or chat cell alike', () => {
		for (const type of ['code', 'markdown', 'sql', 'raw', 'chat'] as const) {
			const id = cellOf(type);
			expect(nbmod.setVisibility(id, true, NB), `setVisibility on a ${type} cell`).toBe(true);
			const cell = nbmod.listCells(NB).find((c) => c.id === id);
			expect(isHiddenFromAgent(cell), `${type} cell hidden`).toBe(true);
		}
	});

	it('reports false for a cell that does not exist, and writes nothing', async () => {
		const evs = await captured(() => {
			expect(nbmod.setVisibility('no-such-cell', true, NB)).toBe(false);
		});
		expect(evs).toEqual([]);
	});
});

describe('showing DELETES the key rather than storing false', () => {
	// `isHiddenFromAgent` is strictly `=== true`, so absent and `false` read the
	// same - and storing the default would put a line in the user's COMMITTED
	// .ipynb for a cell in the state every cell starts in.
	it('a hide/show round trip leaves the on-disk cell byte-identical', () => {
		const id = cellOf('code');
		const before = readFileSync(NB, 'utf8');

		nbmod.setVisibility(id, true, NB);
		expect(readFileSync(NB, 'utf8')).toContain('hidden_from_agent');

		nbmod.setVisibility(id, false, NB);
		expect(readFileSync(NB, 'utf8')).toBe(before);
	});

	it('leaves the rest of the cellar namespace alone when it clears the key', () => {
		const id = cellOf('code');
		nbmod.setCellExport(id, true, NB);
		nbmod.setVisibility(id, true, NB);
		nbmod.setVisibility(id, false, NB);
		const cellar = nbmod.listCells(NB).find((c) => c.id === id)?.metadata?.cellar ?? {};
		expect(cellar.export).toBe(true);
		expect('hidden_from_agent' in cellar).toBe(false);
	});
});

describe('only a real CHANGE writes or emits', () => {
	// An optimistic UI toggle re-sending the value a cell already carries must
	// cost no .ipynb write and no event, or every tab churns on an echo.
	it('re-hiding an already-hidden cell is a no-op', async () => {
		const id = cellOf('code');
		nbmod.setVisibility(id, true, NB);
		const after = readFileSync(NB, 'utf8');

		const evs = await captured(() => {
			expect(nbmod.setVisibility(id, true, NB)).toBe(true);
		});
		expect(evs).toEqual([]);
		expect(readFileSync(NB, 'utf8')).toBe(after);
	});

	it('showing an already-visible cell is a no-op', async () => {
		const id = cellOf('code');
		const before = readFileSync(NB, 'utf8');
		const evs = await captured(() => {
			expect(nbmod.setVisibility(id, false, NB)).toBe(true);
		});
		expect(evs).toEqual([]);
		expect(readFileSync(NB, 'utf8')).toBe(before);
	});
});

describe('the cell:visibility event', () => {
	// Without it a change made here reaches neither another tab nor an agent's
	// digest - the whole reason the row toggle needed a server half at all.
	it('carries the cell, the new value, the notebook and the originId', async () => {
		const id = cellOf('code');
		const evs = await captured(() => nbmod.setVisibility(id, true, NB, 'tab-7'));
		const ev = evs.find((e) => e.type === 'cell:visibility');
		expect(ev).toMatchObject({ type: 'cell:visibility', cellId: id, hidden: true, nb: NB, originId: 'tab-7' });
	});

	it('fires on the way back to visible too', async () => {
		const id = cellOf('code');
		nbmod.setVisibility(id, true, NB);
		const evs = await captured(() => nbmod.setVisibility(id, false, NB));
		expect(evs.find((e) => e.type === 'cell:visibility')).toMatchObject({ cellId: id, hidden: false });
	});
});

describe('the export toggle asks the SAME eligibility rule its setter does', () => {
	// The gate used to be `canBeImports` (`logicalCellType(cell) === 'code'`), which
	// maps anything it does not recognize onto `code` - and `deserialize` passes a
	// FOREIGN nbformat `cell_type` through verbatim. So an externally-authored
	// notebook carrying one rendered a toggle whose `aria-pressed` could never move
	// (`isExportCell` is the strict rule) and whose setter always skipped it: a
	// permanently dead always-visible control, exactly what a gate exists to avoid.
	const foreign = { cell_type: 'heading', metadata: {} };

	it('the two rules really do diverge on a foreign cell_type', () => {
		expect(logicalCellType(foreign)).toBe('code'); // the loose rule admits it
		expect(canExportCell(foreign)).toBe(false); // the eligibility rule does not
	});

	it('and the SETTER skips such a cell, so a toggle over it could never move', () => {
		// written straight to disk, never through `createNotebook`, which would seed a
		// default code cell and cache that doc ahead of this file
		const nb = join(process.env.CELLAR_WORKSPACE as string, 'foreign.ipynb');
		writeFileSync(
			nb,
			JSON.stringify({
				cells: [{ cell_type: 'heading', id: 'headingcell', source: ['# Title'], metadata: {} }],
				metadata: {},
				nbformat: 4,
				nbformat_minor: 5
			})
		);
		const id = nbmod.listCells(nb)[0].id;
		expect(nbmod.listCells(nb)[0].cell_type).toBe('heading'); // passed through verbatim
		nbmod.setCellExport(id, true, nb);
		expect(nbmod.listCells(nb)[0].metadata?.cellar?.export).toBeUndefined();
	});

	it('agrees with the setter for every type the row can render', () => {
		for (const type of ['code', 'markdown', 'sql', 'raw', 'chat'] as const) {
			const id = cellOf(type);
			const cell = () => nbmod.listCells(NB).find((c) => c.id === id);
			const eligible = canExportCell(cell());
			expect(eligible, `${type} eligible`).toBe(type === 'code');
			nbmod.setCellExport(id, true, NB);
			expect(cell()?.metadata?.cellar?.export === true, `${type} marked`).toBe(eligible);
			if (eligible) nbmod.setCellExport(id, false, NB);
		}
	});
});

describe('a .py text notebook', () => {
	// Such a document is rebuilt from its CELLS on save, so it carries no cellar
	// metadata: the write would be a blocking jupytext spawn producing
	// byte-identical output while losing the very flag it was asked to store. The
	// event still fires, so open tabs update - the in-session-only limit every
	// per-cell cellar flag has on a `.py`, not one this toggle invents.
	it('emits the event but does not rewrite the file', async () => {
		const id = nbmod.listCells(PY)[0].id;
		const before = readFileSync(PY, 'utf8');
		const evs = await captured(() => nbmod.setVisibility(id, true, PY));
		expect(evs.find((e) => e.type === 'cell:visibility')).toMatchObject({ cellId: id, hidden: true });
		expect(readFileSync(PY, 'utf8')).toBe(before);
		// and it is honored in-session, which is what the agent surface reads
		expect(isHiddenFromAgent(nbmod.listCells(PY).find((c) => c.id === id))).toBe(true);
	});
});

// ---------------------------------------------------------------------------

const src = (rel: string) => read(new URL(`../../src/${rel}`, import.meta.url), 'utf8');

/**
 * The stack of `{#if ...}` blocks a marker sits INSIDE, innermost last, walked
 * from the top of the toolbar row. A `lastIndexOf('{#if ')` would answer with the
 * nearest PRECEDING gate whether or not it is still open - which reports an
 * ungated control as gated the moment a gated sibling precedes it, exactly the
 * two controls here.
 */
function openGates(s: string, marker: string): string[] {
	const from = s.indexOf('onclick={onHeaderClick}');
	const at = s.indexOf(marker);
	expect(from, 'expected the toolbar row').toBeGreaterThanOrEqual(0);
	expect(at, `expected to find ${marker}`).toBeGreaterThan(from);
	const stack: string[] = [];
	for (const m of s.slice(from, at).matchAll(/\{#if ([^}]*)\}|\{\/if\}/g)) {
		if (m[0] === '{/if}') stack.pop();
		else stack.push(`{#if ${m[1]}}`);
	}
	return stack;
}

/** Svelte source with comments removed, so a guard cannot be satisfied by prose. */
function code(s: string): string {
	return s.replace(/<!--[\s\S]*?-->/g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * The index of the `>` closing the opening tag that starts at `open`, or -1.
 *
 * It SCANS rather than guessing an indent: a terminator like `'\n\t\t\t\t>'`
 * encodes a nesting depth, so it silently runs past a button nested one level
 * deeper (as the export one is, inside `{#if canBeImports}`) and returns a slice
 * spanning the NEXT control - which made every assertion over it vacuous.
 * A `>` only terminates outside an HTML attribute value and outside a Svelte
 * `{expression}` (and the JS strings within one), so all three are tracked.
 */
function openingTagEnd(s: string, open: number, name = 'button'): number {
	let attr = ''; // the HTML attribute quote we are inside, '' if none
	let braces = 0; // depth of the Svelte {expression} we are inside
	let js = ''; // the string quote inside that expression, '' if none
	for (let i = open + name.length + 1; i < s.length; i++) {
		const c = s[i];
		if (js) {
			if (c === '\\') i++;
			else if (c === js) js = '';
		} else if (braces > 0) {
			if (c === '"' || c === "'" || c === '`') js = c;
			else if (c === '{') braces++;
			else if (c === '}') braces--;
		} else if (c === '{') {
			braces = 1; // Svelte interpolates inside a quoted attribute too
		} else if (attr) {
			if (c === attr) attr = '';
		} else if (c === '"' || c === "'") {
			attr = c;
		} else if (c === '>') {
			return i;
		} else if (c === '<') {
			return -1; // a new tag opened before this one closed
		}
	}
	return -1;
}

/**
 * The opening tag of the toggle button containing `marker`, `<button` to `>`.
 * Self-checking: exactly one `data-testid=` and one `aria-pressed=` must fall
 * inside it, so an overrun into a sibling control fails HERE rather than
 * silently satisfying whichever guard reads the slice next.
 */
function toggleButtonTag(s: string, marker: string): string {
	const at = s.indexOf(marker);
	expect(at, `expected to find ${marker}`).toBeGreaterThanOrEqual(0);
	const open = s.lastIndexOf('<button', at);
	expect(open, `expected a <button> before ${marker}`).toBeGreaterThanOrEqual(0);
	const end = openingTagEnd(s, open);
	expect(end, `expected the <button> opening tag around ${marker} to close`).toBeGreaterThan(at);
	const tag = s.slice(open, end + 1);
	expect(tag.match(/data-testid=/g), `${marker}: one control per tag`).toHaveLength(1);
	expect(tag.match(/aria-pressed=/g), `${marker}: one aria-pressed per tag`).toHaveLength(1);
	return tag;
}

/** The value of `name="..."` in `tag`, brace-aware so a `{expr}` cannot end it. */
function attributeValue(tag: string, name: string, label: string): string {
	const at = tag.indexOf(`${name}="`);
	expect(at, `${label}: expected a ${name}="..." attribute`).toBeGreaterThanOrEqual(0);
	const start = at + name.length + 2;
	let braces = 0;
	let js = '';
	let end = -1;
	for (let i = start; i < tag.length && end < 0; i++) {
		const c = tag[i];
		if (js) {
			if (c === '\\') i++;
			else if (c === js) js = '';
		} else if (braces > 0) {
			if (c === '"' || c === "'" || c === '`') js = c;
			else if (c === '{') braces++;
			else if (c === '}') braces--;
		} else if (c === '{') {
			braces = 1;
		} else if (c === '"') {
			end = i;
		}
	}
	expect(end, `${label}: ${name}="..." never closed`).toBeGreaterThan(start - 1);
	return tag.slice(start, end);
}

/**
 * A `class="<static> {state ? 'on' : 'off'}"` attribute split into its three
 * parts.
 *
 * It PARSES rather than scanning with one regex: both branches carry Tailwind
 * variant colons (`hover:`) and the ternary's own separator is a `:`, so a
 * pattern like `/\?[^:]*\b(px-|h-)/` can never reach past the first `hover:` -
 * it caught a geometry class only at the HEAD of the ON branch and missed the
 * tail, anything after a variant, and the whole OFF branch. Throws rather than
 * returning a partial answer if the ternary is not in the expected shape.
 */
function stateClassParts(
	tag: string,
	label: string
): { staticPrefix: string; whenOn: string; whenOff: string } {
	const value = attributeValue(tag, 'class', label);
	const brace = value.indexOf('{');
	expect(brace, `${label}: expected a {state ? on : off} class expression`).toBeGreaterThan(0);
	const close = value.lastIndexOf('}');
	expect(close, `${label}: the class expression never closes`).toBeGreaterThan(brace);
	const expr = value.slice(brace + 1, close);

	const branches: string[] = [];
	let qmark = -1;
	let colon = -1;
	for (let i = 0; i < expr.length; i++) {
		const c = expr[i];
		if (c === "'" || c === '"' || c === '`') {
			let j = i + 1;
			for (; j < expr.length && expr[j] !== c; j++) if (expr[j] === '\\') j++;
			expect(j, `${label}: unterminated string in the class expression`).toBeLessThan(expr.length);
			branches.push(expr.slice(i + 1, j));
			if (branches.length === 1)
				expect(qmark, `${label}: expected the ON branch after a "?"`).toBeGreaterThanOrEqual(0);
			if (branches.length === 2)
				expect(colon, `${label}: expected the OFF branch after a ":"`).toBeGreaterThan(qmark);
			i = j;
		} else if (c === '?' && qmark < 0) qmark = i;
		else if (c === ':' && qmark >= 0 && colon < 0) colon = i;
	}
	expect(branches, `${label}: expected exactly two branch strings`).toHaveLength(2);
	return { staticPrefix: value.slice(0, brace), whenOn: branches[0], whenOff: branches[1] };
}

/** Class names that change a control's BOX. Whole-token, so `text-base-content/60`
 *  (a colour) is never confused with `text-base` (a size). Colour utilities are
 *  deliberately absent: a state-dependent colour is the POINT of these ternaries. */
const GEOMETRY_EXACT = new Set([
	'btn-xs', 'btn-sm', 'btn-md', 'btn-lg', 'btn-square', 'btn-circle', 'btn-wide', 'btn-block',
	'text-xs', 'text-sm', 'text-base', 'text-lg', 'text-xl'
]);
const GEOMETRY_PREFIXES = [
	'p-', 'px-', 'py-', 'pt-', 'pb-', 'pl-', 'pr-', 'ps-', 'pe-',
	'm-', 'mx-', 'my-', 'mt-', 'mb-', 'ml-', 'mr-', 'ms-', 'me-',
	'h-', 'w-', 'size-', 'min-w-', 'max-w-', 'min-h-', 'max-h-',
	'gap-', 'space-x-', 'space-y-', 'leading-'
];

/**
 * Every geometry-changing class in `branch`, wherever it sits. Tailwind variants
 * are stripped first, so `hover:bg-accent/25` is measured as `bg-accent/25` and a
 * variant is never mistaken for geometry; arbitrary values (`bg-(--token)`) carry
 * no leading `word:` and so pass through untouched.
 */
function geometryTokens(branch: string): string[] {
	return branch
		.split(/\s+/)
		.filter(Boolean)
		.map((t) => t.replace(/^!/, '').replace(/^(?:[\w-]+:)+/, ''))
		.filter((u) => GEOMETRY_EXACT.has(u) || GEOMETRY_PREFIXES.some((pre) => u.startsWith(pre)));
}

describe('the source-guard helper itself', () => {
	// The defect this replaced: the terminator was a hardcoded `'\n\t\t\t\t>'`, so
	// for a button nested one level deeper it ran past that button's own `>` and
	// returned a slice spanning the NEXT control - which silently satisfied every
	// assertion read off it.
	const nested = [
		'<div>',
		'\t\t\t\t{#if gate}',
		'\t\t\t\t\t<button',
		'\t\t\t\t\t\taria-pressed={a}',
		'\t\t\t\t\t\tdata-testid="deep"',
		'\t\t\t\t\t>',
		'\t\t\t\t\t</button>',
		'\t\t\t\t{/if}',
		'\t\t\t\t<button',
		'\t\t\t\t\taria-pressed={b}',
		'\t\t\t\t\tdata-testid="shallow"',
		'\t\t\t\t>',
		'\t\t\t\t</button>',
		'</div>'
	].join('\n');

	it("stops at the deeper button's own `>`, not at a shallower sibling's", () => {
		const tag = toggleButtonTag(nested, 'data-testid="deep"');
		expect(tag).toContain('data-testid="deep"');
		expect(tag).not.toContain('data-testid="shallow"');
		expect(tag.endsWith('>')).toBe(true);
	});

	it('a `>` inside an attribute value or a {expression} does not terminate the tag', () => {
		const tricky = [
			'<button',
			'\ttitle="a > b, the notebook\'s own"',
			"\tclass=\"x {on ? 'p>q' : 'r'}\"",
			'\taria-pressed={on}',
			'\tdata-testid="tricky"',
			'>'
		].join('\n');
		expect(toggleButtonTag(tricky, 'data-testid="tricky"')).toBe(tricky);
	});

	it('fails loudly rather than handing back a wrong-sized slice', () => {
		const unclosed = '<button aria-pressed={a} data-testid="x"';
		expect(() => toggleButtonTag(unclosed, 'data-testid="x"')).toThrow();
		const noState = nested.replace('aria-pressed={a}\n', '');
		expect(() => toggleButtonTag(noState, 'data-testid="deep"')).toThrow();
	});

	// The geometry guard's own defect: a regex anchored on `?` and blocked by
	// `[^:]*` caught a size class only at the HEAD of the ON branch, because both
	// branches carry `hover:` variants and the ternary separator is itself a `:`.
	const ON = 'bg-accent/15 text-accent hover:bg-accent/25';
	const OFF = 'text-base-content/60 hover:text-base-content/90';
	const classTag = (on: string, off: string) =>
		[
			'<button',
			'\tclass="btn btn-ghost btn-xs btn-square {isExport',
			`\t\t? '${on}'`,
			`\t\t: '${off}'}"`,
			'\taria-pressed={isExport}',
			'\tdata-testid="c"',
			'>'
		].join('\n');

	it('splits the class attribute into its static prefix and both branches', () => {
		const cls = stateClassParts(classTag(ON, OFF), 'unmutated');
		expect(cls.staticPrefix).toContain('btn btn-ghost btn-xs btn-square');
		expect(cls.whenOn).toBe(ON);
		expect(cls.whenOff).toBe(OFF);
	});

	it('finds a geometry class ANYWHERE in either branch', () => {
		const mutations: Array<[string, string, string]> = [
			['head of the ON branch', `px-2 ${ON}`, OFF],
			['tail of the ON branch', `${ON} px-2`, OFF],
			['after a hover: variant', `${ON} h-6 w-6`, OFF],
			['inside the OFF branch', ON, `px-2 ${OFF}`],
			['an arbitrary-value branch', 'bg-(--cellar-agent-hidden-soft) hover:bg-(--x) py-1', OFF]
		];
		for (const [where, on, off] of mutations) {
			const cls = stateClassParts(classTag(on, off), where);
			const found = [...geometryTokens(cls.whenOn), ...geometryTokens(cls.whenOff)];
			expect(found, where).not.toEqual([]);
		}
	});

	it('reads a variant or a colour as neither geometry nor a branch separator', () => {
		const cls = stateClassParts(classTag(ON, OFF), 'unmutated');
		expect(geometryTokens(cls.whenOn)).toEqual([]);
		expect(geometryTokens(cls.whenOff)).toEqual([]);
		// `text-base-content/60` is a colour; only the exact `text-base` is a size
		expect(geometryTokens('text-base-content/60 hover:text-base-content/90')).toEqual([]);
		expect(geometryTokens('bg-(--cellar-agent-hidden-soft) hover:bg-(--cellar-agent-hidden-strong)')).toEqual([]);
		expect(geometryTokens('text-base')).toEqual(['text-base']);
	});

	it('fails loudly on a class attribute it cannot parse', () => {
		expect(() => stateClassParts(classTag(ON, OFF).replace("? '", "'"), 'no ?')).toThrow();
		expect(() => stateClassParts('<button class="btn btn-xs" data-testid="c">', 'no ternary')).toThrow();
		expect(() => stateClassParts(classTag(ON, OFF).replace(`${OFF}'`, OFF), 'unterminated')).toThrow();
	});
});

describe('the wiring the browser ships (source guards - see the file header)', () => {
	const cell = src('lib/Cell.svelte');

	// WHY SOURCE: "is this control in the row or in the menu" is a fact about
	// where a node is rendered, observable only by mounting. The e2e asserts the
	// rendered outcome; this is the CI-visible half.
	it('neither toggle is left duplicated inside the "⋮" menu', () => {
		const menuAt = cell.indexOf('data-testid="cell-actions-menu"');
		expect(menuAt).toBeGreaterThan(0);
		const menu = cell.slice(menuAt);
		expect(menu).not.toContain('data-testid="toggle-export"');
		expect(menu).not.toContain('data-testid="toggle-agent-hidden"');
		// what SHOULD still be there - reached rarely, or a per-cell override of a
		// notebook-wide default
		expect(menu).toContain('data-testid="toggle-imports-role"');
		expect(menu).toContain('data-testid="toggle-hide-input"');
	});

	// WHY SOURCE: the badge's ABSENCE cannot be asserted by mounting something
	// that no longer exists; and it is the redundancy this change removed - two
	// controls for one fact, the second of which re-laid the row out on every flip.
	it('the export badge is gone, its job folded into the toggle', () => {
		expect(cell).not.toContain('data-testid="export-badge"');
		expect(cell).toContain('data-testid="toggle-export"');
	});

	// WHY SOURCE: an always-visible control that can never apply is worse than one
	// behind a menu, so export is GATED and hide-from-agent deliberately is not.
	// WHICH rule the gate asks is checked BEHAVIOURALLY above; what only source can
	// say is that the rendered gate is that derived rather than a second, looser one.
	it('export is gated on the export eligibility rule; hide-from-agent is ungated', () => {
		expect(openGates(cell, 'data-testid="toggle-export"')).toEqual(['{#if canExport}']);
		expect(cell).toContain('const canExport = $derived(canExportCell(cell));');
		expect(cell).toContain("import { canExportCell, isExportCell } from '$lib/exportRole'");
		expect(openGates(cell, 'data-testid="toggle-agent-hidden"')).toEqual([]);
	});

	// WHY SOURCE: this is the no-shift invariant at its root. The e2e measures the
	// consequence in a real browser; here we pin the CAUSE - the geometry classes
	// sit OUTSIDE the state conditional, so only colour can move.
	it('both toggles keep identical geometry in both states', () => {
		for (const t of ['toggle-export', 'toggle-agent-hidden']) {
			const cls = stateClassParts(toggleButtonTag(cell, `data-testid="${t}"`), t);
			// the sizing classes are unconditional; only the colour half is a ternary
			expect(cls.staticPrefix, t).toContain('btn btn-ghost btn-xs btn-square');
			expect(geometryTokens(cls.whenOn), `${t}: the ON branch`).toEqual([]);
			expect(geometryTokens(cls.whenOff), `${t}: the OFF branch`).toEqual([]);
		}
	});

	// WHY SOURCE: `aria-pressed` IS the state for a screen reader; without it the
	// toggles announce as plain buttons and the state is sighted-only.
	it('both are toggle buttons with a stable accessible name', () => {
		for (const [t, name] of [
			['toggle-export', 'aria-label="Export this cell to the notebook\'s .py module"'],
			['toggle-agent-hidden', 'aria-label="Hide this cell from AI agents"']
		]) {
			const btn = toggleButtonTag(cell, `data-testid="${t}"`);
			expect(btn, t).toMatch(/aria-pressed=\{/);
			expect(btn, t).toContain(name);
		}
	});

	// WHY SOURCE: the flag is a DISCLOSURE rule with one owner; a second inline
	// copy in the browser half is exactly what `agentVisibility.ts` exists to stop.
	it('the row reads the flag through the shared predicate', () => {
		expect(cell).toContain("import { isHiddenFromAgent } from '$lib/agentVisibility'");
		expect(cell).toContain('$derived(isHiddenFromAgent(cell))');
		// prose may NAME the key; a second read of it in code is the drift
		expect(code(cell)).not.toMatch(/hidden_from_agent/);
	});

	// WHY SOURCE: the card is `overflow-hidden`, so without wrapping the controls
	// past its edge are CLIPPED rather than cramped. The e2e measures reachability;
	// this pins that the row is allowed to wrap at all.
	it('the toolbar may wrap, and its right-hand group stays right-aligned when it does', () => {
		const bar = cell.slice(cell.indexOf('onclick={onHeaderClick}') - 400, cell.indexOf('onclick={onHeaderClick}'));
		expect(bar).toMatch(/class="flex flex-wrap items-center justify-between/);
		expect(cell).toContain('<div class="ml-auto flex items-center gap-1">');
	});
});

describe('the PATCH route accepts the new field', () => {
	const patch = (id: string, body: unknown) =>
		PATCH({
			params: { id },
			request: new Request(`http://x/api/cells/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
		});

	// One writer, so the UI toggle and MCP's set_cell_visibility cannot drift - and
	// the route reaches it with the caller's originId, which is what lets the tab
	// that flipped the toggle suppress its own echo.
	it('routes hiddenFromAgent to setVisibility with the originId', async () => {
		const id = cellOf('markdown');
		const evs: Ev[] = [];
		const off = events.subscribe((e) => evs.push(e as Ev));
		let res: Response;
		try {
			res = await patch(id, { hiddenFromAgent: true, nb: NB, originId: 'tab-7' });
		} finally {
			off();
		}
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		expect(isHiddenFromAgent(nbmod.listCells(NB).find((c) => c.id === id))).toBe(true);
		expect(evs.find((e) => e.type === 'cell:visibility')).toMatchObject({
			cellId: id,
			hidden: true,
			nb: NB,
			originId: 'tab-7'
		});
	});

	// The body's value is COERCED (`!!`), so a truthy/falsy JSON value still lands
	// as the boolean the flag is read as (`isHiddenFromAgent` is strictly === true).
	it('shows the cell again, deleting the key rather than storing false', async () => {
		const id = cellOf('code');
		await patch(id, { hiddenFromAgent: true, nb: NB });
		const res = await patch(id, { hiddenFromAgent: false, nb: NB });
		expect(res.status).toBe(200);
		const cellar = nbmod.listCells(NB).find((c) => c.id === id)?.metadata?.cellar ?? {};
		expect('hidden_from_agent' in cellar).toBe(false);
	});

	// The WITHHOLDING half: this is the one field in the handler whose write is
	// reported rather than assumed. A `{ok:true}` for a cell the document does not
	// have would leave the row claiming a concealment that never happened, and the
	// client cannot read a verdict the server refuses to send.
	it('REFUSES a cell the document does not have, rather than reporting success', async () => {
		const evs: Ev[] = [];
		const off = events.subscribe((e) => evs.push(e as Ev));
		let res: Response;
		try {
			res = await patch('no-such-cell', { hiddenFromAgent: true, nb: NB });
		} finally {
			off();
		}
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ ok: false, reason: 'no-such-cell' });
		expect(evs).toEqual([]);
	});

	// Scoped deliberately: the sibling setters still report `{ok:true}` whatever
	// their own boolean said, so this refusal cannot start firing for them.
	it('leaves the sibling fields reporting as they did', async () => {
		const res = await patch('no-such-cell', { export: true, nb: NB });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});
});

describe('the client half', () => {
	const live = src('lib/LiveNotebook.svelte');

	// WHY SOURCE: the optimistic apply, its revert and the event handler must all
	// DELETE the key on show, matching the server - else a toggle-off and a reload
	// disagree about the shape of a visible cell's metadata. They reach ONE local
	// writer, which is what makes that true by construction rather than by three
	// copies happening to agree.
	it('optimistic apply and the SSE handler go through one local writer', () => {
		expect(code(live)).toContain('function applyHiddenFromAgentLocally(id: string, hidden: boolean)');
		const writer = code(live).slice(code(live).indexOf('function applyHiddenFromAgentLocally'));
		expect(writer.slice(0, 400)).toContain('delete cellar.hidden_from_agent');
		const setter = live.slice(live.indexOf('async function setHiddenFromAgent'));
		expect(setter.slice(0, 900)).toContain('applyHiddenFromAgentLocally(id, hidden)');
		const handler = live.slice(live.indexOf("ev.type === 'cell:visibility'"));
		expect(handler.slice(0, 600)).toContain('applyHiddenFromAgentLocally(ev.cellId, ev.hidden)');
	});

	// WHY SOURCE: WHICH surface a failed withhold reports on, and WHAT it says.
	// The shell's transient line is single and nonce-keyed, so a second surface
	// would silently replace this message; and the wording is the point - "request
	// failed" leaves the reader unable to tell whether the cell is concealed. What
	// actually HAPPENS on a failed write (the toggle reverting, the notice showing,
	// an unchanged .ipynb) is asserted against a real browser in
	// `tests/e2e/cell-row-toggles.spec.ts` - deliberately not restated as tokens
	// here, which would pin a spelling a behaviour-preserving refactor may change.
	it('reports a failed withhold on the ONE notice channel, saying what is true', () => {
		const all = code(live);
		const from = all.indexOf('async function setHiddenFromAgent');
		expect(from, 'expected setHiddenFromAgent').toBeGreaterThan(0);
		const body = all.slice(from, all.indexOf('function applyHiddenFromAgentLocally', from));
		expect(body).toMatch(/onNotice\?\.\(/);
		// both directions state the cell's REAL disclosure state, not "request failed"
		expect(body).toContain('still VISIBLE to AI agents');
		expect(body).toContain('still HIDDEN from AI agents');
	});

	it('is threaded to the renderer', () => {
		expect(live).toContain('onSetHiddenFromAgent={setHiddenFromAgent}');
		expect(src('lib/Notebook.svelte')).toContain('onSetHiddenFromAgent={onSetHiddenFromAgent}');
	});
});
