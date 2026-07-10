import { json } from '@sveltejs/kit';
import { getStatus } from '$lib/server/databricks.js';

/**
 * Everything the sidebar's Databricks section needs in one read: the profiles
 * found in `~/.databrickscfg`, whether the kernel's venv can import the SDK, and
 * the live connection (epoch-checked, so a kernel restart reads as disconnected).
 *
 * Never boots a kernel and never contacts a workspace, so it is safe to poll.
 */
export async function GET() {
	try {
		return json(await getStatus());
	} catch (err) {
		return json({ code: err?.code ?? 'error', message: String(err?.message ?? err) }, { status: 500 });
	}
}
