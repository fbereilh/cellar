import { describe, it, expect } from 'vitest';
import { DEFAULT_SHORTCUTS, shortcuts, modesOverlap } from '../../src/lib/shortcuts.svelte';

/**
 * The `a` / `b` command-mode "insert cell above / below" shortcuts must live in
 * the one shortcut registry (so the Settings "Keyboard shortcuts" panel lists
 * and can rebind them) and be COMMAND-mode only - never active while typing in a
 * cell's editor, where `a`/`b` must type those characters.
 *
 * The registry is the single source of truth for mode gating: the dispatcher
 * looks a keystroke up in the mode it read off the DOM, so `lookup('edit', 'a')`
 * returning nothing is exactly what makes typing `a` in an editor insert a
 * character instead of a cell.
 */
describe('insert-above / insert-below shortcuts', () => {
	const byId = (id: string) => DEFAULT_SHORTCUTS.find((s) => s.id === id);

	it('declares insert-above on `a` and insert-below on `b`, command mode, with descriptions', () => {
		const above = byId('insert-above');
		const below = byId('insert-below');
		expect(above).toBeDefined();
		expect(below).toBeDefined();
		expect(above!.keys).toEqual(['a']);
		expect(below!.keys).toEqual(['b']);
		expect(above!.mode).toBe('command');
		expect(below!.mode).toBe('command');
		// Non-empty descriptions so they render in the Settings panel like the others.
		expect(above!.description.length).toBeGreaterThan(0);
		expect(below!.description.length).toBeGreaterThan(0);
		expect(above!.category).toBe('Structure');
		expect(below!.category).toBe('Structure');
	});

	it('resolves `a`/`b` in command mode but NOT in edit mode (mode gating)', () => {
		expect(shortcuts.lookup('command', 'a')?.id).toBe('insert-above');
		expect(shortcuts.lookup('command', 'b')?.id).toBe('insert-below');
		// In edit mode a command-only shortcut is inactive, so `a`/`b` type text.
		expect(shortcuts.lookup('edit', 'a')).toBeUndefined();
		expect(shortcuts.lookup('edit', 'b')).toBeUndefined();
		// The modes genuinely don't overlap (command vs edit).
		expect(modesOverlap('command', 'edit')).toBe(false);
	});
});
