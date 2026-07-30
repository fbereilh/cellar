/**
 * Cellar — harness (AI coding agent) MCP integration registry.
 *
 * Connecting an agent to Cellar means registering ONE stdio MCP server —
 * `cellar mcp` — in whatever config file that agent reads. The command is the
 * same for every harness; only the FILE and its FORMAT differ, and they differ
 * enough that a user who configured Claude Code has done nothing for Codex:
 *
 *   claude (Claude Code)  <workspace>/.mcp.json           JSON
 *   codex  (OpenAI Codex) <workspace>/.codex/config.toml  TOML
 *
 * That mismatch is the whole reason this module exists: Codex does NOT read
 * `.mcp.json`, so Cellar's zero-config wiring was silently invisible to it.
 *
 * ## The registry IS the extension point
 *
 * Adding a harness is a DATA addition to `HARNESSES` (a name, a label, a
 * workspace-relative config path, and one of the two formats) — never new
 * control flow. Both the first-run prompt and `cellar harness add` iterate the
 * registry, so a new entry reaches both surfaces at once. A harness whose
 * config format is not JSON-`mcpServers` or TOML-`mcp_servers` needs a new
 * writer; that is the one case that is more than data.
 *
 * ## Writes are MERGES, and refuse rather than clobber
 *
 * These files belong to the user: they hold other MCP servers and (for Codex)
 * unrelated settings like `model` or `approval_policy`. So every write MERGES,
 * is idempotent (an already-registered Cellar reports `already` and touches
 * nothing), and — the load-bearing half — **refuses on anything it cannot edit
 * confidently**, returning an actionable `skipped` instead of rewriting the
 * file. A hand-editable config the user must repair is a worse outcome than a
 * one-line manual step.
 *
 * The TOML writer is deliberately TEXT-SURGICAL rather than a parse/serialize
 * round-trip: it rewrites only the `command`/`args` lines inside
 * `[mcp_servers.cellar]` (or appends that table), so comments, key order,
 * spacing and every other setting survive byte-for-byte. A round-trip through
 * a TOML AST would reformat the user's whole file — and would need a
 * dependency this module deliberately does not have (node builtins only, so
 * `bin/cellar.js` can import it exactly like `venv.js`/`runtime.js`; it is in
 * `package.json` `files` for the same reason).
 *
 * ## The running-cellar dependency
 *
 * `cellar mcp` is a BRIDGE, not a standalone server: it attaches to the Cellar
 * instance running in that workspace (see `mcp-bridge.js`). So a configured
 * harness gets Cellar's tools only while `cellar` is running there — which is
 * why every surface here prints that note rather than implying the config alone
 * is enough. The bridge resolves the workspace from its own cwd, which is the
 * project directory an agent launches it in, so no path ever appears in config.
 */
import { join, dirname } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * @typedef {Object} HarnessResult
 * @property {boolean} ok             false only for an unknown harness name
 * @property {string} name
 * @property {'already'|'wrote'|'updated'|'skipped'|'unknown'} status
 * @property {string} message         one line, safe to print verbatim
 * @property {string} [label]
 * @property {string} [file]          absolute path of the config that was read
 * @property {string} [note]          harness-specific caveat (e.g. Codex trust)
 *
 * @typedef {Object} HarnessStateInfo
 * @property {string} name
 * @property {string} label
 * @property {string} file
 * @property {boolean} exists         the config file is on disk at all
 * @property {boolean} present        it names a `cellar` MCP server, somehow
 * @property {boolean} configured     that entry matches what Cellar would write
 * @property {boolean} unreadable     it exists but cannot be edited confidently
 *
 * @typedef {Object} HarnessSetupMarker
 * @property {number} [version]
 * @property {number} [promptedAt]
 * @property {string[]} [configured]
 * @property {string[]} [declined]
 */

/** The MCP server name Cellar registers itself under, in every harness. */
export const SERVER_NAME = 'cellar';
/** The stdio command an agent runs to reach the live instance (never a URL). */
export const SERVER_COMMAND = 'cellar';
/** Args for that command. */
export const SERVER_ARGS = ['mcp'];

/**
 * One-line reminder printed after every successful configure. The config alone
 * is inert: `cellar mcp` bridges to a RUNNING instance, so say so plainly.
 */
export const RUNNING_NOTE =
	'your agent gets Cellar\'s tools while `cellar` is running in this workspace (start it here and leave it running).';

/**
 * Supported harnesses. Data only — see the header: adding one is an entry here.
 *
 * `auto: true` marks a harness Cellar wires up on EVERY launch (today only
 * Claude Code, whose `.mcp.json` write predates this registry and is the
 * documented zero-config behavior). The first-run prompt still offers it, and
 * an explicit decline is honored by the launcher.
 */
export const HARNESSES = [
	{
		name: 'claude',
		label: 'Claude Code',
		configPath: '.mcp.json',
		format: 'json',
		auto: true
	},
	{
		name: 'codex',
		label: 'Codex',
		configPath: join('.codex', 'config.toml'),
		format: 'toml',
		// Codex loads project-scoped config only for a project the user has
		// trusted. Cellar deliberately does NOT write that trust itself: it lives
		// in the user's GLOBAL ~/.codex/config.toml and grants the agent broader
		// sandbox latitude, which is the user's call, not a launcher's side effect.
		note: 'Codex reads project config only for a trusted project - approve this folder when Codex asks.'
	}
];

/** Every supported harness name, in registry order. */
export function harnessNames() {
	return HARNESSES.map((h) => h.name);
}

/** Look up a harness by name (case-insensitive, whitespace-tolerant), or null. */
export function getHarness(name) {
	const want = String(name ?? '')
		.trim()
		.toLowerCase();
	if (!want) return null;
	return HARNESSES.find((h) => h.name === want) ?? null;
}

/** Absolute path of a harness's config file for a workspace. */
export function harnessConfigPath(name, workspace) {
	const h = getHarness(name);
	return h ? join(workspace, h.configPath) : null;
}

// ---- JSON (`.mcp.json`, Claude Code) --------------------------------------

const JSON_ENTRY = { command: SERVER_COMMAND, args: [...SERVER_ARGS] };

function sameJsonEntry(entry) {
	return (
		!!entry &&
		typeof entry === 'object' &&
		entry.command === JSON_ENTRY.command &&
		JSON.stringify(entry.args) === JSON.stringify(JSON_ENTRY.args)
	);
}

/**
 * Inspect a `.mcp.json`-shaped config. Returns
 * `{ present, matches, unreadable }` — `unreadable` means the file exists but
 * is not a JSON object, which must never be overwritten.
 */
function readJsonState(file) {
	if (!existsSync(file)) return { present: false, matches: false, unreadable: false };
	let config;
	try {
		config = JSON.parse(readFileSync(file, 'utf8'));
	} catch {
		return { present: false, matches: false, unreadable: true };
	}
	if (config === null || typeof config !== 'object' || Array.isArray(config)) {
		return { present: false, matches: false, unreadable: true };
	}
	const servers = config.mcpServers && typeof config.mcpServers === 'object' ? config.mcpServers : {};
	const entry = servers[SERVER_NAME];
	return { present: entry !== undefined, matches: sameJsonEntry(entry), unreadable: false, config };
}

function writeJsonConfig(file) {
	const state = readJsonState(file);
	if (state.unreadable) {
		return {
			status: 'skipped',
			message: `${file} is not a JSON object; leaving it untouched (add an "${SERVER_NAME}" entry under "mcpServers" by hand)`
		};
	}
	const config = state.config ?? {};
	const servers = config.mcpServers && typeof config.mcpServers === 'object' ? config.mcpServers : {};
	// Spread first so an existing `cellar` key keeps its POSITION while its value
	// is replaced, and every other server survives untouched.
	config.mcpServers = { ...servers, [SERVER_NAME]: { ...JSON_ENTRY } };
	const next = JSON.stringify(config, null, 2) + '\n';

	if (state.matches) {
		// Idempotent in the strong sense: identical bytes on disk = no write at all.
		try {
			if (readFileSync(file, 'utf8') === next) return { status: 'already', message: 'already configured' };
		} catch {}
	}
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, next);
	return state.present
		? { status: 'updated', message: `updated the ${SERVER_NAME} MCP server` }
		: { status: 'wrote', message: `added the ${SERVER_NAME} MCP server` };
}

// ---- TOML (`.codex/config.toml`, Codex) -----------------------------------

const TOML_TABLE = ['mcp_servers', SERVER_NAME];
const TOML_BLOCK = [
	`[${TOML_TABLE.join('.')}]`,
	`command = "${SERVER_COMMAND}"`,
	`args = [${SERVER_ARGS.map((a) => JSON.stringify(a)).join(', ')}]`
];

/**
 * Walk one line, tracking TOML string state so structural characters inside a
 * string or a comment are never mistaken for syntax.
 *
 * `state` carries an OPEN multi-line string delimiter (`"""` / `'''`) across
 * lines — the reason a naive line scan cannot be trusted: a multi-line string
 * may contain text that looks exactly like a `[table]` header. Returns the
 * index where a real comment starts (or null), the state to carry forward, and
 * `malformed` for an unterminated single-line string (a file we must not edit).
 */
function scanLine(line, state) {
	let i = 0;
	let malformed = false;
	if (state) {
		const idx = line.indexOf(state);
		if (idx === -1) return { commentAt: null, state, malformed };
		i = idx + state.length;
		state = null;
	}
	while (i < line.length) {
		const c = line[i];
		if (c === '#') return { commentAt: i, state, malformed };
		if (c === '"' || c === "'") {
			const triple = line.slice(i, i + 3);
			if (triple === '"""' || triple === "'''") {
				const close = line.indexOf(triple, i + 3);
				if (close === -1) return { commentAt: null, state: triple, malformed };
				i = close + 3;
				continue;
			}
			let j = i + 1;
			let closed = false;
			while (j < line.length) {
				if (c === '"' && line[j] === '\\') {
					j += 2;
					continue;
				}
				if (line[j] === c) {
					closed = true;
					break;
				}
				j++;
			}
			if (!closed) return { commentAt: null, state, malformed: true };
			i = j + 1;
			continue;
		}
		i++;
	}
	return { commentAt: null, state, malformed };
}

/** Strip a quoted TOML key/value token to its text; plain tokens pass through. */
function unquote(tok) {
	const t = tok.trim();
	if (t.length >= 2 && ((t[0] === '"' && t.at(-1) === '"') || (t[0] === "'" && t.at(-1) === "'"))) {
		const inner = t.slice(1, -1);
		return t[0] === '"' ? inner.replace(/\\(.)/g, '$1') : inner;
	}
	return t;
}

/** Split a dotted TOML key path on `.` outside quotes, or null if malformed. */
function splitDotted(text) {
	const parts = [];
	let cur = '';
	let quote = null;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quote) {
			cur += c;
			if (c === '\\' && quote === '"') {
				if (i + 1 < text.length) cur += text[++i];
				continue;
			}
			if (c === quote) quote = null;
			continue;
		}
		if (c === '"' || c === "'") {
			quote = c;
			cur += c;
			continue;
		}
		if (c === '.') {
			parts.push(cur);
			cur = '';
			continue;
		}
		cur += c;
	}
	if (quote) return null;
	parts.push(cur);
	const out = parts.map((p) => unquote(p));
	return out.every((p) => p.length > 0) ? out : null;
}

/**
 * Parse a `[table]` / `[[array.of.tables]]` header from a comment-stripped
 * line. Returns `{ key, isArray }`, null when the line is not a header, or
 * `'malformed'` when it opens like one but does not close cleanly.
 */
function parseTableHeader(code) {
	const t = code.trim();
	if (!t.startsWith('[')) return null;
	const isArray = t.startsWith('[[');
	const open = isArray ? 2 : 1;
	// Find the closing bracket(s) outside any quoted key segment.
	let quote = null;
	let end = -1;
	for (let i = open; i < t.length; i++) {
		const c = t[i];
		if (quote) {
			if (c === '\\' && quote === '"') {
				i++;
				continue;
			}
			if (c === quote) quote = null;
			continue;
		}
		if (c === '"' || c === "'") {
			quote = c;
			continue;
		}
		if (c === ']') {
			end = i;
			break;
		}
	}
	if (end === -1) return 'malformed';
	const close = isArray ? t.slice(end, end + 2) : t.slice(end, end + 1);
	if (close !== (isArray ? ']]' : ']')) return 'malformed';
	if (t.slice(end + close.length).trim() !== '') return 'malformed';
	const key = splitDotted(t.slice(open, end).trim());
	return key ? { key, isArray } : 'malformed';
}

/** Parse a `key = …` / `a.b.c = …` line's key path, or null if it is not one. */
function parseKeyPath(code) {
	let quote = null;
	for (let i = 0; i < code.length; i++) {
		const c = code[i];
		if (quote) {
			if (c === '\\' && quote === '"') {
				i++;
				continue;
			}
			if (c === quote) quote = null;
			continue;
		}
		if (c === '"' || c === "'") {
			quote = c;
			continue;
		}
		if (c === '=') {
			const raw = code.slice(0, i).trim();
			return raw ? splitDotted(raw) : null;
		}
	}
	return null;
}

/**
 * Structural scan of a TOML document: every table span and every key line, with
 * the table each key belongs to. `malformed` means we could not read it with
 * confidence, and the caller must refuse to edit rather than guess.
 */
function parseTomlDoc(text) {
	const lines = text.split('\n');
	const tables = [];
	const keys = [];
	let state = null;
	let malformed = false;
	let current = { key: [], isArray: false, start: 0, end: lines.length };
	for (let i = 0; i < lines.length; i++) {
		const r = scanLine(lines[i], state);
		if (r.malformed) malformed = true;
		const wasOpen = state !== null;
		state = r.state;
		// A line that continues — or closes — an open multi-line string carries no
		// structure we need: a table header is never legal there, and the tail after
		// a closing delimiter can only finish a value. Skip it conservatively.
		if (wasOpen) continue;
		const code = r.commentAt == null ? lines[i] : lines[i].slice(0, r.commentAt);
		if (code.trim() === '') continue;
		const hdr = parseTableHeader(code);
		if (hdr === 'malformed') {
			malformed = true;
			continue;
		}
		if (hdr) {
			current.end = i;
			tables.push(current);
			current = { key: hdr.key, isArray: hdr.isArray, start: i, end: lines.length };
			continue;
		}
		const path = parseKeyPath(code);
		if (path) keys.push({ table: current.key, path, line: i });
	}
	tables.push(current);
	if (state) malformed = true; // unterminated multi-line string
	return { lines, tables, keys, malformed };
}

const samePath = (a, b) => a.length === b.length && a.every((s, i) => s === b[i]);

/** Parse a bracketed TOML array of strings, or null when it is anything else. */
function parseStringArray(text) {
	const t = text.trim();
	if (!t.startsWith('[') || !t.endsWith(']')) return null;
	const inner = t.slice(1, -1).trim();
	if (inner === '') return [];
	const out = [];
	for (const part of inner.split(',')) {
		const p = part.trim();
		if (p === '') continue;
		if (!/^(".*"|'.*')$/s.test(p)) return null;
		out.push(unquote(p));
	}
	return out;
}

/**
 * Read a `key = value` assignment out of a table's line span, joining a value
 * whose brackets continue onto later lines (`args = [\n "mcp"\n]`).
 */
function readAssignment(lines, start, end, key) {
	for (let i = start; i < end; i++) {
		const r = scanLine(lines[i], null);
		const code = r.commentAt == null ? lines[i] : lines[i].slice(0, r.commentAt);
		const path = parseKeyPath(code);
		if (!path || path.length !== 1 || path[0] !== key) continue;
		let value = code.slice(code.indexOf('=') + 1);
		let depth = (value.match(/\[/g) ?? []).length - (value.match(/\]/g) ?? []).length;
		let last = i;
		while (depth > 0 && last + 1 < end) {
			last++;
			const rr = scanLine(lines[last], null);
			const more = rr.commentAt == null ? lines[last] : lines[last].slice(0, rr.commentAt);
			value += '\n' + more;
			depth += (more.match(/\[/g) ?? []).length - (more.match(/\]/g) ?? []).length;
		}
		return { first: i, last, value: value.trim() };
	}
	return null;
}

/**
 * Classify what a Codex config already says about the cellar MCP server:
 *   absent      — nothing; append the canonical table
 *   table       — the canonical `[mcp_servers.cellar]` table (editable in place)
 *   other-form  — defined some other legal way (inline table, dotted key); we
 *                 detect it so we never write a DUPLICATE, but refuse to edit it
 *   malformed   — unreadable with confidence; refuse
 */
function codexState(text) {
	const doc = parseTomlDoc(text);
	if (doc.malformed) return { kind: 'malformed', doc };
	const table = doc.tables.find((t) => !t.isArray && samePath(t.key, TOML_TABLE));
	if (table) return { kind: 'table', doc, table };
	for (const k of doc.keys) {
		const full = [...k.table, ...k.path];
		if (full.length >= TOML_TABLE.length && samePath(full.slice(0, TOML_TABLE.length), TOML_TABLE)) {
			return { kind: 'other-form', doc, line: k.line };
		}
	}
	return { kind: 'absent', doc };
}

/** True when the canonical table already says exactly what Cellar would write. */
function tableMatches(doc, table) {
	const cmd = readAssignment(doc.lines, table.start + 1, table.end, 'command');
	const args = readAssignment(doc.lines, table.start + 1, table.end, 'args');
	if (!cmd || !args) return false;
	if (unquote(cmd.value) !== SERVER_COMMAND) return false;
	const parsed = parseStringArray(args.value);
	return !!parsed && JSON.stringify(parsed) === JSON.stringify(SERVER_ARGS);
}

/** Rewrite `command`/`args` inside the existing table, leaving all else intact. */
function rewriteTable(doc, table) {
	const lines = [...doc.lines];
	// Replace from the bottom up so an earlier edit cannot shift a later index.
	const edits = [];
	for (const [key, text] of [
		['command', `command = "${SERVER_COMMAND}"`],
		['args', `args = [${SERVER_ARGS.map((a) => JSON.stringify(a)).join(', ')}]`]
	]) {
		const found = readAssignment(doc.lines, table.start + 1, table.end, key);
		edits.push({ key, text, found });
	}
	for (const e of [...edits].sort((a, b) => (b.found?.first ?? -1) - (a.found?.first ?? -1))) {
		if (e.found) lines.splice(e.found.first, e.found.last - e.found.first + 1, e.text);
	}
	// A table missing a key entirely (hand-written, or Cellar's shape changed):
	// insert right after the header so the table stays self-describing.
	const missing = edits.filter((e) => !e.found).map((e) => e.text);
	if (missing.length) lines.splice(table.start + 1, 0, ...missing);
	return lines.join('\n');
}

/** Append the canonical table, separated by exactly one blank line. */
function appendTable(text) {
	let body = text;
	if (body !== '' && !body.endsWith('\n')) body += '\n';
	if (body.trim() !== '' && !body.endsWith('\n\n')) body += '\n';
	return body + TOML_BLOCK.join('\n') + '\n';
}

function writeTomlConfig(file) {
	const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
	const state = codexState(existing);

	if (state.kind === 'malformed') {
		return {
			status: 'skipped',
			message: `${file} could not be read as TOML with confidence; leaving it untouched (add a [${TOML_TABLE.join('.')}] table by hand)`
		};
	}
	if (state.kind === 'other-form') {
		return {
			status: 'skipped',
			message: `${file} already defines ${TOML_TABLE.join('.')} in another form (line ${state.line + 1}); leaving it untouched so nothing is duplicated`
		};
	}

	let next;
	let status;
	if (state.kind === 'table') {
		if (tableMatches(state.doc, state.table)) return { status: 'already', message: 'already configured' };
		next = rewriteTable(state.doc, state.table);
		status = 'updated';
	} else {
		next = appendTable(existing);
		status = 'wrote';
	}
	if (next === existing) return { status: 'already', message: 'already configured' };
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, next);
	return {
		status,
		message:
			status === 'updated' ? `updated [${TOML_TABLE.join('.')}]` : `added [${TOML_TABLE.join('.')}]`
	};
}

// ---- Public API -----------------------------------------------------------

/**
 * Is this harness already pointed at Cellar? Reports `present` (an entry named
 * `cellar` exists at all) separately from `configured` (it matches what Cellar
 * would write), so a stale entry is distinguishable from a correct one.
 *
 * @param {string} name
 * @param {string} workspace
 * @returns {HarnessStateInfo | null} null for an unknown harness name
 */
export function harnessState(name, workspace) {
	const h = getHarness(name);
	if (!h) return null;
	const file = join(workspace, h.configPath);
	if (h.format === 'json') {
		const s = readJsonState(file);
		return { name: h.name, label: h.label, file, exists: existsSync(file), present: s.present, configured: s.matches, unreadable: s.unreadable };
	}
	const exists = existsSync(file);
	const state = codexState(exists ? readFileSync(file, 'utf8') : '');
	const configured = state.kind === 'table' && tableMatches(state.doc, state.table);
	return {
		name: h.name,
		label: h.label,
		file,
		exists,
		present: state.kind === 'table' || state.kind === 'other-form',
		configured,
		unreadable: state.kind === 'malformed'
	};
}

/**
 * `harnessState` for every registered harness, in registry order.
 *
 * @param {string} workspace
 * @returns {HarnessStateInfo[]}
 */
export function harnessStates(workspace) {
	return HARNESSES.map((h) => /** @type {HarnessStateInfo} */ (harnessState(h.name, workspace)));
}

/**
 * Register Cellar's MCP server for `name` in `workspace`. Idempotent and
 * non-destructive (see the header). Returns
 * `{ ok, name, label, file, status, message, note }` where `status` is one of
 * `already` | `wrote` | `updated` | `skipped`, and `ok` is false only for an
 * unknown harness.
 *
 * @param {string} name
 * @param {string} workspace
 * @returns {HarnessResult}
 */
export function configureHarness(name, workspace) {
	const h = getHarness(name);
	if (!h) {
		return {
			ok: false,
			name: String(name ?? ''),
			status: 'unknown',
			message: `unknown harness "${name}" (supported: ${harnessNames().join(', ')})`
		};
	}
	const file = join(workspace, h.configPath);
	const result = h.format === 'json' ? writeJsonConfig(file) : writeTomlConfig(file);
	return { ok: true, name: h.name, label: h.label, file, note: h.note, ...result };
}

// ---- First-run marker -----------------------------------------------------

/**
 * Per-workspace record of the first-run harness question, so it is asked ONCE.
 *
 * It lives in `.cellar/` (gitignored, per-project, port-independent) beside the
 * other durable local state (`checkpoints.json`, the UI store) — NOT in
 * `runtime.json`, which the launcher deletes on shutdown, and not globally,
 * because harness wiring is per-project: a fresh clone should be asked.
 */
export function harnessMarkerPath(workspace) {
	return join(workspace, '.cellar', 'harness.json');
}

/**
 * Read the marker, or null when absent/unreadable (→ treated as unasked).
 *
 * @param {string} workspace
 * @returns {HarnessSetupMarker | null}
 */
export function readHarnessSetup(workspace) {
	const file = harnessMarkerPath(workspace);
	if (!existsSync(file)) return null;
	try {
		const data = JSON.parse(readFileSync(file, 'utf8'));
		if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
		return data;
	} catch {
		return null;
	}
}

/**
 * Record the answer. `configured` are the harnesses the user chose; `declined`
 * are the ones they were offered and did not — an explicit "no" the launcher
 * honors for the auto-configured harness, so the prompt cannot be contradicted
 * one step later by the automatic `.mcp.json` write.
 *
 * @param {string} workspace
 * @param {{ configured?: string[], declined?: string[] }} [answer]
 */
export function writeHarnessSetup(workspace, { configured = [], declined = [] } = {}) {
	const file = harnessMarkerPath(workspace);
	mkdirSync(dirname(file), { recursive: true });
	const data = { version: 1, promptedAt: Date.now(), configured, declined };
	writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
	return data;
}

/** Has the first-run harness question already been asked in this workspace? */
export function harnessSetupDone(workspace) {
	const m = readHarnessSetup(workspace);
	return !!m && typeof m.promptedAt === 'number';
}

/** Did the user explicitly decline this harness when asked? */
export function harnessDeclined(name, workspace) {
	const h = getHarness(name);
	if (!h) return false;
	const m = readHarnessSetup(workspace);
	return Array.isArray(m?.declined) && m.declined.includes(h.name);
}

/**
 * Should the launcher ask the first-run harness question? Pure decision, kept
 * here rather than inline in `bin/cellar.js` so each rule is directly testable:
 * asking twice, or asking a script, are both regressions with no visible
 * symptom in a normal interactive run.
 *
 * Returns `{ prompt, reason, offered, record }`, where `record` says whether the
 * caller should still write the marker — true for `all-configured` (nothing to
 * ask, and we should not re-check every launch) and deliberately FALSE for
 * `non-interactive`: a `-y`/CI/piped launch has answered nothing, so a human
 * running `cellar` here later must still be asked.
 *
 * @param {string} workspace
 * @param {{ interactive?: boolean }} [opts]
 * @returns {{ prompt: boolean, reason: 'already-asked'|'all-configured'|'non-interactive'|'ask',
 *            offered: string[], record: boolean, states?: HarnessStateInfo[] }}
 */
export function shouldPromptHarnessSetup(workspace, { interactive = true } = {}) {
	const offered = harnessNames();
	if (harnessSetupDone(workspace)) return { prompt: false, reason: 'already-asked', offered, record: false };
	const states = harnessStates(workspace);
	if (states.every((s) => s.configured)) {
		return { prompt: false, reason: 'all-configured', offered, record: true, states };
	}
	if (!interactive) return { prompt: false, reason: 'non-interactive', offered, record: false };
	return { prompt: true, reason: 'ask', offered, record: true, states };
}

/**
 * Resolve a free-text answer to the first-run prompt against the offered
 * harnesses. Accepts 1-based numbers, names (case-insensitive), `all`, and any
 * comma/space mix; an empty answer or a no/none/skip token means skip. Unknown
 * tokens come back in `unknown` so the caller can say so instead of silently
 * dropping them.
 *
 * @param {string} answer
 * @param {string[]} [offered]
 * @returns {{ chosen: string[], unknown: string[], skipped: boolean }}
 */
export function parseHarnessAnswer(answer, offered = harnessNames()) {
	const raw = String(answer ?? '').trim();
	if (raw === '') return { chosen: [], unknown: [], skipped: true };
	const tokens = raw
		.split(/[\s,]+/)
		.map((t) => t.trim().toLowerCase())
		.filter(Boolean);
	if (tokens.some((t) => t === 'all' || t === 'a' || t === '*')) return { chosen: [...offered], unknown: [], skipped: false };
	if (tokens.length === 1 && ['n', 'no', 'none', 'skip', 's', 'q'].includes(tokens[0])) {
		return { chosen: [], unknown: [], skipped: true };
	}
	const chosen = [];
	const unknown = [];
	for (const t of tokens) {
		if (/^\d+$/.test(t)) {
			const idx = Number(t) - 1;
			if (idx >= 0 && idx < offered.length) {
				if (!chosen.includes(offered[idx])) chosen.push(offered[idx]);
				continue;
			}
			unknown.push(t);
			continue;
		}
		const h = getHarness(t);
		if (h && offered.includes(h.name)) {
			if (!chosen.includes(h.name)) chosen.push(h.name);
			continue;
		}
		unknown.push(t);
	}
	return { chosen, unknown, skipped: chosen.length === 0 };
}
