import { json } from '@sveltejs/kit';
import { addCell } from '$lib/server/notebook';

/** Add a cell (optionally after `afterId`, of `cellType` 'code' | 'markdown',
 *  seeded with `source`) to notebook `nb` (workspace-relative path; defaults to
 *  the active one). */
export async function POST({ request }) {
	const { afterId, cellType, source, nb, originId } = await request.json().catch(() => ({}));
	const cell = addCell(afterId, cellType, nb, originId, source);
	return json({ cell });
}
