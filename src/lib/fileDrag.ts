/**
 * Cellar - the rules deciding whether a file-tree DRAG may drop on a given row.
 *
 * Pure and DOM-free on purpose, the `tabReorder.ts` / `cellSelection.ts`
 * precedent: vitest runs without the SvelteKit plugin, so a rule left inside
 * `FileTreeNode.svelte` or `Sidebar.svelte` could not be executed by a test at
 * all - and drag behaviour is exactly the kind of thing that rots silently.
 *
 * THE SERVER STAYS THE AUTHORITY. `fstree.ts`'s `moveEntry` already refuses a
 * folder into itself or a descendant, treats a same-parent move as a no-op, and
 * de-duplicates a colliding destination name rather than clobbering it. Nothing
 * here re-implements or replaces any of that - this decides only what the drag
 * may OFFER, so an invalid drop reads as invalid while the pointer is still
 * moving instead of travelling to the server to be refused. A rule that drifts
 * from the server can therefore only ever be over-strict (an offer withheld),
 * never over-permissive in a way that reaches the filesystem.
 */

/** The workspace-relative path of a row's parent folder ('' = the workspace root). */
export function parentDirOf(path: string): string {
	const i = path.lastIndexOf('/');
	return i >= 0 ? path.slice(0, i) : '';
}

/** What a drop is being offered over: a folder row, the tree's root area, or a file row. */
export interface DropTargetRow {
	type: 'file' | 'dir' | 'root';
	/** Workspace-relative path; '' for the root. */
	path: string;
}

/**
 * Why a drop is not on offer. Each is a DIFFERENT fact and the caller words them
 * differently - in particular `same-parent` is not a mistake at all, so it must
 * never be reported as one (see `dropVerdict`).
 */
export type DropRefusal = 'no-drag' | 'not-a-folder' | 'into-itself' | 'into-descendant' | 'same-parent';

export type DropVerdict =
	| { ok: true; dest: string }
	| { ok: false; reason: DropRefusal };

/**
 * May `from` be dropped on `target`, and if so into which folder?
 *
 * Only a FOLDER (or the root area) is a target: dropping onto a file is refused
 * rather than silently redirected to that file's parent. The redirect is what
 * VS Code does, but it moves the item somewhere the pointer was never over,
 * which is the wrong direction for a gesture that is easy to trigger by
 * accident - and the explorer already draws that line the same way, `Paste`
 * being offered on a folder and the root and nowhere else.
 *
 * `same-parent` is a REFUSAL here and a NO-OP at the server, deliberately: the
 * item is already in that folder, so there is nothing to confirm and nothing to
 * report. It is kept as its own reason precisely so the caller can stay silent
 * about it while still speaking up about the genuine mistakes.
 *
 * `into-itself` is checked FIRST and covers a file row as well as a folder: the
 * pointer over the dragged entry's OWN row is where every drag begins, and
 * releasing there is the ordinary "never mind" gesture - an abort, not a
 * mistake, so it is as silent as `same-parent`.
 */
export function dropVerdict(from: string | null | undefined, target: DropTargetRow): DropVerdict {
	if (!from) return { ok: false, reason: 'no-drag' };
	if (target.type !== 'root' && target.path === from) return { ok: false, reason: 'into-itself' };
	if (target.type === 'file') return { ok: false, reason: 'not-a-folder' };
	const dest = target.type === 'root' ? '' : target.path;
	// A folder may not be dropped inside its own subtree. Compared on the path
	// PREFIX with its separator, so a sibling that merely shares a name prefix
	// (`notes` vs `notes-old`) is a perfectly good destination.
	if (dest.startsWith(from + '/')) return { ok: false, reason: 'into-descendant' };
	if (parentDirOf(from) === dest) return { ok: false, reason: 'same-parent' };
	return { ok: true, dest };
}

/** Is this a drop the user should be TOLD about, or one to pass over in silence? */
export function refusalIsWorthReporting(reason: DropRefusal): boolean {
	return reason === 'not-a-folder' || reason === 'into-descendant';
}

/**
 * The sentence shown when a drop is refused. Only the reasons
 * `refusalIsWorthReporting` admits have one - the others describe a gesture
 * that never started, one that asked for nothing, or one the user took back.
 */
export function refusalMessage(reason: DropRefusal, name: string): string {
	switch (reason) {
		case 'not-a-folder':
			return `Cannot move ${name} onto a file - drop it on a folder.`;
		case 'into-descendant':
			return `Cannot move ${name} into a folder inside itself.`;
		default:
			return '';
	}
}
