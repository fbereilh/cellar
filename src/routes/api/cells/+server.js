import { json } from '@sveltejs/kit';
import { addCell } from '$lib/server/notebook';
import { TextNotebookCellTypeError, isLogicalCellTypeName } from '$lib/cellLanguage';

/** Add a cell (optionally after `afterId`, of `cellType` 'code' | 'sql' |
 *  'markdown' | 'raw', seeded with `source`) to notebook `nb` (workspace-relative
 *  path; defaults to the active one). `cellar` seeds the new cell's `cellar`
 *  metadata namespace so a restored cell (undo-delete) comes back exactly as it was
 *  in ONE write; the runtime-only records in it are stripped server-side (see
 *  `seedCellar`).
 *
 *  `cellType` is OPTIONAL (absent means 'code') but VALIDATED when given, against
 *  the same `$lib/cellLanguage` vocabulary the PATCH and bulk routes use: an
 *  out-of-vocabulary value would otherwise fall through `nbCellType` and create a
 *  runnable Python cell nobody asked for. A type a `.py` notebook cannot hold
 *  (`raw`, `chat`) is refused by `addCell` itself, in the shape the bulk route
 *  already speaks - the error carries its own reason code. */
export async function POST({ request }) {
	const { afterId, cellType, source, nb, originId, cellar } = await request.json().catch(() => ({}));
	if (cellType != null && !isLogicalCellTypeName(cellType))
		return json({ ok: false, reason: 'bad-cell-type' }, { status: 400 });
	try {
		const cell = addCell(afterId, cellType, nb, originId, source, cellar);
		return json({ cell });
	} catch (err) {
		if (err instanceof TextNotebookCellTypeError)
			return json({ ok: false, reason: err.reason, message: err.message }, { status: 400 });
		throw err;
	}
}
