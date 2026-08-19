/**
 * Cellar - the chat cell's shared vocabulary (pure, browser-safe).
 *
 * The one place the browser (ChatPanel, LiveNotebook's bulk-run abort) and the
 * server (`server/chat/*`) agree on the chat account/failure shapes, on the
 * key naming the selected account slot, and on what a legal slot NAME is - the
 * `databricksReauth.ts` precedent: a second copy of any of these would not
 * throw, it would silently tell the human and the engine different things.
 */

/**
 * The distinct failure states a chat run can end in. Each renders its own
 * actionable message (see `server/chat/failure.ts`); `rate_limited` is the one
 * the bulk-run loop also acts on (stops at the first, instead of failing every
 * later chat cell with the same message).
 */
export type ChatFailureKind =
	| 'not_installed' // the `claude` CLI is missing (spawn ENOENT)
	| 'not_signed_in' // no authenticated account resolved / CLI says not logged in
	| 'rate_limited' // the subscription's usage window is exhausted
	| 'api_error' // the CLI reported an API/model failure
	| 'unsafe_init' // the CLI's init event reported tools/MCP/skills present: fail closed
	| 'cancelled'; // interrupted (user interrupt / restart / shutdown)

/** The rate-limit failure kind, named for the one cross-module comparison. */
export const CHAT_RATE_LIMITED: ChatFailureKind = 'rate_limited';

/**
 * The user-settings key holding the selected Cellar account slot (a name under
 * `~/.cellar/claude/`). Machine-scoped (`~/.cellar/settings.json`) because the
 * credential it names is machine-scoped too - a keychain item, not a project
 * file. Absent/empty = no slot selected, so chat borrows the ambient terminal
 * login (read-only) when one exists.
 */
export const CHAT_SLOT_KEY = 'cellar-chat-claude-slot';

/**
 * Is `name` a legal account-slot name? A slot name becomes a DIRECTORY segment
 * under `~/.cellar/claude/`, so this is a security rule, not cosmetics: the
 * first character must be alphanumeric (which alone rules out `.`/`..` and
 * hidden names) and the rest stays in a safe set with no path separators.
 */
export function isValidChatSlotName(name: unknown): name is string {
	return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name);
}

/** What `claude auth status --json` reports about one slot (never a token). */
export interface ChatAccountInfo {
	loggedIn: boolean;
	authMethod?: string;
	email?: string;
	orgName?: string;
	subscriptionType?: string;
}

/** One named Cellar slot and who is signed in to it. */
export interface ChatSlotInfo {
	slot: string;
	account: ChatAccountInfo | null;
	selected: boolean;
}

/**
 * Which credential a chat run would use right now. `slot` = Cellar's own
 * selected slot; `ambient` = the user's terminal login, BORROWED read-only
 * (Cellar may use it and may never sign it out); `none` = signed in nowhere.
 */
export interface ChatAuthResolution {
	kind: 'slot' | 'ambient' | 'none';
	/** The slot name when kind === 'slot'. */
	slot?: string;
	account?: ChatAccountInfo | null;
	/** True when the `claude` CLI itself could not be found. */
	notInstalled?: boolean;
}
