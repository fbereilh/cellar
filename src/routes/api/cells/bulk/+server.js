import { json } from '@sveltejs/kit';
import { deleteCells, moveCells, setCellTypes } from '$lib/server/notebook';
import { RAW_UNSUPPORTED_REASON, RawCellTypeError, isLogicalCellTypeName } from '$lib/cellLanguage';

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
 *
 * `dir` and `cellType` are VALIDATED, not coerced: both ops rewrite and persist the
 * user's `.ipynb`, so an out-of-vocabulary value must fail like `no-ids` /
 * `unknown-op` rather than silently reorder or retype cells in a direction nobody
 * asked for. The cell-type vocabulary is `$lib/cellLanguage`'s, shared with the
 * single-cell PATCH and add routes so one of them cannot start accepting a type
 * the others refuse. A delete that would empty the notebook fails the same way,
 * as does `raw` on a `.py` notebook, but both rules are the doc layer's - the
 * route only reports its verdict.
 */
const MOVE_DIRS = new Set(['up', 'down']);

export async function POST({ request }) {
	const { op, ids, nb, originId, dir, cellType } = await request.json().catch(() => ({}));
	const list = Array.isArray(ids) ? ids.filter((id) => typeof id === 'string' && id) : [];
	if (!list.length) return json({ ok: false, reason: 'no-ids' }, { status: 400 });

	if (op === 'delete') {
		// The invariant itself lives in `deleteCells`, where the real cell count is;
		// this only surfaces its refusal in the shape the route already speaks.
		const res = deleteCells(list, nb, originId);
		if (!res.ok) return json({ ok: false, reason: res.reason }, { status: 400 });
		return json({ ok: true, removed: res.removed });
	}
	if (op === 'move') {
		if (!MOVE_DIRS.has(dir)) return json({ ok: false, reason: 'bad-dir' }, { status: 400 });
		return json({ ok: true, moved: moveCells(list, dir, nb, originId) });
	}
	if (op === 'type') {
		if (!isLogicalCellTypeName(cellType)) return json({ ok: false, reason: 'bad-cell-type' }, { status: 400 });
		try {
			return json({ ok: true, changed: setCellTypes(list, cellType, nb, originId) });
		} catch (err) {
			if (err instanceof RawCellTypeError)
				return json({ ok: false, reason: RAW_UNSUPPORTED_REASON, message: err.message }, { status: 400 });
			throw err;
		}
	}
	return json({ ok: false, reason: 'unknown-op' }, { status: 400 });
}
