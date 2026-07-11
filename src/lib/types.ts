/**
 * Cellar - shared *client-side* domain types.
 *
 * Server-owned shapes (Cell, CellView, notebook document, outputs, events, run
 * queue) live in `$lib/server/types` and are imported directly by the client;
 * this file is only for shapes that exist purely in the browser layer - the
 * notebook's modal-keyboard mode and the imperative per-cell API a `Cell`
 * publishes up to its `LiveNotebook`.
 */

/** Jupyter-style modal keyboard mode for the notebook. */
export type KeyMode = 'command' | 'edit';

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
	/** Run this cell (code) or render it (markdown), using the editor's live text. */
	run: () => void;
	/** Flip a markdown cell to its rendered view (no-op for code cells). */
	showRendered: () => void;
	isMarkdown: () => boolean;
	/** The editor's current text (never the debounced `cell.source`). */
	currentSource: () => string;
	/** Caret offset in the source, where a split divides it. */
	cursorOffset: () => number;
	/** Replace the editor doc through the remote-apply path (caller persists). */
	replaceSource: (source: string) => void;
}
