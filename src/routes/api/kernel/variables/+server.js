import { json, error } from '@sveltejs/kit';
import { inspectVariables } from '$lib/server/inspect';

/** Introspect the live kernel and return its user variables as JSON. */
export async function GET() {
	try {
		return json({ variables: await inspectVariables() });
	} catch (err) {
		throw error(500, String(err?.message ?? err));
	}
}
