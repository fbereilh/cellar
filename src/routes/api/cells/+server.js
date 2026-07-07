import { json } from '@sveltejs/kit';
import { addCell } from '$lib/server/notebook.js';

/** Add a cell (optionally after `afterId`, of `cellType` 'code' | 'markdown'). */
export async function POST({ request }) {
	const { afterId, cellType } = await request.json().catch(() => ({}));
	const cell = addCell(afterId, cellType);
	return json({ cell });
}
