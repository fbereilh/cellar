/**
 * Cellar - custom instructions for chat cells and MCP agents (pure, browser-safe).
 *
 * The person may add standing instructions of their own to the two places Cellar
 * instructs a model: the chat cell's system prompt and the MCP `instructions` an
 * agent receives at connect. They can write one text per place, or MERGE them so
 * the same text is used in both.
 *
 * Person-scoped (`~/.cellar/settings.json`), like the chat model beside it: how
 * someone wants a model to work with them is about the person, not a project.
 *
 * The ONE resolution rule lives here so the Settings pane and both server
 * surfaces cannot disagree about which text applies.
 */

/** Instructions for chat cells, used while the two are NOT merged. */
export const CUSTOM_INSTRUCTIONS_CHAT_KEY = 'cellar-custom-instructions-chat';

/** Instructions for MCP agents, used while the two are NOT merged. */
export const CUSTOM_INSTRUCTIONS_MCP_KEY = 'cellar-custom-instructions-mcp';

/**
 * The merge flag. Only a literal `true` merges, so hand-edited junk in the
 * untyped store keeps the two texts separate.
 */
export const CUSTOM_INSTRUCTIONS_MERGED_KEY = 'cellar-custom-instructions-merged';

/**
 * The one text used in BOTH places while merged. Its own key, so merging and
 * un-merging never overwrites the two separate texts.
 */
export const CUSTOM_INSTRUCTIONS_SHARED_KEY = 'cellar-custom-instructions-shared';

/**
 * The longest text sent. The chat text rides the child's argv inside
 * `--system-prompt`, and the MCP text is paid for by every agent session, so
 * both are bounded. The Settings fields enforce the same number.
 */
export const CUSTOM_INSTRUCTIONS_MAX_CHARS = 4000;

export type CustomInstructionsTarget = 'chat' | 'mcp';

/** Is the merge on? Strict, like every other opt-in in the store. */
export function customInstructionsMerged(value: unknown): boolean {
	return value === true;
}

/**
 * Make a stored value safe to send: text only, no control characters except
 * newline and tab, trimmed and bounded. A NUL in an argv element makes `spawn`
 * throw, and the store is untyped JSON, so a non-string reads as no instructions.
 */
export function cleanCustomInstructions(value: unknown): string {
	if (typeof value !== 'string') return '';
	// eslint-disable-next-line no-control-regex
	const text = value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '');
	return text.trim().slice(0, CUSTOM_INSTRUCTIONS_MAX_CHARS).trimEnd();
}

/**
 * The instructions that apply to one target, or `''` for none. Merged: the
 * shared text for both. Otherwise each target reads its own.
 */
export function resolveCustomInstructions(
	settings: Record<string, unknown> | null | undefined,
	target: CustomInstructionsTarget
): string {
	const s = settings ?? {};
	if (customInstructionsMerged(s[CUSTOM_INSTRUCTIONS_MERGED_KEY])) {
		return cleanCustomInstructions(s[CUSTOM_INSTRUCTIONS_SHARED_KEY]);
	}
	return cleanCustomInstructions(
		s[target === 'chat' ? CUSTOM_INSTRUCTIONS_CHAT_KEY : CUSTOM_INSTRUCTIONS_MCP_KEY]
	);
}

/**
 * The sentence that introduces the person's text to a model. Cellar's own rules
 * come first and win: this text is appended, never substituted.
 */
export const CUSTOM_INSTRUCTIONS_HEADING =
	'The person using this notebook added these standing instructions. Follow them unless they conflict with a rule above:';

/** The block appended to a prompt, or `''` when there are no instructions. */
export function customInstructionsBlock(text: string): string {
	const clean = cleanCustomInstructions(text);
	return clean ? `${CUSTOM_INSTRUCTIONS_HEADING}\n${clean}` : '';
}

/**
 * The shared text to start from when merging is turned on: keep one already
 * written, else adopt the chat text, else the MCP text.
 */
export function seedSharedInstructions(shared: string, chat: string, mcp: string): string {
	if (shared.trim()) return shared;
	if (chat.trim()) return chat;
	return mcp;
}
