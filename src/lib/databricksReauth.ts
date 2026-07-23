/**
 * The ONE rule for "this named `~/.databrickscfg` profile's stored sign-in
 * expired", shared by the server (`databricks.ts`, which classifies the SDK
 * error) and the browser (`Databricks.svelte`, which renders the remedy).
 *
 * Why it needs to be its own case: a `databricks-cli` (or otherwise CLI-managed
 * OAuth) profile keeps its credential in the **databricks CLI's** own store, not
 * in the SDK's python-local OAuth cache that Cellar's browser sign-in mints into.
 * When its refresh token dies, Cellar's own "Sign in with Databricks" button
 * (`oauth_login_required` → `login()` → an external-browser flow scoped to a bare
 * host / a no-token `external-browser` profile) writes a credential the profile
 * will never read - so offering it is a dead end. The only thing that fixes it is
 * the CLI's own login, in a terminal:
 *
 *     databricks auth login --profile <name>
 *
 * Cellar deliberately does NOT run that for the user: it is an interactive
 * command that opens a browser, can prompt for a workspace choice on a TTY Cellar
 * does not own, and on macOS writes through the Keychain (`auth_storage = secure`
 * in `~/.databrickscfg`), which can raise its own consent dialog. Spawning it
 * from the server risks a hung subprocess and a half-written credential; showing
 * the exact command is the reliable remedy.
 *
 * Browser-safe by construction: no imports, pure string work.
 */

/** The `DatabricksError.code` for this case. Distinct from `oauth_login_required` on purpose. */
export const PROFILE_REAUTH_CODE = 'profile_reauth_required';

/**
 * The credential could not be refreshed. The databricks CLI's own wording is
 * "A new access token could not be retrieved because the refresh token is
 * invalid"; older/other shapes say expired, not set, or `invalid_refresh_token`.
 */
const REFRESH_DEAD = /refresh[ _]token(?:\s+is)?\s+(?:invalid|expired|not\s+set)|invalid_refresh_token/i;

/** The databricks-cli credential strategy is the one that failed to produce a token. */
const CLI_STRATEGY = /databricks-cli\b[\s\S]{0,120}?cannot get access token/i;

/** The CLI's own remedy sentence, e.g. "To reauthenticate, run: $ databricks auth login --profile DEFAULT". */
const CLI_LOGIN_REMEDY = /databricks\s+auth\s+login\b/i;

/**
 * Does this SDK error mean "a real named profile exists, but its stored sign-in
 * needs `databricks auth login` again"?
 *
 * Either signal alone would be too loose: `databricks auth login` also appears in
 * the CLI's generic "consider setting up a profile" hint, and "cannot get access
 * token" covers transient network failures too. So it is a dead refresh token
 * (unambiguous on its own), or the databricks-cli strategy failing *together
 * with* the CLI telling the user to log in again.
 */
export function isProfileReauthError(message: unknown): boolean {
	const m = typeof message === 'string' ? message : String(message ?? '');
	if (!m) return false;
	return REFRESH_DEAD.test(m) || (CLI_STRATEGY.test(m) && CLI_LOGIN_REMEDY.test(m));
}

/**
 * The command's two fixed halves. Exported because the sidebar renders it in a
 * ~200px-wide box where it MUST wrap, and a browser will happily wrap right after
 * a hyphen - splitting `--profile` into `-` / `-profile`, a command a reader would
 * mistype. The renderer keeps the flag in a no-wrap span; building the string from
 * the same two constants is what stops the displayed and the copied command from
 * ever drifting apart.
 */
export const REAUTH_COMMAND_HEAD = 'databricks auth login';
export const REAUTH_PROFILE_FLAG = '--profile';

/** The exact command the user must run in a terminal to fix `profile`. */
export function reauthCommand(profile: string): string {
	return `${REAUTH_COMMAND_HEAD} ${REAUTH_PROFILE_FLAG} ${profile}`;
}

/**
 * The one-line explanation shown above the command. Says what died and what the
 * user does about it - never that Cellar can fix it, because it cannot.
 */
export function reauthExplanation(profile: string): string {
	return `Your saved ${profile} sign-in expired. Re-authenticate in a terminal, then reconnect.`;
}

/** Separates Cellar's actionable head from the SDK's own text in `reauthMessage`. */
const MESSAGE_SEPARATOR = '\n\n';

/**
 * The server-side `DatabricksError.message`: the actionable sentence first (so a
 * log line, an MCP tool result, and the sidebar's detail row all carry the fix),
 * then the SDK's own text so the real cause is never hidden.
 */
export function reauthMessage(profile: string, detail?: string): string {
	const head = `${reauthExplanation(profile)} Run: ${reauthCommand(profile)}`;
	const tail = String(detail ?? '').trim();
	return tail ? `${head}${MESSAGE_SEPARATOR}${tail}` : head;
}

/**
 * The SDK's own text back out of a `reauthMessage()`. The sidebar renders the
 * head as a proper explanation plus a copyable command row, so echoing it into
 * the raw-detail line below would state the same remedy three times over. Empty
 * when there was no underlying detail - the caller then shows no detail line.
 *
 * Safe to split on: the head is written by `reauthMessage` in this same module,
 * so the separator is ours, not a shape guessed out of an SDK string.
 */
export function reauthDetail(message: unknown): string {
	const m = typeof message === 'string' ? message : String(message ?? '');
	const i = m.indexOf(MESSAGE_SEPARATOR);
	return i === -1 ? '' : m.slice(i + MESSAGE_SEPARATOR.length).trim();
}
