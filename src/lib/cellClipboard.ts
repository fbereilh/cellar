// The in-app cell clipboard behind `x` / `c` / `v` / `Shift-V`.
//
// Shared by every notebook open in the tab, so a cell copied in one notebook
// pastes into another - Jupyter's behavior. Deliberately *not* the system
// clipboard: a cell carries its type and its `cellar` metadata, which plain text
// cannot, and putting cell source on the system clipboard would silently clobber
// whatever the user had copied from elsewhere.
//
// An entry carries `cell_type`, `source` and the cell's WHOLE `cellar` namespace.
// Outputs are not carried - a pasted cell would then show a saved result the live
// kernel never produced, the exact stale-output trap the run-metadata design
// elsewhere avoids.
//
// THE NAMESPACE IS CARRIED WHOLE, NOT AS AN ALLOWLIST, and that is the fix to a
// real bug rather than a preference. The entry used to name three fields
// (`cell_type`, `source`, `output_scrolled`), so an ordinary copy/paste silently
// DOWNGRADED a cell: a SQL cell came back as plain Python - wrong grammar, wrong
// run path, its `-- >>` result binding gone - and the nbdev `export` mark, the
// report-view `hide_input` choice, the imports `role` and `hidden_from_agent`
// were dropped with it. An allowlist here would have to be kept in step with
// `CellarNamespace` by hand, and NOT keeping it in step is exactly how that
// shipped: `seedCellar`'s `DURABLE_CELLAR_KEYS` names eight durable keys and this
// file named one of them. Carrying the namespace whole means the NINTH rides
// along by construction rather than by whoever adds it remembering this file.
//
// There IS an allowlist, and it lives where it can also defend the document:
// `seedCellar` in `server/notebook.ts` copies only its enumerated
// `DURABLE_CELLAR_KEYS` and strips the runtime-only records first
// (`stripRuntimeMeta`), so an entry cannot become a path from arbitrary metadata
// into the user's persisted `.ipynb`, and `lastRun` - the sole evidence a cell
// ran against the LIVE kernel namespace - can never be forged by a paste. A
// second copy of that rule here could only drift from the one the disk write
// uses. The server also owns what a namespace MEANS in its new home: the imports
// `role` is one per notebook, so a copy pasted beside its original does not claim
// it while a CUT one does.
//
// `cell_type` is the nbformat type, so `raw` is covered by the type itself, and
// the LOGICAL type - which a `cellar.language` tag can make `sql`, `chat` or
// `mojo` - is read back through `clipboardCellType` rather than guessed from
// `cell_type` alone.

import { logicalCellType } from '$lib/cellLanguage';
import type { CellarNamespace, CellMetadata, CellType, LogicalCellType } from '$lib/server/types';

export interface ClipboardCell {
	cell_type: CellType;
	source: string;
	/** The cell's whole `cellar` namespace (see the header); absent when it has none. */
	cellar?: CellarNamespace;
}

/**
 * A clipboard entry taken from a live cell. `source` is passed in rather than
 * read off the cell, because the caller has the EDITOR's live text (the model's
 * `source` lags it by the autosave debounce).
 *
 * The ONE snapshot rule: the undo stack takes its records through it too, so cut
 * / copy and undo can never disagree about what a cell IS - the divergence that
 * left undo restoring a SQL cell while a paste of the same cell produced Python.
 */
export function clipboardCellFrom(
	cell: { cell_type: CellType; metadata?: CellMetadata | null },
	source: string
): ClipboardCell {
	const cellar = cell.metadata?.cellar;
	return {
		cell_type: cell.cell_type,
		source,
		cellar: cellar ? { ...cellar } : undefined
	};
}

/**
 * The LOGICAL type an entry describes - `sql` / `chat` / `mojo` for a tagged code
 * cell, else the nbformat type. Read through `$lib/cellLanguage`'s one rule, so a
 * paste asks the same question every other surface asks; `cell_type` alone reads
 * every tagged cell as plain `code`, which is what a `.py` notebook's paste
 * refusal must not do now that the tag travels.
 */
export function clipboardCellType(entry: ClipboardCell): LogicalCellType {
	return logicalCellType({ cell_type: entry.cell_type, metadata: { cellar: entry.cellar } });
}

let entries: ClipboardCell[] = [];

export const cellClipboard = {
	/** Replace the clipboard contents - an array, because `x` / `c` act on the
	 *  whole multi-cell selection (one entry per selected cell, in document order). */
	copy(cells: ClipboardCell[]): void {
		entries = cells.map(cloneEntry);
	},

	/** A fresh copy of the clipboard, so a paste can never mutate it. */
	read(): ClipboardCell[] {
		return entries.map(cloneEntry);
	},

	get isEmpty() {
		return entries.length === 0;
	}
};

/** A copy deep enough that neither side can mutate the other's `cellar`. */
function cloneEntry(c: ClipboardCell): ClipboardCell {
	return { ...c, cellar: c.cellar ? { ...c.cellar } : undefined };
}
