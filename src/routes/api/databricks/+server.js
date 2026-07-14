import { json } from '@sveltejs/kit';
import { getStatus } from '$lib/server/databricks';

/**
 * Everything the sidebar's Databricks section needs in one read: the profiles
 * found in `~/.databrickscfg`, whether the kernel's venv can import the SDK, and
 * the live connection (epoch-checked, so a kernel restart reads as disconnected).
 *
 * Never boots a kernel and never contacts a workspace, so it is safe to poll.
 */
export async function GET({ url }) {
	try {
		// `path` is the notebook whose connection to report - the sidebar sends the
		// ACTIVE notebook, so the panel reflects the focused notebook's session.
		return json(await getStatus(url.searchParams.get('path')));
	} catch (err) {
		return json({ code: err?.code ?? 'error', message: String(err?.message ?? err) }, { status: 500 });
	}
}
