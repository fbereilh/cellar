/**
 * Cellar - the claude CLI chat engine (the one ChatEngine implementation).
 *
 * ## The frozen flag set is the safety boundary - treat it like the sandbox
 * ## attribute in HtmlPreview: one word wide, pinned by a unit test.
 *
 * `chatCliArgs()` disables every capability except "answer this text" plus, on
 * explicit user opt-ins, web search and workspace-confined file READS and
 * NOTHING wider: `--tools <names>` (`""` by default - no tools; `WebSearch`
 * when the run opted in - search is mediated, so it is deliberately NOT
 * WebFetch or any fetch-shaped tool; `Read,Glob,Grep` when reads are on -
 * read-only, so never `Write`/`Edit`/`Bash`), `--allowedTools <rules>` on the
 * capability shapes ONLY (see below - `--tools` alone makes the tool exist but
 * leaves the CALL permission-gated, so an opt-in would be inert; the default
 * shape passes neither flag and is byte-for-byte the pre-settings argv),
 * `--disable-slash-commands`, `--setting-sources ""` (the user's/project's
 * CLAUDE.md, settings.json hooks, allowedTools etc. are never loaded),
 * `--strict-mcp-config` with no MCP config (no MCP servers),
 * `--no-session-persistence` (nothing written into the slot's history). The CLI
 * is spawned with the scrubbed env (`chatChildEnv`) and a NEUTRAL cwd
 * (`os.tmpdir()`), so no project directory can contribute context. The model is
 * a user setting, but NO user text reaches argv: the stored value is constrained
 * to `$lib/chatCell`'s closed `CHAT_MODELS` list (`normalizeChatModel`, applied
 * HERE as well as at the settings read, so no caller can route around it) and
 * anything else falls back to the default. And the permissions-bypass flag (the
 * "dangerously skip" one) is never passed - a read-only search tool needs no
 * permission skipped, and the literal appearing ANYWHERE in this module (this
 * comment included) is a test failure.
 *
 * ## `--tools` REQUESTS a tool; `--allowedTools` GRANTS the call
 *
 * Measured against claude 2.1.237: with `--tools WebSearch` alone the session
 * LISTS the tool (so `system/init` reports it and the allowlist assertion below
 * passes), but in non-interactive `-p` mode the CALL is still permission-gated
 * - the model calls WebSearch and the CLI answers `Claude requested permissions
 * to use WebSearch, but you haven't granted it yet.`, so the opt-in is INERT
 * and the reply a user sees is a dead end Cellar offers no way out of (and not
 * the `unsafe_init` path any copy explains). The identical argv plus
 * `--allowedTools WebSearch` performs the search and returns cited results, so
 * the search shape passes BOTH flags - and both from the SAME
 * `chatToolAllowlist(webSearch)` the init assertion reads, one source for
 * request, grant and assertion, so the grant can never name a tool the run did
 * not request and then assert. An EMPTY `--allowedTools` is never passed: the
 * default shape omits the flag entirely, which is what keeps its argv
 * byte-for-byte the pre-settings one.
 *
 * ## Workspace reads are CONFINED BY PATH-SCOPED GRANTS, and nothing else
 *
 * A chat cell's prompt is partly notebook CONTENT, and web search is an outbound
 * channel, so unconfined reads would put `.env` files, credentials and keys one
 * prompt away from an exfiltration path. Confinement is therefore the feature,
 * not a nicety attached to it - and it is enforced by the GRANT PATTERN, which
 * is the one mechanism measured to work. Probed against claude 2.1.238
 * (2026-08-21), every case driven end to end through a real `-p` run:
 *
 *   - A BARE `--allowedTools Read,Glob,Grep` grant is NOT confined by anything,
 *     the child's cwd included: from a cwd inside the workspace, an absolute
 *     path to a file outside it was READ, and an unscoped `Grep` returned the
 *     matching LINE CONTENT of a file outside it. So the cwd is never the
 *     confinement mechanism, and a grant must never be spelled bare.
 *   - A PATH-SCOPED grant (`Read(//abs/root/**)`, likewise `Glob`/`Grep`)
 *     refuses everything outside the root: the CLI answers the call with
 *     `is_error: true` and "requested permissions to read from <path>, but you
 *     haven't granted it yet", i.e. an ungranted call is DENIED in `-p` mode
 *     rather than prompting. Every read tool must carry its own pattern -
 *     scoping `Read` while leaving `Grep` bare leaks file content through Grep.
 *   - Inside the root everything still works: nested directories, dotfiles, the
 *     root path itself as an explicit `path` argument, and the tools' default
 *     (no `path`) behaviour, which is why reads-on moves the cwd there.
 *   - The escapes are closed by the CLI's own matcher, not by us: an absolute
 *     path containing `..` that resolves outside is refused (the refusal names
 *     the RESOLVED path, so matching happens after normalization), and an
 *     absolute path through a symlink that leaves the root is refused too
 *     (Glob does not follow such a link at all).
 *   - A workspace path containing a space, a comma, and even the adversarial
 *     segment `,Read,` - which would inject a BARE unscoped `Read` grant if the
 *     flag's "comma or space-separated" parsing split the value - kept working
 *     inside and kept refusing outside. The value is not split within one argv
 *     element.
 *
 * The root is the WORKSPACE, deliberately not a notebook's code root: a code
 * root may be an external git worktree, and Cellar's standing rule is that such
 * a root grants a kernel cwd and not one byte of file reach (every file surface
 * stays workspace-scoped, through `resolveInWorkspace`). Reads follow that rule
 * rather than inventing a second answer.
 *
 * Fail-closed all the way down: `chatToolPolicy` refuses any root it cannot
 * confine (non-string, empty, relative, non-POSIX) and yields a READ-LESS
 * policy, so the failure mode of every unknown is today's tool-less session.
 * And because the frozen system prompt is chosen from that same policy, a run
 * that ends up read-less is also told it cannot read.
 *
 * ## The init assertion (fail closed, EXACT allowlist - never a relaxation)
 *
 * Flags are a REQUEST; the CLI's own `system/init` event is the REPORT of what
 * the session actually got. Every run asserts that report against the tool set
 * THAT RUN requested, exactly: `tools` must equal the requested SET (`[]` for a
 * default run - byte-for-byte today's guarantee; `['WebSearch']` for a
 * search-on run; the read tools for a reads-on run - a report carrying any tool
 * the run did not request, or missing one it did, is the same verdict). It is a
 * SET comparison because the CLI reports its own order (a `Read,Glob,Grep`
 * request comes back `["Glob","Grep","Read"]`), and it compares bare NAMES
 * because that is what `system/init` reports - the path scope lives in the
 * grant, which is why the two are derived together. `mcp_servers` and
 * `slash_commands` stay asserted empty on EVERY path (`skills` empty when
 * present). A violation KILLS the child and fails the run `unsafe_init` rather
 * than rendering a reply produced by a session whose capabilities do not match
 * the request. A future CLI version that renames those fields fails closed
 * too: "cannot verify" is not "safe".
 *
 * The MISSING event fails closed the same way, and that is the same rule rather
 * than an extra one: an assertion that only runs when the report arrives is no
 * assertion at all, so a CLI that renames the event, drops it, or stops emitting
 * it under some future `stream-json` default would otherwise stream a reply from
 * a session whose capabilities were never verified. So NO delta is forwarded
 * before a verified init (the same guard the condemned-session case uses), and a
 * run that exits successfully having never reported one fails `unsafe_init`.
 *
 * ## Feed on stdin, close it
 *
 * The prompt is written to stdin and stdin is CLOSED. Passing it as the argv
 * positional was measured stalling ~3s waiting on stdin AND printing a warning
 * to stdout that corrupts the JSON stream - the design report's reproduction.
 *
 * ## stream-json shapes this parses (probed against claude 2.1.x, committed in
 * ## the unit fixtures)
 *
 *   {type:'system',subtype:'init',tools:[],mcp_servers:[],slash_commands:[],skills:[],claude_code_version,...}
 *   (with `--tools WebSearch`, claude 2.1.237 reports tools:["WebSearch"] - exactly
 *   the requested tool and nothing else; probed rather than assumed, and committed
 *   as the SEARCH_INIT fixture beside SAFE_INIT in the unit test)
 *   {type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'...'}}}
 *   {type:'rate_limit_event',rate_limit_info:{status:'allowed'|...,resetsAt:<epoch-sec>,...}}
 *   {type:'result',subtype:'success',is_error:false,result:'...',...}
 *
 * Unknown event types and non-JSON lines are skipped - the stream is versioned
 * by the CLI, and a parser that threw on a new event type would break every
 * chat cell on a CLI update.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { normalizeChatModel } from '$lib/chatCell';
import { chatChildEnv, CLAUDE_BIN } from './env';
import type { ChatEngine, ChatEngineFailure, ChatEngineResult, ChatEngineRunArgs } from './engine';

/**
 * The one tool a search-on run requests, spelled exactly as the CLI reports it
 * in `system/init` (probed against claude 2.1.237: `--tools WebSearch` reports
 * `tools:["WebSearch"]`, nothing else). Search ONLY - never WebFetch: search is
 * mediated, arbitrary URL fetching is not.
 */
export const WEB_SEARCH_TOOL = 'WebSearch';

/**
 * The read tools a workspace-reads run requests, spelled exactly as the CLI
 * reports them in `system/init`. Probed against claude 2.1.238: `--tools
 * Read,Glob,Grep` reports `tools:["Glob","Grep","Read"]` - the same SET, in the
 * CLI's own order, which is why the init assertion compares sets and never
 * array order.
 *
 * READ-ONLY, and deliberately not one tool wider: no `Write`/`Edit` (a chat cell
 * is a place to learn about code, not a second editor beside the notebook), no
 * `Bash` (which is arbitrary execution and would make every path rule below
 * decorative), and never `WebFetch`.
 */
export const READ_TOOLS: readonly string[] = ['Read', 'Glob', 'Grep'];

/** The per-run capabilities a policy is derived from. */
export interface ChatCapabilities {
	/** Only a literal `true` widens the session to web search. */
	webSearch?: boolean;
	/**
	 * The ABSOLUTE directory workspace reads are confined to, or null/absent for
	 * no reads at all. `chatToolPolicy` re-validates it (see there): anything it
	 * cannot confine yields a read-less policy rather than an unconfined one.
	 */
	readRoot?: string | null;
}

/**
 * One run's tool decision: the bare tool NAMES and the GRANT rules, from one
 * function so request, grant and assertion can never drift.
 *
 * The two lists are not the same strings and that is the whole point of keeping
 * them together. `--tools` and the `system/init` assertion speak bare NAMES
 * (`Read`); `--allowedTools` speaks permission RULES, and for the read tools
 * those rules carry a path pattern (`Read(//abs/path/**)`) - which is what makes
 * the reads confined rather than a licence to read the filesystem. Derived
 * side by side, a grant can never name a tool the run did not request and then
 * assert, and a scoped tool can never be granted unscoped by accident.
 */
export interface ChatToolPolicy {
	/** What `--tools` requests AND what `system/init` must report, exactly. */
	readonly tools: readonly string[];
	/** What `--allowedTools` grants (path-scoped for the read tools). */
	readonly grants: readonly string[];
	/** The confinement root reads were granted under, or null when reads are off. */
	readonly readRoot: string | null;
	/** Whether web search was granted (decides the frozen prompt with `readRoot`). */
	readonly webSearch: boolean;
}

/**
 * The confinement root, normalized, or null when this value cannot be confined.
 *
 * Fails CLOSED on everything it is not sure of, because the alternative to a
 * confined read is an unconfined one: a non-string, an empty string, a relative
 * path, and anything that does not normalize to a POSIX-absolute path all yield
 * null (= reads off). The POSIX check is not incidental - the `//` rule prefix
 * below is the CLI's absolute-path spelling and was measured on POSIX only, so
 * a Windows-style root is refused rather than turned into a rule whose matching
 * behaviour nobody here has established.
 */
export function chatReadRoot(value: unknown): string | null {
	if (typeof value !== 'string' || !value.startsWith('/')) return null;
	const abs = resolve(value);
	return abs.startsWith('/') ? abs : null;
}

/**
 * The `--allowedTools` path pattern confining a read tool to `root`.
 *
 * `//<path-without-leading-slash>/**` is the CLI's own spelling of an absolute
 * path in a permission rule. Measured against claude 2.1.238 (see the module
 * header's confinement section): it admits the root itself, every nested file
 * and dotfiles, and refuses everything outside it.
 */
function readGrantPattern(root: string): string {
	return `//${root.replace(/^\/+/, '')}/**`;
}

/**
 * The tool policy for one run - the ONE source feeding `--tools`,
 * `--allowedTools`, the `system/init` assertion, the frozen system prompt and
 * the child's cwd. `{}` is the default bare session: no tools, no grants.
 */
export function chatToolPolicy(caps: ChatCapabilities = {}): ChatToolPolicy {
	const webSearch = caps.webSearch === true;
	const readRoot = chatReadRoot(caps.readRoot);
	const tools: string[] = [];
	const grants: string[] = [];
	if (webSearch) {
		tools.push(WEB_SEARCH_TOOL);
		// Search takes no path scope: it has no path to scope.
		grants.push(WEB_SEARCH_TOOL);
	}
	if (readRoot) {
		const pattern = readGrantPattern(readRoot);
		for (const tool of READ_TOOLS) {
			tools.push(tool);
			grants.push(`${tool}(${pattern})`);
		}
	}
	return { tools, grants, readRoot, webSearch };
}

/**
 * The fixed system prompts, one per capability shape. Each is FROZEN
 * deliberately: the prompt is part of the cached prompt prefix (see
 * transcript.ts's byte-stability rule), so nothing time-varying or per-run may
 * be interpolated into any of them.
 *
 * FOUR variants rather than one templated string, because the prompt must be
 * TRUE for the capability the run actually has - the bare prompt's "you cannot
 * read files" is false for a reads-on run, and a model told it cannot read while
 * holding `Read` is a bad state - while a single interpolated prompt would make
 * byte-stability a property of the interpolation instead of the constants. Note
 * what the composition below is and is not: the shared framing is spread from a
 * module-scope array of LITERALS and joined once at module load, so each export
 * is a fixed string. No per-run value may ever enter - emphatically NOT the
 * confinement root, which differs per install and would make every run's prefix
 * a cache miss while leaking the path into the model's context.
 *
 * Flipping a setting changes which frozen prefix is sent (one cache miss), which
 * is inherent to changing the capability; within a shape every run stays
 * byte-stable.
 */
const PROMPT_FRAMING: readonly string[] = [
	'You are the AI assistant inside Cellar, a data notebook. The user message is',
	'the notebook so far, rendered as labelled blocks: [cell <id> · <kind>] holds',
	"a cell's source, [cell <id> · output] its result, [cell <id> · reply] an",
	'earlier answer of yours, and [question] is what to answer now. Answer in',
	'concise markdown.'
];

/** The claim every reads-on shape makes about its file reach, verbatim. */
const READS_SENTENCE: readonly string[] = [
	'You can read files in the notebook\'s own workspace with Read, Glob and Grep,',
	'and only there - paths outside it are refused, so do not try. Use them to',
	'ground your answer in the real code, and say which file a claim came from.',
	'You cannot write or edit files and cannot run code - never claim to have done',
	'so; when something needs running, say what to run.'
];

export const CHAT_SYSTEM_PROMPT = [
	...PROMPT_FRAMING,
	'You have no tools and cannot run code, read files, or',
	'browse - never claim to have done so; when the notebook lacks what you would',
	'need, say what to run.'
].join(' ');

/** The search-on variant: same framing, capability sentence accurate for it. */
export const CHAT_SYSTEM_PROMPT_WEB_SEARCH = [
	...PROMPT_FRAMING,
	'Your only tool is web search - use it when the question',
	'needs current or external information, and say when a claim comes from a',
	'search result. You cannot run code or read files - never claim to have done',
	'so; when the notebook lacks what you would need, say what to run.'
].join(' ');

/** The reads-on variant: file reach, no search. */
export const CHAT_SYSTEM_PROMPT_READS = [...PROMPT_FRAMING, ...READS_SENTENCE, 'You cannot browse the web.'].join(' ');

/** Both capabilities. */
export const CHAT_SYSTEM_PROMPT_READS_WEB_SEARCH = [
	...PROMPT_FRAMING,
	...READS_SENTENCE,
	'You can also search the web when the question needs current or external',
	'information; say when a claim comes from a search result.'
].join(' ');

/**
 * Which frozen prompt a run sends - decided by the SAME policy that decides the
 * argv, so the prompt can never describe a capability shape the run does not
 * have.
 */
export function chatSystemPrompt(policy: ChatToolPolicy): string {
	if (policy.readRoot && policy.webSearch) return CHAT_SYSTEM_PROMPT_READS_WEB_SEARCH;
	if (policy.readRoot) return CHAT_SYSTEM_PROMPT_READS;
	if (policy.webSearch) return CHAT_SYSTEM_PROMPT_WEB_SEARCH;
	return CHAT_SYSTEM_PROMPT;
}

/** The per-run inputs `chatCliArgs` accepts (all optional = today's bare run). */
export interface ChatCliOptions extends ChatCapabilities {
	/** Untrusted: constrained through `normalizeChatModel` before touching argv. */
	model?: unknown;
}

/**
 * The frozen argv (everything but the binary). A FUNCTION returning a fresh
 * array so no caller can mutate the shared safety boundary; the unit test pins
 * the exact contents of all four capability shapes, and `chatCliArgs()` with no
 * arguments is byte-for-byte the pre-settings argv.
 */
export function chatCliArgs(opts: ChatCliOptions = {}): string[] {
	const policy = chatToolPolicy(opts);
	return [
		'-p',
		'--tools',
		policy.tools.join(','),
		// The GRANT (see the header): `--tools` alone leaves the call
		// permission-gated in `-p` mode, so without this the opt-in is inert. Derived
		// from the SAME policy as the request and the assertion - never a wider set -
		// and omitted entirely (not passed empty) when there is nothing to grant,
		// which is what keeps the default argv byte-for-byte the pre-settings one.
		//
		// ONE argv element, comma-joined, exactly as the search shape has always
		// passed it. The read rules embed a filesystem path, so the flag's
		// "comma or space-separated" parsing is a real question: measured against
		// claude 2.1.238 with a workspace path containing a space, a comma, and the
		// adversarial segment `,Read,` (which would inject a BARE unscoped `Read`
		// grant if the value were split), confinement held in every case - the value
		// is not split inside one argv element. Pinned by the injection case in
		// `tests/unit/chat-engine-safety.test.ts`.
		...(policy.grants.length > 0 ? ['--allowedTools', policy.grants.join(',')] : []),
		'--disable-slash-commands',
		'--setting-sources',
		'',
		'--strict-mcp-config',
		'--no-session-persistence',
		'--model',
		normalizeChatModel(opts.model),
		'--include-partial-messages',
		'--output-format',
		'stream-json',
		'--verbose',
		'--system-prompt',
		chatSystemPrompt(policy)
	];
}

/**
 * The cwd one run's child is spawned in: the confinement root when reads are on,
 * else the NEUTRAL `os.tmpdir()` today's runs use.
 *
 * Reads-on has to move the cwd there - the tools resolve relative paths against
 * it and default to it when given no `path`, which is how a reply reaches the
 * workspace at all - and that is a real change worth stating: the child's cwd is
 * then a directory of the user's. What it does NOT do is widen the grant, which
 * is the path rules' job and not the cwd's: measured, a cwd inside the workspace
 * with an unscoped `Read` grant still read files anywhere on disk, so the cwd is
 * never the confinement mechanism.
 */
export function chatCliCwd(policy: ChatToolPolicy): string {
	return policy.readRoot ?? tmpdir();
}

/** How many chat children may run at once, across all notebooks. */
const MAX_CONCURRENT = 3;

/** Wall-clock bound on one run (a reply, not a batch job). */
function chatTimeoutMs(): number {
	const raw = Number(process.env.CELLAR_CHAT_TIMEOUT_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : 300_000;
}

// -- tiny FIFO semaphore ------------------------------------------------------
//
// ABORTABLE, for the same reason the run registers its controller before its
// first await: a stop the user asked for must take effect at every point the run
// can be waiting, not only the ones after the child exists. A run queued behind
// `MAX_CONCURRENT` otherwise resolved only when another notebook's chat run
// ended (up to the chat timeout), holding this notebook's kernel queue slot the
// whole time with Stop appearing to do nothing.
//
// The slot accounting is a HAND-OFF: `release` passes its slot to the next
// waiter without touching `inFlight`, so an aborted waiter that never received
// one must simply leave the queue - which is exactly what it does, and why an
// abort here must not be paired with a `release()`.
let inFlight = 0;
const waiters: Array<() => void> = [];
/** True when a slot was taken (release it), false when the wait was aborted. */
function acquire(signal: AbortSignal): Promise<boolean> {
	if (signal.aborted) return Promise.resolve(false);
	if (inFlight < MAX_CONCURRENT) {
		inFlight++;
		return Promise.resolve(true);
	}
	return new Promise((resolve) => {
		const waiter = () => {
			signal.removeEventListener('abort', onAbort);
			resolve(true);
		};
		const onAbort = () => {
			const at = waiters.indexOf(waiter);
			if (at >= 0) waiters.splice(at, 1);
			resolve(false);
		};
		signal.addEventListener('abort', onAbort, { once: true });
		waiters.push(waiter);
	});
}
function release(): void {
	const next = waiters.shift();
	if (next) next();
	else inFlight--;
}

// -- init assertion -----------------------------------------------------------

/**
 * Why an init report is unsafe/unverifiable, or null when it proves a session
 * holding EXACTLY `expectedTools` and nothing else. An ALLOWLIST check, never a
 * relaxation: the reported `tools` must equal the requested set - a tool the
 * run did not request is a capability no assertion covered, and a requested
 * tool the CLI did not grant means the (frozen, capability-accurate) system
 * prompt no longer describes the session - both are the same fail-closed
 * verdict. The default `[]` keeps the bare path's guarantee byte-for-byte:
 * `tools` exactly empty. `mcp_servers`/`slash_commands` are asserted empty on
 * every path (`skills` empty when present). Exported for the unit test
 * (fail-closed in BOTH directions).
 */
export function initViolation(init: Record<string, unknown>, expectedTools: readonly string[] = []): string | null {
	const tools = init.tools;
	if (!Array.isArray(tools)) return `the CLI's init event did not report tools - cannot verify the session's capabilities`;
	const extra = tools.filter((t) => !expectedTools.includes(t as string));
	if (extra.length > 0) return `the CLI session has tools enabled that this run did not request (${extra.map(String).join(', ')})`;
	const missing = expectedTools.filter((t) => !tools.includes(t));
	if (missing.length > 0) return `the CLI session is missing tools this run requested (${missing.join(', ')}) - the report does not match the request`;
	for (const key of ['mcp_servers', 'slash_commands'] as const) {
		const v = init[key];
		if (!Array.isArray(v)) return `the CLI's init event did not report ${key} - cannot verify the session is bare`;
		if (v.length > 0) return `the CLI session has ${key} enabled (${v.length})`;
	}
	const skills = init.skills;
	if (Array.isArray(skills) && skills.length > 0) return `the CLI session has skills enabled (${skills.length})`;
	return null;
}

// -- failure classification ---------------------------------------------------

interface RateLimitInfo {
	status?: string;
	resetsAt?: number;
}

/** Classify a failed run's cause (exported for the unit test's error contracts). */
export function classifyChatFailure(message: string, rateLimit: RateLimitInfo | null): ChatEngineFailure {
	const limited = (rateLimit?.status && rateLimit.status !== 'allowed') || /rate.?limit|usage limit|limit reached|out of (?:usage|credits)/i.test(message);
	if (limited) {
		const resetsAt = typeof rateLimit?.resetsAt === 'number' ? rateLimit.resetsAt : undefined;
		return { kind: 'rate_limited', message, ...(resetsAt ? { resetsAt } : {}) };
	}
	if (/not logged in|logged out|no (?:auth|credential)|invalid api key|authentication|oauth|please run \/login|please log ?in/i.test(message)) {
		return { kind: 'not_signed_in', message };
	}
	return { kind: 'api_error', message };
}

// -- the engine ---------------------------------------------------------------

export const claudeCliEngine: ChatEngine = {
	async run(args: ChatEngineRunArgs): Promise<ChatEngineResult> {
		if (!(await acquire(args.signal))) return fail({ kind: 'cancelled', message: 'interrupted' }, null);
		try {
			return await runOnce(args);
		} finally {
			release();
		}
	}
};

function runOnce({ prompt, configDir, model, webSearch, readRoot, signal, onDelta }: ChatEngineRunArgs): Promise<ChatEngineResult> {
	return new Promise((settleRun) => {
		if (signal.aborted) {
			settleRun(fail({ kind: 'cancelled', message: 'interrupted' }, null));
			return;
		}

		// ONE policy decides what the argv requests, what it grants, which frozen
		// prompt is sent, where the child runs, and what the init assertion requires
		// the CLI to have reported - derived once here, which is what makes "the
		// report must equal the request" structural rather than several rules that
		// happen to agree.
		const policy = chatToolPolicy({ webSearch, readRoot });
		const expectedTools = policy.tools;

		let child: ChildProcess;
		try {
			child = spawn(CLAUDE_BIN, chatCliArgs({ model, webSearch, readRoot }), {
				env: chatChildEnv(configDir),
				cwd: chatCliCwd(policy),
				stdio: ['pipe', 'pipe', 'pipe']
			});
		} catch (err) {
			settleRun(spawnFailure(err));
			return;
		}

		let engine: string | null = null;
		let sawInit = false;
		let unsafe: string | null = null;
		let aborted = false;
		let timedOut = false;
		let result: Record<string, unknown> | null = null;
		let rateLimit: RateLimitInfo | null = null;
		let stderrTail = '';
		let settled = false;

		const settle = (value: ChatEngineResult) => {
			if (settled) return;
			settled = true;
			cleanup();
			settleRun(value);
		};

		const kill = () => {
			try {
				child.kill('SIGTERM');
			} catch {
				// already gone
			}
			const hard = setTimeout(() => {
				try {
					child.kill('SIGKILL');
				} catch {
					// already gone
				}
			}, 3_000);
			if (typeof hard.unref === 'function') hard.unref();
			// `close` waits for every stdio pipe to drain, and a grandchild the CLI
			// left behind can hold stdout open past the kill - so a killed run also
			// FORCE-settles shortly after, with whatever state it has. Without this a
			// stop (interrupt / unsafe init / timeout) could hang on a pipe nobody
			// will close, which is strictly worse than settling early: the verdict
			// (cancelled/unsafe/timeout) is already decided by the time kill() runs.
			const force = setTimeout(() => settleAfterExit(null), 5_000);
			if (typeof force.unref === 'function') force.unref();
		};

		const onAbort = () => {
			aborted = true;
			kill();
		};
		signal.addEventListener('abort', onAbort, { once: true });

		const timer = setTimeout(() => {
			timedOut = true;
			kill();
		}, chatTimeoutMs());
		if (typeof timer.unref === 'function') timer.unref();

		const cleanup = () => {
			clearTimeout(timer);
			signal.removeEventListener('abort', onAbort);
		};

		// Feed the prompt on stdin and CLOSE it (see the module header). An EPIPE
		// from a child that died first must not crash the process.
		child.stdin?.on('error', () => {});
		child.stdin?.end(prompt);

		// NDJSON line parser (partial lines buffered across chunks).
		let buf = '';
		const onLine = (line: string) => {
			// A settled run owns no accumulator any more: `run.ts` has finished and
			// persisted it, so a delta parsed after the force-settle (a grandchild
			// holding stdout open past the kill) would publish a phantom frame for a
			// cell whose run:end already fired and diverge the in-memory doc from disk.
			if (settled) return;
			const trimmed = line.trim();
			if (!trimmed) return;
			let ev: unknown;
			try {
				ev = JSON.parse(trimmed);
			} catch {
				return; // not JSON - a stray warning line; skip
			}
			if (typeof ev !== 'object' || ev === null) return;
			const e = ev as Record<string, unknown>;
			switch (e.type) {
				case 'system': {
					if (e.subtype !== 'init') return;
					sawInit = true;
					if (typeof e.claude_code_version === 'string' && e.claude_code_version) {
						engine = `claude-cli/${e.claude_code_version}`;
					}
					const violation = initViolation(e, expectedTools);
					if (violation) {
						unsafe = violation;
						kill(); // fail closed: never render a reply from a capable session
					}
					return;
				}
				case 'stream_event': {
					// Nothing from a condemned - or an UNVERIFIED - session reaches the
					// cell. The CLI reports init before any delta, so this costs a healthy
					// run nothing; if that ever stopped being true the run fails closed
					// below rather than rendering text no assertion covered.
					if (unsafe || !sawInit) return;
					const inner = e.event as Record<string, unknown> | undefined;
					if (inner?.type !== 'content_block_delta') return;
					const delta = inner.delta as Record<string, unknown> | undefined;
					if (delta?.type === 'text_delta' && typeof delta.text === 'string') onDelta(delta.text);
					return;
				}
				case 'rate_limit_event': {
					const info = e.rate_limit_info as Record<string, unknown> | undefined;
					if (info) {
						rateLimit = {
							status: typeof info.status === 'string' ? info.status : undefined,
							resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt : undefined
						};
					}
					return;
				}
				case 'result': {
					result = e;
					return;
				}
				default:
					return; // unknown event type: skip (see header)
			}
		};
		child.stdout?.on('data', (d: Buffer) => {
			buf += d.toString();
			let nl;
			while ((nl = buf.indexOf('\n')) >= 0) {
				onLine(buf.slice(0, nl));
				buf = buf.slice(nl + 1);
			}
		});
		child.stderr?.on('data', (d: Buffer) => {
			stderrTail = (stderrTail + d.toString()).slice(-2000);
		});

		child.on('error', (err) => settle(spawnFailure(err)));
		child.on('close', (code) => settleAfterExit(code));
		const settleAfterExit = (code: number | null) => {
			if (settled) return;
			if (buf) onLine(buf); // a final line without a trailing newline
			if (unsafe) {
				settle(fail({ kind: 'unsafe_init', message: unsafe }, engine));
				return;
			}
			if (aborted) {
				settle(fail({ kind: 'cancelled', message: 'interrupted' }, engine));
				return;
			}
			if (timedOut) {
				settle(fail({ kind: 'api_error', message: `the chat run timed out after ${Math.round(chatTimeoutMs() / 1000)}s` }, engine));
				return;
			}
			const isError = result ? result.is_error === true || result.subtype !== 'success' : true;
			if (!isError && code === 0) {
				if (!sawInit) {
					// An otherwise-successful run that never reported its session: the
					// assertion could not run, so the verdict is the same as a failed one.
					const message = 'the CLI never reported its session capabilities (no system/init event) - cannot verify the session is bare';
					settle(fail({ kind: 'unsafe_init', message }, engine));
					return;
				}
				const replyText = typeof result?.result === 'string' ? result.result : null;
				settle({ ok: true, failure: null, engine, replyText });
				return;
			}
			const message =
				(typeof result?.result === 'string' && result.result.trim()) ||
				(typeof result?.subtype === 'string' && result.subtype !== 'success' && `the CLI reported ${result.subtype}`) ||
				stderrTail.trim().split('\n').slice(-3).join(' ').trim() ||
				`the claude CLI exited ${code}`;
			settle(fail(classifyChatFailure(message, rateLimit), engine));
		};
	});
}

function fail(failure: ChatEngineFailure, engine: string | null): ChatEngineResult {
	return { ok: false, failure, engine, replyText: null };
}

function spawnFailure(err: unknown): ChatEngineResult {
	const code = (err as NodeJS.ErrnoException)?.code;
	if (code === 'ENOENT') {
		return fail({ kind: 'not_installed', message: 'the `claude` CLI was not found on PATH' }, null);
	}
	return fail({ kind: 'api_error', message: String(err) }, null);
}

/** Test seam: the concurrency cap (so the semaphore test can read it). */
export const CHAT_MAX_CONCURRENT = MAX_CONCURRENT;
