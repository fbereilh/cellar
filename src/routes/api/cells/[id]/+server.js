import { json } from '@sveltejs/kit';
import { setSource, setCellType, deleteCell, setOutputScrolled, setCellRole, setCellExport, setHideInput, setVisibility } from '$lib/server/notebook';
import { TextNotebookCellTypeError, isLogicalCellTypeName } from '$lib/cellLanguage';

/** Edit a cell's source, type ('code' | 'sql' | 'markdown' | 'raw'), imports-cell
 *  role, agent visibility, and/or its output-scroll choice in notebook `nb` (body field;
 *  workspace-relative path, defaults to the active notebook). `role` is 'imports'
 *  to designate this cell the notebook's imports cell (clearing any other) or null
 *  to un-designate; `setCellRole` enforces the one-imports-cell-per-notebook rule.
 *  `hiddenFromAgent` withholds the cell from every agent surface (the same flag
 *  MCP's `set_cell_visibility` writes) and applies to EVERY cell type, so unlike
 *  `export`/`hideInput` it is not gated on the cell being code. It is also the one
 *  field here whose write is REPORTED rather than assumed: it is a withholding
 *  control applied optimistically in the browser, so answering `{ok:true}` for a
 *  cell the document does not have would leave the row claiming a concealment that
 *  never happened.
 *
 *  `cell_type` is VALIDATED against `$lib/cellLanguage`'s vocabulary — the same one
 *  the bulk and add routes use — rather than coerced: `nbCellType` maps anything it
 *  does not recognize onto `code`, so a typo ('RAW', a trailing space) would
 *  silently turn a raw cell holding frontmatter into a runnable Python cell. `raw`
 *  on a `.py` notebook is refused by `setCellType` itself and reported the way the
 *  bulk route reports its own refusals, so the caller can resync instead of
 *  rendering a conversion the document never took.
 *
 *  All three refusals are settled BEFORE any other field is written, so a refused
 *  PATCH applies NOTHING: every caller today sends a single field, but a body
 *  carrying `source` alongside a rejected `cell_type` or `export` would otherwise
 *  have persisted the source and dropped the fields after it. `setCellType` throws
 *  before it mutates and `setCellExport` refuses before it writes, so it is each
 *  writer's own rule that decides here — not a second copy of it. */
export async function PATCH({ params, request }) {
	const body = await request.json();
	if (body.cell_type != null) {
		if (!isLogicalCellTypeName(body.cell_type)) return json({ ok: false, reason: 'bad-cell-type' }, { status: 400 });
		try {
			setCellType(params.id, body.cell_type, body.nb, body.originId);
		} catch (err) {
			if (err instanceof TextNotebookCellTypeError)
				return json({ ok: false, reason: err.reason, message: err.message }, { status: 400 });
			throw err;
		}
	}
	// REPORTED, unlike its `source`/`role`/`scrolled`/`hideInput` siblings, and for
	// exactly ONE of its refusals - the scope is deliberate: `no-such-cell` and
	// `not-code` stay silent exactly as they always were (widening the sibling setters
	// is a separate change - see `hiddenFromAgent` below). What cannot stay silent is
	// a cell whose SOURCE carries nbdev's `#| export`: the directive keeps it exported
	// and Cellar never writes one, so there is no metadata to clear and `{ok:true}`
	// would leave the row showing an unticked toggle over a cell the exporter still
	// writes. The client reverts and says why.
	//
	// It sits with `cell_type` ABOVE every other field so the handler's pre-write
	// invariant stays literally true: `setCellExport` decides its refusal before it
	// writes anything, so a refused PATCH persists none of the body.
	if ('export' in body) {
		const r = setCellExport(params.id, !!body.export, body.nb, body.originId);
		if (!r.ok && r.reason === 'export-directive-owns-cell')
			return json({ ok: false, reason: r.reason }, { status: 409 });
	}
	if (typeof body.source === 'string') setSource(params.id, body.source, body.nb, body.originId);
	if ('scrolled' in body) setOutputScrolled(params.id, body.scrolled, body.nb);
	if ('role' in body) setCellRole(params.id, body.role, body.nb, body.originId);
	if ('hideInput' in body) setHideInput(params.id, body.hideInput, body.nb, body.originId);
	// SCOPED to `hiddenFromAgent` deliberately: the sibling setters above discard
	// their boolean too, and widening them is a separate change. This one is
	// different because it is a WITHHOLDING control - the client applies it
	// optimistically, so a swallowed refusal leaves the row claiming the cell is
	// hidden from every agent surface while the document still hands it to each of
	// them. `setVisibility` reports false only for a cell that does not exist (a
	// no-op still reports true), so this cannot fire on an ordinary re-set.
	//
	// It can also THROW: the notebook write can fail (a read-only checkout, ENOSPC,
	// EACCES on the `.ipynb`), and it rolls its own in-memory change back before
	// rethrowing so the agent surface is never left more permissive than what the
	// client is about to report. That is a stated outcome of this field rather than
	// an incidental 500 with a stack trace, so it is reported in this handler's own
	// refusal shape - and, like the 404 above, scoped to `hiddenFromAgent` alone.
	if ('hiddenFromAgent' in body) {
		try {
			if (!setVisibility(params.id, !!body.hiddenFromAgent, body.nb, body.originId))
				return json({ ok: false, reason: 'no-such-cell' }, { status: 404 });
		} catch (err) {
			return json({ ok: false, reason: 'write-failed', message: String(err?.message ?? err) }, { status: 500 });
		}
	}
	return json({ ok: true });
}

/** Delete a cell from notebook `nb` (query param, defaults to the active one).
 *  A delete that would empty the notebook is refused by `deleteCell` itself and
 *  surfaced the way the bulk route surfaces its own refusals, so the caller can
 *  resync instead of rendering a removal the document never took. */
export function DELETE({ params, url }) {
	const res = deleteCell(params.id, url.searchParams.get('nb') || undefined, url.searchParams.get('originId') || undefined);
	if (!res.ok) return json({ ok: false, reason: res.reason }, { status: 400 });
	return json({ ok: true });
}
