import { json } from '@sveltejs/kit';
import { listClusters, statusFor } from '$lib/server/databricks';
import { selectionFrom } from '../selection.js';

/**
 * Clusters visible to the chosen `?profile=` or typed `?host=`, via the SDK in a
 * subprocess of the project venv. Job/pipeline clusters are filtered out - they
 * cannot be attached to. Never touches the kernel. Requires a prior sign-in for
 * OAuth selections (else `oauth_login_required`).
 */
export async function GET({ url }) {
	const sel = selectionFrom(url);
	try {
		return json({ ...sel, clusters: await listClusters(sel) });
	} catch (err) {
		const code = err?.code ?? 'error';
		return json({ code, message: String(err?.message ?? err) }, { status: statusFor(code) });
	}
}
