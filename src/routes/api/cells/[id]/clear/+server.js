import { json } from '@sveltejs/kit';
import { clearOutputs } from '$lib/server/notebook.js';

/** Clear a cell's outputs. */
export function POST({ params }) {
	clearOutputs(params.id);
	return json({ ok: true });
}
