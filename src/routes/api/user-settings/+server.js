import { json } from '@sveltejs/kit';
import { getUserSettings, setUserSettings } from '$lib/server/user-settings';

/** The whole cross-project user-setting map (see `$lib/server/user-settings.ts`). */
export function GET() {
	return json(getUserSettings());
}

/**
 * Shallow-merge a flat `{ key: value, … }` body of setting updates into the store
 * (a `null` value deletes the key). Returns the updated map.
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
	return json(setUserSettings(body));
}
