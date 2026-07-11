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
	openMenu: (e: MouseEvent, node: FileDescriptor) => void;
	select: (node: FileDescriptor) => void;
	submitRename: (path: string, name: string) => void;
	cancelRename: () => void;
	submitNew: (name: string) => void;
	cancelNew: () => void;
}
