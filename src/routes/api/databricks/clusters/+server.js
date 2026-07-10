import { json } from '@sveltejs/kit';
import { listClusters, statusFor } from '$lib/server/databricks.js';

/**
 * Clusters visible to `?profile=` (default DEFAULT), via the SDK in a
 * subprocess of the project venv. Job/pipeline clusters are filtered out -
 * they cannot be attached to. Never touches the kernel.
 */
export async function GET({ url }) {
	const profile = url.searchParams.get('profile') || 'DEFAULT';
	try {
		return json({ profile, clusters: await listClusters(profile) });
	} catch (err) {
		const code = err?.code ?? 'error';
		return json({ code, message: String(err?.message ?? err) }, { status: statusFor(code) });
	}
}
