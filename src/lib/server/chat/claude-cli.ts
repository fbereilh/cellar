/**
 * Cellar - the claude CLI chat engine (the one ChatEngine implementation).
 *
 * ## The frozen flag set is the safety boundary - treat it like the sandbox
 * ## attribute in HtmlPreview: one word wide, pinned by a unit test.
 *
 * `chatCliArgs()` disables every capability except "answer this text":
 * `--tools ""` (no tools), `--disable-slash-commands`, `--setting-sources ""`
 * (the user's/project's CLAUDE.md, settings.json hooks, allowedTools etc. are
 * never loaded), `--strict-mcp-config` with no MCP config (no MCP servers),
 * `--no-session-persistence` (nothing written into the slot's history). The CLI
 * is spawned with the scrubbed env (`chatChildEnv`) and a NEUTRAL cwd
 * (`os.tmpdir()`), so no project directory can contribute context. And the
 * permissions-bypass flag (the "dangerously skip" one) is never passed - with
 * tools off there is nothing to skip, and the literal appearing ANYWHERE in
 * this module (this comment included) is a test failure.
 *
 * ## The init assertion (fail closed)
 *
 * Flags are a REQUEST; the CLI's own `system/init` event is the REPORT of what
 * the session actually got. Every run asserts that report - `tools`,
 * `mcp_servers` and `slash_commands` all present and empty (`skills` empty when
 * present) - and a violation KILLS the child and fails the run `unsafe_init`
 * rather than rendering a reply produced by a session with capabilities. A
 * future CLI version that renames those fields fails closed too: "cannot
 * verify" is not "safe".
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
import { chatChildEnv, CLAUDE_BIN } from './env';
import type { ChatEngine, ChatEngineFailure, ChatEngineResult, ChatEngineRunArgs } from './engine';

/** The model chat cells use (a settled decision, not yet a setting). */
export const CHAT_MODEL = 'sonnet';

/**
 * The fixed system prompt. FROZEN deliberately: it is part of the cached prompt
 * prefix (see transcript.ts's byte-stability rule), so nothing time-varying or
 * per-run may be interpolated into it.
 */
export const CHAT_SYSTEM_PROMPT = [
	'You are the AI assistant inside Cellar, a data notebook. The user message is',
	'the notebook so far, rendered as labelled blocks: [cell <id> · <kind>] holds',
	"a cell's source, [cell <id> · output] its result, [cell <id> · reply] an",
	'earlier answer of yours, and [question] is what to answer now. Answer in',
	'concise markdown. You have no tools and cannot run code, read files, or',
	'browse - never claim to have done so; when the notebook lacks what you would',
	'need, say what to run.'
].join(' ');

/**
 * The frozen argv (everything but the binary). A FUNCTION returning a fresh
 * array so no caller can mutate the shared safety boundary; the unit test pins
 * the exact contents.
 */
export function chatCliArgs(): string[] {
	return [
		'-p',
		'--tools',
		'',
		'--disable-slash-commands',
		'--setting-sources',
		'',
		'--strict-mcp-config',
		'--no-session-persistence',
		'--model',
		CHAT_MODEL,
		'--include-partial-messages',
		'--output-format',
		'stream-json',
		'--verbose',
		'--system-prompt',
		CHAT_SYSTEM_PROMPT
	];
}

/** How many chat children may run at once, across all notebooks. */
const MAX_CONCURRENT = 3;

/** Wall-clock bound on one run (a reply, not a batch job). */
function chatTimeoutMs(): number {
	const raw = Number(process.env.CELLAR_CHAT_TIMEOUT_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : 300_000;
}

// -- tiny FIFO semaphore ------------------------------------------------------
let inFlight = 0;
const waiters: Array<() => void> = [];
function acquire(): Promise<void> {
	if (inFlight < MAX_CONCURRENT) {
		inFlight++;
		return Promise.resolve();
	}
	return new Promise((resolve) => waiters.push(() => resolve()));
}
function release(): void {
	const next = waiters.shift();
	if (next) next();
	else inFlight--;
}

// -- init assertion -----------------------------------------------------------

/**
 * Why an init report is unsafe/unverifiable, or null when it proves a bare
 * session. Exported for the unit test (fail-closed in BOTH directions).
 */
export function initViolation(init: Record<string, unknown>): string | null {
	for (const key of ['tools', 'mcp_servers', 'slash_commands'] as const) {
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
		await acquire();
		try {
			return await runOnce(args);
		} finally {
			release();
		}
	}
};

function runOnce({ prompt, configDir, signal, onDelta }: ChatEngineRunArgs): Promise<ChatEngineResult> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve(fail({ kind: 'cancelled', message: 'interrupted' }, null));
			return;
		}

		let child: ChildProcess;
		try {
			child = spawn(CLAUDE_BIN, chatCliArgs(), {
				env: chatChildEnv(configDir),
				cwd: tmpdir(),
				stdio: ['pipe', 'pipe', 'pipe']
			});
		} catch (err) {
			resolve(spawnFailure(err));
			return;
		}

		let engine: string | null = null;
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
			resolve(value);
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
					if (typeof e.claude_code_version === 'string' && e.claude_code_version) {
						engine = `claude-cli/${e.claude_code_version}`;
					}
					const violation = initViolation(e);
					if (violation) {
						unsafe = violation;
						kill(); // fail closed: never render a reply from a capable session
					}
					return;
				}
				case 'stream_event': {
					if (unsafe) return; // nothing from a condemned session reaches the cell
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
