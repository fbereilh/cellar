import { json } from '@sveltejs/kit';
import { clearOutputs } from '$lib/server/notebook.js';

/** Clear a cell's outputs in notebook `nb` (query param, defaults to active). */
export function POST({ params, url }) {
	clearOutputs(params.id, url.searchParams.get('nb') || undefined, url.searchParams.get('originId') || undefined);
	return json({ ok: true });
}
