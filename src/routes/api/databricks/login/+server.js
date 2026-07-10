import { json } from '@sveltejs/kit';
import { login, statusFor } from '$lib/server/databricks.js';

/**
 * Sign in to a workspace so the fast listing subprocesses (and the kernel
 * session) can run without a surprise browser. For a PAT profile this is an
 * instant no-op; for OAuth it runs the interactive external-browser flow in a
 * long-lived subprocess - the system browser opens, the user authenticates as
 * themselves, and the SDK caches the token to disk. No `databricks` CLI and no
 * pre-cached `databricks auth login` are required.
 *
 * Takes `{profile}` (a `~/.databrickscfg` profile) or `{host}` (a workspace host
 * typed by hand, so a teammate with no profile can still connect).
 */
export async function POST({ request }) {
	const { profile, host } = await request.json();
	try {
		return json(await login(profile ? { profile } : { host }));
	} catch (err) {
		const code = err?.code ?? 'error';
		return json({ code, message: String(err?.message ?? err) }, { status: statusFor(code) });
	}
}
