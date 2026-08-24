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

/** The `<button ...>` element containing `marker`, from its `<button` to its `>`. */
function buttonAround(s: string, marker: string): string {
	const at = s.indexOf(marker);
	expect(at, `expected to find ${marker}`).toBeGreaterThanOrEqual(0);
	const open = s.lastIndexOf('<button', at);
	expect(open, `expected a <button> before ${marker}`).toBeGreaterThanOrEqual(0);
	return s.slice(open, s.indexOf('\n\t\t\t\t>', at));
}

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
	it('export is gated on a Python code cell; hide-from-agent is ungated', () => {
		expect(openGates(cell, 'data-testid="toggle-export"')).toEqual(['{#if canBeImports}']);
		expect(openGates(cell, 'data-testid="toggle-agent-hidden"')).toEqual([]);
	});

	// WHY SOURCE: this is the no-shift invariant at its root. The e2e measures the
	// consequence in a real browser; here we pin the CAUSE - the geometry classes
	// sit OUTSIDE the state conditional, so only colour can move.
	it('both toggles keep identical geometry in both states', () => {
		for (const t of ['toggle-export', 'toggle-agent-hidden']) {
			const btn = buttonAround(cell, `data-testid="${t}"`);
			const cls = btn.slice(btn.indexOf('class="'), btn.indexOf('}"') + 2);
			// the sizing classes are unconditional; only the colour half is a ternary
			expect(cls.slice(0, cls.indexOf('{')), t).toContain('btn btn-ghost btn-xs btn-square');
			expect(cls, t).not.toMatch(/\?[^:]*\b(btn-sm|btn-md|px-|py-|h-|w-|gap-)/);
		}
	});

	// WHY SOURCE: `aria-pressed` IS the state for a screen reader; without it the
	// toggles announce as plain buttons and the state is sighted-only.
	it('both are toggle buttons with a stable accessible name', () => {
		for (const [t, name] of [
			['toggle-export', 'aria-label="Export this cell to the notebook\'s .py module"'],
			['toggle-agent-hidden', 'aria-label="Hide this cell from AI agents"']
		]) {
			const btn = buttonAround(cell, `data-testid="${t}"`);
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
	// One writer, so the UI toggle and MCP's set_cell_visibility cannot drift.
	it('routes hiddenFromAgent to setVisibility with the originId', () => {
		const route = read(new URL('../../src/routes/api/cells/[id]/+server.js', import.meta.url), 'utf8');
		expect(route).toMatch(
			/if \('hiddenFromAgent' in body\) setVisibility\(params\.id, !!body\.hiddenFromAgent, body\.nb, body\.originId\)/
		);
	});
});

describe('the client half', () => {
	const live = src('lib/LiveNotebook.svelte');

	// WHY SOURCE: the optimistic apply and the event handler must both DELETE the
	// key on show, matching the server - else a toggle-off and a reload disagree
	// about the shape of a visible cell's metadata.
	it('optimistic apply and the SSE handler both delete the key on show', () => {
		const setter = live.slice(live.indexOf('async function setHiddenFromAgent'));
		expect(setter.slice(0, 600)).toContain('delete cellar.hidden_from_agent');
		const handler = live.slice(live.indexOf("ev.type === 'cell:visibility'"));
		expect(handler.slice(0, 600)).toContain('delete cellar.hidden_from_agent');
	});

	it('is threaded to the renderer', () => {
		expect(live).toContain('onSetHiddenFromAgent={setHiddenFromAgent}');
		expect(src('lib/Notebook.svelte')).toContain('onSetHiddenFromAgent={onSetHiddenFromAgent}');
	});
});
