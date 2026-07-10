/**
 * A Databricks connection is chosen either by `~/.databrickscfg` profile or by a
 * typed workspace host. Every listing route accepts both and forwards the one
 * that is present to `databricks.js`, which resolves it to the right auth (PAT
 * for a profile with a token, external-browser OAuth otherwise). Profile wins if
 * both are somehow present.
 */
export function selectionFrom(url) {
	const profile = url.searchParams.get('profile');
	if (profile) return { profile };
	return { host: url.searchParams.get('host') || '' };
}
