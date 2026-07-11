/**
 * Cellar — in-app log store.
 *
 * A small, bounded, in-memory ring buffer that captures Cellar's own server-side
 * logging so it can be shown live inside the app (the Logs panel) instead of
 * living only in the terminal that launched `cellar`. This is what turns a failed
 * Databricks connect - whose real cause (bad host, TLS, timeout, auth) is a
 * python traceback the friendly sidebar copy hides - into something the user can
 * actually read without leaving the browser.
 *
 * What it captures (all in the SvelteKit server process, where the kernel bridge,
 * the MCP server, and every metadata subprocess live):
 *   - the process `console.*` output (still printed to the terminal too), and
 *   - explicit `logInfo/logWarn/logError` calls from the kernel bridge, the
 *     Databricks integration, and any subprocess stderr/stdout worth surfacing.
 *
 * Delivery reuses the existing SSE event bus (`events.js` `publishGlobal`): each
 * new entry is broadcast as a `{ type: 'log', entry }` global event, so an open
 * browser reflects it with no polling, and a freshly-opened panel backfills the
 * current buffer over `GET /api/logs`.
 *
 * Entries are scrubbed before they are stored or streamed (memory addresses via
 * `clean.js`, plus obvious credential patterns) so a captured line never leaks a
 * token or password.
 *
 * In-memory only: the buffer does not survive a server restart, which is fine for
 * a live debugging aid (v1).
 */
import { format } from 'node:util';
import { scrubAddresses } from './clean';
import { publishGlobal } from './events';

/** How many recent entries to keep. Old entries fall off the front. */
export const MAX_ENTRIES = 1000;

/** A log severity, as stored on an entry / used for the panel's level filter. */
export type LogLevel = 'info' | 'warn' | 'error';

/** Levels, ordered by severity, for the panel's level filter. */
export const LEVELS: LogLevel[] = ['info', 'warn', 'error'];

/** One recorded log-panel entry. */
export interface LogEntry {
	seq: number;
	ts: number;
	level: LogLevel;
	source: string;
	message: string;
	/** Bumped when an identical line repeats within DEDUPE_WINDOW_MS instead of duplicating. */
	count?: number;
}

const buffer: LogEntry[] = [];
let seq = 0;

/**
 * Coalesce a burst of identical lines: a probe that spews the same warning many
 * times should read as "that warning (xN)", not flood the panel. Only the most
 * recent entry is a candidate, and only within a short window.
 */
const DEDUPE_WINDOW_MS = 1000;

// ---------------------------------------------------------------------------
// Secret scrubbing
// ---------------------------------------------------------------------------

/**
 * Credential patterns to redact before a line is ever stored or streamed. These
 * are best-effort belt-and-braces on top of the fact that Cellar does not log
 * secrets on purpose - a stray token in a subprocess traceback or an echoed env
 * var must not reach the panel.
 */
// Order matters: the token-shaped patterns run BEFORE the key=value collapse, so
// `Authorization: Bearer <tok>` has its credential redacted rather than having the
// key=value rule consume only the scheme word ("Bearer") and leave the token.
const SECRET_PATTERNS: [RegExp, string][] = [
	// `Bearer <credential>` / `token <credential>` in an auth header
	[/\b(Bearer|token)(\s+)([A-Za-z0-9._~+/=-]{8,})/gi, '$1$2***'],
	// Databricks personal access tokens (`dapi…`) and OAuth (`dose…`) wherever they appear
	[/\b(dapi|dose|dkea)[a-z0-9]{6,}\b/gi, '$1***'],
	// AWS-style access key ids
	[/\bAKIA[0-9A-Z]{12,}\b/g, 'AKIA***'],
	// key = value / key: value for obviously sensitive keys (quoted or bare value)
	[/\b(token|password|passwd|pwd|secret|api[_-]?key|access[_-]?key|client[_-]?secret|authorization)\b(\s*[:=]\s*)(["']?)([^\s"',;]+)\3/gi, '$1$2$3***$3']
];

/** Redact obvious credentials from a string. Exported for testing/reuse. */
export function scrubSecrets(text: string): string {
	if (typeof text !== 'string') return text;
	let out = text;
	for (const [re, repl] of SECRET_PATTERNS) out = out.replace(re, repl);
	return out;
}

/** Full scrub applied to every captured message: memory addresses + credentials. */
function scrub(message: string): string {
	return scrubSecrets(scrubAddresses(message));
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/**
 * Record one log entry: scrub it, push it onto the ring buffer (dropping the
 * oldest past the cap), and broadcast it to open browsers over the SSE bus.
 *
 * `level` is one of `LEVELS`; `source` is a short category tag (e.g. `databricks`,
 * `kernel`, `mcp`, `server`). Returns the stored entry.
 */
export function record(level: unknown, source: unknown, message: unknown): LogEntry | null {
	const lvl: LogLevel = (LEVELS as unknown as string[]).includes(level as string) ? (level as LogLevel) : 'info';
	const src = String(source || 'server');
	const msg = scrub(String(message ?? '')).trimEnd();
	if (!msg) return null;

	// Coalesce an immediate repeat of the exact same line into a count on the
	// previous entry rather than storing a duplicate.
	const prev = buffer[buffer.length - 1];
	if (prev && prev.level === lvl && prev.source === src && prev.message === msg && Date.now() - prev.ts < DEDUPE_WINDOW_MS) {
		prev.count = (prev.count ?? 1) + 1;
		prev.ts = Date.now();
		publishGlobal({ type: 'log', entry: prev });
		return prev;
	}

	const entry: LogEntry = { seq: ++seq, ts: Date.now(), level: lvl, source: src, message: msg };
	buffer.push(entry);
	if (buffer.length > MAX_ENTRIES) buffer.shift();
	publishGlobal({ type: 'log', entry });
	return entry;
}

export const logInfo = (source: unknown, message: unknown): LogEntry | null => record('info', source, message);
export const logWarn = (source: unknown, message: unknown): LogEntry | null => record('warn', source, message);
export const logError = (source: unknown, message: unknown): LogEntry | null => record('error', source, message);

/** The current buffer, oldest first — used to backfill a freshly-opened panel. */
export function getLogs(): LogEntry[] {
	return buffer.slice();
}

/** Empty the buffer and tell open panels to clear (the panel's Clear button). */
export function clearLogs(): void {
	buffer.length = 0;
	publishGlobal({ type: 'log:cleared' });
}

// ---------------------------------------------------------------------------
// console.* capture
// ---------------------------------------------------------------------------

let consolePatched = false;
// Reentrancy guard: recording must never trigger another capture (a throw inside
// publish that logged would loop). Records are plain data, but be defensive.
let capturing = false;

/** The console methods captured, and the log level each maps to. */
type ConsoleMethod = 'log' | 'info' | 'debug' | 'warn' | 'error';

const CONSOLE_LEVEL: Record<ConsoleMethod, LogLevel> = {
	log: 'info',
	info: 'info',
	debug: 'info',
	warn: 'warn',
	error: 'error'
};

/**
 * Pull a `[source]` tag off the front of a formatted console line, e.g.
 * `[cellar-mcp] up` → source `cellar-mcp`, message `up`. Falls back to `server`.
 */
function splitSource(text: string): { source: string; message: string } {
	const m = /^\s*\[([a-z0-9:_-]+)\]\s*(.*)$/is.exec(text);
	if (m) return { source: m[1], message: m[2] };
	return { source: 'server', message: text };
}

/**
 * Wrap `console.log/info/warn/error/debug` so every server-side log line is ALSO
 * recorded into the ring buffer, without losing the original terminal output.
 * Idempotent; safe to call once at server boot (`hooks.server.js`).
 */
export function installConsoleCapture(): void {
	if (consolePatched) return;
	consolePatched = true;
	for (const method of Object.keys(CONSOLE_LEVEL) as ConsoleMethod[]) {
		const original = console[method].bind(console);
		console[method] = (...args: unknown[]) => {
			original(...args); // keep the terminal log intact
			if (capturing) return;
			capturing = true;
			try {
				// util.format's own signature is (...args: any[]) - a genuine dynamic
				// boundary, since console methods accept anything.
				const text = format(...(args as any[]));
				const { source, message } = splitSource(text);
				record(CONSOLE_LEVEL[method], source, message);
			} catch {
				// Capturing a log line must never break the log call itself.
			} finally {
				capturing = false;
			}
		};
	}
}
