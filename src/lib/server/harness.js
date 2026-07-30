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
 * nothing), is ATOMIC (`writeFileAtomic` - a crash mid-write must not truncate
 * a config), and - the load-bearing half - **refuses on anything it cannot edit
 * confidently**, returning an actionable `skipped` instead of rewriting the
 * file. A hand-editable config the user must repair is a worse outcome than a
 * one-line manual step.
 *
 * MERGE reaches INSIDE the cellar entry too, in both writers: Cellar owns
 * `command`/`args` and nothing else, so a key the user added beside them (`env`,
 * `type`, `cwd`) survives. And idempotence is decided on MEANING, never on our
 * re-serialized bytes matching the user's formatting - otherwise a correct config
 * indented differently would be reported `updated` and rewritten every launch.
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
 * Being text-surgical means the scanner IS the safety property: it has to know
 * what is structure and what is a value, in both directions - an open
 * multi-line string AND an open bracket (see `parseTomlDoc`). Every structural
 * decision reads a string-masked copy of the line, never the raw text, because
 * getting this wrong does not surface as a parse error; it surfaces as a config
 * that quietly lost a key, gained a duplicate one, or had text rewritten inside
 * the user's own string while the real key kept its stale value.
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
import { join, dirname, basename } from 'node:path';
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { randomBytes } from 'node:crypto';

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

/**
 * Replace a config file's contents atomically: a unique temp in the TARGET's own
 * directory (a cross-device `/tmp` rename is not atomic), fsync, then rename over
 * the target. These files are the user's - they hold other MCP servers, `model`,
 * `approval_policy` - so a crash / full disk mid-write must never leave a
 * truncated one behind: a reader sees the complete old bytes or the complete new
 * ones. On any failure the temp is removed and the original is untouched, which
 * is the same never-clobber contract the successful path keeps.
 *
 * Deliberately a few lines of `node:fs` rather than `atomic-write.ts`: this
 * module is node-builtins-only so `bin/cellar.js` can import it (see the header).
 */
function writeFileAtomic(file, text) {
	const dir = dirname(file);
	mkdirSync(dir, { recursive: true });
	const tmp = join(dir, `.${basename(file)}.cellar-${process.pid}-${randomBytes(6).toString('hex')}.tmp`);
	try {
		const fd = openSync(tmp, 'wx');
		try {
			writeFileSync(fd, text);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(tmp, file);
	} catch (err) {
		try {
			rmSync(tmp, { force: true });
		} catch {}
		throw err;
	}
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
	if (state.matches) {
		// Idempotent in the strong sense: the entry already says what Cellar would
		// write, so there is nothing to merge and NOTHING is written - whatever the
		// file's own formatting. Deciding this by comparing our re-serialized bytes
		// against the user's would report `updated` (and rewrite the file) on every
		// single launch for anyone whose config is indented differently.
		return { status: 'already', message: 'already configured' };
	}
	const config = state.config ?? {};
	const servers = config.mcpServers && typeof config.mcpServers === 'object' ? config.mcpServers : {};
	const existing = servers[SERVER_NAME];
	// Merge, like the TOML writer: `command`/`args` are Cellar's, every other key the
	// user put on this entry (`env`, `type`, `cwd`) survives. Spreading `servers`
	// first also keeps an existing `cellar` key in its POSITION, and every other
	// server untouched. `existing` is spread only when it is a plain object - a
	// string would spread into character-indexed keys.
	const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
	config.mcpServers = { ...servers, [SERVER_NAME]: { ...base, ...JSON_ENTRY } };
	writeFileAtomic(file, JSON.stringify(config, null, 2) + '\n');
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
 * index where a real comment starts (or null), the state to carry forward,
 * `malformed` for an unterminated single-line string (a file we must not edit),
 * and `masked`.
 *
 * `masked` is the same line with every string span AND the comment blanked to
 * spaces, same length, so an index into one indexes the other. It is what makes
 * "is this character structure?" answerable by a plain scan: every structural
 * decision downstream (a `[`/`]` depth count, the `=` that opens a value) reads
 * `masked`, never the raw text - counting a `[` that lives inside a string is
 * exactly how a value's span used to run away and swallow the keys after it.
 */
function scanLine(line, state) {
	let i = 0;
	// Code UNITS, not code points: every index here comes from `indexOf`/a `[i]`
	// walk over `line`, so a surrogate pair must not shift `masked` out of step.
	const chars = line.split('');
	const blank = (from, to) => {
		for (let k = Math.max(0, from); k < to && k < chars.length; k++) chars[k] = ' ';
	};
	const out = (commentAt, nextState, malformed) => ({
		commentAt,
		state: nextState,
		malformed,
		masked: chars.join('')
	});
	if (state) {
		const idx = line.indexOf(state);
		if (idx === -1) {
			blank(0, line.length);
			return out(null, state, false);
		}
		blank(0, idx + state.length);
		i = idx + state.length;
		state = null;
	}
	while (i < line.length) {
		const c = line[i];
		if (c === '#') {
			blank(i, line.length);
			return out(i, state, false);
		}
		if (c === '"' || c === "'") {
			const triple = line.slice(i, i + 3);
			if (triple === '"""' || triple === "'''") {
				const close = line.indexOf(triple, i + 3);
				if (close === -1) {
					blank(i, line.length);
					return out(null, triple, false);
				}
				blank(i, close + 3);
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
			if (!closed) {
				blank(i, line.length);
				return out(null, state, true);
			}
			blank(i, j + 1);
			i = j + 1;
			continue;
		}
		i++;
	}
	return out(null, state, false);
}

/** Net `[` minus `]` over already-masked code - structure only, never a string. */
function bracketDelta(masked) {
	let d = 0;
	for (const c of masked) {
		if (c === '[') d++;
		else if (c === ']') d--;
	}
	return d;
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
 * Structural scan of a TOML document: every table span, and every key with the
 * table it belongs to AND the span of its value. `malformed` means we could not
 * read it with confidence, and the caller must refuse to edit rather than guess.
 *
 * The scan is the ONE place that decides what is structure and what is a value,
 * and it must track BOTH kinds of continuation to do so - an open multi-line
 * string, and an open bracket. Anything inside either is data: `[1, 2]` as an
 * element of a multi-line array is not a table header, and a `command = "…"` line
 * inside a `"""…"""` block is not an assignment. Reading those as structure is
 * not a cosmetic mistake - it truncated the enclosing table's span (so a key that
 * IS present read as missing and got inserted a second time, i.e. invalid TOML)
 * and it aimed a rewrite at text inside the user's own string while leaving the
 * real key untouched. So a key is recorded with `valueFrom`/`last` here, once,
 * rather than re-scanned later by whoever wants to read it.
 */
function parseTomlDoc(text) {
	const lines = text.split('\n');
	const codes = [];
	const tables = [];
	const keys = [];
	let state = null;
	let malformed = false;
	let depth = 0;
	/** The key whose value is still open across lines; its `last` closes it. */
	let pending = null;
	let current = { key: [], isArray: false, start: 0, end: lines.length };
	for (let i = 0; i < lines.length; i++) {
		const r = scanLine(lines[i], state);
		if (r.malformed) malformed = true;
		const wasOpen = state !== null;
		state = r.state;
		const code = r.commentAt == null ? lines[i] : lines[i].slice(0, r.commentAt);
		const maskedCode = r.commentAt == null ? r.masked : r.masked.slice(0, r.commentAt);
		codes.push(code);
		// Was this line's start already inside a multi-line value? Decide BEFORE
		// folding this line's own brackets in, or a value's closing line would look
		// like structure.
		const inValue = depth > 0;
		depth += bracketDelta(maskedCode);
		if (depth < 0) {
			// More `]` than `[`: we are not reading this file correctly.
			malformed = true;
			depth = 0;
		}
		// A value is closed once neither kind of continuation is open - a bracket
		// depth back at 0 AND no multi-line string still running.
		if (pending && depth === 0 && state === null) {
			pending.last = i;
			pending = null;
		}
		// A line that continues — or closes — an open multi-line string carries no
		// structure we need: a table header is never legal there, and the tail after
		// a closing delimiter can only finish a value. Skip it conservatively.
		if (wasOpen || inValue) continue;
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
		if (path) {
			// The `=` is located on the MASKED line, so a quoted key containing one
			// (`"a=b" = 1`) cannot be mistaken for the assignment.
			const eq = maskedCode.indexOf('=');
			const entry = { table: current.key, path, line: i, valueFrom: eq + 1, last: i };
			keys.push(entry);
			if (depth > 0 || state) pending = entry;
		}
	}
	tables.push(current);
	// An unterminated multi-line string, or a value whose brackets never closed:
	// either way the tail of this file is not what we think it is.
	if (state || depth !== 0 || pending) malformed = true;
	return { lines, codes, tables, keys, malformed };
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
 * Read a `key = value` assignment out of a table, using the span `parseTomlDoc`
 * already resolved (so a value continuing onto later lines - `args = [\n "mcp"\n]`
 * - is joined, and text that merely LOOKS like this key inside a multi-line
 * string is not a candidate at all: it was never recorded as a key).
 */
function readAssignment(doc, table, key) {
	const entry = doc.keys.find(
		(k) =>
			k.line > table.start &&
			k.line < table.end &&
			samePath(k.table, table.key) &&
			k.path.length === 1 &&
			k.path[0] === key
	);
	if (!entry) return null;
	let value = doc.codes[entry.line].slice(entry.valueFrom);
	for (let i = entry.line + 1; i <= entry.last; i++) value += '\n' + doc.codes[i];
	return { first: entry.line, last: entry.last, value: value.trim() };
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
		// Either this key IS (or is under) `mcp_servers.cellar` - an inline table or a
		// dotted key - or it is a PREFIX of it, i.e. `mcp_servers` itself assigned as a
		// value (`mcp_servers = { cellar = … }`). The prefix case has to refuse too:
		// TOML forbids extending an inline table, so appending `[mcp_servers.cellar]`
		// under it would leave the whole file unparseable, taking every other setting
		// and every other MCP server down with it.
		const shared = Math.min(full.length, TOML_TABLE.length);
		if (samePath(full.slice(0, shared), TOML_TABLE.slice(0, shared))) {
			return { kind: 'other-form', doc, line: k.line };
		}
	}
	return { kind: 'absent', doc };
}

/** True when the canonical table already says exactly what Cellar would write. */
function tableMatches(doc, table) {
	const cmd = readAssignment(doc, table, 'command');
	const args = readAssignment(doc, table, 'args');
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
		const found = readAssignment(doc, table, key);
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
	writeFileAtomic(file, next);
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
 * is the narrow thing it says it is - a harness the user was offered as NOT yet
 * configured and explicitly skipped. The launcher honors that for the
 * auto-configured harness, so the prompt cannot be contradicted one step later
 * by the automatic `.mcp.json` write.
 *
 * `declined` is deliberately NOT "everything not chosen": a harness that was
 * ALREADY configured must never land here (declining it would switch off the
 * per-launch write that repairs a stale entry, over a choice the user never
 * made), and an answer nobody understood is not an answer at all - the caller
 * records nothing in that case, so the next interactive launch asks again.
 *
 * @param {string} workspace
 * @param {{ configured?: string[], declined?: string[], promptedAt?: number }} [answer]
 */
export function writeHarnessSetup(workspace, { configured = [], declined = [], promptedAt } = {}) {
	const file = harnessMarkerPath(workspace);
	const data = {
		version: 1,
		promptedAt: typeof promptedAt === 'number' ? promptedAt : Date.now(),
		configured,
		declined
	};
	writeFileAtomic(file, JSON.stringify(data, null, 2) + '\n');
	return data;
}

/**
 * Retract a recorded decline for one harness - what makes the advice printed
 * beside the skipped `.mcp.json` write ("`cellar harness add claude` to enable")
 * TRUE. Without it the decline was permanent: the automatic write stayed off and
 * the launcher kept claiming a decline on every launch, over a config the user
 * had since asked for by hand, with no remedy short of deleting the marker.
 *
 * Keeps the original `promptedAt`, so the question still counts as asked.
 *
 * @param {string} name
 * @param {string} workspace
 * @returns {boolean} true when a decline was actually retracted
 */
export function clearHarnessDecline(name, workspace) {
	const h = getHarness(name);
	if (!h) return false;
	const marker = readHarnessSetup(workspace);
	const declined = Array.isArray(marker?.declined) ? marker.declined : [];
	if (!declined.includes(h.name)) return false;
	const configured = Array.isArray(marker?.configured) ? marker.configured : [];
	writeHarnessSetup(workspace, {
		configured: configured.includes(h.name) ? configured : [...configured, h.name],
		declined: declined.filter((n) => n !== h.name),
		promptedAt: typeof marker?.promptedAt === 'number' ? marker.promptedAt : undefined
	});
	return true;
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
 * `exclude` drops harnesses from BOTH `offered` and `states` — the launcher passes
 * the `auto` harness when `--no-mcp-config` opts out of writing its config, so the
 * prompt cannot offer to write the very file that flag refuses. An excluded
 * harness is not offered, so it can never be recorded as declined either: it is
 * absent from the `states` the decline is derived from.
 *
 * @param {string} workspace
 * @param {{ interactive?: boolean, exclude?: string[] }} [opts]
 * @returns {{ prompt: boolean,
 *            reason: 'already-asked'|'nothing-offered'|'all-configured'|'non-interactive'|'ask',
 *            offered: string[], record: boolean, states?: HarnessStateInfo[] }}
 */
export function shouldPromptHarnessSetup(workspace, { interactive = true, exclude = [] } = {}) {
	const skip = new Set(exclude.map((n) => getHarness(n)?.name).filter(Boolean));
	const offered = harnessNames().filter((n) => !skip.has(n));
	if (harnessSetupDone(workspace)) return { prompt: false, reason: 'already-asked', offered, record: false };
	// Nothing left to ask about is not an answered question: record nothing, so a
	// launch without the opt-out still asks.
	if (offered.length === 0) {
		return { prompt: false, reason: 'nothing-offered', offered, record: false, states: [] };
	}
	const states = harnessStates(workspace).filter((s) => !skip.has(s.name));
	if (states.every((s) => s.configured)) {
		return { prompt: false, reason: 'all-configured', offered, record: true, states };
	}
	if (!interactive) return { prompt: false, reason: 'non-interactive', offered, record: false, states };
	return { prompt: true, reason: 'ask', offered, record: true, states };
}

/**
 * Resolve a free-text answer to the first-run prompt against the offered
 * harnesses. Accepts 1-based numbers, names (case-insensitive), `all`, and any
 * comma/space mix; an empty answer or a no/none/skip token means skip. Unknown
 * tokens come back in `unknown` so the caller can say so instead of silently
 * dropping them.
 *
 * `answered` separates a real reply from one nothing in it resolved: an all-typo
 * answer is NOT a decision, so the caller must record nothing and ask again
 * rather than treat it as "no to everything". An empty answer and an explicit
 * no/skip ARE decisions.
 *
 * @param {string} answer
 * @param {string[]} [offered]
 * @returns {{ chosen: string[], unknown: string[], skipped: boolean, answered: boolean }}
 */
export function parseHarnessAnswer(answer, offered = harnessNames()) {
	const raw = String(answer ?? '').trim();
	if (raw === '') return { chosen: [], unknown: [], skipped: true, answered: true };
	const tokens = raw
		.split(/[\s,]+/)
		.map((t) => t.trim().toLowerCase())
		.filter(Boolean);
	if (tokens.some((t) => t === 'all' || t === 'a' || t === '*'))
		return { chosen: [...offered], unknown: [], skipped: false, answered: true };
	if (tokens.length === 1 && ['n', 'no', 'none', 'skip', 's', 'q'].includes(tokens[0])) {
		return { chosen: [], unknown: [], skipped: true, answered: true };
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
	// Tokens were given but none resolved: not a decision, so the caller records
	// nothing and asks again next time.
	return { chosen, unknown, skipped: chosen.length === 0, answered: chosen.length > 0 };
}

/**
 * Turn one prompt answer into what should be RECORDED - the second half of
 * `shouldPromptHarnessSetup`, kept here for the same reason: the marker outlives
 * the launch and silently gates the automatic `.mcp.json` write, so getting it
 * wrong has no visible symptom in the run that wrote it.
 *
 * `answer` is the raw reply, or `null` for "no answer at all" - a stdin that
 * closed, a backgrounded job, or the prompt timing out. Those are indistinguishable
 * by design, and none of them is a decision.
 *
 * `record` is null when nothing should be written (no answer, or an answer nothing
 * in which resolved), so the next interactive launch asks again. Otherwise it
 * carries `configured` (the picks) and `declined` - ONLY harnesses shown as not
 * configured and passed over. An already-configured harness is never declined:
 * saying no to it was never on offer, and recording it would switch off the write
 * that keeps its entry current.
 *
 * @param {HarnessStateInfo[]} states
 * @param {string | null | undefined} answer
 * @param {string[]} [offered]
 * @returns {{ chosen: string[], unknown: string[],
 *            record: { configured: string[], declined: string[] } | null }}
 */
export function resolveHarnessAnswer(states, answer, offered = states.map((s) => s.name)) {
	if (answer === null || answer === undefined) return { chosen: [], unknown: [], record: null };
	const { chosen, unknown, answered } = parseHarnessAnswer(answer, offered);
	if (!answered) return { chosen, unknown, record: null };
	return {
		chosen,
		unknown,
		record: {
			configured: chosen,
			declined: states.filter((s) => !s.configured && !chosen.includes(s.name)).map((s) => s.name)
		}
	};
}
