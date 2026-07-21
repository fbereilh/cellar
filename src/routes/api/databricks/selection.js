/**
 * A Databricks connection is chosen either by `~/.databrickscfg` profile or by a
 * typed workspace host. Every listing route accepts both and forwards the one
 * that is present to `databricks.js`, which resolves it to the right auth (a
 * named profile the SDK authenticates by name, whatever its `auth_type`, or
 * external-browser OAuth against a bare typed host). Profile wins if both are
 * somehow present.
 */
export function selectionFrom(url) {
	const profile = url.searchParams.get('profile');
	if (profile) return { profile };
	return { host: url.searchParams.get('host') || '' };
}
