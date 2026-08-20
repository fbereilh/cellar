/**
 * Chat cells are creatable from the ADD affordances - the bottom add row and the
 * hover-between gap strip - not only through the per-cell type menu.
 *
 * These are SOURCE GUARDS (vitest runs without the SvelteKit plugin, so the
 * components cannot be mounted here, and e2e is deliberately absent from CI and
 * the no-mistakes gate). Each rule is one expression wide, and losing it either
 * silently removes a create path the captain decided on, or - worse - puts a
 * control on a `.py` notebook that offers a cell type the document cannot store,
 * the exact failure the type menu's `typeOptions` filter exists to prevent.
 *
 * The behavior itself (a gap / bottom-row click really creating a tagged chat
 * cell, and both controls absent on a `.py` notebook) is e2e-covered in
 * `tests/e2e/insert-cell.spec.ts`; the writers' refusal is unit-covered in
 * `chat-cell-py-notebook.test.ts`. What THIS file pins is the wiring the browser
 * ships.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { isPyUnsupportedType } from '../../src/lib/cellLanguage';

const read = (rel: string) => readFileSync(new URL(`../../src/lib/${rel}`, import.meta.url), 'utf8');

/** The template block from `marker` to the next `{/if}`, so gate + payload are read together. */
function blockAround(src: string, marker: string): string {
	const at = src.indexOf(marker);
	expect(at, `expected to find ${marker}`).toBeGreaterThanOrEqual(0);
	// Walk back to the `{#if ` that gates this control and forward to its `{/if}`.
	const open = src.lastIndexOf('{#if ', at);
	expect(open, `expected an {#if} gate before ${marker}`).toBeGreaterThanOrEqual(0);
	const close = src.indexOf('{/if}', at);
	expect(close, `expected the {#if} around ${marker} to close`).toBeGreaterThanOrEqual(0);
	return src.slice(open, close);
}

describe('the chat add controls exist, and are gated off the shared .py rule', () => {
	const src = read('Notebook.svelte');

	it('the gate derives from $lib/cellLanguage, never a restated list', () => {
		// One derived flag, expressed through the SAME predicate the type menu
		// filters on - so a change to PY_UNSUPPORTED_TYPES reaches these controls
		// with no edit here.
		expect(src).toMatch(/const offerChatCell = \$derived\(!isPy \|\| !isPyUnsupportedType\('chat'\)\)/);
		// And the predicate still says what the gate assumes: chat IS refused on a
		// .py notebook while the two types the row already offers are not.
		expect(isPyUnsupportedType('chat')).toBe(true);
		expect(isPyUnsupportedType('code')).toBe(false);
		expect(isPyUnsupportedType('markdown')).toBe(false);
	});

	it('the bottom add row offers Chat, gated, labelled, through the one add path', () => {
		const block = blockAround(src, 'data-testid="add-chat"');
		expect(block).toContain('{#if offerChatCell}');
		expect(block).toMatch(/onAddCell\(cells\.at\(-1\)\?\.id, 'chat'\)/);
		// A real label (the row's Code/Markdown convention), plus a title saying
		// what a chat cell does.
		expect(block).toMatch(/>\s*Chat\s*</);
		expect(block).toMatch(/title="Add a chat cell/);
	});

	it('the hover-between gap strip offers Chat, gated, labelled, through the one insert path', () => {
		const block = blockAround(src, 'data-testid="insert-chat"');
		expect(block).toContain('{#if offerChatCell}');
		expect(block).toMatch(/onInsertCell\(where, targetId, 'chat'\)/);
		expect(block).toMatch(/>\s*Chat\s*</);
		expect(block).toMatch(/title="Insert a chat cell/);
	});

	it('the gap strip keeps Code FIRST, one click, ungated - the common case pays nothing', () => {
		const strip = src.slice(src.indexOf('{#snippet insertControls('), src.indexOf('{/snippet}'));
		const code = strip.indexOf('data-testid="insert-code"');
		const chat = strip.indexOf('data-testid="insert-chat"');
		expect(code).toBeGreaterThanOrEqual(0);
		expect(chat).toBeGreaterThan(code);
		// The code button sits OUTSIDE any {#if}: the strip's own `{#if targetId}`
		// aside, nothing gates it, so it renders in every gap on every notebook.
		const beforeCode = strip.slice(0, code);
		expect(beforeCode.match(/\{#if /g)?.length).toBe(1); // only the targetId guard
	});
});

describe('the per-cell insert icons stay the hardwired one-click code path', () => {
	it('Cell.svelte insert-above/below still pass code - a type picker there would slow the frequent action', () => {
		const src = read('Cell.svelte');
		expect(src).toMatch(/onInsertCell\('above', cell\.id, 'code'\)/);
		expect(src).toMatch(/onInsertCell\('below', cell\.id, 'code'\)/);
	});
});
