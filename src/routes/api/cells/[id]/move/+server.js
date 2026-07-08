import { json } from '@sveltejs/kit';
import { moveCell } from '$lib/server/notebook.js';

/** Move a cell up or down. Body: { dir: 'up' | 'down', nb?: string }. */
export async function POST({ params, request }) {
	const { dir, nb } = await request.json();
	moveCell(params.id, dir === 'up' ? 'up' : 'down', nb);
	return json({ ok: true });
}
