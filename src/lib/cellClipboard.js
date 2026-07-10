// The in-app cell clipboard behind `x` / `c` / `v` / `Shift-V`.
//
// Shared by every notebook open in the tab, so a cell copied in one notebook
// pastes into another - Jupyter's behavior. Deliberately *not* the system
// clipboard: a cell carries its type (and its view metadata), which plain text
// cannot, and putting cell source on the system clipboard would silently
// clobber whatever the user had copied from elsewhere.
//
// An entry carries only what the add-cell API can restore: `cell_type`,
// `source`, and the `output_scrolled` view choice. Outputs are not carried -
// a pasted cell would then show a saved result the live kernel never produced,
// the exact stale-output trap the run-metadata design elsewhere avoids.

/** @typedef {{cell_type:string, source:string, output_scrolled?:boolean}} ClipboardCell */

/** @type {ClipboardCell[]} */
let entries = [];

export const cellClipboard = {
	/** Replace the clipboard contents (an array, so multi-cell copy can land later). */
	copy(cells) {
		entries = cells.map((c) => ({ ...c }));
	},

	/** A fresh copy of the clipboard, so a paste can never mutate it. */
	read() {
		return entries.map((c) => ({ ...c }));
	},

	get isEmpty() {
		return entries.length === 0;
	}
};
