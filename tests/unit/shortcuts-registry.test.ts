/**
 * Registry-wide invariants for the shortcut declarations.
 *
 * These exist because of a real, silent failure: `CATEGORY_ORDER` is a hand-written
 * DISPLAY order, and Settings used to render only the categories named in it - so a
 * shortcut declared in a category nobody had added there worked at the keyboard but
 * was invisible in Settings, i.e. unlistable AND unrebindable, with nothing failing.
 * The rendering is now fail-safe (an unknown category is appended rather than
 * dropped), and these pin the rest: every category has a decided PLACE, every entry
 * is listable, and the two new kernel-introspection chords keep the properties that
 * let them be bound to Tab at all.
 */
import { describe, it, expect } from 'vitest';
import {
	CATEGORY_ORDER,
	DEFAULT_SHORTCUTS,
	bindingsCollide,
	modesOverlap,
	shortcutCategories,
	typingHazards
} from '$lib/shortcuts.svelte';

describe('every declared shortcut is listable in Settings', () => {
	it('groups every category, in the decided order', () => {
		const categories = shortcutCategories(DEFAULT_SHORTCUTS);
		const declared = new Set(DEFAULT_SHORTCUTS.map((s) => s.category));
		// Nothing dropped...
		expect(new Set(categories)).toEqual(declared);
		// ...and no duplicates, which would render one group twice.
		expect(categories.length).toBe(new Set(categories).size);
	});

	it('appends an unplaced category rather than hiding it', () => {
		const invented = [...DEFAULT_SHORTCUTS, { ...DEFAULT_SHORTCUTS[0], id: 'x', category: 'Zzz Unplaced' }];
		const categories = shortcutCategories(invented);
		expect(categories).toContain('Zzz Unplaced');
		expect(categories[categories.length - 1]).toBe('Zzz Unplaced');
	});

	it('has a decided PLACE for every category the registry really uses', () => {
		// The fail-safe above means forgetting this costs placement, not visibility -
		// which is exactly why it needs an assertion of its own, or "at the end"
		// quietly becomes the permanent home of a group that deserves a place.
		for (const s of DEFAULT_SHORTCUTS) expect(CATEGORY_ORDER).toContain(s.category);
	});

	it('gives every shortcut a description to list it by', () => {
		for (const s of DEFAULT_SHORTCUTS) {
			expect(s.description.length).toBeGreaterThan(0);
			expect(s.keys.length).toBeGreaterThan(0);
		}
	});
});

describe('the kernel-introspection chords', () => {
	const byId = (id: string) => DEFAULT_SHORTCUTS.find((s) => s.id === id);

	it('bind Tab and Shift+Tab in edit mode, where the caret is', () => {
		expect(byId('kernel-complete')).toMatchObject({ keys: ['Tab'], mode: 'edit' });
		expect(byId('kernel-docs')).toMatchObject({ keys: ['Shift-Tab'], mode: 'edit' });
	});

	it('shadow no typable character, so Settings raises no hazard for them', () => {
		// A key NAME longer than one character can never be what a keystroke types,
		// which is the only reason an edit-mode binding on a bare key is admissible.
		expect(typingHazards(byId('kernel-complete')!)).toEqual([]);
		expect(typingHazards(byId('kernel-docs')!)).toEqual([]);
	});

	it('collide with nothing else that fires in the same mode', () => {
		for (const id of ['kernel-complete', 'kernel-docs']) {
			const mine = byId(id)!;
			for (const other of DEFAULT_SHORTCUTS) {
				if (other.id === mine.id || !modesOverlap(mine.mode, other.mode)) continue;
				for (const a of mine.keys)
					for (const b of other.keys)
						expect(
							bindingsCollide(a, b),
							`${mine.id} (${a}) collides with ${other.id} (${b})`
						).toBe(false);
			}
		}
	});

	it('are two SEPARATE entries, because Tab and Shift+Tab do different things', () => {
		expect(byId('kernel-complete')!.description).not.toBe(byId('kernel-docs')!.description);
	});
});
