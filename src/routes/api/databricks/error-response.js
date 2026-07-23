import { json } from '@sveltejs/kit';
import { statusFor } from '$lib/server/databricks';

/**
 * The ONE failure body every Databricks route returns: `{code, message}` plus,
 * for the failures that are about a specific `~/.databrickscfg` profile
 * (`profile_reauth_required`), the profile name - the sidebar needs the REAL
 * name to render the exact `databricks auth login --profile <name>` command
 * rather than a hardcoded one.
 *
 * Shared so the shape cannot drift between the eight routes that catch a
 * `DatabricksError`; the UI keys its copy off `code`, so a route that quietly
 * dropped a field would silently lose the remedy.
 */
export function databricksErrorResponse(err) {
	const code = err?.code ?? 'error';
	const body = { code, message: String(err?.message ?? err) };
	if (typeof err?.profile === 'string' && err.profile) body.profile = err.profile;
	return json(body, { status: statusFor(code) });
}
