/**
 * The ONE workspace-host normalization, shared by the server (`databricks.ts`
 * `resolveAuth`) and the browser (`Databricks.svelte`).
 *
 * It has to be shared because the server records a completed sign-in under the
 * NORMALIZED host (`signedInHosts`), while the sidebar holds whatever the user
 * typed. A second, drifting copy of this rule would make the panel decide "we
 * have nothing to sign out of" for a host we are in fact signed in to - i.e. hide
 * the Logout button exactly when it matters.
 *
 * Browser-safe by construction: no imports, pure string work.
 */
export function normalizeDatabricksHost(host?: string | null): string {
	let h = String(host ?? '')
		.trim()
		.replace(/\/+$/, '');
	if (!h) return '';
	if (!/^https?:\/\//i.test(h)) h = `https://${h}`;
	return h.replace(/^http:\/\//i, 'https://');
}
