import { json } from '@sveltejs/kit';
import { setSource, setCellType, deleteCell } from '$lib/server/notebook.js';

/** Edit a cell's source and/or its type ('code' | 'markdown') in notebook `nb`
 *  (body field; workspace-relative path, defaults to the active notebook). */
export async function PATCH({ params, request }) {
	const body = await request.json();
	if (typeof body.source === 'string') setSource(params.id, body.source, body.nb);
	if (body.cell_type) setCellType(params.id, body.cell_type, body.nb);
	return json({ ok: true });
}

/** Delete a cell from notebook `nb` (query param, defaults to the active one). */
export function DELETE({ params, url }) {
	deleteCell(params.id, url.searchParams.get('nb') || undefined);
	return json({ ok: true });
}
