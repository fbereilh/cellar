import { json } from '@sveltejs/kit';
import { moveCell } from '$lib/server/notebook.js';

/** Move a cell up or down. Body: { dir: 'up' | 'down' }. */
export async function POST({ params, request }) {
	const { dir } = await request.json();
	moveCell(params.id, dir === 'up' ? 'up' : 'down');
	return json({ ok: true });
}
