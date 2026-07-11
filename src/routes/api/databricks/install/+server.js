import { json } from '@sveltejs/kit';
import { installDeps, statusFor } from '$lib/server/databricks';

/**
 * Install `databricks-sdk` + `databricks-connect` into the *project* venv (the
 * kernel's own environment) with uv - the same lever `venv.js` uses for
 * ipykernel, so the packages the kernel can import are the packages our
 * server-side SDK subprocess can import.
 *
 * `{version}` pins `databricks-connect` to a Databricks Runtime line (e.g.
 * "16.1" → `databricks-connect==16.1.*`). Unpinned installs the latest, which
 * only talks to the latest DBR - the usual first-run surprise.
 */
export async function POST({ request }) {
	const { version } = await request.json().catch(() => ({}));
	try {
		return json(await installDeps({ version: version || undefined }));
	} catch (err) {
		const code = err?.code ?? 'error';
		return json({ code, message: String(err?.message ?? err) }, { status: statusFor(code) });
	}
}
