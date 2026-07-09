import { json } from '@sveltejs/kit';
import { addCell } from '$lib/server/notebook.js';

/** Add a cell (optionally after `afterId`, of `cellType` 'code' | 'markdown')
 *  to notebook `nb` (workspace-relative path; defaults to the active one). */
export async function POST({ request }) {
	const { afterId, cellType, nb, originId } = await request.json().catch(() => ({}));
	const cell = addCell(afterId, cellType, nb, originId);
	return json({ cell });
}
