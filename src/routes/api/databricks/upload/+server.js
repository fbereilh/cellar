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
 * control character rather than repairing it.
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
				// Anything that is not a string is no affix at all: a number or an object
				// interpolated into a workspace name is never what a caller meant.
				prefix: typeof prefix === 'string' ? prefix : '',
				postfix: typeof postfix === 'string' ? postfix : ''
			})
		);
	} catch (err) {
		return databricksErrorResponse(err);
	}
}
