// The in-app cell clipboard behind `x` / `c` / `v` / `Shift-V`.
//
// Shared by every notebook open in the tab, so a cell copied in one notebook
// pastes into another - Jupyter's behavior. Deliberately *not* the system
// clipboard: a cell carries its type (and its view metadata), which plain text
// cannot, and putting cell source on the system clipboard would silently
// clobber whatever the user had copied from elsewhere.
//
// An entry carries `cell_type`, `source`, and the `output_scrolled` view choice.
// Outputs are not carried - a pasted cell would then show a saved result the live
// kernel never produced, the exact stale-output trap the run-metadata design
// elsewhere avoids.
//
// `cell_type` is the nbformat type, so it now covers `raw` for free: copying a raw
// cell pastes a raw cell, since the type IS what the entry carries. (Its verbatim
// source rides along like any other; there are no outputs to drop.)
//
// That is NARROWER than what the add-cell API can now seed: `addCell` takes a
// `cellar` namespace (see `seedCellar` in `server/notebook.ts`), which the undo
// stack uses to bring a deleted cell back exactly - `language`, `role`, `export`,
// `hide_input`. A paste still drops those, so a copied SQL cell pastes as Python;
// widening this shape is a deliberate follow-up, not an oversight of the
// multi-cell cut/copy that only made it easier to notice.

import type { CellType } from '$lib/server/types';

export interface ClipboardCell {
	cell_type: CellType;
	source: string;
	output_scrolled?: boolean;
}

let entries: ClipboardCell[] = [];

export const cellClipboard = {
	/** Replace the clipboard contents - an array, because `x` / `c` act on the
	 *  whole multi-cell selection (one entry per selected cell, in document order). */
	copy(cells: ClipboardCell[]): void {
		entries = cells.map((c) => ({ ...c }));
	},

	/** A fresh copy of the clipboard, so a paste can never mutate it. */
	read(): ClipboardCell[] {
		return entries.map((c) => ({ ...c }));
	},

	get isEmpty() {
		return entries.length === 0;
	}
};
