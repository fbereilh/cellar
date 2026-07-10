import { json } from '@sveltejs/kit';
import { getUiState, setUiState } from '$lib/server/ui-state.js';

/** The whole per-project UI-preference map (see `$lib/server/ui-state.js`). */
export function GET() {
	return json(getUiState());
}

/**
 * Shallow-merge a flat `{ key: value, … }` body of preference updates into the
 * store (a `null` value deletes the key). Returns the updated map.
 */
export async function PUT({ request }) {
	let body;
	try {
		body = await request.json();
	} catch {
		body = null;
	}
	if (!body || typeof body !== 'object' || Array.isArray(body)) {
		return json({ error: 'expected an object of key→value updates' }, { status: 400 });
	}
	return json(setUiState(body));
}
