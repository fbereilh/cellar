import { json } from '@sveltejs/kit';
import { deleteCells, moveCells, setCellTypes } from '$lib/server/notebook';

/**
 * Bulk cell operations over a multi-cell SELECTION — one request, one document
 * write, one `.ipynb` persist.
 *
 * The point of the batch is atomicity, not fewer round trips: looping the
 * single-cell routes serializes + fsyncs + renames the whole notebook once per
 * cell and walks the file through N-1 intermediate states a crash could freeze
 * it in. Each op below is a single pass in `notebook.ts` that then emits the
 * ORDINARY per-cell events (`cell:deleted` / `cell:moved` / `cell:type`), so
 * every open tab applies patches it already understands — the batch introduces
 * no new event shape.
 *
 * Body: `{ op, ids, nb?, originId?, ... }`
 *   - `{ op: 'delete', ids }`               remove every id
 *   - `{ op: 'move', ids, dir: 'up'|'down' }` slide the selection one step
 *   - `{ op: 'type', ids, cellType }`         retype ('code' | 'sql' | 'markdown')
 */
export async function POST({ request }) {
	const { op, ids, nb, originId, dir, cellType } = await request.json().catch(() => ({}));
	const list = Array.isArray(ids) ? ids.filter((id) => typeof id === 'string' && id) : [];
	if (!list.length) return json({ ok: false, reason: 'no-ids' }, { status: 400 });

	if (op === 'delete') return json({ ok: true, removed: deleteCells(list, nb, originId) });
	if (op === 'move') return json({ ok: true, moved: moveCells(list, dir === 'up' ? 'up' : 'down', nb, originId) });
	if (op === 'type') {
		const type = cellType === 'markdown' ? 'markdown' : cellType === 'sql' ? 'sql' : 'code';
		return json({ ok: true, changed: setCellTypes(list, type, nb, originId) });
	}
	return json({ ok: false, reason: 'unknown-op' }, { status: 400 });
}
