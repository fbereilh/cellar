import { json } from '@sveltejs/kit';
import { setSource, setCellType, deleteCell, setOutputScrolled, setCellRole, setCellExport } from '$lib/server/notebook';

/** Edit a cell's source, type ('code' | 'markdown'), imports-cell role, and/or
 *  its output-scroll choice in notebook `nb` (body field; workspace-relative
 *  path, defaults to the active notebook). `role` is 'imports' to designate this
 *  cell the notebook's imports cell (clearing any other) or null to un-designate;
 *  `setCellRole` enforces the one-imports-cell-per-notebook rule. */
export async function PATCH({ params, request }) {
	const body = await request.json();
	if (typeof body.source === 'string') setSource(params.id, body.source, body.nb, body.originId);
	if (body.cell_type) setCellType(params.id, body.cell_type, body.nb, body.originId);
	if ('scrolled' in body) setOutputScrolled(params.id, body.scrolled, body.nb);
	if ('role' in body) setCellRole(params.id, body.role, body.nb, body.originId);
	if ('export' in body) setCellExport(params.id, !!body.export, body.nb, body.originId);
	return json({ ok: true });
}

/** Delete a cell from notebook `nb` (query param, defaults to the active one). */
export function DELETE({ params, url }) {
	deleteCell(params.id, url.searchParams.get('nb') || undefined, url.searchParams.get('originId') || undefined);
	return json({ ok: true });
}
