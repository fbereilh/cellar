/**
 * Cellar - the chat cell's tool-activity lines: one compact line per tool call
 * the model made, the way a coding harness shows them.
 *
 * ## Why this exists: it is PROVENANCE, not decoration
 *
 * A chat cell can hold tools - web search, and workspace `Read`/`Glob`/`Grep`.
 * Without a mark in the output a reader cannot tell whether a claim came from
 * the notebook the model was handed, from a web page, or from a file on disk.
 * These lines are what makes that legible, so the rules below are about what
 * they may CLAIM, not about how they look.
 *
 * ## The result is NEVER rendered - the line reports the CALL
 *
 * A `tool_result` is the model's INPUT: it can be enormous, and for a file read
 * it is the user's own file content, which has no business being pasted into an
 * output that gets committed and exported. Measured against claude 2.1.241, a
 * failed read's result even names the child's working directory. So the tracker
 * reads exactly two things off a result - its id, and whether it errored - and
 * discards `content` without looking at it. `toolCallLine` is a pure function of
 * the CALL, so no result string has a path to the output by construction.
 *
 * ## Only a KNOWN tool's KNOWN field is rendered (an allowlist, like everything
 * ## else here)
 *
 * `TOOL_TARGETS` names, per tool, the input fields that may be shown. An
 * unrecognized tool renders as its bare name with NO target, because an unknown
 * tool's input is an unknown shape - a `Write`'s `content`, say - and shipping
 * it would leak exactly what the rule above forbids, through the other door.
 * Widening this list means deciding, per field, that the value is a TARGET (a
 * query, a path, a pattern) and not a payload.
 *
 * ## Paths are workspace-relative, and an outside path is NAMED but not PRINTED
 *
 * An absolute path inside the workspace is noise and leaks the user's directory
 * layout into a notebook that may be shared, so it is made relative through the
 * one shared `toWorkspaceRel` rule. A path that resolves OUTSIDE the workspace
 * renders as `outside the workspace` with no path at all: it closes the leak
 * completely, and it costs no provenance, because every shipped read shape
 * confines reads to the workspace, so an outside path is a call the CLI DENIES -
 * the line carries `(failed)` beside it and the reader learns what happened
 * without the notebook carrying a stranger's directory layout.
 *
 * ## The rendered line
 *
 * A one-line blockquote holding a call signature in a code span:
 *
 *     > `Read(src/lib/loader.py)`
 *     > `Read(src/lib/missing.py)` *(failed)*
 *     > `WebSearch(Node.js current stable version)`
 *
 * The blockquote is what the app ALREADY renders as secondary text (`app.css`'s
 * `.cellar-md blockquote` - a left rule and 70%-opacity ink), and the chat
 * failure detail already uses it, so this invents no new visual family. The
 * target lives in a CODE SPAN because it is untrusted text that must not be
 * parsed as markdown: a recursive glob pattern is a run of asterisks and a
 * slash, which as prose opens emphasis and swallows the rest of the reply (that
 * pattern cannot even be written in this comment - its slash-star would close
 * it - which is the point rather than an inconvenience). `fenceCode` picks a
 * backtick run longer than any inside the target, which is what makes that
 * immunity hold for a target containing backticks too.
 *
 * ## KNOWN, ACCEPTED limitation: an unterminated code fence swallows the line
 *
 * These lines are markdown in the same stream as the reply, which is what makes
 * them persist, round-trip and export with it for free (see `run-chat.ts`). The
 * cost is markdown's own non-composability: if the model leaves a ``` fence open
 * when it calls a tool, the finalized render puts the line inside that code
 * block. That is a reply already broken by its own unterminated fence rather
 * than a failure this introduces, it cannot happen without one (a tool call ends
 * the assistant turn, so its text blocks are complete), and the line is still
 * plainly visible while the run streams - the live view shows raw text, and only
 * the finalize renders markdown. Closing the fence ourselves would corrupt the
 * user's code block, which is worse.
 */

import { toWorkspaceRel } from '$lib/workspacePath';

/**
 * How one tool call ended. `no_result` is the honest third state: the call was
 * made and the run settled before its result arrived (a stop, a timeout), so
 * neither success nor failure was observed.
 */
export type ChatToolOutcome = 'ok' | 'failed' | 'no_result';

/** One tool call, as the chat run learned of it. Never carries a result. */
export interface ChatToolCall {
	/** The tool's name exactly as the CLI reports it (`WebSearch`, `Read`, …). */
	name: string;
	/** The call's parsed input. Only allow-listed fields are ever rendered. */
	input: Record<string, unknown>;
	outcome: ChatToolOutcome;
}

/**
 * Per tool, the input fields that may be RENDERED, in order: `[primary,
 * secondary?]`. An ALLOWLIST - a tool absent from this map renders its name and
 * nothing else, so a tool added to the engine later cannot leak an input shape
 * nobody decided was a target.
 *
 * `path` rides along for `Glob`/`Grep` because a pattern without the directory it
 * ran in is not provenance - `load` says nothing, `load in src` does.
 */
const TOOL_TARGETS: Record<string, readonly string[]> = {
	WebSearch: ['query'],
	Read: ['file_path'],
	Glob: ['pattern', 'path'],
	Grep: ['pattern', 'path']
};

/** Input fields whose value is a FILE PATH (made workspace-relative). */
const PATH_FIELDS = new Set(['file_path', 'path']);

/** What an out-of-workspace path renders as - never the path itself. */
export const OUTSIDE_WORKSPACE = 'outside the workspace';

/** One target's rendered length ceiling; a long query/path is elided, not dropped. */
const MAX_TARGET_CHARS = 120;

/**
 * Render a path for the line: workspace-relative when it is inside the
 * workspace, and `OUTSIDE_WORKSPACE` when it is not.
 *
 * Absolute paths go through the shared `toWorkspaceRel` (boundary-aware, so a
 * sibling directory sharing the workspace's name as a prefix is not read as
 * inside it). A RELATIVE path is already workspace-relative - the read shapes
 * run the child with the workspace as its cwd - so it is only normalized, and
 * one that climbs out with `..` is treated as outside. Purely lexical: this
 * touches no filesystem, so it is a pure function of its two arguments.
 */
function relativePath(value: string, workspace: string): string {
	const isAbs = value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);
	if (isAbs) {
		const rel = toWorkspaceRel(workspace, value);
		return rel ?? OUTSIDE_WORKSPACE;
	}
	const parts: string[] = [];
	for (const seg of value.split(/[/\\]+/)) {
		if (!seg || seg === '.') continue;
		if (seg === '..') {
			if (parts.length === 0) return OUTSIDE_WORKSPACE; // climbs out of the workspace
			parts.pop();
			continue;
		}
		parts.push(seg);
	}
	return parts.join('/') || '.';
}

/** Collapse whitespace and bound the length; a target is one line, always. */
function oneLine(value: string): string {
	const flat = value.replace(/\s+/g, ' ').trim();
	return flat.length > MAX_TARGET_CHARS ? `${flat.slice(0, MAX_TARGET_CHARS - 1)}…` : flat;
}

/**
 * The target text for a call, or null when there is none to show (an
 * unrecognized tool, or a known one whose fields are absent or not strings).
 */
export function toolCallTarget(call: ChatToolCall, workspace: string): string | null {
	const fields = TOOL_TARGETS[call.name];
	if (!fields) return null;
	const parts: string[] = [];
	for (const field of fields) {
		const raw = call.input?.[field];
		if (typeof raw !== 'string' || !raw.trim()) continue;
		parts.push(oneLine(PATH_FIELDS.has(field) ? relativePath(raw.trim(), workspace) : raw));
	}
	if (parts.length === 0) return null;
	return parts.join(', ');
}

/**
 * Wrap `text` in an inline code span whose fence is longer than any backtick run
 * inside it (CommonMark's own rule), padding with spaces when the text starts or
 * ends with a backtick. This is what makes a target immune to markdown: no
 * emphasis, no link, no math, whatever the model asked for.
 */
function fenceCode(text: string): string {
	let longest = 0;
	for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
	const fence = '`'.repeat(longest + 1);
	const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
	return `${fence}${pad}${text}${pad}${fence}`;
}

/** The outcome's trailing marker - nothing at all for a call that succeeded. */
function outcomeSuffix(outcome: ChatToolOutcome): string {
	if (outcome === 'failed') return ' *(failed)*';
	if (outcome === 'no_result') return ' *(no result)*';
	return '';
}

/**
 * The markdown for one call, WITHOUT the leading `> ` (the caller owns how
 * consecutive lines join - see `run-chat.ts`). Never contains a newline.
 */
export function toolCallLine(call: ChatToolCall, workspace: string): string {
	const name = oneLine(call.name) || 'tool';
	const target = toolCallTarget(call, workspace);
	const signature = target === null ? name : `${name}(${target})`;
	return `${fenceCode(signature)}${outcomeSuffix(call.outcome)}`;
}

// -- the stream-json tracker --------------------------------------------------

/** A tool_use block seen on an assistant message, awaiting its result. */
interface PendingCall {
	id: string;
	name: string;
	input: Record<string, unknown>;
}

/**
 * Pairs the CLI's `tool_use` blocks with the `tool_result` blocks that answer
 * them, and reports each call ONCE, in the order its result arrived.
 *
 * The shapes it consumes, probed against claude 2.1.241 and committed verbatim
 * as `tests/unit/fixtures/chat-cli-*.ndjson`:
 *
 *   {type:'assistant', message:{content:[{type:'tool_use', id, name, input}, …]}}
 *   {type:'user',      message:{content:[{type:'tool_result', tool_use_id, is_error?, content}, …]}}
 *
 * The `assistant` event is what it reads, NOT the `content_block_start` /
 * `input_json_delta` stream: that pair reports the tool's name before its input
 * has finished streaming, so tracking it would mean reassembling partial JSON
 * for a target the very next event delivers already parsed. The accepted cost is
 * the millisecond window between the two - a run stopped exactly there records
 * nothing, while a stop during the call itself (the SLOW part: the search or the
 * read runs between the assistant event and its result) is caught by `flush`.
 *
 * `is_error` is the only thing read off a result besides its id; `content` is
 * discarded unread (see the module header).
 */
export class ChatToolTracker {
	private pending = new Map<string, PendingCall>();
	/** Insertion order, so `flush` reports unresolved calls as they were made. */
	private order: string[] = [];

	/**
	 * Consume one parsed stream-json event; returns the calls it RESOLVED, in the
	 * order the CLI answered them (empty for every other event). Unknown event
	 * types and malformed shapes are ignored - the stream is versioned by the CLI,
	 * and a tracker that threw on a new shape would break every chat cell on an
	 * update.
	 */
	observe(event: Record<string, unknown>): ChatToolCall[] {
		const content = messageContent(event);
		if (!content) return [];
		if (event.type === 'assistant') {
			for (const block of content) {
				if (block?.type !== 'tool_use') continue;
				const id = typeof block.id === 'string' ? block.id : null;
				const name = typeof block.name === 'string' ? block.name : null;
				if (!id || !name || this.pending.has(id)) continue;
				const input = block.input;
				this.pending.set(id, {
					id,
					name,
					input: typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {}
				});
				this.order.push(id);
			}
			return [];
		}
		if (event.type !== 'user') return [];
		const resolved: ChatToolCall[] = [];
		for (const block of content) {
			if (block?.type !== 'tool_result') continue;
			const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : null;
			if (!id) continue;
			const call = this.pending.get(id);
			if (!call) continue; // a result for a call we never saw: nothing to report
			this.pending.delete(id);
			// `is_error` is the WHOLE reading of a result. A refused call (the read
			// confinement denying a path) and a genuine failure (a missing file) both
			// arrive as `is_error: true` and are told apart only by the result TEXT,
			// which may never be rendered - so both report `failed`, which says what
			// was observed and claims nothing more.
			resolved.push({ name: call.name, input: call.input, outcome: block.is_error === true ? 'failed' : 'ok' });
		}
		return resolved;
	}

	/**
	 * The calls that never got a result, in the order they were made - reported
	 * once, at settle, so a run stopped mid-call still says a tool ran. Draining
	 * makes a second call a no-op.
	 */
	flush(): ChatToolCall[] {
		const out: ChatToolCall[] = [];
		for (const id of this.order) {
			const call = this.pending.get(id);
			if (call) out.push({ name: call.name, input: call.input, outcome: 'no_result' });
		}
		this.pending.clear();
		this.order = [];
		return out;
	}
}

/** `event.message.content` as an array of blocks, or null for anything else. */
function messageContent(event: Record<string, unknown>): Record<string, unknown>[] | null {
	const message = event.message as Record<string, unknown> | undefined;
	const content = message?.content;
	if (!Array.isArray(content)) return null;
	return content.filter((b): b is Record<string, unknown> => typeof b === 'object' && b !== null);
}
