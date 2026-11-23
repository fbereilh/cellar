import { json, error } from '@sveltejs/kit';
import { inspectVariables } from '$lib/server/inspect';

/**
 * Introspect the live kernel and return its user variables as JSON.
 *
 * `inspectVariables` returns `{ variables, busy }`: `busy: true` means the kernel
 * was running a cell, so it did NOT probe (an internal probe must never queue
 * behind a run — see inspect.js). The flag is forwarded so the client keeps the
 * variables it already shows rather than clearing them mid-run.
 *
 * `path` + `session_id` name the namespace the list was read from, so the page can
 * clear it the moment a lifecycle broadcast says that namespace is gone - however
 * it died and whoever killed it (see `$lib/variablesNamespace`).
 */
export async function GET() {
	try {
		const { variables, busy, path, session_id } = await inspectVariables();
		return json({ variables, busy: busy ?? false, path, session_id });
	} catch (err) {
		throw error(500, String(err?.message ?? err));
	}
}
