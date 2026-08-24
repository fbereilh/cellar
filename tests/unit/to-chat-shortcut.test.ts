/**
 * The `t` command-mode "change the selected cell(s) to chat" shortcut - the
 * fourth member of the change-type family beside `m` (markdown), `y` (code) and
 * `r` (raw).
 *
 * Two halves, and the split is the one this repo already draws:
 *
 *  1. The REGISTRY half is executed, not read: whether `t` resolves in command
 *     mode, whether it stays inert in edit mode (where it must type a `t`), and
 *     whether it collides with anything are all questions the store itself
 *     answers, so they are asked of the store. The collision check is the store's
 *     own `conflicts`, which already understands chord SEQUENCES - a bare letter
 *     that happened to be some sequence's prefix (`d` before `d d`) would be
 *     caught by it and by nothing a hand-written list of taken letters could do.
 *  2. The CONVERSION half is driven through the REAL doc layer, because the whole
 *     point of the acceptance criteria is that the new member behaves exactly
 *     like its three siblings: same batch writer, same skip rule, same
 *     drops. Asserting that against `setCellTypes` - the function the shortcut's
 *     `setTypeSelection('chat')` bulk path really posts to - is what makes
 *     "consistent with the family" a fact rather than a claim.
 *
 * The one SOURCE guard at the bottom carries its own reason: vitest here runs
 * WITHOUT the SvelteKit plugin (see `vite.config.js`), so `LiveNotebook.svelte`
 * cannot be mounted and the action map it exposes cannot be executed. It pins
 * WIRING only - which function the id is bound to - never what that function
 * means, which is executed above. The rendered keypress is covered for real in
 * `tests/e2e/to-chat-shortcut.spec.ts`, which is deliberately absent from CI and
 * the no-mistakes gate, hence this CI-visible check.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	DEFAULT_SHORTCUTS,
	shortcuts,
	bindingsCollide,
	chordSequence,
	modesOverlap,
	typingHazards
} from '../../src/lib/shortcuts.svelte';
import { TextNotebookCellTypeError, isChatCell, logicalCellType } from '../../src/lib/cellLanguage';
import { buildCommands } from '../../src/lib/commands';

const byId = (id: string) => DEFAULT_SHORTCUTS.find((s) => s.id === id);

/** The change-type family, in the order the registry declares it. */
const FAMILY = ['to-markdown', 'to-code', 'to-raw', 'to-chat'] as const;

describe('the registry entry', () => {
	it('declares to-chat on `t`, in command mode, as a peer of m / y / r', () => {
		const chat = byId('to-chat');
		expect(chat).toBeDefined();
		expect(chat!.keys).toEqual(['t']);
		expect(chat!.mode).toBe('command');
		expect(chat!.category).toBe('Structure');
	});

	it('matches the family: same mode, same category, same description shape', () => {
		const siblings = FAMILY.map(byId);
		expect(siblings.every(Boolean)).toBe(true);
		// One mode and one category across all four, read off the family rather than
		// restated - a fifth member added here inherits the assertion.
		expect(new Set(siblings.map((s) => s!.mode))).toEqual(new Set(['command']));
		expect(new Set(siblings.map((s) => s!.category))).toEqual(new Set(['Structure']));
		for (const s of siblings) {
			expect(s!.description, s!.id).toMatch(/^Change the selected cell\(s\) to \S+$/);
		}
		expect(byId('to-chat')!.description).toBe('Change the selected cell(s) to chat');
	});

	it('is listed for the Settings panel like every other shortcut', () => {
		// Settings renders `shortcuts.list` grouped by category, so being in the
		// effective list under a known category IS being listed.
		const listed = shortcuts.list.find((s) => s.id === 'to-chat');
		expect(listed).toBeDefined();
		expect(listed!.customized).toBe(false);
		expect(listed!.keys).toEqual(['t']);
	});
});

describe('mode gating and collisions', () => {
	it('resolves `t` in command mode but NOT in edit mode, so `t` still types', () => {
		expect(shortcuts.lookup('command', 't')?.id).toBe('to-chat');
		expect(shortcuts.lookup('edit', 't')).toBeUndefined();
		expect(modesOverlap('command', 'edit')).toBe(false);
		// A bare letter in COMMAND mode is exactly where bare letters belong, so the
		// registry's own hazard check must report none (it would flag `t` on an
		// edit/global shortcut, which is what makes this assertion meaningful).
		expect(typingHazards(byId('to-chat')!)).toEqual([]);
	});

	it('collides with nothing - the store\'s own conflict rule, sequence prefixes included', () => {
		expect(shortcuts.conflicts.has('to-chat')).toBe(false);
		// And the whole registry stays clean, so this entry cannot have merely moved
		// a conflict onto some other id.
		expect([...shortcuts.conflicts]).toEqual([]);
	});

	it('`t` is not the prefix of, nor prefixed by, any other command-mode binding', () => {
		const active = DEFAULT_SHORTCUTS.filter((s) => s.id !== 'to-chat' && (s.mode === 'command' || s.mode === 'global'));
		for (const s of active) {
			for (const k of s.keys) {
				expect(bindingsCollide('t', k), `${s.id} binds ${k}`).toBe(false);
			}
		}
		// The prefix half of that rule is real: a hypothetical `t t` sequence WOULD
		// collide, which is what the assertion above is protecting against.
		expect(bindingsCollide('t', 't t')).toBe(true);
		expect(chordSequence('t')).toEqual(['t']);
	});
});

describe('the command palette', () => {
	it('offers "Change cell(s) to chat" beside its three siblings, on the same action', () => {
		const dispatched: string[] = [];
		const cmds = buildCommands({
			notebook: { dispatch: (id: string) => dispatched.push(id) },
			app: { toggleTheme() {}, toggleSidebar() {} }
		} as unknown as Parameters<typeof buildCommands>[0]);
		const cells = cmds.filter((c) => FAMILY.some((id) => c.id === `nb:${id}`));
		expect(cells.map((c) => c.id).sort()).toEqual(FAMILY.map((id) => `nb:${id}`).sort());
		const chat = cells.find((c) => c.id === 'nb:to-chat')!;
		expect(chat.title).toBe('Change cell(s) to chat');
		expect(chat.category).toBe('Cells');
		// The palette reads the binding out of the registry, so the row shows `t`.
		expect(chat.keys).toEqual(['t']);
		// And running it dispatches the SHORTCUT id into the notebook's own action
		// map - the palette is a second surface on one action, never a second path.
		chat.run();
		expect(dispatched).toEqual(['to-chat']);
	});
});

// ---- The conversion itself, through the real doc layer ----------------------

// Reading a real `.py` notebook shells out to the project venv's python; what is
// under test is the notebook layer's refusal, not the converter (the
// `add-chat-cell-controls.test.ts` / `chat-cell-py-notebook.test.ts` harness).
vi.mock('../../src/lib/server/jupytext', async () => {
	const actual = await vi.importActual<typeof import('../../src/lib/server/jupytext')>('../../src/lib/server/jupytext');
	return {
		...actual,
		readPyNotebook: () => ({
			format: 'databricks',
			cells: [{ id: null, cell_type: 'code', source: 'print(1)', outputs: [], metadata: {} }]
		}),
		writePyNotebook: (path: string, cells: { source: string }[]) => {
			writeFileSync(path, cells.map((c) => c.source).join('\n\n# COMMAND ----------\n\n') + '\n');
		}
	};
});

let nbmod: typeof import('../../src/lib/server/notebook');
let WS = '';

beforeAll(async () => {
	WS = mkdtempSync(join(tmpdir(), 'cellar-to-chat-'));
	process.env.CELLAR_WORKSPACE = WS;
	nbmod = await import('../../src/lib/server/notebook');
});

/** A fresh `.ipynb` of `n` code cells; returns its path and their ids. */
function makeNotebook(name: string, n: number): { nb: string; ids: string[] } {
	const nb = nbmod.createNotebook(name).path;
	const ids: string[] = [];
	let after: string | null = null;
	for (let i = 0; i < n; i++) {
		after = nbmod.addCell(after, 'code', nb, null, `a = ${i}`).id;
		ids.push(after);
	}
	// Drop the notebook's own first cell so the document is exactly our n.
	const seed = nbmod.listCells(nb).find((c) => !ids.includes(c.id));
	if (seed) nbmod.deleteCell(seed.id, nb);
	return { nb, ids };
}

describe('converting a multi-cell selection to chat (setCellTypes, the bulk path)', () => {
	it('retypes exactly the addressed cells and leaves the rest alone', () => {
		const { nb, ids } = makeNotebook('bulk.ipynb', 4);
		const picked = [ids[0], ids[2]];
		expect(nbmod.setCellTypes(picked, 'chat', nb).sort()).toEqual([...picked].sort());
		const after = nbmod.listCells(nb);
		expect(after.map((c) => logicalCellType(c))).toEqual(['chat', 'code', 'chat', 'code']);
		// A chat cell is an nbformat `code` cell tagged `cellar.language` - the SQL
		// shape - so the on-disk type never becomes something nbformat cannot hold.
		expect(after.filter((c) => isChatCell(c)).every((c) => c.cell_type === 'code')).toBe(true);
	});

	it('keeps the source, and keeps outputs (chat shares the nbformat code type)', () => {
		const { nb, ids } = makeNotebook('keep.ipynb', 1);
		nbmod.setOutputs(ids[0], [{ output_type: 'stream', name: 'stdout', text: 'hi\n' }], nb);
		nbmod.setCellTypes([ids[0]], 'chat', nb);
		const cell = nbmod.listCells(nb)[0];
		expect(cell.source).toBe('a = 0');
		// The family's rule verbatim: `applyCellType` empties outputs only when the
		// nbformat type stops being `code`, so code→chat keeps them exactly as
		// code→sql does. Nothing chat-specific is invented here.
		expect(cell.outputs).toHaveLength(1);
	});

	it('drops the imports role and the export flag - a chat cell holds no Python', () => {
		const { nb, ids } = makeNotebook('flags.ipynb', 1);
		nbmod.setCellRole(ids[0], 'imports', nb);
		nbmod.setCellExports([ids[0]], true, nb);
		nbmod.setHideInput(ids[0], true, nb);
		nbmod.setCellTypes([ids[0]], 'chat', nb);
		const cellar = nbmod.listCells(nb)[0].metadata?.cellar ?? {};
		expect(cellar.role).toBeUndefined();
		expect(cellar.export).toBeUndefined();
		// `hide_input` is deliberately KEPT, exactly as it is for markdown and raw.
		expect(cellar.hide_input).toBe(true);
	});

	it('is idempotent: an already-chat cell is skipped, and an all-chat batch writes nothing', () => {
		const { nb, ids } = makeNotebook('idem.ipynb', 2);
		expect(nbmod.setCellTypes(ids, 'chat', nb).sort()).toEqual([...ids].sort());
		// The second pass changes nothing - the same `isLogicalCellType` skip the
		// browser predicts, which is what keeps a legitimate skip from reading as a
		// refused batch.
		expect(nbmod.setCellTypes(ids, 'chat', nb)).toEqual([]);
		// A mixed batch converts only the cell that is not chat yet.
		const extra = nbmod.addCell(ids[1], 'code', nb, null, 'b = 1').id;
		expect(nbmod.setCellTypes([...ids, extra], 'chat', nb)).toEqual([extra]);
	});

	it('converting BACK is the sibling conversion, and undoes the tag', () => {
		const { nb, ids } = makeNotebook('back.ipynb', 1);
		nbmod.setCellTypes(ids, 'chat', nb);
		nbmod.setCellTypes(ids, 'code', nb);
		const cell = nbmod.listCells(nb)[0];
		expect(logicalCellType(cell)).toBe('code');
		expect(cell.metadata?.cellar?.language).toBeUndefined();
	});

	it('refuses the WHOLE batch on a .py notebook, writing nothing', () => {
		const py = join(WS, 'dbx.py');
		writeFileSync(py, '# Databricks notebook source\nprint(1)\n');
		expect(() => nbmod.setCellTypes([nbmod.listCells(py)[0].id], 'chat', py)).toThrow(TextNotebookCellTypeError);
		expect(nbmod.listCells(py).every((c) => !isChatCell(c))).toBe(true);
	});
});

describe('the wiring the browser ships (source guard - see the file header)', () => {
	it('binds the id to the shared bulk type action, not a chat-specific path', () => {
		const src = readFileSync(new URL('../../src/lib/LiveNotebook.svelte', import.meta.url), 'utf8');
		// The whole family goes through ONE action, so the new member inherits the
		// multi-selection semantics, the `.py` refusal and the optimistic apply
		// rather than re-deriving any of them.
		for (const [id, type] of [
			['to-markdown', 'markdown'],
			['to-code', 'code'],
			['to-raw', 'raw'],
			['to-chat', 'chat']
		]) {
			expect(src).toContain(`'${id}': () => setTypeSelection('${type}'),`);
		}
	});
});
