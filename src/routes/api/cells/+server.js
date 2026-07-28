import { json } from '@sveltejs/kit';
import { addCell } from '$lib/server/notebook';

/** Add a cell (optionally after `afterId`, of `cellType` 'code' | 'markdown',
 *  seeded with `source`) to notebook `nb` (workspace-relative path; defaults to
 *  the active one). `cellar` seeds the new cell's `cellar` metadata namespace so a
 *  restored cell (undo-delete) comes back exactly as it was in ONE write; the
 *  runtime-only records in it are stripped server-side (see `seedCellar`). */
export async function POST({ request }) {
	const { afterId, cellType, source, nb, originId, cellar } = await request.json().catch(() => ({}));
	const cell = addCell(afterId, cellType, nb, originId, source, cellar);
	return json({ cell });
}
