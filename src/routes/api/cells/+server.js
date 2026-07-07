import { json } from '@sveltejs/kit';
import { addCell } from '$lib/server/notebook.js';

/** Add a cell (optionally after `afterId`). */
export async function POST({ request }) {
	const { afterId } = await request.json().catch(() => ({}));
	const cell = addCell(afterId);
	return json({ cell });
}
