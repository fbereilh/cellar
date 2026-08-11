import { json } from '@sveltejs/kit';
import { setSource, setCellType, deleteCell, setOutputScrolled, setCellRole, setCellExport, setHideInput } from '$lib/server/notebook';
import { RAW_UNSUPPORTED_REASON, RawCellTypeError, isLogicalCellTypeName } from '$lib/cellLanguage';

/** Edit a cell's source, type ('code' | 'sql' | 'markdown' | 'raw'), imports-cell
 *  role, and/or its output-scroll choice in notebook `nb` (body field;
 *  workspace-relative path, defaults to the active notebook). `role` is 'imports'
 *  to designate this cell the notebook's imports cell (clearing any other) or null
 *  to un-designate; `setCellRole` enforces the one-imports-cell-per-notebook rule.
 *
 *  `cell_type` is VALIDATED against `$lib/cellLanguage`'s vocabulary — the same one
 *  the bulk and add routes use — rather than coerced: `nbCellType` maps anything it
 *  does not recognize onto `code`, so a typo ('RAW', a trailing space) would
 *  silently turn a raw cell holding frontmatter into a runnable Python cell. `raw`
 *  on a `.py` notebook is refused by `setCellType` itself and reported the way the
 *  bulk route reports its own refusals, so the caller can resync instead of
 *  rendering a conversion the document never took.
 *
 *  Both refusals are settled BEFORE any other field is written, so a refused PATCH
 *  applies NOTHING: every caller today sends a single field, but a body carrying
 *  `source` alongside a rejected `cell_type` would otherwise have persisted the
 *  source and dropped the fields after it. `setCellType` throws before it mutates,
 *  so it is the writer's own rule that decides here — not a second copy of it. */
export async function PATCH({ params, request }) {
	const body = await request.json();
	if (body.cell_type != null) {
		if (!isLogicalCellTypeName(body.cell_type)) return json({ ok: false, reason: 'bad-cell-type' }, { status: 400 });
		try {
			setCellType(params.id, body.cell_type, body.nb, body.originId);
		} catch (err) {
			if (err instanceof RawCellTypeError)
				return json({ ok: false, reason: RAW_UNSUPPORTED_REASON, message: err.message }, { status: 400 });
			throw err;
		}
	}
	if (typeof body.source === 'string') setSource(params.id, body.source, body.nb, body.originId);
	if ('scrolled' in body) setOutputScrolled(params.id, body.scrolled, body.nb);
	if ('role' in body) setCellRole(params.id, body.role, body.nb, body.originId);
	if ('export' in body) setCellExport(params.id, !!body.export, body.nb, body.originId);
	if ('hideInput' in body) setHideInput(params.id, body.hideInput, body.nb, body.originId);
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
