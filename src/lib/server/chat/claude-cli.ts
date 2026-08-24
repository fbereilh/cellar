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
 * `--disallowedTools <rules>` on the reads shape ONLY (the current notebook,
 * Cellar's `.cellar/` state, and by default every other notebook - see the
 * denial section below),
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
 * `chatToolPolicy(caps)` the init assertion reads. That ONE policy decides the
 * request, the grant, the DENIAL, the init assertion, the frozen prompt and the
 * child's cwd, so the grant can never name a tool the run did not request and
 * then assert, nor outrun the denials taken back from inside it. An EMPTY
 * `--allowedTools` is never passed: the
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
 *     path containing `..` that resolves outside is refused, and the refusal
 *     names the RESOLVED path, which is what shows matching happens after
 *     normalization rather than lexically; and an absolute path through an
 *     in-workspace symlink whose target is outside is refused too, even though
 *     it is LEXICALLY inside the pattern (that refusal names the path as
 *     given, so the link is resolved for the decision and not for the message).
 *     Both pinned against the real binary in `chat-workspace-reads.spec.ts`.
 *   - A workspace path containing a space, a comma, and even the adversarial
 *     segment `,Read,` - which would inject a BARE unscoped `Read` grant if the
 *     flag's "comma or space-separated" parsing split the value - kept working
 *     inside and kept refusing outside. The value is not split within one argv
 *     element.
 *   - CHARACTERS MEANINGFUL TO THE RULE GRAMMAR WERE DRIVEN ONE BY ONE, and the
 *     results land in FOUR different places - so the doc names the members,
 *     never a class: `* ? [ ] { }` WIDEN the grant (`<root>/ws[ab]` yielded a
 *     rule the matcher glob-INTERPRETED, reading `<root>/wsa/secret.txt` in a
 *     SIBLING directory); `\` BREAKS child startup (with `<root>/ws\a` really
 *     on disk the CLI refused to launch, rc=1, "Can't access working
 *     directory"); `(` and `)` are SAFE in BOTH the spaced and the ADJACENT form
 *     (`<root>/ws (2)` and `<root>/report(2)` each read inside and still refused
 *     outside), so ordinary names like `~/Projects/analysis (2)` keep working;
 *     and the extglob-shaped `@(`, `+(`, `!(` were each driven against a
 *     workspace with the sibling an extglob would have covered and were INERT
 *     (sibling refused, inside read fine). `chatReadRoot` refuses the first two
 *     groups because they were measured to FAIL, and the extglob prefixes as a
 *     DURABLE PRECAUTION - extglob being off is an unstated detail of the CLI's
 *     matcher a future version could flip - never because they were measured to
 *     leak. Refused rather than escaped, escape semantics being unmeasured.
 *   - The child WRITES NOTHING into that cwd: with the shipped flags
 *     (`--no-session-persistence`, `--setting-sources ""`) a successful
 *     reads-on run left the workspace directory tree byte-identical, so moving
 *     the cwd there does not dirty the user's checkout. Pinned by the same spec,
 *     because it is a property of the CLI a future version could change.
 *
 * The root is the WORKSPACE, deliberately not a notebook's code root: a code
 * root may be an external git worktree, and Cellar's standing rule is that such
 * a root grants a kernel cwd and not one byte of file reach (every file surface
 * stays workspace-scoped, through `resolveInWorkspace`). Reads follow that rule
 * rather than inventing a second answer.
 *
 * ## The grant says WHERE; the denial says what stays unreadable there
 *
 * A grant over the workspace would otherwise hand back, through the file
 * system, exactly what the transcript deliberately withholds: the notebook file
 * carries every cell the user marked `hidden_from_agent`, and so do the copies
 * Cellar itself writes beside it (`<stem>.py`, `<stem>.html`,
 * `.ipynb_checkpoints/<stem>-checkpoint.ipynb`) and
 * `<root>/.cellar/checkpoints.json`. So a reads-on run also passes
 * `--disallowedTools`, built by the SAME `chatToolPolicy` and enumerated in
 * `denialPatterns`: the CURRENT notebook and the artifacts named after it
 * (always, whatever its extension), `<root>/.cellar/` whole, and - unless the
 * person opted other notebooks in - every `.ipynb` FILE in the workspace. Measured
 * against claude 2.1.238: a deny rule BEATS the allow rule for a path inside
 * the granted root, a sibling file in that root still reads, and the denial is
 * enforced per file by the tools themselves (a Grep over the granted directory
 * for the denied file's content found nothing, and a recursive Glob for every
 * `.ipynb` under it listed nothing), which is what makes it bound Grep and Glob
 * and not only Read.
 *
 * Denying the current notebook is an ANSWER-QUALITY decision as much as a
 * privacy one - the model already holds it as a curated, FRESH transcript, so
 * reading the file could only add a stale copy, the hidden cells, and a second
 * conflicting view of the thing it is looking at. The rationale, the by-NAME
 * (never by file type) shape of the derived-artifact rules, and the two
 * residuals this layer does NOT cover all sit in full at `denialPatterns`.
 *
 * Fail-closed all the way down: `chatToolPolicy` refuses any root it cannot
 * confine (non-string, empty, relative, non-POSIX, or carrying one of
 * `UNCONFINABLE_ROOT_CHARS`/`EXTGLOB_PREFIX`) and yields a READ-LESS policy, so
 * the failure mode of every unknown is today's tool-less session - and it
 * requires a deniable notebook path by the same rule, so there is no way to
 * reach a granted read whose notebook denial was skipped.
 * And because the frozen system prompt is chosen from that same policy, a run
 * that ends up read-less is also told it cannot read.
 *
 * The one thing reads-on adds that a policy cannot decide is a cwd that may
 * VANISH: `run-chat.ts` checks the workspace exists, but a delete landing between
 * that check and the spawn raises the SAME `ENOENT` a missing `claude` binary
 * does - and node reports the two IDENTICALLY (measured on node 22: `path` and
 * `syscall` name the COMMAND either way), so `spawnFailure` discriminates on the
 * cwd itself rather than on the error's fields.
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
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
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
	/**
	 * The ABSOLUTE path of the notebook this run is answering in - ALWAYS denied
	 * when reads are on (see `denialPatterns` rule 1), whatever its extension.
	 *
	 * Reads need BOTH this and `readRoot`: without a notebook to deny there is no
	 * way to keep the always-denied promise, so `chatToolPolicy` yields a
	 * read-less policy rather than an unbounded one. That is what makes the
	 * promise structural instead of a discipline every caller has to remember.
	 */
	notebookPath?: string | null;
	/**
	 * May OTHER notebooks in the workspace be read? Only a literal `true` opens
	 * them (the person-scoped opt-in); the CURRENT notebook stays denied either
	 * way, as does `<root>/.cellar/`.
	 */
	otherNotebooks?: boolean;
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
	/**
	 * What `--disallowedTools` takes back INSIDE that grant - the current
	 * notebook, `<root>/.cellar/`, and (unless opted out of) every other
	 * `*.ipynb`. Empty whenever reads are off, so the default argv is unchanged.
	 */
	readonly denials: readonly string[];
	/** The confinement root reads were granted under, or null when reads are off. */
	readonly readRoot: string | null;
	/** Whether web search was granted (decides the frozen prompt with `readRoot`). */
	readonly webSearch: boolean;
}

/**
 * Characters a path may not contain if it is to become a LITERAL rule - each
 * DRIVEN against claude 2.1.238, and the results land in three different places,
 * which is why this set is exactly these seven characters rather than
 * "punctuation" or "glob-ish":
 *
 *   - `* ? [ ] { }` WIDEN THE GRANT, a real confinement escape. A workspace at
 *     `<root>/ws[ab]` produced `Read(//<root>/ws[ab]/**)`, which the matcher
 *     glob-INTERPRETED: it read its own file AND read `<root>/wsa/secret.txt`
 *     in a SIBLING directory, returning the secret.
 *   - `\` BREAKS CHILD STARTUP, which is worse than it looks. With a real
 *     directory `<root>/ws\a` on disk, the CLI refused to launch at all: rc=1,
 *     stderr `Can't access working directory <root>/ws\a: Path "<root>/ws\a"
 *     does not exist`. Passed through, that surfaces to the user as an opaque
 *     `api_error` on a run they asked to read files; refused, they get a
 *     coherent read-less run whose frozen prompt truthfully says it cannot read.
 *   - `(` and `)` are SAFE and deliberately NOT refused, driven in BOTH the
 *     spaced and the ADJACENT form (a different question each, since only the
 *     adjacent one could be an extglob): `<root>/ws (2)` and `<root>/report(2)`
 *     each produced a rule that read its own file and still REFUSED a path
 *     outside it. `~/Projects/analysis (2)` and `report(2)` are entirely
 *     ordinary directory names and must keep working, so a bare `@`, `+` or `!`
 *     anywhere in a path stays allowed too (`my@notes`, `c++`, `important!`).
 *
 * `EXTGLOB_PREFIX` is the one refusal here that is NOT a measured leak, and the
 * distinction matters: `@(`, `+(` and `!(` were each driven against a real
 * workspace with a sibling the extglob would have covered (`runs@(a|b)` beside
 * `runsa`, `data!(old)` beside `dataX`, `logs+(x)` beside `logsx`) and all three
 * were INERT - the sibling was refused and the inside read still worked, i.e.
 * extglob is off in this engine. They are refused anyway as a DURABLE
 * PRECAUTION: extglob being disabled is an unstated implementation detail of the
 * CLI's matcher that a future version could flip, and this module fails closed
 * on grammar it cannot depend on. Do not restate this as a measured leak - it
 * was measured NOT to leak.
 *
 * The refused characters are refused rather than escaped, on this module's
 * standing fail-closed doctrine: the matcher's escape semantics are UNMEASURED,
 * and a wrong escape reopens the hole while looking fixed. Such directory names
 * are rare, and the degradation stays coherent - a read-less run is also TOLD it
 * cannot read. Do not widen this set by analogy: every member is here because it
 * was driven, and every non-member because it was driven too.
 */
const UNCONFINABLE_ROOT_CHARS = /[*?[\]{}\\]/;

/** The extglob-shaped two-character prefix - see `UNCONFINABLE_ROOT_CHARS`. */
const EXTGLOB_PREFIX = /[@+!]\(/;

/**
 * An absolute path this module can express as a LITERAL permission rule,
 * normalized - or null when it cannot.
 *
 * ONE rule for both sides of the policy: the confinement ROOT a grant is scoped
 * to, and the paths a DENIAL names. They ask the same question (can this path be
 * spelled so the matcher treats every character of it literally) and answering it
 * twice is how the two would drift into disagreeing about which paths are safe.
 *
 * Fails CLOSED on everything it is not sure of, because the alternative to a
 * confined read is an unconfined one, and the alternative to a literal denial is
 * a denial that silently misses its target: a non-string, an empty string, a
 * relative path, anything that does not normalize to a POSIX-absolute path, and
 * anything carrying one of `UNCONFINABLE_ROOT_CHARS` or an `EXTGLOB_PREFIX` all
 * yield null (= reads off). The POSIX check is not incidental - the `//` rule
 * prefix below is the CLI's absolute-path spelling and was measured on POSIX
 * only, so a Windows-style path is refused rather than turned into a rule whose
 * matching behaviour nobody here has established.
 */
export function literalRulePath(value: unknown): string | null {
	if (typeof value !== 'string' || !value.startsWith('/')) return null;
	const abs = resolve(value);
	if (!abs.startsWith('/')) return null;
	if (UNCONFINABLE_ROOT_CHARS.test(abs) || EXTGLOB_PREFIX.test(abs)) return null;
	return abs;
}

/**
 * The confinement root, normalized, or null when this value cannot be confined.
 * The root half of `literalRulePath` - see there for what is refused and why.
 */
export function chatReadRoot(value: unknown): string | null {
	return literalRulePath(value);
}

/**
 * `//<path-without-leading-slash>` - the CLI's own spelling of an absolute path
 * inside a permission rule. Every path reaching here passed `literalRulePath`,
 * so every character of it is matched literally.
 */
function rulePath(abs: string): string {
	return `//${abs.replace(/^\/+/, '')}`;
}

/**
 * The `--allowedTools` path pattern confining a read tool to `root`.
 *
 * Measured against claude 2.1.238 (see the module header's confinement section):
 * the `/**` suffix admits the root itself, every nested file and dotfiles, and
 * refuses everything outside it.
 */
function readGrantPattern(root: string): string {
	return `${rulePath(root)}/**`;
}

/** Cellar's own per-project state directory, denied whole (see `denialPatterns`). */
const CELLAR_STATE_DIR = '.cellar';

/** Jupyter's own autosave copy directory, beside the notebook it copies. */
const JUPYTER_CHECKPOINT_DIR = '.ipynb_checkpoints';

/**
 * The current notebook's own path plus every artifact DERIVED FROM ITS NAME that
 * carries the same cells - or null when any of them cannot be expressed as a
 * literal rule.
 *
 * Denying the notebook file alone is not enough, because Cellar itself writes
 * copies of those cells beside it and NONE of those writers filters
 * `hidden_from_agent`: `jupytext-actions.ts`'s "Save as .py" renders every cell
 * into `<stem>.py`, `export-html.ts` renders every cell AND its outputs into
 * `<stem>.html` (that filter is deliberately MCP-only), `convertPyToIpynb`
 * writes `<stem>.ipynb`, and Jupyter's own autosave copies the whole document
 * into `.ipynb_checkpoints/<stem>-checkpoint.ipynb`. Each is the denied content
 * reachable through a back door.
 *
 * BY NAME, never by file TYPE, and that is the whole shape of this rule: `.py`
 * is exactly what a chat cell exists to read and what the Settings copy promises
 * stays readable, so denying those extensions wholesale would gut the feature to
 * close a leak that only ever involves the notebook's OWN name. Driven end to
 * end against claude 2.1.238: with these rules and no blanket notebook block,
 * the four named artifacts came back unreadable while a sibling `helper.py`, a
 * sibling `report.html` and another notebook all still read.
 *
 * The checkpoint copy is denied UNCONDITIONALLY rather than riding the
 * by-default notebook block - it IS the current notebook, so the
 * other-notebooks opt-in must not open it.
 *
 * Returns NULL rather than a partial list when any target is un-patternable, and
 * the caller turns that into a READ-LESS run: a deny pattern the matcher would
 * glob-interpret does not merely miss, it matches the WRONG file. Measured
 * against claude 2.1.238 with the notebook at `<ws>/data[1].ipynb` beside a decoy
 * `<ws>/data1.ipynb`: the rule denied the DECOY and left the real notebook
 * READABLE - "the current notebook is always denied" silently false. So reads
 * are granted only where the notebook can PROVABLY be denied; an un-patternable
 * name costs the reads, never the guarantee. (`literalRulePath` already refuses
 * such a notebook path outright, so this is the same rule applied to the derived
 * names as well, keeping the invariant structural if the derivation ever grows.)
 */
function deniableNotebookPaths(notebookPath: string): string[] | null {
	const dir = dirname(notebookPath);
	const stem = basename(notebookPath).replace(/\.(ipynb|py)$/i, '');
	const targets = [
		notebookPath,
		join(dir, `${stem}.py`),
		join(dir, `${stem}.ipynb`),
		join(dir, `${stem}.html`),
		join(dir, JUPYTER_CHECKPOINT_DIR, `${stem}-checkpoint.ipynb`)
	];
	const safe: string[] = [];
	for (const target of targets) {
		const literal = literalRulePath(target);
		if (literal === null) return null;
		if (!safe.includes(literal)) safe.push(literal);
	}
	return safe;
}

/** Which half of the reads precondition a workspace/notebook pair fails. */
export type ChatReadsBlockedCause = 'workspace' | 'notebook';

/**
 * Why a reads-on run would silently come back READ-LESS, or null when reads can
 * really be granted - the DETECT half of the Settings pane's report.
 *
 * The fail-closed fallbacks above are deliberate, but on their own they are
 * SILENT: the toggle still renders on and the copy still promises the reply may
 * browse the workspace, while the only report goes to the MODEL through the
 * frozen prompt, so the person meets a reply that merely seems broken. This is
 * the same DETECT + REPORT shape the Databricks card already applies to a
 * silently-inert capability (`sdkDbutils`).
 *
 * The two causes are reported SEPARATELY because they differ in scope and in
 * remedy: a `workspace` verdict means no notebook in this workspace can have
 * reads, while a `notebook` verdict is about THAT notebook's own name and its
 * derived artifacts - reads keep working in the notebook beside it, so a report
 * that did not say which is at fault would be wrong about the workspace as a
 * whole. Order matters: the workspace is checked first, since an unusable root
 * makes the notebook question moot.
 *
 * It answers from the SAME `chatReadRoot`/`literalRulePath`/`deniableNotebookPaths`
 * the policy uses - never a second copy of the character rule, so the pane can
 * never promise (or deny) something the engine would decide differently.
 */
export function chatReadsBlockedCause(readRoot: unknown, notebookPath: unknown): ChatReadsBlockedCause | null {
	if (chatReadRoot(readRoot) === null) return 'workspace';
	const literal = literalRulePath(notebookPath);
	if (literal === null || deniableNotebookPaths(literal) === null) return 'notebook';
	return null;
}

/**
 * The paths a reads-on run DENIES inside its own confinement root.
 *
 * The grant says where a reply may read; this says what stays unreadable there,
 * and both come out of the one policy below so a widened grant cannot quietly
 * outrun its denials. Measured against claude 2.1.238: a `--disallowedTools`
 * rule BEATS the allow rule for a path inside the granted root (the CLI answers
 * `is_error: true` with "File is in a directory that is denied by your
 * permission settings"), a sibling file in the same root still reads fine, and
 * the denial is enforced PER FILE by the tools themselves rather than only on
 * the tool's path argument - a Grep over the granted directory for the denied
 * file's content returned "No matches found" and a recursive Glob for every
 * `.ipynb` under it returned "No files found". That last is what makes denying a
 * file actually bound Grep and Glob and not just Read, which is why every rule
 * below is emitted for EACH read tool: each can surface content independently.
 *
 * Three rules, in order:
 *
 *   1. **The CURRENT notebook and the artifacts named after it**, always - never
 *      optional, never behind a setting, and never an `.ipynb` PATTERN, because a
 *      jupytext `.py` notebook is the current notebook too. The set is built by
 *      `deniableNotebookPaths`; see there for why the derived copies are in it
 *      and why the list is by NAME rather than by file type. This is an
 *      ANSWER-QUALITY rule as much as a privacy one: the model is already handed
 *      this notebook as a curated, FRESH transcript, so a file read of it can
 *      only add (a) a STALE copy, the editor's autosave being debounced, (b) the
 *      cells the user deliberately marked `hidden_from_agent`, and (c) a second,
 *      conflicting view of the very thing it is looking at. There is no case
 *      where reading it beats the transcript it already holds.
 *   2. **`<root>/.cellar/` whole**, Cellar's own per-project state. The artifact
 *      that matters there is `checkpoints.json`, which stores full cell
 *      snapshots INCLUDING outputs and hidden cells - the same content rule 1
 *      denies, reachable through a back door. It is denied as a DIRECTORY rather
 *      than as that one file: everything under it is Cellar runtime state the
 *      model needs none of, and a directory rule covers whatever is added there
 *      later instead of silently going stale.
 *   3. **Every `.ipynb` FILE in the workspace**, unless the person opted OTHER
 *      notebooks in. Off (the default) the reply still reads `.py`, `.md` and
 *      data files; on, other notebooks open up while rules 1 and 2 stand either
 *      way. This is an `.ipynb` rule and nothing wider - see residual (c): it is
 *      deliberately NOT extended to `.py`/`.html` by type, which would deny
 *      exactly what this feature exists to read, and the by-NAME derivation of
 *      rule 1 is built from the CURRENT notebook's stem alone. Both a top-level
 *      and a nested form
 *      are emitted rather than relying on a leading globstar matching zero
 *      directories, which is engine-dependent and would silently leave the
 *      workspace's top-level notebooks readable.
 *
 * WHAT THIS DOES NOT COVER, stated rather than glossed, because the layer's
 * whole justification is that a hidden cell stays out of reach. Two residuals:
 *
 *   (a) A hidden cell in a DIFFERENT notebook, once the other-notebooks option
 *       is ON. That is exactly what the option decides, and it defaults OFF.
 *   (b) A derived artifact written to a NON-DEFAULT path, which a by-name rule
 *       cannot see: MCP `export_html` called with an explicit `path`, and an
 *       nbdev export module at a configured `metadata.cellar.export_target`.
 *       Neither is derivable from the notebook's name, so neither is denied.
 *   (c) ANOTHER notebook's DEFAULT-PATH exports, and any jupytext `.py`
 *       notebook - readable whether the other-notebooks option is on or OFF.
 *       Rule 3 blocks `.ipynb` files; rule 1's by-name derivation covers only
 *       the CURRENT notebook's stem. So `<other>.py` (its "Save as .py") and
 *       `<other>.html` (its `export_html`) stay readable, and since neither
 *       `export-html.ts` nor `jupytext-actions.ts` filters hidden cells, such a
 *       file carries every cell of that notebook including the hidden ones,
 *       plus outputs. A jupytext `.py` notebook is the same case with no
 *       `.ipynb` to block at all. Widening rule 3 to those file TYPES is
 *       deliberately rejected: it would deny exactly what a reads-on reply
 *       exists to read, and `.py` is what the Settings copy promises stays
 *       readable.
 *
 * So the claim this layer supports is the narrow one, and it is about THIS
 * notebook: a hidden cell in the CURRENT notebook is unreachable through the
 * notebook file, the copies Cellar names after it, and the checkpoint store.
 * That guarantee is by-name and complete. The other-notebooks block is the
 * WEAKER, separate statement in rule 3 - `.ipynb` files only - and the two must
 * not be restated as one, nor either of them more widely.
 */
function denialPatterns(root: string, notebookTargets: readonly string[], otherNotebooks: boolean): string[] {
	const patterns = [...notebookTargets.map(rulePath), `${rulePath(root)}/${CELLAR_STATE_DIR}/**`];
	if (!otherNotebooks) patterns.push(`${rulePath(root)}/*.ipynb`, `${rulePath(root)}/**/*.ipynb`);
	return patterns;
}

/**
 * The tool policy for one run - the ONE source feeding `--tools`,
 * `--allowedTools`, `--disallowedTools`, the `system/init` assertion, the frozen
 * system prompt and the child's cwd. `{}` is the default bare session: no tools,
 * no grants, no denials.
 *
 * Reads require a confinable ROOT and a deniable NOTEBOOK PATH together - and
 * "deniable" means the notebook AND every artifact named after it can each be
 * spelled as a literal rule. Either half missing or unexpressible yields a
 * read-less policy, which is what makes "the current notebook is always denied"
 * true by construction rather than by every caller remembering to pass it: there
 * is no way to reach a granted read whose notebook denial was skipped, and none
 * whose denial pattern the matcher would glob-interpret onto some other file.
 */
export function chatToolPolicy(caps: ChatCapabilities = {}): ChatToolPolicy {
	const webSearch = caps.webSearch === true;
	const root = chatReadRoot(caps.readRoot);
	const notebookPath = literalRulePath(caps.notebookPath);
	// Every path the run must be able to DENY, resolved before any grant is
	// built: null here (an un-patternable notebook name) costs the reads, so a
	// granted read whose notebook denial silently missed is unreachable.
	const notebookTargets = notebookPath === null ? null : deniableNotebookPaths(notebookPath);
	const readRoot = root !== null && notebookTargets !== null ? root : null;
	const tools: string[] = [];
	const grants: string[] = [];
	const denials: string[] = [];
	if (webSearch) {
		tools.push(WEB_SEARCH_TOOL);
		// Search takes no path scope: it has no path to scope.
		grants.push(WEB_SEARCH_TOOL);
	}
	if (readRoot && notebookTargets) {
		const pattern = readGrantPattern(readRoot);
		const denied = denialPatterns(readRoot, notebookTargets, caps.otherNotebooks === true);
		for (const tool of READ_TOOLS) {
			tools.push(tool);
			grants.push(`${tool}(${pattern})`);
			// Every denial is emitted for EVERY read tool: each can surface a file's
			// content independently, so a rule missing from one of them is that file
			// readable through the other two.
			for (const path of denied) denials.push(`${tool}(${path})`);
		}
	}
	return { tools, grants, denials, readRoot, webSearch };
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
	'The notebook you are answering in is not readable as a file: you already have',
	'it above, fresher than any copy on disk, so do not go looking for it.',
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
		// The DENIAL (see `denialPatterns`): what the grant above may NOT reach
		// inside its own root. Measured to BEAT the allow rule for a path inside
		// it, and enforced per file by the tools rather than only on their path
		// argument. Same shape rules as the grant - one comma-joined argv element,
		// derived from the SAME policy, and omitted entirely rather than passed
		// empty, which is what keeps the read-less argv byte-for-byte unchanged.
		...(policy.denials.length > 0 ? ['--disallowedTools', policy.denials.join(',')] : []),
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

function runOnce({ prompt, configDir, model, webSearch, readRoot, notebookPath, otherNotebooks, signal, onDelta }: ChatEngineRunArgs): Promise<ChatEngineResult> {
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
		const policy = chatToolPolicy({ webSearch, readRoot, notebookPath, otherNotebooks });
		const expectedTools = policy.tools;

		// Hoisted so BOTH spawn-failure paths can ask whether the cwd is still
		// there: reads-on points it at a directory of the user's, which can vanish
		// between `chatReadableWorkspace()`'s check and this spawn.
		const cwd = chatCliCwd(policy);

		let child: ChildProcess;
		try {
			child = spawn(CLAUDE_BIN, chatCliArgs({ model, webSearch, readRoot, notebookPath, otherNotebooks }), {
				env: chatChildEnv(configDir),
				cwd,
				stdio: ['pipe', 'pipe', 'pipe']
			});
		} catch (err) {
			settleRun(spawnFailure(err, cwd));
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

		child.on('error', (err) => settle(spawnFailure(err, cwd)));
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

function spawnFailure(err: unknown, cwd: string): ChatEngineResult {
	const code = (err as NodeJS.ErrnoException)?.code;
	if (code === 'ENOENT') {
		// A missing cwd and a missing BINARY are both ENOENT, and node reports them
		// IDENTICALLY - measured on node 22: spawning a real binary into a missing
		// cwd still yields `path: '<command>'` and `syscall: 'spawn <command>'`,
		// byte for byte what a missing binary yields. So `err.path`/`err.syscall`
		// cannot tell them apart and the only discriminator is the cwd itself,
		// asked HERE rather than before the spawn - the point is precisely that it
		// went away in between (reads-on runs the child in a directory of the
		// user's, which a delete or an unmount can take out from under us). Telling
		// someone to install a CLI they already have is a dead end, the same class
		// of defect as a remedy naming a setting that is already off.
		if (!existsSync(cwd)) {
			return fail({ kind: 'api_error', message: `the workspace directory is no longer available (${cwd})` }, null);
		}
		return fail({ kind: 'not_installed', message: 'the `claude` CLI was not found on PATH' }, null);
	}
	return fail({ kind: 'api_error', message: String(err) }, null);
}

/** Test seam: the concurrency cap (so the semaphore test can read it). */
export const CHAT_MAX_CONCURRENT = MAX_CONCURRENT;
