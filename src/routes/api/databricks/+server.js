import { json } from '@sveltejs/kit';
import { getStatus } from '$lib/server/databricks';
import { databricksErrorResponse } from './error-response.js';

/**
 * Everything the sidebar's Databricks section needs in one read: the profiles
 * found in `~/.databrickscfg`, whether the kernel's venv can import the SDK, the
 * live connection (epoch-checked, so a kernel restart reads as disconnected - and
 * flagged `restarting` while an expected rebuild is in flight), and the `runtime`
 * block describing what the LIVE kernel session was started with plus which
 * decisions the environment forces.
 *
 * Never boots a kernel, and safe to POLL (the panel does, ~1.2s, for as long as a
 * restart rebuild is in flight): the workspace probes are memoized behind a short
 * TTL and the liveness probe is memoized too, skipped while the kernel is busy and
 * never blocking on a reconnect.
 */
export async function GET({ url }) {
	try {
		// `path` is the notebook whose connection to report - the sidebar sends the
		// ACTIVE notebook, so the panel reflects the focused notebook's session.
		return json(await getStatus(url.searchParams.get('path')));
	} catch (err) {
		return databricksErrorResponse(err);
	}
}
