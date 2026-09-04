/**
 * The chat engine's SAFETY boundary, exercised against real spawns of a stub
 * `claude` script on PATH (the shipped code path end to end: argv, env, stdin,
 * the NDJSON parser, the init assertion, the kill):
 *
 * - The frozen flag array is pinned EXACTLY, and what the child actually
 *   RECEIVES equals it (an arg mangled in transit is the same failure as one
 *   never passed). `--dangerously-skip-permissions` appearing anywhere in the
 *   module is a test failure.
 * - The child env carries NO `ANTHROPIC*`/`CLAUDE*` key beyond the one
 *   `CLAUDE_CONFIG_DIR` Cellar means - the html-preview sandbox doctrine: the
 *   isolation is one word wide, so it is asserted from inside the child.
 * - The prompt arrives on STDIN (the argv positional stalls and corrupts the
 *   stream - the design report's measured failure).
 * - Workspace READS are confined by the GRANT, not by the cwd: every read tool
 *   is granted with its path pattern and never bare, a root that cannot be
 *   confined yields a read-less run, and each of the four capability shapes gets
 *   the frozen prompt that is TRUE for it (no per-run value, the confinement
 *   root included, ever enters one). The CLI's own half of that - that a scoped
 *   grant really refuses outside paths while a bare one does not - is measured
 *   against the real binary in `tests/e2e/chat-workspace-reads.spec.ts`.
 * - An init report with capabilities KILLS the run and fails closed
 *   (`unsafe_init`), delivering not one delta; a missing field fails closed
 *   too, and so does a MISSING EVENT ("cannot verify" is not "safe" - an
 *   assertion that only runs when the report arrives is no assertion at all).
 * - A delta parsed AFTER the run settled (a grandchild holding stdout open past
 *   the kill) reaches nobody: the accumulator it would push into is finished
 *   and persisted.
 * - Each failure shape classifies to its own actionable kind: not_installed /
 *   not_signed_in / rate_limited (with resetsAt) / api_error / cancelled.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	chatCliArgs,
	chatCliCwd,
	chatReadRoot,
	literalRulePath,
	chatSystemPrompt,
	chatToolPolicy,
	classifyChatFailure,
	claudeCliEngine,
	initViolation,
	CHAT_LEARNING_MODE_BLOCK,
	CHAT_MAX_CONCURRENT,
	CHAT_SYSTEM_PROMPT,
	CHAT_SYSTEM_PROMPT_READS,
	CHAT_SYSTEM_PROMPT_READS_WEB_SEARCH,
	CHAT_SYSTEM_PROMPT_WEB_SEARCH,
	READ_TOOLS,
	WEB_SEARCH_TOOL
} from '../../src/lib/server/chat/claude-cli';
import { CHAT_MODEL_DEFAULT, normalizeChatModel } from '../../src/lib/chatCell';
import { chatFailureMarkdown } from '../../src/lib/server/chat/failure';
import { chatChildEnv, isChatSensitiveEnv } from '../../src/lib/server/chat/env';
import type { ChatEngineFailure, ChatEngineResult } from '../../src/lib/server/chat/engine';

let BIN: string; // temp dir holding the stub `claude`, prepended to PATH
let OUT: string; // scratch the stubs dump argv/env/stdin into
const savedPath = process.env.PATH;
const savedEnv: Record<string, string | undefined> = {};

const SAFE_INIT = JSON.stringify({
	type: 'system',
	subtype: 'init',
	tools: [],
	mcp_servers: [],
	slash_commands: [],
	skills: [],
	claude_code_version: '9.9.9-stub',
	model: 'claude-sonnet-stub'
});

// The search-on init shape as the REAL CLI reports it - probed against claude
// 2.1.237 (2026-08-20): `--tools WebSearch` reports tools:["WebSearch"], exactly
// the requested tool, with mcp_servers/slash_commands/skills still empty.
// Committed the way SAFE_INIT commits the bare shape, so the assertion is pinned
// against what the CLI actually says rather than an assumed name.
const SEARCH_INIT = JSON.stringify({
	type: 'system',
	subtype: 'init',
	tools: ['WebSearch'],
	mcp_servers: [],
	slash_commands: [],
	skills: [],
	claude_code_version: '9.9.9-stub',
	model: 'claude-sonnet-stub'
});

// The reads-on init shape as the REAL CLI reports it - probed against claude
// 2.1.238 (2026-08-21): `--tools Read,Glob,Grep` reports the same SET back in
// the CLI's OWN order, which is why the assertion compares sets and never array
// order. Note what is NOT here: the path scope. `system/init` reports bare tool
// NAMES, so the confinement lives entirely in the `--allowedTools` rules - which
// is exactly why request and grant are derived from one policy.
const READS_INIT = JSON.stringify({
	type: 'system',
	subtype: 'init',
	tools: ['Glob', 'Grep', 'Read'],
	mcp_servers: [],
	slash_commands: [],
	skills: [],
	claude_code_version: '9.9.9-stub',
	model: 'claude-sonnet-stub'
});

/** The `--system-prompt` value of a given argv - read off the SAME array, since
 *  the optional `--allowedTools` pair shifts every index after it. */
function promptOf(args: string[]): string {
	return args[args.indexOf('--system-prompt') + 1];
}

/** A representative absolute workspace root for the argv-shape assertions. */
const WS = '/tmp/cellar-ws';
/** The grant pattern the module builds for `WS` - spelled out, not derived. */
const WS_RULE = '//tmp/cellar-ws/**';
/**
 * The notebook a run is answering in. Reads need BOTH a root and this, so every
 * reads-on shape below passes it; it is also what the run DENIES (rule 1 of
 * `denialPatterns`), which is why the deny rules are spelled out here too rather
 * than derived from the module under test.
 */
const NB = '/tmp/cellar-ws/analysis.ipynb';
/**
 * The deny patterns a reads-on run over `WS`/`NB` builds, in order. The notebook
 * group is the file itself PLUS the artifacts Cellar names after it - each of
 * those writers renders every cell, hidden ones included - deduped, so the
 * `.ipynb` derivation of an `.ipynb` notebook collapses into its own path.
 */
const NB_DENY = [
	'//tmp/cellar-ws/analysis.ipynb',
	'//tmp/cellar-ws/analysis.py',
	'//tmp/cellar-ws/analysis.html',
	'//tmp/cellar-ws/.ipynb_checkpoints/analysis-checkpoint.ipynb'
];
const CELLAR_DENY = '//tmp/cellar-ws/.cellar/**';
const IPYNB_DENY = ['//tmp/cellar-ws/*.ipynb', '//tmp/cellar-ws/**/*.ipynb'];
/** Every deny rule one shape emits, in the order the policy builds them. */
function denyRules(notebooks: readonly string[], blanket: boolean): string[] {
	return READ_TOOLS.flatMap((t) => [
		...notebooks.map((d) => `${t}(${d})`),
		`${t}(${CELLAR_DENY})`,
		...(blanket ? IPYNB_DENY.map((d) => `${t}(${d})`) : [])
	]);
}

/** Install a stub `claude` whose body is `script` (sh). */
function stubClaude(script: string) {
	writeFileSync(join(BIN, 'claude'), `#!/bin/sh\n${script}\n`);
	chmodSync(join(BIN, 'claude'), 0o755);
}

function run(
	overrides: {
		configDir?: string | null;
		signal?: AbortSignal;
		model?: string;
		webSearch?: boolean;
		readRoot?: string | null;
		notebookPath?: string | null;
		otherNotebooks?: boolean;
	} = {}
): Promise<ChatEngineResult> & { deltas: string[] } {
	const deltas: string[] = [];
	const p = claudeCliEngine.run({
		prompt: 'hello transcript\n',
		configDir: overrides.configDir ?? null,
		model: overrides.model,
		webSearch: overrides.webSearch,
		readRoot: overrides.readRoot,
		// Defaulted, not omitted: reads need a notebook to deny, so a `readRoot`
		// override with no notebook would silently produce a READ-LESS run and every
		// reads assertion below would pass for the wrong reason.
		notebookPath: overrides.notebookPath === undefined ? NB : overrides.notebookPath,
		otherNotebooks: overrides.otherNotebooks,
		signal: overrides.signal ?? new AbortController().signal,
		onDelta: (t) => deltas.push(t)
	}) as Promise<ChatEngineResult> & { deltas: string[] };
	p.deltas = deltas;
	return p;
}

/**
 * Wait until the run has actually DELIVERED `n` deltas, bounded and loud.
 *
 * A fixed sleep here is a race: the wait has to cover spawning the shell stub,
 * its echoes, and the engine parsing and forwarding the delta, which under this
 * suite's parallel forks (and, measured, even in isolation) can exceed any
 * constant worth hardcoding - and losing that race silently turns "what
 * streamed before the stop is kept" into an empty array. Gating on the
 * condition itself is deterministic, and mirrors how the settle test below
 * establishes "after the settle" with a flag file rather than out-racing a
 * timer.
 */
async function waitForDeltas(
	p: { deltas: string[] },
	n = 1,
	timeoutMs = 10_000
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (p.deltas.length < n) {
		if (Date.now() > deadline) {
			throw new Error(`the run delivered ${p.deltas.length} delta(s), expected ${n}, in ${timeoutMs}ms`);
		}
		await new Promise((r) => setTimeout(r, 10));
	}
}

beforeAll(() => {
	BIN = mkdtempSync(join(tmpdir(), 'cellar-chat-stub-'));
	OUT = mkdtempSync(join(tmpdir(), 'cellar-chat-out-'));
	process.env.PATH = `${BIN}:${savedPath}`;
	// Plant sensitive vars the scrub must remove - asserted from INSIDE the child.
	for (const [k, v] of Object.entries({
		ANTHROPIC_API_KEY: 'sk-leak',
		ANTHROPIC_BASE_URL: 'https://evil.example',
		CLAUDECODE: '1',
		CLAUDE_CODE_ENTRYPOINT: 'cli',
		CLAUDE_CONFIG_DIR: '/tmp/parent-session-config'
	})) {
		savedEnv[k] = process.env[k];
		process.env[k] = v;
	}
});

afterAll(() => {
	process.env.PATH = savedPath;
	for (const [k, v] of Object.entries(savedEnv)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmSync(BIN, { recursive: true, force: true });
	rmSync(OUT, { recursive: true, force: true });
});

describe('the frozen flag set', () => {
	it('the DEFAULT argv is byte-for-byte the pre-settings chat-only argv, and the module never names the permissions bypass', async () => {
		// Pinned against LITERALS ('' for tools, 'sonnet' for the model), not the
		// constants that produce them: the whole claim is that an install that never
		// touched the new settings runs exactly what it ran before they existed.
		expect(chatCliArgs()).toEqual([
			'-p',
			'--tools',
			'',
			'--disable-slash-commands',
			'--setting-sources',
			'',
			'--strict-mcp-config',
			'--no-session-persistence',
			'--model',
			'sonnet',
			'--include-partial-messages',
			'--output-format',
			'stream-json',
			'--verbose',
			'--system-prompt',
			CHAT_SYSTEM_PROMPT
		]);
		// The GRANT flag belongs to the search shape ONLY: a default run has no tool
		// to grant, so it must not carry the flag at all (nor an empty value).
		expect(chatCliArgs()).not.toContain('--allowedTools');
		expect(CHAT_MODEL_DEFAULT).toBe('sonnet');
		const src = readFileSync(new URL('../../src/lib/server/chat/claude-cli.ts', import.meta.url), 'utf8');
		expect(src).not.toContain('dangerously-skip-permissions');
	});

	it('the search-on argv widens EXACTLY the tools value, the GRANT and the system prompt, nothing else', () => {
		const base = chatCliArgs();
		const search = chatCliArgs({ webSearch: true, model: 'opus' });
		// Pinned whole, against literals like the default shape: `--tools` REQUESTS
		// the tool and `--allowedTools` GRANTS the call (without it claude 2.1.237
		// answers the model's WebSearch call "you haven't granted it yet" in `-p`
		// mode, i.e. the opt-in is inert), and the grant names exactly the requested
		// tool - never a wider set.
		expect(search).toEqual([
			'-p',
			'--tools',
			'WebSearch',
			'--allowedTools',
			'WebSearch',
			'--disable-slash-commands',
			'--setting-sources',
			'',
			'--strict-mcp-config',
			'--no-session-persistence',
			'--model',
			'opus',
			'--include-partial-messages',
			'--output-format',
			'stream-json',
			'--verbose',
			'--system-prompt',
			CHAT_SYSTEM_PROMPT_WEB_SEARCH
		]);
		expect(search[search.indexOf('--tools') + 1]).toBe(WEB_SEARCH_TOOL);
		expect(search[search.indexOf('--allowedTools') + 1]).toBe(WEB_SEARCH_TOOL);
		// Every OTHER position is identical to the default argv - the safety flags
		// (--disable-slash-commands, --setting-sources '', --strict-mcp-config,
		// --no-session-persistence) never move with the capability shape.
		const withoutGrant = (args: string[]) => {
			const at = args.indexOf('--allowedTools');
			return at < 0 ? args : [...args.slice(0, at), ...args.slice(at + 2)];
		};
		const scrub = (args: string[]) =>
			args.map((a, i) => (['--tools', '--model', '--system-prompt'].includes(args[i - 1] ?? '') ? '<varies>' : a));
		expect(scrub(withoutGrant(search))).toEqual(scrub(base));
		// The prompt sent must be TRUE for the capability: only the bare prompt may
		// claim the session cannot browse.
		expect(CHAT_SYSTEM_PROMPT).toContain('no tools');
		expect(CHAT_SYSTEM_PROMPT_WEB_SEARCH).not.toContain('cannot run code, read files, or browse');
		expect(CHAT_SYSTEM_PROMPT_WEB_SEARCH).toContain('web search');
		// EVERY shape requires a language-TAGGED fence. It rides the SHARED framing
		// because it is capability-INDEPENDENT - a fact about the reply's FORMAT, and
		// every shape's reply is read by the same notebook - so it is asserted over
		// all four rather than over the two that happen to be in view here. It is a
		// product contract, not style advice: a rendered code block is lifted straight
		// into a cell (`$lib/codeBlockExtract`) and the fence tag picks that cell's
		// TYPE, so an untagged block silently becomes a Python cell and an unfenced
		// one gets no control at all.
		for (const prompt of [CHAT_SYSTEM_PROMPT, CHAT_SYSTEM_PROMPT_WEB_SEARCH, CHAT_SYSTEM_PROMPT_READS, CHAT_SYSTEM_PROMPT_READS_WEB_SEARCH]) {
			expect(prompt).toContain('ALWAYS put code in a fenced block tagged with its language');
			expect(prompt).toContain('```python');
			expect(prompt).toContain('```sql');
			expect(prompt).toContain('```markdown');
		}
		expect(chatSystemPrompt(chatToolPolicy())).toBe(CHAT_SYSTEM_PROMPT);
		expect(chatSystemPrompt(chatToolPolicy({ webSearch: true }))).toBe(CHAT_SYSTEM_PROMPT_WEB_SEARCH);
		// One rule for request, grant and assertion: the argv's values ARE the policy.
		expect(chatToolPolicy().tools).toEqual([]);
		expect(chatToolPolicy().grants).toEqual([]);
		expect(chatToolPolicy({ webSearch: true }).tools).toEqual([WEB_SEARCH_TOOL]);
		expect(chatToolPolicy({ webSearch: true }).grants).toEqual([WEB_SEARCH_TOOL]);
	});

	it('an unknown or non-string model can never reach argv: it falls back to the default', () => {
		for (const bad of [
			'--dangerously-skip-nothing', // flag-shaped text a hand-edited store could hold
			'sonnet; rm -rf /',
			'claude-fable-5', // full names are not on the closed list - aliases only
			'SONNET', // the list is exact, not case-folded
			'',
			42,
			{ id: 'opus' },
			null,
			undefined
		]) {
			expect(normalizeChatModel(bad)).toBe(CHAT_MODEL_DEFAULT);
			expect(chatCliArgs({ model: bad })[chatCliArgs().indexOf('--model') + 1]).toBe(CHAT_MODEL_DEFAULT);
		}
		for (const good of ['haiku', 'sonnet', 'opus', 'fable']) {
			expect(normalizeChatModel(good)).toBe(good);
		}
	});

	it('the child RECEIVES that argv, the prompt on STDIN, and a scrubbed env', async () => {
		const argvFile = join(OUT, 'argv.txt');
		const envFile = join(OUT, 'env.txt');
		const stdinFile = join(OUT, 'stdin.txt');
		stubClaude(
			[
				`for a in "$@"; do printf '%s\\n' "$a"; done > "${argvFile}"`,
				`env | grep -E '^(ANTHROPIC|CLAUDE)' > "${envFile}"; true`,
				`cat > "${stdinFile}"`,
				`echo '${SAFE_INIT}'`,
				`echo '{"type":"result","subtype":"success","is_error":false,"result":"ok"}'`
			].join('\n')
		);
		const res = await run({ configDir: '/tmp/cellar-slot-x' });
		expect(res.ok).toBe(true);
		// argv byte-for-byte (the system prompt has no newlines, so line-split is exact)
		expect(readFileSync(argvFile, 'utf8')).toBe(chatCliArgs().join('\n') + '\n');
		// stdin carried the prompt, whole and closed (cat returned)
		expect(readFileSync(stdinFile, 'utf8')).toBe('hello transcript\n');
		// the one-word-wide isolation: only OUR config dir survives the scrub
		expect(readFileSync(envFile, 'utf8').trim()).toBe('CLAUDE_CONFIG_DIR=/tmp/cellar-slot-x');
	});

	it('with no slot, the child sees NO ANTHROPIC/CLAUDE var at all (ambient = env unset)', async () => {
		const envFile = join(OUT, 'env-ambient.txt');
		stubClaude(
			[
				`env | grep -E '^(ANTHROPIC|CLAUDE)' > "${envFile}"; true`,
				`cat > /dev/null`,
				`echo '${SAFE_INIT}'`,
				`echo '{"type":"result","subtype":"success","is_error":false,"result":"ok"}'`
			].join('\n')
		);
		const res = await run({ configDir: null });
		expect(res.ok).toBe(true);
		expect(readFileSync(envFile, 'utf8').trim()).toBe('');
	});

	it('the scrub predicate is the bare prefixes (CLAUDECODE included)', () => {
		expect(isChatSensitiveEnv('ANTHROPIC_API_KEY')).toBe(true);
		expect(isChatSensitiveEnv('ANTHROPIC_BASE_URL')).toBe(true);
		expect(isChatSensitiveEnv('CLAUDECODE')).toBe(true);
		expect(isChatSensitiveEnv('CLAUDE_CODE_ENTRYPOINT')).toBe(true);
		expect(isChatSensitiveEnv('CLAUDE_CONFIG_DIR')).toBe(true);
		expect(isChatSensitiveEnv('PATH')).toBe(false);
		expect(isChatSensitiveEnv('HOME')).toBe(false);
		const env = chatChildEnv(null);
		expect(Object.keys(env).filter(isChatSensitiveEnv)).toEqual([]);
		expect(Object.keys(chatChildEnv('/x')).filter(isChatSensitiveEnv)).toEqual(['CLAUDE_CONFIG_DIR']);
	});
});

describe('workspace reads are CONFINED, and confinement is the grant', () => {
	it('the reads-on argv requests bare NAMES and grants PATH-SCOPED rules - never a bare read grant', () => {
		const args = chatCliArgs({ readRoot: WS, notebookPath: NB });
		expect(args).toEqual([
			'-p',
			'--tools',
			'Read,Glob,Grep',
			'--allowedTools',
			`Read(${WS_RULE}),Glob(${WS_RULE}),Grep(${WS_RULE})`,
			'--disallowedTools',
			denyRules(NB_DENY, true).join(','),
			'--disable-slash-commands',
			'--setting-sources',
			'',
			'--strict-mcp-config',
			'--no-session-persistence',
			'--model',
			'sonnet',
			'--include-partial-messages',
			'--output-format',
			'stream-json',
			'--verbose',
			'--system-prompt',
			CHAT_SYSTEM_PROMPT_READS
		]);
		// THE defect this whole feature turns on, asserted directly: measured against
		// claude 2.1.238, a BARE `Read`/`Grep` grant reads and greps files anywhere on
		// disk from a cwd inside the workspace - so not one granted read tool may
		// appear unscoped. Every read grant must carry its pattern.
		const grants = args[args.indexOf('--allowedTools') + 1].split(',');
		for (const tool of READ_TOOLS) {
			expect(grants).not.toContain(tool);
			expect(grants).toContain(`${tool}(${WS_RULE})`);
		}
		// Search takes no path scope (it has no path), and the two capabilities
		// compose without either losing its own shape.
		const both = chatToolPolicy({ webSearch: true, readRoot: WS, notebookPath: NB });
		expect(both.grants).toEqual([WEB_SEARCH_TOOL, `Read(${WS_RULE})`, `Glob(${WS_RULE})`, `Grep(${WS_RULE})`]);
		expect(both.tools).toEqual([WEB_SEARCH_TOOL, ...READ_TOOLS]);
		expect(promptOf(chatCliArgs({ webSearch: true, readRoot: WS, notebookPath: NB }))).toBe(CHAT_SYSTEM_PROMPT_READS_WEB_SEARCH);
	});

	it('every OTHER argv position is unchanged by the reads shape - the safety flags never move', () => {
		const drop = (args: string[], flag: string) => {
			const at = args.indexOf(flag);
			return at < 0 ? args : [...args.slice(0, at), ...args.slice(at + 2)];
		};
		const scrub = (args: string[]) => {
			const bare = drop(drop(args, '--allowedTools'), '--disallowedTools');
			return bare.map((a, i) => (['--tools', '--model', '--system-prompt'].includes(bare[i - 1] ?? '') ? '<varies>' : a));
		};
		expect(scrub(chatCliArgs({ readRoot: WS, notebookPath: NB }))).toEqual(scrub(chatCliArgs()));
		expect(scrub(chatCliArgs({ readRoot: WS, webSearch: true, notebookPath: NB }))).toEqual(scrub(chatCliArgs()));
	});

	it('a root that cannot be confined yields a READ-LESS run, never an unconfined one', () => {
		// Fail closed on every shape the setting or a hand-edited store can produce.
		// The POSIX check is deliberate: the `//` rule prefix is the CLI's
		// absolute-path spelling and was measured on POSIX only, so a Windows-style
		// root is refused rather than turned into a rule of unknown behaviour.
		for (const bad of [null, undefined, '', '   ', 'relative/dir', './x', '..', 'C:\\Users\\me', 42, {}, ['/tmp']]) {
			expect(chatReadRoot(bad)).toBeNull();
			const args = chatCliArgs({ readRoot: bad as never, notebookPath: NB });
			expect(args).toEqual(chatCliArgs());
			expect(args).not.toContain('--allowedTools');
		}
		// ...and a read-less run is also TOLD it cannot read: the prompt is chosen
		// from the same policy, so it can never claim a capability that was refused.
		expect(promptOf(chatCliArgs({ readRoot: 'relative/dir', notebookPath: NB }))).toBe(CHAT_SYSTEM_PROMPT);
		// A good root normalizes (trailing slash, `..`, doubled separators) before
		// it becomes a pattern, so one directory always yields one rule.
		expect(chatReadRoot('/tmp/cellar-ws/')).toBe(WS);
		expect(chatReadRoot('/tmp/cellar-ws/sub/..')).toBe(WS);
		expect(chatReadRoot('//tmp//cellar-ws')).toBe(WS);
	});

	it('a root carrying an UNCONFINABLE character is refused - each member driven, never a class', () => {
		// Three MEASUREMENTS against claude 2.1.238, landing in three places - which
		// is why the refused character set is exactly these seven:
		//   `* ? [ ] { }` WIDEN the grant. `<root>/ws[ab]` yields the rule
		//     `Read(//<root>/ws[ab]/**)`, which the matcher GLOB-INTERPRETS - it read
		//     its own file AND read `<root>/wsa/secret.txt` in a SIBLING directory,
		//     returning the secret.
		//   `\` BREAKS CHILD STARTUP. With a real directory `<root>/ws\a` on disk
		//     the CLI refused to launch at all (rc=1, "Can't access working
		//     directory"), which today surfaces as an opaque `api_error` on a run the
		//     user asked to read files.
		// Both are refused outright rather than escaped (escape semantics are
		// unmeasured, and a wrong escape reopens the hole while looking fixed), so
		// the run degrades to today's read-less one.
		for (const bad of ['*', '?', '[', ']', '{', '}', '\\']) {
			const root = `/tmp/cellar${bad}ws`;
			expect(chatReadRoot(root)).toBeNull();
			// Byte-identical to the default shape: no grant flag at all, so nothing
			// unconfined can be granted...
			const args = chatCliArgs({ readRoot: root, notebookPath: NB });
			expect(args).toEqual(chatCliArgs());
			expect(args).not.toContain('--allowedTools');
			// ...the prompt truthfully says so, and the cwd stays neutral.
			expect(promptOf(args)).toBe(CHAT_SYSTEM_PROMPT);
			expect(chatCliCwd(chatToolPolicy({ readRoot: root, notebookPath: NB }))).toBe(tmpdir());
		}
		// One anywhere in the path is enough, including deep in it.
		expect(chatReadRoot('/tmp/proj[1]/ws')).toBeNull();
		expect(chatReadRoot('/tmp/proj\\1/ws')).toBeNull();

		// PARENTHESES are the driven-SAFE third case and must keep working, in BOTH
		// forms - a different question each, since only the ADJACENT one could be an
		// extglob. Driven, `<root>/ws (2)` and `<root>/report(2)` each read inside
		// and still refused outside; `~/Projects/analysis (2)` and `report(2)` are
		// entirely ordinary workspace names.
		for (const paren of ['/tmp/Projects/analysis (2)', '/tmp/Projects/report(2)']) {
			expect(chatReadRoot(paren)).toBe(paren);
			expect(promptOf(chatCliArgs({ readRoot: paren, notebookPath: NB }))).toBe(CHAT_SYSTEM_PROMPT_READS);
			for (const tool of READ_TOOLS) {
				expect(chatToolPolicy({ readRoot: paren, notebookPath: NB }).grants).toContain(`${tool}(/${paren}/**)`);
			}
		}
	});

	it('an EXTGLOB-shaped root is refused as a precaution, while a bare @/+/! still works', () => {
		// The one refusal here that is NOT a measured leak, and the distinction is
		// the point. All three forms were DRIVEN against claude 2.1.238 with the
		// sibling an extglob would have covered - `runs@(a|b)` beside `runsa`,
		// `data!(old)` beside `dataX`, `logs+(x)` beside `logsx` - and all three were
		// INERT: the sibling was refused and the inside read still worked, i.e.
		// extglob is off in this engine. They are refused anyway as a DURABLE
		// PRECAUTION, because that is an unstated detail of the CLI's matcher a
		// future version could flip and this module fails closed on grammar it
		// cannot depend on. Do not rewrite this as "measured to leak"; it was
		// measured NOT to.
		for (const root of ['/tmp/runs@(a|b)', '/tmp/data!(old)', '/tmp/logs+(x)', '/tmp/proj/@(x)/ws']) {
			expect(chatReadRoot(root)).toBeNull();
			const args = chatCliArgs({ readRoot: root, notebookPath: NB });
			expect(args).toEqual(chatCliArgs());
			expect(args).not.toContain('--allowedTools');
			expect(args).not.toContain('--disallowedTools');
			expect(promptOf(args)).toBe(CHAT_SYSTEM_PROMPT);
			expect(chatCliCwd(chatToolPolicy({ readRoot: root, notebookPath: NB }))).toBe(tmpdir());
		}
		// It is a two-character SEQUENCE test, not a character set: these characters
		// are ordinary in directory names and refusing them outright would take the
		// feature away from perfectly confinable workspaces.
		for (const ok of ['/tmp/my@notes', '/tmp/c++', '/tmp/important!', '/tmp/a(b)@c']) {
			expect(chatReadRoot(ok)).toBe(ok);
			expect(chatToolPolicy({ readRoot: ok, notebookPath: NB }).grants).toContain(`Read(/${ok}/**)`);
		}
	});

	it('reads need a DENIABLE notebook path too - without one the run is read-less, not unbounded', () => {
		// The always-denied promise (rule 1 of `denialPatterns`) is only keepable
		// when the run can name the notebook, so the policy refuses to grant reads
		// without one. That is what makes the promise structural: there is no
		// reachable state with a granted read and no notebook denial.
		for (const bad of [null, undefined, '', 'relative/nb.ipynb', '/tmp/cellar-ws/nb[1].ipynb', '/tmp/cellar-ws/@(nb).ipynb', 42, {}]) {
			const policy = chatToolPolicy({ readRoot: WS, notebookPath: bad as never });
			expect(policy.readRoot).toBeNull();
			expect(policy.tools).toEqual([]);
			expect(policy.grants).toEqual([]);
			expect(policy.denials).toEqual([]);
			const args = chatCliArgs({ readRoot: WS, notebookPath: bad as never });
			expect(args).toEqual(chatCliArgs());
			expect(promptOf(args)).toBe(CHAT_SYSTEM_PROMPT);
			expect(chatCliCwd(policy)).toBe(tmpdir());
		}
		// Web search is a separate capability and is NOT collateral damage: a run
		// that cannot deny its notebook still searches, it just gets no file tools.
		const searchOnly = chatToolPolicy({ webSearch: true, readRoot: WS, notebookPath: null });
		expect(searchOnly.tools).toEqual([WEB_SEARCH_TOOL]);
		expect(searchOnly.denials).toEqual([]);
		expect(promptOf(chatCliArgs({ webSearch: true, readRoot: WS, notebookPath: null }))).toBe(CHAT_SYSTEM_PROMPT_WEB_SEARCH);
	});

	it('a reads-on run DENIES the current notebook, .cellar/ and (by default) every other notebook', () => {
		// The grant says where a reply may read; these say what stays unreadable
		// inside it. Every rule is emitted for EVERY read tool because each can
		// surface a file's content independently - a rule missing from one of them
		// is that file readable through the other two.
		const off = chatToolPolicy({ readRoot: WS, notebookPath: NB });
		expect(off.denials).toEqual(denyRules(NB_DENY, true));

		// The opt-in opens OTHER notebooks and nothing else: the current notebook,
		// the artifacts named after it and Cellar's own state stay denied, which is
		// the invariant the setting may not reach. The checkpoint copy IS the current
		// notebook, so it must survive here rather than merely riding the blanket
		// notebook block that this shape drops.
		const on = chatToolPolicy({ readRoot: WS, notebookPath: NB, otherNotebooks: true });
		expect(on.denials).toEqual(denyRules(NB_DENY, false));
		for (const tool of READ_TOOLS) {
			for (const d of NB_DENY) expect(on.denials).toContain(`${tool}(${d})`);
			expect(on.denials).toContain(`${tool}(${CELLAR_DENY})`);
			for (const d of IPYNB_DENY) expect(on.denials).not.toContain(`${tool}(${d})`);
		}
		// The grant is untouched by the setting - it only ever takes reach back.
		expect(on.grants).toEqual(off.grants);
		expect(on.tools).toEqual(off.tools);

		// A jupytext `.py` notebook is the current notebook too, so the rule is its
		// ACTUAL path and never an `.ipynb` pattern - the case the extension-shaped
		// rules below would silently miss. Its derived set is the mirror image: the
		// `.ipynb` convert output is the sibling here, and the file itself is not
		// covered by the blanket notebook block at all.
		const py = chatToolPolicy({ readRoot: WS, notebookPath: '/tmp/cellar-ws/analysis.py', otherNotebooks: true });
		expect(py.denials).toEqual(denyRules(['//tmp/cellar-ws/analysis.py', '//tmp/cellar-ws/analysis.ipynb', '//tmp/cellar-ws/analysis.html', '//tmp/cellar-ws/.ipynb_checkpoints/analysis-checkpoint.ipynb'], false));

		// The derived rules are BY NAME, never by file TYPE: an unrelated `.py` or
		// `.html` in the same workspace stays readable, which is the whole feature -
		// `.py` is exactly what the Settings copy promises a reply can read.
		for (const rule of on.denials) {
			expect(rule).not.toContain('helper.py');
			expect(rule).not.toContain('report.html');
		}

		// A notebook in a SUBDIRECTORY derives its siblings beside itself, not at the
		// workspace root - a rule built from the basename alone would deny the wrong
		// directory and leave the real copies readable.
		const nested = chatToolPolicy({ readRoot: WS, notebookPath: '/tmp/cellar-ws/sub/deep.ipynb', otherNotebooks: true });
		for (const tool of READ_TOOLS) {
			expect(nested.denials).toContain(`${tool}(//tmp/cellar-ws/sub/deep.html)`);
			expect(nested.denials).toContain(`${tool}(//tmp/cellar-ws/sub/.ipynb_checkpoints/deep-checkpoint.ipynb)`);
		}

		// Both notebook forms are emitted rather than trusting `**/` to match zero
		// directories, which is engine-dependent: relying on it would leave the
		// workspace's TOP-LEVEL notebooks readable.
		for (const tool of READ_TOOLS) {
			expect(off.denials).toContain(`${tool}(//tmp/cellar-ws/*.ipynb)`);
			expect(off.denials).toContain(`${tool}(//tmp/cellar-ws/**/*.ipynb)`);
		}
	});

	it('ONE predicate answers "can this path be a literal rule" for the root AND every denial target', () => {
		// The root and the denial targets ask the same question - can this path be
		// spelled so the matcher treats every character literally - and answering it
		// twice is how the two drift into disagreeing about which paths are safe.
		for (const bad of [null, undefined, '', '   ', 'relative/dir', 'C:\\Users\\me', 42, {}, '/tmp/ws[ab]', '/tmp/ws*', '/tmp/ws?', '/tmp/ws{a}', '/tmp/ws\\a', '/tmp/runs@(a|b)', '/tmp/data!(old)', '/tmp/logs+(x)']) {
			expect(literalRulePath(bad as never)).toBeNull();
			expect(chatReadRoot(bad as never)).toBeNull();
		}
		for (const ok of ['/tmp/cellar-ws', '/tmp/Projects/analysis (2)', '/tmp/Projects/report(2)', '/tmp/my@notes', '/tmp/c++', '/tmp/important!']) {
			expect(literalRulePath(ok)).toBe(ok);
			expect(chatReadRoot(ok)).toBe(ok);
		}
		// It NORMALIZES, so one directory yields one rule whichever spelling arrives.
		expect(literalRulePath('/tmp/cellar-ws/sub/..')).toBe(WS);
	});

	it('an un-patternable NOTEBOOK name costs the reads, not the guarantee', () => {
		// A MEASURED fail-open, not a theoretical one: with the notebook at
		// `<ws>/data[1].ipynb` beside a decoy `<ws>/data1.ipynb`, the deny pattern was
		// glob-INTERPRETED - it denied the DECOY and left the real current notebook
		// READABLE, so "the current notebook is always denied" was silently false.
		// The root is perfectly confinable in every case here, so what is being
		// pinned is that the NOTEBOOK's own name can veto the reads.
		for (const nb of ['/tmp/cellar-ws/data[1].ipynb', '/tmp/cellar-ws/v*.ipynb', '/tmp/cellar-ws/q?.ipynb', '/tmp/cellar-ws/a{b}.ipynb', '/tmp/cellar-ws/back\\slash.ipynb', '/tmp/cellar-ws/runs@(a|b).ipynb', '/tmp/cellar-ws/deep[1]/nb.ipynb']) {
			const policy = chatToolPolicy({ readRoot: WS, notebookPath: nb });
			expect(policy.readRoot).toBeNull();
			expect(policy.tools).toEqual([]);
			expect(policy.grants).toEqual([]);
			expect(policy.denials).toEqual([]);
			// Byte-identical to the default shape, neutral cwd, read-less prompt: the
			// degradation stays coherent rather than shipping a grant whose denial
			// points at the wrong file.
			const args = chatCliArgs({ readRoot: WS, notebookPath: nb });
			expect(args).toEqual(chatCliArgs());
			expect(args).not.toContain('--allowedTools');
			expect(args).not.toContain('--disallowedTools');
			expect(promptOf(args)).toBe(CHAT_SYSTEM_PROMPT);
			expect(chatCliCwd(policy)).toBe(tmpdir());
		}
		// Web search is a separate capability and survives: only the file half is
		// withheld.
		const searchOnly = chatToolPolicy({ webSearch: true, readRoot: WS, notebookPath: '/tmp/cellar-ws/data[1].ipynb' });
		expect(searchOnly.tools).toEqual([WEB_SEARCH_TOOL]);
		expect(searchOnly.denials).toEqual([]);
	});

	it('the denial rides ONE argv element and is omitted, never empty, when reads are off', () => {
		// Same shape rules as the grant beside it. Omitted rather than passed empty
		// is what keeps the read-less argv byte-for-byte the pre-settings one.
		for (const caps of [{}, { webSearch: true }]) {
			expect(chatCliArgs(caps)).not.toContain('--disallowedTools');
		}
		const args = chatCliArgs({ readRoot: WS, notebookPath: NB });
		const at = args.indexOf('--disallowedTools');
		expect(at).toBeGreaterThan(-1);
		expect(args.filter((a) => a === '--disallowedTools')).toHaveLength(1);
		const value = args[at + 1];
		expect(value.length).toBeGreaterThan(0);
		// Every rule in it is SCOPED: a bare tool name in the deny list would deny
		// the tool outright and silently kill the feature.
		for (const rule of value.split(',')) expect(rule).toMatch(/^(Read|Glob|Grep)\(\/\//);
	});

	it('canonicalises the root, and VALIDATES BEFORE it does - a relative root stays refused', () => {
		// The whole policy is built in the canonical namespace because the CLI's deny
		// only binds there (see `canonicalPath`). The ordering is the trap: realpath
		// resolves a RELATIVE path against the process's own cwd, so canonicalising
		// before validating turns a value that must be REFUSED into a real absolute
		// path and grants reads over whatever directory Cellar is running in.
		for (const bad of ['relative/dir', './x', '..', '']) {
			expect(chatCliArgs({ readRoot: bad, notebookPath: `${WS}/analysis.ipynb` })).toEqual(chatCliArgs());
		}
		// A real symlinked root IS canonicalised, and every emitted rule - grant,
		// cwd and denials - is in that one namespace.
		const link = join(OUT, 'ws-link');
		const real = mkdtempSync(join(tmpdir(), 'cellar-canon-real-'));
		try {
			rmSync(link, { force: true });
			symlinkSync(real, link);
			const nb = join(link, 'analysis.ipynb');
			writeFileSync(join(real, 'analysis.ipynb'), '{}');
			const policy = chatToolPolicy({ readRoot: link, notebookPath: nb });
			const canonical = realpathSync(real);
			expect(policy.readRoot).toBe(canonical);
			expect(chatCliCwd(policy)).toBe(canonical);
			expect(policy.grants.every((g) => g.includes(canonical))).toBe(true);
			// Belt and braces: the LEXICAL spelling is denied too, so a tool handed
			// the other spelling of an already-denied path still refuses.
			expect(policy.denials.some((d) => d.includes(`//${canonical.replace(/^\/+/, '')}/analysis.ipynb`))).toBe(true);
			expect(policy.denials.some((d) => d.includes(`//${link.replace(/^\/+/, '')}/analysis.ipynb`))).toBe(true);
		} finally {
			rmSync(link, { force: true });
			rmSync(real, { recursive: true, force: true });
		}
	});

	it('a workspace path that could SPLIT the grant list cannot inject a bare read grant', () => {
		// `--allowedTools` is documented "comma or space-separated", and the read
		// rules embed a filesystem path - so a path containing `,Read,` is the
		// adversarial case: were the value split, a BARE `Read` would be granted and
		// the confinement would silently evaporate. Measured against claude 2.1.238
		// the value is NOT split inside one argv element (an outside read stayed
		// refused from exactly such a workspace); this pins OUR half - the grant is
		// one argv element, and every read grant in it still carries its pattern.
		const nasty = '/tmp/ws,Read,x/my ws,with space';
		const args = chatCliArgs({ readRoot: nasty, notebookPath: NB });
		const at = args.indexOf('--allowedTools');
		expect(at).toBeGreaterThan(-1);
		const grant = args[at + 1];
		// ONE argv element carries the whole grant (never one element per rule, and
		// never a stray element the CLI would read as a separate bare tool name).
		expect(args[at + 2]).toBe('--disallowedTools');
		expect(args[at + 4]).toBe('--disable-slash-commands');
		for (const tool of READ_TOOLS) {
			expect(grant).toContain(`${tool}(//tmp/ws,Read,x/my ws,with space/**)`);
		}
		// The DENIAL embeds the same path and answers the same question: split, it
		// would fall apart into fragments the CLI reads as bare tool names, denying
		// the tools outright and silently killing the feature.
		const deny = args[args.indexOf('--disallowedTools') + 1];
		for (const tool of READ_TOOLS) {
			expect(deny).toContain(`${tool}(//tmp/ws,Read,x/my ws,with space/.cellar/**)`);
			expect(deny).not.toBe(tool);
		}
		// What THIS side controls, asserted exactly: the policy never emits a bare
		// grant, whatever the root looks like. (A fragment scan of the joined string
		// would be meaningless here - `Read` appears in the path itself, which is
		// precisely why the CLI's non-splitting had to be measured rather than
		// reasoned about; that half is pinned against the real binary in
		// `tests/e2e/chat-workspace-reads.spec.ts`.)
		const nastyPolicy = chatToolPolicy({ readRoot: nasty, notebookPath: NB });
		for (const g of nastyPolicy.grants) {
			expect(READ_TOOLS).not.toContain(g);
			expect(g).toMatch(/\(\/\/.*\/\*\*\)$/);
		}
		for (const d of nastyPolicy.denials) {
			expect(READ_TOOLS).not.toContain(d);
			expect(d).toMatch(/^(Read|Glob|Grep)\(\/\/.*\)$/);
		}
	});

	it('learning mode is OFF by default: every shipped prompt is byte-identical without it', () => {
		// The regression this whole increment must not cause. The four constants are
		// what every existing install sends today, so they are pinned as literal
		// EXPECTED text rather than against the composition that produced them -
		// compared against `buildChatSystemPrompt`'s own output the assertion would
		// be a tautology and a reworded framing would sail through it.
		const framing =
			'You are the AI assistant inside Cellar, a data notebook. The user message is the notebook so far, ' +
			'rendered as labelled blocks: [cell <id> · <kind>] holds a cell\'s source, [cell <id> · output] its ' +
			'result, [cell <id> · reply] an earlier answer of yours, and [question] is what to answer now. Answer ' +
			'in concise markdown. ALWAYS put code in a fenced block tagged with its language (```python, ```sql, ' +
			'```markdown, ```bash): the user lifts a fenced block straight into a notebook cell and the tag picks ' +
			"that cell's type, so an untagged or unfenced snippet lands as the wrong kind of cell.";
		const reads =
			"You can read files in the notebook's own workspace with Read, Glob and Grep, and only there - paths " +
			'outside it are refused, so do not try. Use them to ground your answer in the real code, and say which ' +
			'file a claim came from. The notebook you are answering in is not readable as a file: you already have ' +
			'it above, fresher than any copy on disk, so do not go looking for it. You cannot write or edit files ' +
			'and cannot run code - never claim to have done so; when something needs running, say what to run.';
		expect(CHAT_SYSTEM_PROMPT).toBe(
			`${framing} You have no tools and cannot run code, read files, or browse - never claim to have done so; ` +
				'when the notebook lacks what you would need, say what to run.'
		);
		expect(CHAT_SYSTEM_PROMPT_WEB_SEARCH).toBe(
			`${framing} Your only tool is web search - use it when the question needs current or external ` +
				'information, and say when a claim comes from a search result. You cannot run code or read files - ' +
				'never claim to have done so; when the notebook lacks what you would need, say what to run.'
		);
		expect(CHAT_SYSTEM_PROMPT_READS).toBe(`${framing} ${reads} You cannot browse the web.`);
		expect(CHAT_SYSTEM_PROMPT_READS_WEB_SEARCH).toBe(
			`${framing} ${reads} You can also search the web when the question needs current or external ` +
				'information; say when a claim comes from a search result.'
		);

		// A caller that does not ask for learning mode gets those four back, byte for
		// byte - the DEFAULT is what an upgraded install sends, so it is asserted at
		// the function as well as at the constants.
		const shapes = [
			[chatToolPolicy(), CHAT_SYSTEM_PROMPT],
			[chatToolPolicy({ webSearch: true }), CHAT_SYSTEM_PROMPT_WEB_SEARCH],
			[chatToolPolicy({ readRoot: WS, notebookPath: NB }), CHAT_SYSTEM_PROMPT_READS],
			[chatToolPolicy({ readRoot: WS, webSearch: true, notebookPath: NB }), CHAT_SYSTEM_PROMPT_READS_WEB_SEARCH]
		] as const;
		for (const [policy, expected] of shapes) {
			expect(chatSystemPrompt(policy)).toBe(expected);
			expect(chatSystemPrompt(policy, false)).toBe(expected);
			expect(expected).not.toContain(CHAT_LEARNING_MODE_BLOCK);
			expect(expected).not.toContain('act as a teacher');
		}
		// And the ARGV path defaults the same way: an omitted flag, and an explicit
		// false, both send the unchanged prompt.
		expect(promptOf(chatCliArgs())).toBe(CHAT_SYSTEM_PROMPT);
		expect(promptOf(chatCliArgs({ learningMode: false }))).toBe(CHAT_SYSTEM_PROMPT);
		// Only a literal `true` turns it on - the same gate the store read applies, so
		// a truthy value that slipped past the caller cannot change what is sent.
		for (const junk of ['true', 1, {}] as unknown[]) {
			expect(promptOf(chatCliArgs({ learningMode: junk as boolean }))).toBe(CHAT_SYSTEM_PROMPT);
		}
	});

	it('learning mode ADDS one block to every capability shape, and changes nothing else', () => {
		// The block is the product owner's wording and is sent VERBATIM - it is an
		// instruction to the model, not copy, so it is pinned here as the literal text
		// rather than referenced through the constant it lives in.
		expect(CHAT_LEARNING_MODE_BLOCK).toBe(
			'Could you act as a teacher and build up the ideas from first principles?\n' +
				'Try to answer in short blocks and test my understanding, your main goal is to make me understand.'
		);

		// It composes with EVERY combination of the two capabilities - the point of
		// composing from parts rather than writing eight finished constants - and each
		// on-prompt is exactly its own off-prompt plus the block, so it can never
		// silently reword the capability sentence it is appended to.
		const cases = [
			[{}, CHAT_SYSTEM_PROMPT],
			[{ webSearch: true }, CHAT_SYSTEM_PROMPT_WEB_SEARCH],
			[{ readRoot: WS, notebookPath: NB }, CHAT_SYSTEM_PROMPT_READS],
			[{ readRoot: WS, webSearch: true, notebookPath: NB }, CHAT_SYSTEM_PROMPT_READS_WEB_SEARCH]
		] as const;
		const seen = new Set<string>();
		for (const [caps, off] of cases) {
			const policy = chatToolPolicy(caps);
			const on = chatSystemPrompt(policy, true);
			expect(on).toBe(`${off} ${CHAT_LEARNING_MODE_BLOCK}`);
			expect(on).toContain(CHAT_LEARNING_MODE_BLOCK);
			seen.add(on);
			// The capability claim is untouched: the shape still says what it can and
			// cannot do, so a taught reply is not also a mis-described one.
			expect(on.startsWith(off)).toBe(true);
		}
		// Eight distinct prompts across the two axes, from one added block.
		expect(seen.size).toBe(4);
		expect(new Set([...seen, CHAT_SYSTEM_PROMPT, CHAT_SYSTEM_PROMPT_WEB_SEARCH, CHAT_SYSTEM_PROMPT_READS, CHAT_SYSTEM_PROMPT_READS_WEB_SEARCH]).size).toBe(8);

		// BYTE-STABILITY survives the composition: nothing per-run may enter, so two
		// installs with different confinement roots must send the same bytes.
		for (const root of ['/tmp/cellar-ws', '/some/other/workspace']) {
			const p = promptOf(chatCliArgs({ readRoot: root, notebookPath: NB, learningMode: true }));
			expect(p).toBe(chatSystemPrompt(chatToolPolicy({ readRoot: WS, notebookPath: NB }), true));
			expect(p).not.toContain(root);
		}

		// The SAFETY BOUNDARY is untouched: learning mode moves `--system-prompt` and
		// nothing else, so it can never widen a session. Asserted over every shape,
		// because the flag is one argument the argv builder threads through all of them.
		for (const [caps] of cases) {
			const off = chatCliArgs(caps);
			const on = chatCliArgs({ ...caps, learningMode: true });
			const at = off.indexOf('--system-prompt');
			expect(on.indexOf('--system-prompt')).toBe(at);
			expect(on.length).toBe(off.length);
			expect([...on.slice(0, at + 1), ...on.slice(at + 2)]).toEqual([...off.slice(0, at + 1), ...off.slice(at + 2)]);
			// Stated positively too, since these three are the whole confinement story.
			const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];
			expect(flag(on, '--tools')).toBe(flag(off, '--tools'));
			expect(on.includes('--allowedTools')).toBe(off.includes('--allowedTools'));
			expect(on.includes('--disallowedTools')).toBe(off.includes('--disallowedTools'));
			// ...and the policy the init assertion is made against is the same object,
			// so a learning-mode run cannot report a different tool set as acceptable.
			expect(chatToolPolicy(caps).tools).toEqual(chatToolPolicy({ ...caps }).tools);
		}
		// The cwd is a function of the policy alone, so it cannot move either.
		expect(chatCliCwd(chatToolPolicy({ readRoot: WS, notebookPath: NB }))).toBe(chatCliCwd(chatToolPolicy({ readRoot: WS, notebookPath: NB })));
	});

	it('the child runs IN the confinement root when reads are on, and in the neutral tmpdir otherwise', () => {
		// Reads-on has to move the cwd: the tools resolve relative paths against it
		// and default to it with no `path`. It is NOT the confinement mechanism -
		// measured, a cwd inside the workspace with a bare grant still read outside -
		// so the cwd moving and the grant being scoped are two separate claims.
		expect(chatCliCwd(chatToolPolicy({ readRoot: WS, notebookPath: NB }))).toBe(WS);
		expect(chatCliCwd(chatToolPolicy())).toBe(tmpdir());
		expect(chatCliCwd(chatToolPolicy({ webSearch: true }))).toBe(tmpdir());
		expect(chatCliCwd(chatToolPolicy({ readRoot: 'relative/dir', notebookPath: NB }))).toBe(tmpdir());
	});

	it('each of the four frozen prompts is TRUE for its own shape, and none carries a per-run value', () => {
		const prompts = {
			bare: CHAT_SYSTEM_PROMPT,
			search: CHAT_SYSTEM_PROMPT_WEB_SEARCH,
			reads: CHAT_SYSTEM_PROMPT_READS,
			both: CHAT_SYSTEM_PROMPT_READS_WEB_SEARCH
		};
		// The policy picks the prompt, so a shape can never be described by another's.
		expect(chatSystemPrompt(chatToolPolicy())).toBe(prompts.bare);
		expect(chatSystemPrompt(chatToolPolicy({ webSearch: true }))).toBe(prompts.search);
		expect(chatSystemPrompt(chatToolPolicy({ readRoot: WS, notebookPath: NB }))).toBe(prompts.reads);
		expect(chatSystemPrompt(chatToolPolicy({ readRoot: WS, webSearch: true, notebookPath: NB }))).toBe(prompts.both);
		expect(new Set(Object.values(prompts)).size).toBe(4);

		// No prompt may claim "no tools" while the shape HOLDS tools - the specific
		// falsehood this feature would otherwise introduce.
		expect(prompts.bare).toContain('no tools');
		for (const p of [prompts.search, prompts.reads, prompts.both]) expect(p).not.toContain('no tools');
		// A reads-on shape may not say it cannot read files; a reads-off one must.
		for (const p of [prompts.bare, prompts.search]) expect(p).toMatch(/cannot run code or read files|cannot run code, read files/);
		for (const p of [prompts.reads, prompts.both]) {
			expect(p).not.toMatch(/cannot .*read files/);
			expect(p).toMatch(/Read, Glob and Grep/);
			expect(p).toMatch(/only there|refused/); // the confinement is stated, not implied
			expect(p).toMatch(/cannot write or edit files/); // read-only is stated
		}
		// Browsing: claimed only where granted.
		expect(prompts.reads).toMatch(/cannot browse/);
		for (const p of [prompts.search, prompts.both]) expect(p).toMatch(/search/i);

		// BYTE-STABILITY: the prompt is the cached prefix, so it must be a constant
		// per shape - no per-run value, and emphatically not the confinement root
		// (which differs per install, would miss the cache every run, and would leak
		// the path into the model's context).
		for (const root of ['/tmp/cellar-ws', '/some/other/workspace']) {
			const prompt = promptOf(chatCliArgs({ readRoot: root, notebookPath: NB }));
			expect(prompt).toBe(prompts.reads);
			expect(prompt).not.toContain(root);
		}
	});

	it('the assertion covers the reads shapes too - both directions, on the CLI-probed init', async () => {
		const base = { mcp_servers: [], slash_commands: [], skills: [] };
		const reads = chatToolPolicy({ readRoot: WS, notebookPath: NB }).tools;
		// The CLI reports its OWN order, so the comparison is a SET comparison.
		expect(initViolation({ ...base, tools: ['Glob', 'Grep', 'Read'] }, reads)).toBeNull();
		// Never MORE...
		expect(initViolation({ ...base, tools: [...READ_TOOLS, 'Bash'] }, reads)).toMatch(/Bash/);
		// ...and never LESS (a missing tool means the frozen prompt over-claims).
		expect(initViolation({ ...base, tools: ['Read', 'Glob'] }, reads)).toMatch(/missing/);
		// The DEFAULT path still condemns a session holding read tools nobody asked for.
		expect(initViolation({ ...base, tools: ['Read'] })).toMatch(/Read/);
		// The SEARCH path condemns them too: capabilities do not pool across shapes.
		expect(initViolation({ ...base, tools: [WEB_SEARCH_TOOL, 'Read'] }, chatToolPolicy({ webSearch: true }).tools)).toMatch(/Read/);
		// And the both-on shape asserts exactly the union.
		const both = chatToolPolicy({ webSearch: true, readRoot: WS, notebookPath: NB }).tools;
		expect(initViolation({ ...base, tools: ['Glob', 'Grep', 'Read', WEB_SEARCH_TOOL] }, both)).toBeNull();
		expect(initViolation({ ...base, tools: [...READ_TOOLS] }, both)).toMatch(/missing/);
	});

	it('a reads-on run against the CLI-probed init succeeds, and the child received the scoped argv', async () => {
		const argvFile = join(OUT, 'argv-reads.txt');
		stubClaude(
			[
				`for a in "$@"; do printf '%s\\n' "$a"; done > "${argvFile}"`,
				`cat > /dev/null`,
				`echo '${READS_INIT}'`,
				`echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"read it"}}}'`,
				`echo '{"type":"result","subtype":"success","is_error":false,"result":"read it"}'`
			].join('\n')
		);
		// The root must EXIST: the engine spawns the child with it as cwd.
		const ws = mkdtempSync(join(tmpdir(), 'cellar-chat-ws-'));
		try {
			const p = run({ readRoot: ws, notebookPath: NB });
			const res = await p;
			expect(res.ok).toBe(true);
			expect(p.deltas).toEqual(['read it']);
			expect(readFileSync(argvFile, 'utf8')).toBe(chatCliArgs({ readRoot: ws, notebookPath: NB }).join('\n') + '\n');
		} finally {
			rmSync(ws, { recursive: true, force: true });
		}
	});

	it('an unrequested read tool kills a reads-on run: one extra tool beside the requested three', async () => {
		const overInit = JSON.stringify({
			type: 'system',
			subtype: 'init',
			tools: ['Glob', 'Grep', 'Read', 'Write'],
			mcp_servers: [],
			slash_commands: [],
			skills: [],
			claude_code_version: '9.9.9-stub'
		});
		stubClaude(
			[
				`cat > /dev/null`,
				`echo '${overInit}'`,
				`echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"leak"}}}'`,
				`echo '{"type":"result","subtype":"success","is_error":false,"result":"leak"}'`
			].join('\n')
		);
		const ws = mkdtempSync(join(tmpdir(), 'cellar-chat-ws-'));
		try {
			const p = run({ readRoot: ws, notebookPath: NB });
			const res = await p;
			expect(res.ok).toBe(false);
			expect(res.failure?.kind).toBe('unsafe_init');
			expect(res.failure?.message).toContain('Write');
			expect(p.deltas).toEqual([]);
		} finally {
			rmSync(ws, { recursive: true, force: true });
		}
	});

	it('ONE source: for every shape, the argv\'s request and grant ARE the policy the assertion reads', () => {
		// The invariant this whole design turns on, made executable rather than left
		// as a comment: request, grant and assertion must be one decision. Two
		// independently-computed lists would not throw - they would silently grant a
		// capability nothing asserted, or assert one nothing granted.
		for (const caps of [{}, { webSearch: true }, { readRoot: WS, notebookPath: NB }, { webSearch: true, readRoot: WS, notebookPath: NB }]) {
			const policy = chatToolPolicy(caps);
			const args = chatCliArgs(caps);
			// `--tools` REQUESTS exactly the policy's tools...
			expect(args[args.indexOf('--tools') + 1]).toBe(policy.tools.join(','));
			// ...`--allowedTools` GRANTS exactly the policy's grants, and is absent
			// (never empty) when there is nothing to grant...
			const at = args.indexOf('--allowedTools');
			if (policy.grants.length === 0) expect(at).toBe(-1);
			else expect(args[at + 1]).toBe(policy.grants.join(','));
			// ...the prompt is the one THAT policy selects...
			expect(promptOf(args)).toBe(chatSystemPrompt(policy));
			// ...and every granted rule names a tool the run actually requested, so a
			// grant can never reach a capability the assertion does not cover.
			for (const grant of policy.grants) {
				const name = grant.replace(/\(.*$/, '');
				expect(policy.tools).toContain(name);
			}
		}
	});

	it('the module never requests a WRITE-shaped or executing tool, and never WebFetch', () => {
		// The capability ceiling as OBSERVABLE OUTPUT: a chat cell learns from the
		// workspace, it does not edit it or run things in it.
		expect(READ_TOOLS).toEqual(['Read', 'Glob', 'Grep']);
		// Whatever shape is asked for, the requested set stays within the ceiling.
		for (const caps of [{}, { webSearch: true }, { readRoot: WS, notebookPath: NB }, { webSearch: true, readRoot: WS, notebookPath: NB }]) {
			for (const tool of chatToolPolicy(caps).tools) {
				expect([WEB_SEARCH_TOOL, ...READ_TOOLS]).toContain(tool);
			}
		}
	});
});

describe('a failure names a remedy the user can actually reach', () => {
	it('the MISSING-tool unsafe_init is rendered without blaming one capability', async () => {
		// Reachable from EITHER capability now: a CLI or account that does not grant
		// a requested tool reports fewer tools than the run asked for. Driven end to
		// end - a READS-on run against a session reporting no tools - because the
		// point is the copy the user is left holding, and attributing it to web
		// search sends someone whose search toggle is already off to turn it off.
		const noTools = JSON.stringify({ type: 'system', subtype: 'init', tools: [], mcp_servers: [], slash_commands: [], skills: [], claude_code_version: '9.9.9-stub' });
		stubClaude([`cat > /dev/null`, `echo '${noTools}'`, `echo '{"type":"result","subtype":"success","is_error":false,"result":"hi"}'`].join('\n'));
		// The root must EXIST: the engine spawns the child with it as cwd.
		const ws = mkdtempSync(join(tmpdir(), 'cellar-chat-ws-'));
		let res: ChatEngineResult;
		try {
			res = await run({ readRoot: ws, notebookPath: NB });
		} finally {
			rmSync(ws, { recursive: true, force: true });
		}
		expect(res.ok).toBe(false);
		expect(res.failure?.kind).toBe('unsafe_init');
		expect(res.failure?.message).toMatch(/missing/i);

		const md = chatFailureMarkdown(res.failure as ChatEngineFailure);
		// It points at the group that holds every capability, and never singles out
		// a toggle this run may have had OFF.
		expect(md).toContain('Chat cells');
		expect(md).not.toMatch(/turn \*\*Allow web search\*\* off/i);
		// It still says what happened: the run was refused, not answered.
		expect(md).toMatch(/refused to run/i);
	});

	it('a vanished workspace is not reported as a missing CLI', async () => {
		// Reads-on spawns the child WITH the workspace as its cwd, so a directory
		// deleted between `chatReadableWorkspace()`'s check and the spawn makes node
		// raise ENOENT - the SAME code, and (measured) the same `path`/`syscall`, as
		// a missing binary. Blaming the CLI there tells the user to install
		// something they already have.
		const gone = join(tmpdir(), 'cellar-chat-vanished-workspace-xyz');
		rmSync(gone, { recursive: true, force: true });
		stubClaude(`echo '{"type":"result","subtype":"success","is_error":false,"result":"hi"}'`);
		const res = await run({ readRoot: gone, notebookPath: NB });
		expect(res.ok).toBe(false);
		expect(res.failure?.kind).toBe('api_error');
		expect(res.failure?.message).toContain(gone);
		expect(res.failure?.message).not.toMatch(/PATH/);

		// ...while a genuinely absent binary still reports itself, over the very
		// same ENOENT - the two must not be collapsed in either direction. PATH is
		// narrowed to the stub dir for this half, or a developer machine with the
		// real `claude` installed would simply run it and prove nothing.
		const withStub = process.env.PATH;
		rmSync(join(BIN, 'claude'), { force: true });
		process.env.PATH = BIN;
		try {
			const missing = await run();
			expect(missing.failure?.kind).toBe('not_installed');
			expect(missing.failure?.message).toMatch(/not found on PATH/);
		} finally {
			process.env.PATH = withStub;
			stubClaude(`echo '{"type":"result","subtype":"success","is_error":false,"result":"hi"}'`);
		}
	});
});

describe('the init assertion fails closed', () => {
	it('a capable session is killed: unsafe_init, zero deltas delivered', async () => {
		const badInit = JSON.stringify({ type: 'system', subtype: 'init', tools: ['Bash'], mcp_servers: [], slash_commands: [], skills: [], claude_code_version: '9.9.9-stub' });
		// The stub keeps streaming after the bad init; nothing may reach the cell,
		// and the kill must end it well before its 10s of output.
		stubClaude(
			[
				`cat > /dev/null`,
				`echo '${badInit}'`,
				`for i in $(seq 1 100); do echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"leak"}}}'; sleep 0.1; done`,
				`echo '{"type":"result","subtype":"success","is_error":false,"result":"leak"}'`
			].join('\n')
		);
		const started = Date.now();
		const p = run();
		const res = await p;
		expect(res.ok).toBe(false);
		expect(res.failure?.kind).toBe('unsafe_init');
		expect(res.failure?.message).toContain('tools');
		expect(p.deltas).toEqual([]); // not one byte of the condemned session's reply
		expect(Date.now() - started).toBeLessThan(8000); // killed, not awaited
	}, 15_000);

	it('a run that NEVER reports its session fails closed too, delivering no reply', async () => {
		// The same CLI stream minus the init line - a renamed event, a future
		// `stream-json` default, a build that stops emitting it. The run "succeeds"
		// as far as the CLI is concerned, which is exactly why the verdict cannot be
		// left to whether the report happened to arrive.
		stubClaude(
			[
				`cat > /dev/null`,
				`echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"unverified"}}}'`,
				`echo '{"type":"result","subtype":"success","is_error":false,"result":"unverified reply"}'`
			].join('\n')
		);
		const p = run();
		const res = await p;
		expect(res.ok).toBe(false);
		expect(res.failure?.kind).toBe('unsafe_init');
		expect(res.failure?.message).toMatch(/never reported its session/i);
		expect(res.replyText).toBeNull();
		// Not one byte of the unverified session's reply reached the cell either.
		expect(p.deltas).toEqual([]);
	});

	it('cannot-verify is not safe: missing/non-array fields and non-empty skills all violate', () => {
		const base = { tools: [], mcp_servers: [], slash_commands: [] };
		expect(initViolation({ ...base, skills: [] })).toBeNull();
		expect(initViolation(base)).toBeNull(); // absent skills is fine (older CLIs)
		expect(initViolation({ ...base, tools: ['Bash'] })).toMatch(/tools/);
		expect(initViolation({ ...base, mcp_servers: [{}] })).toMatch(/mcp_servers/);
		expect(initViolation({ ...base, slash_commands: ['/x'] })).toMatch(/slash_commands/);
		expect(initViolation({ ...base, skills: ['s'] })).toMatch(/skills/);
		expect(initViolation({ mcp_servers: [], slash_commands: [] })).toMatch(/tools/); // missing
		expect(initViolation({ ...base, tools: 'none' })).toMatch(/tools/); // not an array
	});

	it('the assertion is an EXACT allowlist, never a relaxation - both capability shapes, both directions', () => {
		const base = { mcp_servers: [], slash_commands: [], skills: [] };
		const allow = chatToolPolicy({ webSearch: true }).tools;
		// The search-on session must hold exactly what it requested…
		expect(initViolation({ ...base, tools: [WEB_SEARCH_TOOL] }, allow)).toBeNull();
		// …never MORE (not "contains", not "non-empty": one unrequested tool beside
		// the requested one is still a violation)…
		expect(initViolation({ ...base, tools: [WEB_SEARCH_TOOL, 'Bash'] }, allow)).toMatch(/Bash/);
		expect(initViolation({ ...base, tools: ['Bash'] }, allow)).toMatch(/Bash/);
		// …and never LESS: a session missing the requested tool does not match the
		// request (the frozen search prompt would describe a capability it lacks).
		expect(initViolation({ ...base, tools: [] }, allow)).toMatch(/missing/);
		// The DEFAULT path's guarantee does not weaken by one byte: no expectedTools
		// argument means exactly-empty, so a session holding the search tool nobody
		// requested is condemned there too.
		expect(initViolation({ ...base, tools: [WEB_SEARCH_TOOL] })).toMatch(/tools/);
		// mcp_servers / slash_commands / skills stay asserted empty on the search
		// path exactly as on the bare one.
		expect(initViolation({ ...base, tools: [WEB_SEARCH_TOOL], mcp_servers: [{}] }, allow)).toMatch(/mcp_servers/);
		expect(initViolation({ ...base, tools: [WEB_SEARCH_TOOL], slash_commands: ['/x'] }, allow)).toMatch(/slash_commands/);
		expect(initViolation({ ...base, tools: [WEB_SEARCH_TOOL], skills: ['s'] }, allow)).toMatch(/skills/);
		// Cannot-verify is still not safe with an allowlist in hand.
		expect(initViolation({ mcp_servers: [], slash_commands: [] }, allow)).toMatch(/tools/);
	});

	it('a search-on run against the CLI-probed init succeeds, and the child received the search argv', async () => {
		const argvFile = join(OUT, 'argv-search.txt');
		stubClaude(
			[
				`for a in "$@"; do printf '%s\\n' "$a"; done > "${argvFile}"`,
				`cat > /dev/null`,
				`echo '${SEARCH_INIT}'`,
				`echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"found"}}}'`,
				`echo '{"type":"result","subtype":"success","is_error":false,"result":"found"}'`
			].join('\n')
		);
		const p = run({ webSearch: true, model: 'opus' });
		const res = await p;
		expect(res.ok).toBe(true);
		expect(p.deltas).toEqual(['found']);
		expect(readFileSync(argvFile, 'utf8')).toBe(chatCliArgs({ webSearch: true, model: 'opus' }).join('\n') + '\n');
	});

	it('an unrequested capability kills the run on the DEFAULT path: the search tool nobody asked for', async () => {
		// The same SEARCH_INIT that a search-on run accepts - reported to a run that
		// requested nothing - is a condemned session: the default path still asserts
		// exactly-empty.
		stubClaude(
			[
				`cat > /dev/null`,
				`echo '${SEARCH_INIT}'`,
				`echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"leak"}}}'`,
				`echo '{"type":"result","subtype":"success","is_error":false,"result":"leak"}'`
			].join('\n')
		);
		const p = run();
		const res = await p;
		expect(res.ok).toBe(false);
		expect(res.failure?.kind).toBe('unsafe_init');
		expect(res.failure?.message).toContain(WEB_SEARCH_TOOL);
		expect(p.deltas).toEqual([]);
	});

	it('an unrequested capability kills the run on the SEARCH path too: one extra tool beside the requested one', async () => {
		const overInit = JSON.stringify({
			type: 'system',
			subtype: 'init',
			tools: ['WebSearch', 'Bash'],
			mcp_servers: [],
			slash_commands: [],
			skills: [],
			claude_code_version: '9.9.9-stub'
		});
		stubClaude(
			[
				`cat > /dev/null`,
				`echo '${overInit}'`,
				`echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"leak"}}}'`,
				`echo '{"type":"result","subtype":"success","is_error":false,"result":"leak"}'`
			].join('\n')
		);
		const p = run({ webSearch: true });
		const res = await p;
		expect(res.ok).toBe(false);
		expect(res.failure?.kind).toBe('unsafe_init');
		expect(res.failure?.message).toContain('Bash');
		expect(p.deltas).toEqual([]);
	});
});

describe('distinct, actionable failure states', () => {
	it('a missing CLI is not_installed', async () => {
		const empty = mkdtempSync(join(tmpdir(), 'cellar-chat-nopath-'));
		const prev = process.env.PATH;
		process.env.PATH = empty;
		try {
			const res = await run();
			expect(res.ok).toBe(false);
			expect(res.failure?.kind).toBe('not_installed');
		} finally {
			process.env.PATH = prev;
			rmSync(empty, { recursive: true, force: true });
		}
	});

	it('an auth failure is not_signed_in', async () => {
		stubClaude(
			[
				`cat > /dev/null`,
				`echo '${SAFE_INIT}'`,
				`echo '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Invalid API key. Please run /login"}'`,
				`exit 1`
			].join('\n')
		);
		const res = await run();
		expect(res.failure?.kind).toBe('not_signed_in');
	});

	it('an exhausted usage window is rate_limited, carrying resetsAt', async () => {
		stubClaude(
			[
				`cat > /dev/null`,
				`echo '${SAFE_INIT}'`,
				`echo '{"type":"rate_limit_event","rate_limit_info":{"status":"exceeded","resetsAt":1900000000,"rateLimitType":"five_hour"}}'`,
				`echo '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"limit reached"}'`,
				`exit 1`
			].join('\n')
		);
		const res = await run();
		expect(res.failure?.kind).toBe('rate_limited');
		expect(res.failure?.resetsAt).toBe(1900000000);
	});

	it('anything else is api_error, with the CLI detail carried', async () => {
		stubClaude(
			[
				`cat > /dev/null`,
				`echo '${SAFE_INIT}'`,
				`echo '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Overloaded: upstream 529"}'`,
				`exit 1`
			].join('\n')
		);
		const res = await run();
		expect(res.failure?.kind).toBe('api_error');
		expect(res.failure?.message).toContain('529');
	});

	it('an abort mid-stream is cancelled', async () => {
		stubClaude(
			[
				`cat > /dev/null`,
				`echo '${SAFE_INIT}'`,
				`echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}}'`,
				`sleep 30`
			].join('\n')
		);
		const ctrl = new AbortController();
		const p = run({ signal: ctrl.signal });
		// Interrupt only once the first delta has really been delivered.
		await waitForDeltas(p);
		ctrl.abort();
		const res = await p;
		expect(res.failure?.kind).toBe('cancelled');
		expect(p.deltas).toEqual(['partial']); // what streamed before the stop is kept
	}, 15_000);

	it('a delta parsed after the run settled reaches nobody', async () => {
		// The force-settle path the module documents: a GRANDCHILD holds stdout open
		// past the kill, so the pipe never closes and the run settles on its own 5s
		// timer - after which `run.ts` has already finished and persisted the
		// accumulator, and a late delta would publish a phantom frame for a cell
		// whose run:end fired.
		//
		// The grandchild is GATED on a file this test creates only once the run has
		// settled, and it touches a second file once it has finished writing - so
		// "after the settle" is established by the test rather than by out-racing a
		// 5s timer on a machine running the whole suite in parallel forks.
		const late = `{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"after-settle"}}}`;
		const go = join(OUT, 'late-go.flag');
		const wrote = join(OUT, 'late-wrote.flag');
		rmSync(go, { force: true });
		rmSync(wrote, { force: true });
		stubClaude(
			[
				`cat > /dev/null`,
				`echo '${SAFE_INIT}'`,
				`echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"before"}}}'`,
				`(while [ ! -f "${go}" ]; do sleep 0.05; done; for i in $(seq 1 20); do echo '${late}'; sleep 0.05; done; touch "${wrote}") &`,
				`sleep 60`
			].join('\n')
		);
		const ctrl = new AbortController();
		const p = run({ signal: ctrl.signal });
		await waitForDeltas(p);
		ctrl.abort();
		const res = await p;
		expect(res.failure?.kind).toBe('cancelled');
		expect(p.deltas).toEqual(['before']); // what streamed before the stop is kept

		// Settled. NOW let the orphaned writer loose, and wait for it to report that
		// every one of its lines is down the pipe we are still holding open.
		writeFileSync(go, '');
		const deadline = Date.now() + 20_000;
		while (!existsSync(wrote)) {
			if (Date.now() > deadline) throw new Error('the orphaned writer never finished');
			await new Promise((r) => setTimeout(r, 50));
		}
		await new Promise((r) => setTimeout(r, 300)); // let any delivery land
		expect(p.deltas).toEqual(['before']);
	}, 40_000);

	it('an abort while QUEUED behind the concurrency cap is honored immediately', async () => {
		// A run waiting for a slot must answer Stop then and there: waiting for
		// another notebook's chat run to end (up to the chat timeout) holds this
		// notebook's kernel queue slot with Stop appearing to do nothing.
		stubClaude([`cat > /dev/null`, `echo '${SAFE_INIT}'`, `sleep 60`].join('\n'));
		const holders = Array.from({ length: CHAT_MAX_CONCURRENT }, () => new AbortController());
		const running = holders.map((c) => run({ signal: c.signal }));
		// Let them all take their slots, so the next run can only be queued.
		await new Promise((r) => setTimeout(r, 300));

		const queued = new AbortController();
		const waiting = run({ signal: queued.signal });
		let settled = false;
		void waiting.then(() => (settled = true));
		await new Promise((r) => setTimeout(r, 200));
		expect(settled).toBe(false); // genuinely queued: no slot was free

		const t0 = Date.now();
		queued.abort();
		const res = await waiting;
		// Answered while the three holders are still running, not after one ends.
		expect(Date.now() - t0).toBeLessThan(3000);
		expect(res.failure?.kind).toBe('cancelled');
		expect(waiting.deltas).toEqual([]); // never spawned, so never billed

		// The aborted waiter took no slot, so the cap is intact: release the
		// holders and a fresh run still gets in.
		for (const c of holders) c.abort();
		await Promise.all(running);
		stubClaude(
			[
				`cat > /dev/null`,
				`echo '${SAFE_INIT}'`,
				`echo '{"type":"result","subtype":"success","is_error":false,"result":"ok"}'`
			].join('\n')
		);
		expect((await run()).ok).toBe(true);
	}, 30_000);

	it('classification itself: the message/info rules', () => {
		expect(classifyChatFailure('x', { status: 'allowed' }).kind).toBe('api_error');
		expect(classifyChatFailure("You've reached your usage limit", null).kind).toBe('rate_limited');
		expect(classifyChatFailure('not logged in', null).kind).toBe('not_signed_in');
		expect(classifyChatFailure('boom', null).kind).toBe('api_error');
	});

	it('the deltas of a healthy run stream in order and the result is ok', async () => {
		stubClaude(
			[
				`cat > /dev/null`,
				`echo '${SAFE_INIT}'`,
				`echo 'stray non-JSON warning line'`,
				`echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello "}}}'`,
				`echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"world"}}}'`,
				`echo '{"type":"result","subtype":"success","is_error":false,"result":"Hello world"}'`
			].join('\n')
		);
		const p = run();
		const res = await p;
		expect(res.ok).toBe(true);
		expect(res.engine).toBe('claude-cli/9.9.9-stub');
		expect(res.replyText).toBe('Hello world');
		expect(p.deltas).toEqual(['Hello ', 'world']);
	});
});
