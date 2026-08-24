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
 * ## Paths are workspace-relative, in EITHER of the workspace's two SPELLINGS
 *
 * An absolute path inside the workspace is noise and leaks the user's directory
 * layout into a notebook that may be shared, so it is made relative through the
 * one shared `toWorkspaceRel` rule. But WHICH root a path is measured against is
 * not one string. The engine confines the child to - and cwds it into - the
 * CANONICAL spelling of the workspace (`claude-cli.ts` realpaths the root,
 * because its deny rules only bind in that namespace), while `CELLAR_WORKSPACE`
 * holds the LEXICAL one, and on macOS every `/tmp` and `/var/folders` workspace
 * differs between the two (`/tmp` -> `/private/tmp`). So the model forms its
 * absolute paths in the canonical spelling, and a lexical-only containment test
 * reported an ordinary in-workspace read as `outside the workspace` - the exact
 * opposite of what this feature exists to say, and with no `(failed)` marker
 * beside it, since the call had SUCCEEDED.
 *
 * The workspace therefore arrives as a `ChatWorkspaceRef` that may carry several
 * spellings, and a path inside ANY of them is inside. That cannot widen what is
 * called inside: the spellings are spellings of ONE directory, so accepting
 * either only ever admits a genuinely in-workspace path.
 *
 * The TOOL PATH is never realpath'd - only the ROOT is, once per run, by
 * `run-chat.ts`. The path may not exist at all (a read of a missing file is
 * exactly the failed-read case this must still render), and realpathing one side
 * of a prefix containment test is the trap documented at length for worktree
 * roots ("VERIFY by realpath, BIND and PERSIST lexically"). This module stays
 * purely lexical and touches no filesystem.
 *
 * A path that IS the workspace root renders as `.`, never as an outside path.
 * `toWorkspaceRel` answers null for both, but they are very different facts, and
 * a `Grep`/`Glob` whose `path` is the root is a granted, supported call - the
 * read grant admits the root itself as an explicit argument - so reporting it as
 * outside is a false claim about a search that ran squarely inside. `.` is also
 * what the relative branch already answers for that same directory, so one
 * spelling carries one meaning.
 *
 * A path that resolves OUTSIDE every spelling renders as `outside the workspace`
 * with no path at all: it closes the leak completely, and it costs no provenance,
 * because every shipped read shape confines reads to the workspace, so an outside
 * path is a call the CLI DENIES - the line carries `(failed)` beside it and the
 * reader learns what happened without the notebook carrying a stranger's
 * directory layout.
 *
 * `Glob`'s PATTERN is path-shaped too, and an ABSOLUTE one is held to that exact
 * rule - relativized, or NAMED. A glob pattern IS a path pattern and may
 * legitimately be written absolute (`/Users/me/proj/**` + `/*.py`), which is the
 * same leak through a differently-named field, in its worst shape: such a pattern
 * points outside the confinement root, so the CLI DENIES the call, and printing
 * it would write the directory layout into the reply, persist it to the `.ipynb`
 * and carry it into the HTML export precisely when the security boundary did its
 * job.
 *
 * A RELATIVE glob pattern is left VERBATIM - it is already workspace-relative
 * (the read shapes cwd the child at the root), and running it through the
 * `.`/`..` segment normalization a relative PATH gets would silently rewrite a
 * legal pattern, collapsing `src/../lib/*.py` to `lib/*.py`. WITH ONE EXCEPTION:
 * a pattern whose LEADING segment is `..` is an ESCAPE, and it is NAMED like any
 * other outside path. `pattern` is a Glob-only kind, so a `..` here really is a
 * traversal and not a regex quantifier; the child's cwd IS the confinement root,
 * so `../../Users/<name>/secrets/**` resolves outside, is DENIED, and printing it
 * would leak a username and two levels of layout in exactly the shape - and at
 * exactly the moment - the absolute rule above exists to prevent. Only a LEADING
 * escape is named, so an INTERIOR `..` is untouched and no legal glob is
 * rewritten; the `..` must be a whole SEGMENT, so `..foo/` and `...` are ordinary
 * patterns and stay verbatim.
 *
 * `Grep`'s pattern, though, is CONTENT and is rendered VERBATIM like a search
 * query - it is NOT path-shaped, and treating it as one was a false claim in the
 * other direction. A `Grep` pattern is a REGEX over file CONTENT rather than a
 * path expression, and a regex that merely STARTS WITH A SLASH is not a path:
 * `/api/v1/users`, a `/usr/bin/env` shebang, a slash-delimited regex are all
 * everyday queries, and measured against the workspace each one resolved outside
 * it and rendered `Grep(outside the workspace)` - with NO `(failed)` marker,
 * because the search ran squarely INSIDE and succeeded. That is the same false
 * claim this section exists to remove, produced from the opposite side.
 *
 * STATED RESIDUAL, since this module's rule is to say only what was verified: a
 * `Grep` pattern is model-authored text and MAY contain a path literal (the model
 * reads a file naming `/Users/<name>/data`, then greps for that string), which is
 * then printed as written into the reply, the `.ipynb` and the export. That is
 * the same class of exposure a `WebSearch` query already carries, and there is no
 * fix for it that does not reintroduce the worse false claim above - so it is
 * accepted and recorded rather than claimed away. `Grep`'s `path` field is its
 * path-shaped one, and that one IS measured.
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
 * The `>` and the `\` are raw markdown, so they ARE briefly visible while the
 * run streams (the live view shows raw text; only the finalize renders it). On a
 * run that settles `ok` that is transient - but on a failed or cancelled one it
 * is permanent, which is limitation 2 below rather than a passing detail.
 *
 * ## KNOWN, ACCEPTED limitation 1: an unterminated code fence swallows the line
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
 *
 * ## KNOWN, ACCEPTED limitation 2: a FAILED or CANCELLED run keeps them RAW
 *
 * On a run that FAILS (`api_error`, `rate_limited`, `unsafe_init`,
 * `transcript_too_large`, `not_signed_in`, `not_installed`) or is CANCELLED (the
 * user pressing Stop, an interrupt, a kernel restart or shutdown, the run timing
 * out), the annotation SYNTAX is what persists. `run.ts`'s finalize is gated on
 * `status === 'ok'`, so those paths leave the outputs as
 * `[stream(reply + tool lines), display_data(failure)]` and the stream element
 * renders as PLAIN TEXT rather than as markdown: the reader sees the leading
 * `>`, the backticks around the call signature, the trailing `\` hard break
 * between consecutive lines, and `*(failed)*` / `*(no result)*` as literal
 * asterisks - permanently, not for the length of the run.
 *
 * Accepted, for three reasons. It is PARTLY PRE-EXISTING: a failed run already
 * persisted its partial reply as raw markdown before this feature, so the
 * model's own `**bold**` and `##` already showed literally on that path. The
 * `*(no result)*` line being there AT ALL is the feature working as intended -
 * on a Stop it is exactly the provenance this exists to give, that a tool ran
 * and never came back - so only its RENDERING is ever at issue, never its
 * presence. And it is the ONE path where the syntax is visible for good, which
 * is precisely why it is written down rather than left to be discovered.
 *
 * The eventual fix is to finalize the surviving stream text into markdown BEFORE
 * appending the failure `display_data`; a follow-up is filed. It is out of scope
 * here because it changes the persisted shape of EVERY failed chat run (two
 * `display_data` where there were a `stream` and a `display_data`) and touches
 * the same no-retract-frame reasoning that makes a capped run skip the finalize,
 * so it needs its own test pass. EXPLICITLY REJECTED, so nobody re-proposes it:
 * stripping the `\` hard break on the failure path alone. A joining rule that
 * differs by OUTCOME is a second convention to maintain forever, bought for a
 * cosmetic gain on a path that is already degraded.
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
 * What a rendered field's value IS, which is what decides how it is rendered:
 *
 * - `content` - not a path at all: a search query, or a `Grep` regex over file
 *               CONTENT. Shown verbatim. A regex that merely starts with `/`
 *               (`/api/v1/users`) is NOT a path, so measuring one against the
 *               workspace reports a successful in-workspace search as an outside
 *               one - see the module header.
 * - `path`    - a filesystem path. Absolute: relativized or NAMED. Relative:
 *               normalized (so `src/sub/../a.py` reads `src/a.py`, and one that
 *               climbs out of the workspace is NAMED).
 * - `pattern` - a path PATTERN (`Glob`). Absolute: relativized or NAMED, exactly
 *               like a path, because that is where the leak is. Relative: left
 *               VERBATIM, because normalizing rewrites a legal glob
 *               (`src/../lib/*.py` would be collapsed) - EXCEPT a leading `..`
 *               segment, which is an escape and is NAMED.
 */
type TargetKind = 'content' | 'path' | 'pattern';

/** One renderable input field, and the kind of value it holds. */
interface TargetField {
	readonly field: string;
	readonly kind: TargetKind;
}

/**
 * Per tool, the input fields that may be RENDERED, in order: `[primary,
 * secondary?]`. An ALLOWLIST - a tool absent from this map renders its name and
 * nothing else, so a tool added to the engine later cannot leak an input shape
 * nobody decided was a target.
 *
 * Each field carries its KIND rather than being cross-referenced against a
 * separate set of path-shaped names: a second list is one a new field can miss
 * by mere omission, and missing it defaults to printing the value verbatim,
 * which is the leaking direction. Declared here, adding a field forces the
 * path-vs-content decision at the point of adding it - the same allowlist
 * doctrine this module already applies to tools.
 *
 * `path` rides along for `Glob`/`Grep` because a pattern without the directory it
 * ran in is not provenance - `load` says nothing, `load in src` does. It is also
 * `Grep`'s only path-shaped field, which is what carries the directory its
 * `pattern` is not measured for.
 *
 * A NULL-PROTOTYPE map, so the allowlist behaves as one for EVERY name: read off
 * an object literal, a tool called `toString`/`constructor`/`valueOf` resolves to
 * an INHERITED value and `__proto__` to an object - all truthy, so the
 * unrecognized-tool guard passes and iterating them throws. That throw would
 * escape through `onToolCall` into the child's unwrapped stdout listener and take
 * down the process carrying every kernel websocket, the SSE fan-out and the
 * in-process MCP server, so the formatter is hardened here exactly as the tracker
 * below already is against an unfamiliar shape.
 */
const TOOL_TARGETS: Record<string, readonly TargetField[]> = Object.assign(Object.create(null), {
	WebSearch: [{ field: 'query', kind: 'content' }],
	Read: [{ field: 'file_path', kind: 'path' }],
	Glob: [
		{ field: 'pattern', kind: 'pattern' },
		{ field: 'path', kind: 'path' }
	],
	Grep: [
		{ field: 'pattern', kind: 'content' },
		{ field: 'path', kind: 'path' }
	]
});

/** What an out-of-workspace path renders as - never the path itself. */
export const OUTSIDE_WORKSPACE = 'outside the workspace';

/**
 * Rendered length ceiling per FIELD (so a two-field `Grep` line can reach twice
 * this). A long query or path is elided with an ellipsis, never dropped: the
 * point is that the reader can see WHAT was consulted, and a bound that hid it
 * would defeat the feature to save characters.
 */
const MAX_TARGET_CHARS = 120;

/**
 * The workspace a rendered path is measured against: one spelling, or several.
 *
 * Several, because the lexical and canonical spellings of one workspace are both
 * in play (see the module header) - a path inside ANY of them is inside.
 */
export type ChatWorkspaceRef = string | readonly string[];

/** The spellings of `ref`, in the order they are tried. */
function workspaceSpellings(ref: ChatWorkspaceRef): readonly string[] {
	if (typeof ref === 'string') return [ref];
	return ref.filter((r): r is string => typeof r === 'string' && r !== '');
}

/**
 * Trailing separators are not part of a directory's identity, so `<ws>/` and
 * `<ws>` are the same place. `|| path` keeps a root of `/` intact.
 */
function trimTrailingSep(path: string): string {
	return path.replace(/[/\\]+$/, '') || path;
}

/** Whether `value` names a location from the filesystem root (POSIX or Windows). */
function isAbsolutePath(value: string): boolean {
	return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);
}

/**
 * An ABSOLUTE path or pattern, rendered against the workspace: workspace-relative
 * when it is inside, `.` when it IS the workspace, `OUTSIDE_WORKSPACE` otherwise.
 * This branch is the leak, so EVERY path-shaped field goes through it.
 *
 * It runs the shared `toWorkspaceRel` (boundary-aware, so a sibling directory
 * sharing the workspace's name as a prefix is not read as inside it) once per
 * spelling, taking the first that resolves. That helper answers null both for an
 * outside path and for the root ITSELF, so the root is tested for separately and
 * rendered `.` - collapsing the two would report a search of the workspace root
 * as a search outside it. Purely lexical: it touches no filesystem, so it is a
 * pure function of its two arguments.
 */
function absoluteAgainstWorkspace(value: string, workspace: ChatWorkspaceRef): string {
	const target = trimTrailingSep(value);
	for (const root of workspaceSpellings(workspace)) {
		const rel = toWorkspaceRel(root, value);
		if (rel !== null) return rel;
		if (trimTrailingSep(root) === target) return '.';
	}
	return OUTSIDE_WORKSPACE;
}

/**
 * A RELATIVE path, normalized: `./src/./a.py` and `src/sub/../a.py` both name
 * `src/a.py`, and one that climbs out with `..` is treated as outside. It is
 * already measured from the workspace - the read shapes run the child with the
 * workspace as its cwd - so nothing else is done to it.
 *
 * This is applied to a `path` field ONLY, never to a `pattern`: see the module
 * header for why normalizing a glob would rewrite a legal pattern.
 */
function normalizeRelativePath(value: string): string {
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

/** Render one field's value according to its declared kind (see `TargetKind`). */
function escapesWorkspace(value: string): boolean {
	const segments = value.split(/[/\\]+/);
	let i = 0;
	while (i < segments.length && (segments[i] === '' || segments[i] === '.')) i += 1;
	return segments[i] === '..';
}

function renderField(value: string, kind: TargetKind, workspace: ChatWorkspaceRef): string {
	if (kind === 'content') return value;
	if (isAbsolutePath(value)) return absoluteAgainstWorkspace(value, workspace);
	if (kind !== 'pattern') return normalizeRelativePath(value);
	return escapesWorkspace(value) ? OUTSIDE_WORKSPACE : value;
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
export function toolCallTarget(call: ChatToolCall, workspace: ChatWorkspaceRef): string | null {
	const fields = TOOL_TARGETS[call.name];
	if (!Array.isArray(fields)) return null;
	const parts: string[] = [];
	for (const { field, kind } of fields) {
		const raw = call.input?.[field];
		if (typeof raw !== 'string' || !raw.trim()) continue;
		parts.push(oneLine(renderField(raw.trim(), kind, workspace)));
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
export function toolCallLine(call: ChatToolCall, workspace: ChatWorkspaceRef): string {
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
