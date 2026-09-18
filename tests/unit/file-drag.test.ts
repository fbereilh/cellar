/**
 * Move-by-drag in the file tree - the pure rules (`$lib/fileDrag`).
 *
 * The rule that decides whether a drop is on offer lives here rather than inside
 * `FileTreeNode.svelte` / `Sidebar.svelte` because vitest runs without the
 * SvelteKit plugin, so a rule left in a component could not be driven at all -
 * and drag behaviour rots silently. `tests/e2e/file-tree-drag-move.spec.ts`
 * proves the wiring and the confirm/cancel paths in a real browser; this proves
 * the rules, and a DIFFERENTIAL block below proves they agree with the SERVER,
 * which stays the authority on every one of them.
 */
import { describe, it, expect } from 'vitest';
import {
	dropVerdict,
	parentDirOf,
	refusalIsWorthReporting,
	refusalMessage,
	type DropRefusal,
	type DropTargetRow
} from '$lib/fileDrag';

const dir = (path: string): DropTargetRow => ({ type: 'dir', path });
const file = (path: string): DropTargetRow => ({ type: 'file', path });
const root: DropTargetRow = { type: 'root', path: '' };

/** The refusal reason, or null when the drop is on offer. */
function refusal(from: string | null, target: DropTargetRow): DropRefusal | null {
	const v = dropVerdict(from, target);
	return v.ok ? null : v.reason;
}

describe('parentDirOf', () => {
	it('answers the workspace root for a top-level entry', () => {
		expect(parentDirOf('notes.md')).toBe('');
	});
	it('answers the containing folder for a nested entry', () => {
		expect(parentDirOf('a/b/notes.md')).toBe('a/b');
		expect(parentDirOf('a/b')).toBe('a');
	});
});

describe('a drop that is on offer', () => {
	it('moves a top-level file into a folder', () => {
		expect(dropVerdict('notes.md', dir('docs'))).toEqual({ ok: true, dest: 'docs' });
	});

	it('moves a nested file OUT to the workspace root', () => {
		// The root area is the only way out of a folder by drag, so it has to work.
		expect(dropVerdict('docs/notes.md', root)).toEqual({ ok: true, dest: '' });
	});

	it('moves a folder into another folder', () => {
		expect(dropVerdict('docs', dir('archive'))).toEqual({ ok: true, dest: 'archive' });
	});

	it('moves a folder into a SIBLING that merely shares its name prefix', () => {
		// The descendant check compares on the path prefix, so it must carry the
		// separator: `notes-old` is not inside `notes`, it is beside it.
		expect(dropVerdict('notes', dir('notes-old'))).toEqual({ ok: true, dest: 'notes-old' });
		expect(dropVerdict('a/notes', dir('a/notesX'))).toEqual({ ok: true, dest: 'a/notesX' });
	});

	it('moves a deeply nested entry up one level', () => {
		expect(dropVerdict('a/b/c/x.md', dir('a/b'))).toEqual({ ok: true, dest: 'a/b' });
	});
});

describe('a drop that is refused', () => {
	it('refuses when nothing is being dragged', () => {
		expect(refusal(null, dir('docs'))).toBe('no-drag');
		expect(refusal('', dir('docs'))).toBe('no-drag');
	});

	it('refuses a FILE as the target rather than redirecting to its parent', () => {
		// Deliberate: the redirect is what VS Code does, but it moves the entry
		// somewhere the pointer was never over. See `dropVerdict`'s own note.
		expect(refusal('notes.md', file('other.md'))).toBe('not-a-folder');
		expect(refusal('docs', file('a/other.md'))).toBe('not-a-folder');
	});

	it('refuses a folder onto ITSELF', () => {
		expect(refusal('docs', dir('docs'))).toBe('into-itself');
		expect(refusal('a/b', dir('a/b'))).toBe('into-itself');
	});

	it('refuses a folder into its OWN descendant, at any depth', () => {
		expect(refusal('docs', dir('docs/sub'))).toBe('into-descendant');
		expect(refusal('a', dir('a/b/c/d'))).toBe('into-descendant');
	});

	it('refuses a drop into the folder the entry is ALREADY in', () => {
		// Not a mistake - a no-op. The server agrees (see the differential below).
		expect(refusal('docs/notes.md', dir('docs'))).toBe('same-parent');
		expect(refusal('notes.md', root)).toBe('same-parent');
		expect(refusal('docs', root)).toBe('same-parent');
	});
});

describe('what a refusal is allowed to SAY', () => {
	it('reports the three that are genuine mistakes', () => {
		for (const r of ['not-a-folder', 'into-itself', 'into-descendant'] as const) {
			expect(refusalIsWorthReporting(r)).toBe(true);
			expect(refusalMessage(r, 'notes.md')).toContain('notes.md');
			expect(refusalMessage(r, 'notes.md').length).toBeGreaterThan(0);
		}
	});

	it('stays SILENT about the two that are not', () => {
		// `same-parent` asked for nothing and `no-drag` never started, so an error
		// for either is noise - which is the whole reason they are separate reasons
		// rather than one bare `false`.
		for (const r of ['same-parent', 'no-drag'] as const) {
			expect(refusalIsWorthReporting(r)).toBe(false);
			expect(refusalMessage(r, 'notes.md')).toBe('');
		}
	});
});

/**
 * The rule may only ever be over-STRICT relative to the server, never
 * over-permissive: an offer withheld costs a gesture, an offer the server then
 * refuses would travel to the filesystem. `moveEntry` is the authority - these
 * cases are the three it guards, asserted here so a future edit that loosens the
 * client cannot silently start offering them.
 */
describe('agreement with the server guards (fstree.moveEntry)', () => {
	it('never offers what moveEntry throws on', () => {
		// "cannot move a folder into itself" - both of its shapes.
		expect(dropVerdict('docs', dir('docs')).ok).toBe(false);
		expect(dropVerdict('docs', dir('docs/sub')).ok).toBe(false);
		// "destination is not a folder".
		expect(dropVerdict('notes.md', file('other.md')).ok).toBe(false);
	});

	it('never offers what moveEntry treats as a no-op', () => {
		// moveEntry returns `from === path` for a same-parent move: nothing happens
		// on disk, so a confirmation would be a dialog about nothing.
		expect(dropVerdict('docs/notes.md', dir('docs')).ok).toBe(false);
		expect(dropVerdict('notes.md', root).ok).toBe(false);
	});
});
