import { json } from '@sveltejs/kit';
import { uploadNotebook } from '$lib/server/databricks';
import { databricksErrorResponse } from '../error-response.js';

/**
 * Upload the open notebook into the connected user's own Databricks workspace
 * folder (`/Users/<user>/<name>`) as a real, cells-intact JUPYTER notebook.
 *
 * Runs server-side through the SAME authenticated `WorkspaceClient` every
 * listing uses - no second auth flow - and touches only workspace files: it
 * never starts, stops or restarts a cluster.
 *
 * `overwrite` is opt-in. Without it the server reports `{status:'exists'}` and
 * writes nothing, so replacing a notebook already in the workspace is always a
 * second, deliberate request the user confirmed.
 *
 * `prefix`/`postfix` optionally wrap the notebook's own name (the sidebar sends
 * them already date-token-expanded, which is what makes its preview exact); both
 * omitted is the original behaviour, unchanged. They cannot move the upload out
 * of the user's folder - `$lib/databricksUploadName` refuses a separator or a
 * control character rather than repairing it, and a present non-string affix is
 * a `bad_request` rather than a silent no-affix.
 */
export async function POST({ request }) {
	const { path, overwrite, prefix, postfix } = await request.json().catch(() => ({}));
	try {
		// `path` targets THAT notebook (each notebook has its own Databricks
		// connection); omitting it targets the active notebook.
		return json(
			await uploadNotebook({
				nb: path,
				overwrite: overwrite === true,
				// Forwarded RAW, deliberately: omitted/null is the no-affix path, and a
				// present non-string is REFUSED as `bad_request` one layer down rather
				// than coerced to no-affix here - a caller with no preview must not get a
				// 200 over a name they never asked for.
				prefix,
				postfix
			})
		);
	} catch (err) {
		return databricksErrorResponse(err);
	}
}
