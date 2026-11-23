/**
 * Cellar - the file-management contract shared between the sidebar (which owns
 * the state and provides it) and the recursive `FileTreeNode` (which consumes
 * it), passed through the `cellarFileOps` Svelte context so it need not drill
 * through every level of the tree.
 */

/** A minimal descriptor of the tree entry the menu / selection acts on. */
export interface FileDescriptor {
	type: 'file' | 'dir';
	path: string;
	name: string;
}

/** A pending cut/copy of a workspace path. */
export interface FileClipboard {
	op: 'cut' | 'copy';
	path: string;
}

/** The row a file-tree drag is currently offered over, and whether it may take it. */
export interface DragState {
	/** Workspace-relative path of the entry being dragged, or null when none is. */
	path: string | null;
	/** The row the pointer is over, or null. Only ever a row that ACCEPTS the drop. */
	overPath: string | null;
	/** True while the pointer is over the tree's root area and it accepts the drop. */
	overRoot: boolean;
}

/** A pending "new file/folder" input rooted at a parent folder. */
export interface NewEntry {
	parentPath: string;
	kind: 'file' | 'dir';
}

/**
 * The file-ops API the sidebar publishes on the `cellarFileOps` context. The
 * reactive state (clipboard / renaming / newEntry / selectedPath) is exposed as
 * getters so a `FileTreeNode` reading it stays reactive to the sidebar's state.
 */
export interface CellarFileOps {
	readonly clipboard: FileClipboard | null;
	readonly renaming: string | null;
	readonly newEntry: NewEntry | null;
	readonly selectedPath: string | null;
	/**
	 * Live drag state for the move-by-drag gesture. Owned by the sidebar (which
	 * also owns the confirm modal and the one move-commit path), read by every
	 * tree row so it can draw itself as the dragged entry or as the drop target.
	 */
	readonly drag: DragState;
	openMenu: (e: MouseEvent, node: FileDescriptor) => void;
	select: (node: FileDescriptor) => void;
	/**
	 * Whether the folder at `path` is expanded. Expansion is owned by the sidebar
	 * (one set of paths, `$lib/treeExpansion`) rather than by each row, so a
	 * reveal can open a whole ancestor chain the sidebar does not render itself.
	 * Reactive: a row reading it re-derives when the set changes.
	 */
	isExpanded: (path: string) => boolean;
	/** Open or close the folder at `path`. */
	setExpanded: (path: string, open: boolean) => void;
	submitRename: (path: string, name: string) => void;
	cancelRename: () => void;
	submitNew: (name: string) => void;
	cancelNew: () => void;
	/** A row began a drag. */
	startDrag: (node: FileDescriptor) => void;
	/**
	 * The pointer is over `node` during a drag - `null` means the tree's ROOT
	 * area, the one target a row cannot describe. Returns whether the drop is on
	 * offer, so the row can set the native `dropEffect` accordingly: a refused
	 * target must show the no-drop cursor rather than reading as droppable.
	 */
	dragOver: (node: FileDescriptor | null) => boolean;
	/**
	 * The pointer left `node` (or the root area) without dropping.
	 *
	 * `genuine` says whether the pointer really moved on to something else, as
	 * opposed to the `dragleave` a browser fires as it TEARS THE DRAG DOWN over
	 * the current target. MEASURED against Chromium: the two are distinguishable
	 * only by the event's `relatedTarget`, which is the element being entered on a
	 * real move and `null` at drag-end. The highlight clears either way; a
	 * recorded refusal may only be discarded on a real move, or the drag-end
	 * teardown would wipe the very reason `endDrag` is about to report.
	 */
	dragLeave: (node: FileDescriptor | null, genuine: boolean) => void;
	/**
	 * A drop landed on `node` (or the root area) and opens the confirmation. Only
	 * a target that ACCEPTS the drop is ever armed to receive one, so a refusal
	 * never arrives here - it is reported by `endDrag`, which is the one place
	 * that speaks about one.
	 */
	drop: (node: FileDescriptor | null) => void;
	/** The drag ended (dropped, cancelled, or abandoned). */
	endDrag: () => void;
}
