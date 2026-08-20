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
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	chatCliArgs,
	chatSystemPrompt,
	chatToolAllowlist,
	classifyChatFailure,
	claudeCliEngine,
	initViolation,
	CHAT_MAX_CONCURRENT,
	CHAT_SYSTEM_PROMPT,
	CHAT_SYSTEM_PROMPT_WEB_SEARCH,
	WEB_SEARCH_TOOL
} from '../../src/lib/server/chat/claude-cli';
import { CHAT_MODEL_DEFAULT, normalizeChatModel } from '../../src/lib/chatCell';
import { chatChildEnv, isChatSensitiveEnv } from '../../src/lib/server/chat/env';
import type { ChatEngineResult } from '../../src/lib/server/chat/engine';

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

/** Install a stub `claude` whose body is `script` (sh). */
function stubClaude(script: string) {
	writeFileSync(join(BIN, 'claude'), `#!/bin/sh\n${script}\n`);
	chmodSync(join(BIN, 'claude'), 0o755);
}

function run(
	overrides: { configDir?: string | null; signal?: AbortSignal; model?: string; webSearch?: boolean } = {}
): Promise<ChatEngineResult> & { deltas: string[] } {
	const deltas: string[] = [];
	const p = claudeCliEngine.run({
		prompt: 'hello transcript\n',
		configDir: overrides.configDir ?? null,
		model: overrides.model,
		webSearch: overrides.webSearch,
		signal: overrides.signal ?? new AbortController().signal,
		onDelta: (t) => deltas.push(t)
	}) as Promise<ChatEngineResult> & { deltas: string[] };
	p.deltas = deltas;
	return p;
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
		expect(chatSystemPrompt(false)).toBe(CHAT_SYSTEM_PROMPT);
		expect(chatSystemPrompt(true)).toBe(CHAT_SYSTEM_PROMPT_WEB_SEARCH);
		// One rule for request and assertion: the argv's tools value IS the allowlist.
		expect(chatToolAllowlist(false)).toEqual([]);
		expect(chatToolAllowlist(true)).toEqual([WEB_SEARCH_TOOL]);
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
		const allow = chatToolAllowlist(true);
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
		// Give the child a beat to emit the first delta, then interrupt.
		await new Promise((r) => setTimeout(r, 400));
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
		await new Promise((r) => setTimeout(r, 400));
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
