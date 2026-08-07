/**
 * The cross-project user-setting KEYS for the default upload prefix/postfix.
 *
 * They live in a browser-safe module of their own because both sides need them and
 * only one side may import the other: the Settings pane WRITES them and the
 * Databricks panel SEEDS from them (both browser), while `$lib/server/user-settings`
 * re-exports these very constants so the store and its readers cannot drift onto two
 * spellings of the same key - a drift that would not throw, it would silently look
 * like a default the user set and Cellar then ignored.
 *
 * The stored value is the raw affix TEXT, tokens unexpanded (`{YYYYMM}_`, never
 * `202608_`): a default is a pattern reused across projects and across days, so
 * anything already resolved would stamp every later upload with a stale date.
 */
export const UPLOAD_PREFIX_DEFAULT_KEY = 'cellar-databricks-upload-prefix-default';
export const UPLOAD_POSTFIX_DEFAULT_KEY = 'cellar-databricks-upload-postfix-default';
