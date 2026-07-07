import { json } from '@sveltejs/kit';
import { setSource, setCellType, deleteCell } from '$lib/server/notebook.js';

/** Edit a cell's source and/or its type ('code' | 'markdown'). */
export async function PATCH({ params, request }) {
	const body = await request.json();
	if (typeof body.source === 'string') setSource(params.id, body.source);
	if (body.cell_type) setCellType(params.id, body.cell_type);
	return json({ ok: true });
}

/** Delete a cell. */
export function DELETE({ params }) {
	deleteCell(params.id);
	return json({ ok: true });
}
