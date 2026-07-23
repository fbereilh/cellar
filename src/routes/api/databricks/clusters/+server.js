import { json } from '@sveltejs/kit';
import { listClusters } from '$lib/server/databricks';
import { databricksErrorResponse } from '../error-response.js';
import { selectionFrom } from '../selection.js';

/**
 * Clusters visible to the chosen `?profile=` or typed `?host=`, via the SDK in a
 * subprocess of the project venv. Job/pipeline clusters are filtered out - they
 * cannot be attached to. Never touches the kernel. Requires a prior sign-in only
 * for a selection that could pop a browser - a bare typed host, or a no-token
 * `external-browser` profile (else `oauth_login_required`); every other named
 * profile the SDK authenticates itself and lists without a sign-in step.
 */
export async function GET({ url }) {
	const sel = selectionFrom(url);
	try {
		return json({ ...sel, clusters: await listClusters(sel) });
	} catch (err) {
		return databricksErrorResponse(err);
	}
}
