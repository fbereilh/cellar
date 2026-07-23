/**
 * Cellar - shared *client-side* domain types.
 *
 * Server-owned shapes (Cell, CellView, notebook document, outputs, events, run
 * queue) live in `$lib/server/types` and are imported directly by the client;
 * this file is only for shapes that exist purely in the browser layer - the
 * notebook's modal-keyboard mode and the imperative per-cell API a `Cell`
 * publishes up to its `LiveNotebook`.
 */

import type { Cell } from '$lib/server/types';
import type { Match } from '$lib/search';

/** Jupyter-style modal keyboard mode for the notebook. */
export type KeyMode = 'command' | 'edit';

/**
 * A remote (agent / other-tab) source edit handed to a live `Cell` via
 * `cell.remoteEdit`, held until the user chooses to load it if they are typing.
 */
export interface RemoteEdit {
	source: string;
}

/**
 * A cell as the live UI holds it: the server-owned {@link Cell} plus the
 * runtime-only `remoteEdit` marker `LiveNotebook` attaches when an out-of-band
 * edit arrives. Never persisted - `remoteEdit` exists only in the browser.
 */
export type UICell = Cell & { remoteEdit?: RemoteEdit | null };

/** Segment indices of a single cell that an outer folded heading hides. */
export interface SegHidden {
	headings: Set<number>;
	bodies: Set<number>;
}

/** Imperative fold controls a notebook publishes to the sidebar Outline. */
export interface FoldRegistryHandle {
	toggle: (key: string) => void;
	collapseAll: () => void;
	expandAll: () => void;
}

/** Imperative heading-numbering controls a notebook publishes to the sidebar Outline. */
export interface NumberingRegistryHandle {
	/** Turn the display-only auto-number for heading level (1-6) on or off. */
	setLevel: (level: number, on: boolean) => void;
}

/** Result of an nbdev-style `.py` module export. */
export interface ExportPyResult {
	written: boolean;
	target: string | null;
	count: number;
	reason?: 'no-target' | 'no-cells' | 'unchanged';
}

/**
 * Imperative controls a mounted file tab publishes to the shell.
 *
 * `requestSave` is the tab's ONE save entry point, and the shell's Cmd/Ctrl+S
 * capture handler is its only caller: a save shortcut bound to the editor's own
 * keymap can fire only while `.cm-content` holds focus, which is false in every
 * view where the editor is not the focused surface (a preview hides it with
 * `display:none`, and a `display:none` subtree cannot hold focus at all) - so
 * the keystroke fell through to the browser's "Save page as…" dialog, silently
 * dropping an unsaved edit. Owning it at the tab level makes it view-agnostic.
 * It saves when the document is saveable and surfaces the view-only reason when
 * it is not; it never pretends to save.
 */
export interface FileTabApiHandle {
	requestSave: () => void;
}

/** Options for the shared "take me to this cell" jump (`NotebookApiHandle.jumpToCell`). */
export interface JumpOptions {
	/** The find-in-page match being navigated to (reserved for a match-precise scroll). */
	match?: Match;
	/**
	 * A heading occurrence inside the cell (`headings.ts` fold key). A markdown cell
	 * can hold several headings, so an outline row addresses one of them: the heading
	 * row is what gets scrolled to, while the whole cell is what flashes.
	 */
	foldKey?: string | null;
}

/** Imperative notebook controls the shell hands to the sidebar + command palette. */
export interface NotebookApiHandle {
	insertAndRunCode: (source: string) => void;
	dispatch: (shortcutId: string) => void;
	runAll: () => void;
	clearAll: () => void;
	runAbove: () => void;
	runBelow: () => void;
	runStale: () => void;
	/** Regenerate the nbdev-style `.py` module now (manual "Export to .py"). */
	exportPy: () => Promise<ExportPyResult | null>;
	/** Toggle the notebook-wide "hide all code inputs" (report view) default. */
	toggleHideAllCode: () => void;
	/**
	 * Scroll/reveal this notebook's currently running (or, failing that, first
	 * queued) cell into view. An EXPLICIT user action (clicking the tab's run
	 * spinner), so it bypasses the `follow` preference and the typing guard the
	 * automatic follow-effect honors. No-op when nothing is running or queued.
	 */
	revealRunning: () => void;
	/**
	 * The single deliberate "take me to this cell" seam (shared with the
	 * virtualization mounting primitive), used by the find bar AND by the shell's
	 * outline / sidebar-search rows: reveal (unfold) + **mount** the target cell -
	 * so it works even when virtualization has windowed it out of the DOM - then
	 * scroll it into view and flash it. Resolves to the mounted cell node, or null
	 * when the cell no longer exists.
	 */
	jumpToCell: (id: string, opts?: JumpOptions) => Promise<HTMLElement | null>;
	/** Return keyboard focus to this notebook's root (e.g. after closing the find bar). */
	focusRoot: () => void;
	/**
	 * Abort this notebook's own queued / browser-held run requests (all but the
	 * currently running cell). Called by the shell's interrupt handler BEFORE it
	 * hits the server: freeing the connections those streaming run requests hold is
	 * what lets the interrupt request actually reach the server (otherwise the
	 * HTTP/1.1 connection pool starves it), and it cancels the queued runs at once.
	 */
	cancelQueuedRuns: () => void;
	/**
	 * Flush every cell's pending (not-yet-autosaved) edit and let the normal
	 * PATCH persistence write the notebook now. Resolves once the flushed edits
	 * are persisted — the Cmd/Ctrl+S save path.
	 */
	save: () => Promise<void>;
}

/**
 * The imperative handle a `Cell.svelte` hands up to its notebook via
 * `onRegister(id, api | null)`. The notebook's keyboard dispatcher and the
 * cut/copy/split/heading actions call straight into these, so the cell's live
 * editor state (not the debounced `cell.source`) is always the source of truth.
 */
export interface CellRegisterApi {
	/** Advance focus into this cell: its editor, or the card for rendered markdown. */
	focus: () => void;
	/** Focus the cell's outer card (command mode acts on it). */
	focusCell: () => void;
	/** Leave the editor, handing focus back to the card. */
	blur: () => void;
	/** Enter edit mode (open the editor / raw markdown source). */
	enterEdit: () => void;
	/** True while CodeMirror owns an overlay (completion tooltip / search panel). */
	editorOverlayOpen: () => boolean;
	/**
	 * Run this cell (code) or render it (markdown), using the editor's live text.
	 * `advance` moves focus to the next cell (Shift+Enter); `focusNext` picks
	 * whether that focus lands in the next editor or on the cell (command mode).
	 */
	run: (advance?: boolean, opts?: { focusNext?: boolean }) => void;
	/** Flip a markdown cell to its rendered view (no-op for code cells). */
	showRendered: () => void;
	isMarkdown: () => boolean;
	/** The editor's current text (never the debounced `cell.source`). */
	currentSource: () => string;
	/** Caret offset in the source, where a split divides it. */
	cursorOffset: () => number;
	/** Replace the editor doc through the remote-apply path (caller persists). */
	replaceSource: (source: string) => void;
	/**
	 * Persist this cell's pending edit right now (no debounce/blur wait) and
	 * resolve once the PATCH settles. A no-op (resolved) when nothing is dirty.
	 * Drives the notebook's Cmd/Ctrl+S save.
	 */
	flush: () => Promise<void>;
}
