import { json } from '@sveltejs/kit';
import { reconnectSession } from '$lib/server/databricks';
import { databricksErrorResponse } from '../error-response.js';

/**
 * Reconnect: restore a notebook's Databricks Connect session against the cluster
 * the user ALREADY chose, after it went dead (idle-timeout / GC expiry, a closed
 * client, a dropped kernel socket, or a kernel restart). This is the user-facing
 * surface for the SAME one-click recovery the agent's `databricks_reconnect` tool
 * and the automatic expiry self-heal use - `reconnectSession` walks the one
 * recovery ladder (refresh socket → rebuild session → re-establish after restart),
 * so there is no second reconnect mechanism to drift.
 *
 * Can legitimately take a while when a databricks-connect re-pin restarts the
 * kernel or a cold cluster is involved, so the client shows a spinner. The success
 * payload carries `kernel_restarted` / `namespace_cleared` so the UI can warn that
 * the namespace was wiped.
 */
export async function POST({ request }) {
	const { path } = await request.json().catch(() => ({}));
	try {
		// `path` targets THAT notebook's session (each notebook has its own kernel +
		// Databricks session); omitting it targets the active notebook.
		return json(await reconnectSession(path));
	} catch (err) {
		return databricksErrorResponse(err);
	}
}
