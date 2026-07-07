import { json } from '@sveltejs/kit';
import { setSource, deleteCell } from '$lib/server/notebook.js';

/** Edit a cell's source. */
export async function PATCH({ params, request }) {
	const { source } = await request.json();
	setSource(params.id, source ?? '');
	return json({ ok: true });
}

/** Delete a cell. */
export function DELETE({ params }) {
	deleteCell(params.id);
	return json({ ok: true });
}
