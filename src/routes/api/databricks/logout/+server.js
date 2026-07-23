import { json } from '@sveltejs/kit';
import { logout } from '$lib/server/databricks';
import { databricksErrorResponse } from '../error-response.js';

/**
 * Sign out of Databricks - the deliberate sibling of the connect route's DELETE
 * (disconnect). Disconnect ends the Spark session and keeps you authenticated;
 * this also drops Cellar's own cached sign-in, so the next connect has to
 * authenticate again.
 *
 * It only ever deletes what Cellar's own browser sign-in minted (the SDK's
 * python-local OAuth token cache entry for that selection). The user's
 * `~/.databrickscfg` profiles, the OS keyring and the databricks CLI's own token
 * cache are theirs, not Cellar's, and are never touched.
 *
 * Takes the current `{profile}|{host}` selection (so a selection this process
 * never recorded a sign-in for is still purged) and `{path}` (the notebook whose
 * session to end - every other bound notebook is disconnected too, so no stale
 * reconnect intent survives the sign-out).
 */
export async function POST({ request }) {
	const { profile, host, path } = await request.json();
	try {
		return json(await logout({ profile, host, nb: path }));
	} catch (err) {
		return databricksErrorResponse(err);
	}
}
