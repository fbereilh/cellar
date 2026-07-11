import { json } from '@sveltejs/kit';
import { moveCell, moveCellTo } from '$lib/server/notebook';

/**
 * Move a cell. Body: { toIndex: number, nb? } for an absolute-index move
 * (drag-to-reorder), or { dir: 'up' | 'down', nb? } for a step move
 * (keyboard / toolbar buttons). Both persist via the shared move logic.
 */
export async function POST({ params, request }) {
	const { dir, toIndex, nb, originId } = await request.json();
	if (Number.isInteger(toIndex)) moveCellTo(params.id, toIndex, nb, originId);
	else moveCell(params.id, dir === 'up' ? 'up' : 'down', nb, originId);
	return json({ ok: true });
}
