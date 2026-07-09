import { json } from '@sveltejs/kit';
import { setSource, setCellType, deleteCell, setOutputScrolled } from '$lib/server/notebook.js';

/** Edit a cell's source, type ('code' | 'markdown'), and/or its output-scroll
 *  choice in notebook `nb` (body field; workspace-relative path, defaults to
 *  the active notebook). */
export async function PATCH({ params, request }) {
	const body = await request.json();
	if (typeof body.source === 'string') setSource(params.id, body.source, body.nb, body.originId);
	if (body.cell_type) setCellType(params.id, body.cell_type, body.nb, body.originId);
	if ('scrolled' in body) setOutputScrolled(params.id, body.scrolled, body.nb);
	return json({ ok: true });
}

/** Delete a cell from notebook `nb` (query param, defaults to the active one). */
export function DELETE({ params, url }) {
	deleteCell(params.id, url.searchParams.get('nb') || undefined, url.searchParams.get('originId') || undefined);
	return json({ ok: true });
}
