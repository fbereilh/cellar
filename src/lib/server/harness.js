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
	fchmodSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
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
 * @property {string[]} [allowed]     the allow-list (v2)
 * @property {string[]} [configured]  v1 only; read for migration, never written
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
 * The config file `--no-mcp-config` names. The flag is defined in terms of that
 * FILE, so the harness it excludes is derived from the registry rather than
 * pinned by name — adding a harness stays a data change.
 */
export const MCP_JSON_CONFIG_PATH = '.mcp.json';

/**
 * Supported harnesses. Data only — see the header: adding one is an entry here.
 *
 * `defaultAllowed: true` seeds the workspace allow-list, i.e. Cellar keeps this
 * harness's config in place from the very first launch with nothing recorded and
 * nothing asked. Today only Claude Code, whose `.mcp.json` write predates this
 * registry and is the documented zero-config behavior.
 */
export const HARNESSES = [
	{
		name: 'claude',
		label: 'Claude Code',
		configPath: MCP_JSON_CONFIG_PATH,
		format: 'json',
		defaultAllowed: true
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
	// Carry the TARGET's permissions onto the replacement. temp+rename installs a
	// NEW inode, so without this the file comes back at the default `0o666 & ~umask`
	// (typically 0644) — whereas the in-place write this replaced truncated the
	// existing file and kept whatever mode the user had set. An MCP config commonly
	// holds another server's `env` block with an API token, so silently widening a
	// `chmod 600` config to world-readable is a disclosure, not a cosmetic change.
	// A missing target (first write) simply inherits the default.
	let mode;
	try {
		mode = statSync(file).mode & 0o7777;
	} catch {}
	const tmp = join(dir, `.${basename(file)}.cellar-${process.pid}-${randomBytes(6).toString('hex')}.tmp`);
	try {
		const fd = openSync(tmp, 'wx');
		try {
			writeFileSync(fd, text);
			// After the write, and via the fd: `openSync`'s mode argument is masked by
			// the umask, so a 0600 target would still come back 0600 & ~umask.
			if (mode !== undefined) fchmodSync(fd, mode);
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

/**
 * Read a config file's text. The ONE place a read failure is turned into a
 * value, so both formats answer an unreadable file the same way instead of one
 * of them throwing.
 *
 * `text: null` means the file is THERE but could not be read at all - a mode
 * that denies us (EACCES), a directory where a config should be (EISDIR), an
 * I/O error. That is not a parse problem and it is not "unconfigured": every
 * caller must refuse, because the only honest thing to say about a file we
 * cannot see is that we left it alone. Letting the read throw instead surfaces
 * as a raw stack trace out of `cellar harness list` / `cellar harness add`.
 */
function readConfigText(file) {
	if (!existsSync(file)) return { exists: false, text: '', error: null };
	try {
		return { exists: true, text: readFileSync(file, 'utf8'), error: null };
	} catch (err) {
		return { exists: true, text: null, error: err?.code || err?.message || 'unreadable' };
	}
}

/** A plain `{…}` - never null, never an array (both spread into nonsense). */
function plainObject(v) {
	return !!v && typeof v === 'object' && !Array.isArray(v);
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
 * `{ present, matches, unreadable, reason }` - `unreadable` means the file
 * exists but cannot be edited confidently, which must never be overwritten, and
 * `reason` says which of the ways it is so the message can be honest about it.
 *
 * A non-object `mcpServers` is one of those ways: the merge below would replace
 * whatever the user put there with `{ cellar: … }` and report success, which is
 * exactly the clobber this module refuses to do. The TOML sibling already
 * refuses the analogous `mcp_servers = { … }` shape; the two writers must agree.
 */
function readJsonState(file) {
	const src = readConfigText(file);
	if (!src.exists) return { present: false, matches: false, unreadable: false };
	if (src.text === null) {
		return { present: false, matches: false, unreadable: true, reason: 'unreadable-file', error: src.error };
	}
	let config;
	try {
		config = JSON.parse(src.text);
	} catch {
		return { present: false, matches: false, unreadable: true, reason: 'not-json' };
	}
	if (!plainObject(config)) {
		return { present: false, matches: false, unreadable: true, reason: 'not-json' };
	}
	if (config.mcpServers !== undefined && !plainObject(config.mcpServers)) {
		return { present: false, matches: false, unreadable: true, reason: 'bad-servers' };
	}
	const servers = plainObject(config.mcpServers) ? config.mcpServers : {};
	const entry = servers[SERVER_NAME];
	return { present: entry !== undefined, matches: sameJsonEntry(entry), unreadable: false, config };
}

/** The `add it by hand` tail every JSON refusal ends with. */
const JSON_HAND_EDIT = `add a "${SERVER_NAME}" entry under "mcpServers" by hand`;

/**
 * Why a JSON config was refused, as a sentence fragment. Shared by the write and
 * the strip path so the two cannot describe the same file differently.
 */
function jsonRefusal(state) {
	return state.reason === 'unreadable-file'
		? `could not be read (${state.error})`
		: state.reason === 'bad-servers'
			? 'has a non-object "mcpServers"'
			: 'is not a JSON object';
}

function writeJsonConfig(file) {
	const state = readJsonState(file);
	if (state.unreadable) {
		const why = jsonRefusal(state);
		return {
			status: 'skipped',
			message: `${file} ${why}; leaving it untouched (${JSON_HAND_EDIT})`
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
	// `readJsonState` has already refused anything but a plain object (or nothing)
	// here, so this can only ever merge into the user's own map.
	const servers = plainObject(config.mcpServers) ? config.mcpServers : {};
	const existing = servers[SERVER_NAME];
	// Merge, like the TOML writer: `command`/`args` are Cellar's, every other key the
	// user put on this entry (`env`, `type`, `cwd`) survives. Spreading `servers`
	// first also keeps an existing `cellar` key in its POSITION, and every other
	// server untouched. `existing` is spread only when it is a plain object - a
	// string would spread into character-indexed keys.
	const base = plainObject(existing) ? existing : {};
	config.mcpServers = { ...servers, [SERVER_NAME]: { ...base, ...JSON_ENTRY } };
	writeFileAtomic(file, JSON.stringify(config, null, 2) + '\n');
	return state.present
		? { status: 'updated', message: `updated the ${SERVER_NAME} MCP server` }
		: { status: 'wrote', message: `added the ${SERVER_NAME} MCP server` };
}

// ---- TOML (`.codex/config.toml`, Codex) -----------------------------------

const TOML_TABLE = ['mcp_servers', SERVER_NAME];

/**
 * The two keys Cellar owns inside that table: the line it would write, and - the
 * ONE place that decides it - whether a value already SAYS that. Every consumer
 * reads it (the appended block, the idempotence check, the in-place rewrite), so
 * "already correct" cannot mean one thing to one of them and something else to
 * another. `matches` is only ever called later, so the hoisted helpers it uses
 * are resolved by then.
 */
const TOML_KEYS = [
	{
		key: 'command',
		text: `command = "${SERVER_COMMAND}"`,
		matches: (value) => unquote(value) === SERVER_COMMAND
	},
	{
		key: 'args',
		text: `args = [${SERVER_ARGS.map((a) => JSON.stringify(a)).join(', ')}]`,
		matches: (value) => {
			const parsed = parseStringArray(value);
			return !!parsed && JSON.stringify(parsed) === JSON.stringify(SERVER_ARGS);
		}
	}
];

const TOML_BLOCK = [`[${TOML_TABLE.join('.')}]`, ...TOML_KEYS.map((k) => k.text)];

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
/**
 * The line ending a file predominantly uses. The writer preserves every line it
 * does not touch verbatim, so this decides only what an INSERTED line ends with:
 * emitting LF into a CRLF config left mixed endings, turning a two-line edit into
 * a diff over the whole file - the opposite of what this writer promises.
 */
function dominantEol(text) {
	const crlf = (text.match(/\r\n/g) ?? []).length;
	const lf = (text.match(/\n/g) ?? []).length - crlf;
	return crlf > lf ? '\r\n' : '\n';
}

function parseTomlDoc(text) {
	const lines = text.split('\n');
	// Lines keep their own terminator bytes (a CRLF file's lines each end in '\r'),
	// so an untouched line rejoins byte-identically. Only the lines this writer
	// INSERTS need to be told which ending to wear - see `eol`.
	const eol = dominantEol(text);
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
	return { lines, codes, tables, keys, malformed, eol };
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
	return TOML_KEYS.every((spec) => {
		const found = readAssignment(doc, table, spec.key);
		return !!found && spec.matches(found.value);
	});
}

/** Rewrite `command`/`args` inside the existing table, leaving all else intact. */
function rewriteTable(doc, table) {
	const lines = [...doc.lines];
	// An inserted line wears the file's own ending; `lines` are joined with '\n'
	// and each already carries its own '\r', so untouched lines are byte-identical.
	const nl = (text) => (doc.eol === '\r\n' ? text + '\r' : text);
	// Replace from the bottom up so an earlier edit cannot shift a later index.
	const edits = TOML_KEYS.map((spec) => ({ ...spec, found: readAssignment(doc, table, spec.key) }));
	for (const e of [...edits].sort((a, b) => (b.found?.first ?? -1) - (a.found?.first ?? -1))) {
		// A key whose value already says what Cellar would write is LEFT ALONE. The
		// splice replaces whole physical lines, so rewriting it would destroy that
		// line's own trailing comment (and its spacing) to change nothing - the
		// byte-preservation this writer exists for, applied per key rather than per
		// table.
		if (e.found && !e.matches(e.found.value)) {
			lines.splice(e.found.first, e.found.last - e.found.first + 1, nl(e.text));
		}
	}
	// A table missing a key entirely (hand-written, or Cellar's shape changed):
	// insert right after the header so the table stays self-describing.
	const missing = edits.filter((e) => !e.found).map((e) => nl(e.text));
	if (missing.length) lines.splice(table.start + 1, 0, ...missing);
	return lines.join('\n');
}

/**
 * Append the canonical table, separated by exactly one blank line, in the file's
 * own line ending (an LF block appended to a CRLF config is a whole-file diff).
 */
function appendTable(text) {
	const eol = dominantEol(text);
	let body = text;
	if (body !== '' && !body.endsWith('\n')) body += eol;
	if (body.trim() !== '' && !body.endsWith(eol + eol)) body += eol;
	return body + TOML_BLOCK.join(eol) + eol;
}

/**
 * `codexState` over a file on disk - the ONE place the TOML side reads one, so
 * the writer and `harnessState` cannot disagree about what an unreadable file
 * means. A read that fails is `malformed` with a `readError`: we know nothing
 * about the contents, so the only safe verdict is refuse (never "unconfigured",
 * which would then be appended to and could clobber a file we never saw).
 */
function readCodexFile(file) {
	const src = readConfigText(file);
	if (src.text === null) return { existing: '', state: { kind: 'malformed', readError: src.error } };
	return { existing: src.text, state: codexState(src.text) };
}

function writeTomlConfig(file) {
	const { existing, state } = readCodexFile(file);

	if (state.kind === 'malformed') {
		const why = state.readError
			? `could not be read (${state.readError})`
			: 'could not be read as TOML with confidence';
		return {
			status: 'skipped',
			message: `${file} ${why}; leaving it untouched (add a [${TOML_TABLE.join('.')}] table by hand)`
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
	const { state } = readCodexFile(file);
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
// ---- Allow-list + reconcile ------------------------------------------------

/**
 * WHICH harnesses Cellar may configure here — the one durable decision, and the
 * model the whole feature turns on.
 *
 * The alternative it replaced recorded DECLINES, and that shape had the failure
 * baked in: the most reflexive answer to an unexpected prompt (Enter) was itself
 * a decline, so it permanently switched off the zero-config `.mcp.json` write
 * Cellar has always done. An allow-list inverts that. Nothing is ever declined;
 * a harness is either on the list or simply not on it yet, so no answer — and no
 * absence of an answer — can take capability away.
 *
 * Two consequences worth stating, because everything else follows from them:
 *
 *   1. Claude Code is on the list BY DEFAULT (`defaultAllowed`), so a workspace
 *      with no marker at all behaves exactly as it always has. There is no
 *      migration and no first-launch difference.
 *   2. The list is RECONCILED on every start (`reconcileHarnesses`): each allowed
 *      harness's config is checked and repaired if it is missing, stale or was
 *      deleted. That is what makes the list a standing instruction rather than a
 *      one-off write — delete `.mcp.json` and the next `cellar` puts it back.
 *
 * SCOPE: per-workspace, in the same `.cellar/harness.json` the prompt already
 * used (gitignored, port-independent, beside `checkpoints.json` and the UI
 * store). Deliberately not a global file: which agent you point at a project is
 * a property of that project, and a fresh clone should get the defaults rather
 * than inherit another machine's answer. The GLOBAL default lives in the
 * registry instead, as `defaultAllowed` — code, not state, so it needs no
 * precedence rules and cannot drift out of sync with the harness list.
 */

/** Harnesses on the allow-list before anyone records anything. */
export function defaultAllowedHarnesses() {
	return HARNESSES.filter((h) => h.defaultAllowed).map((h) => h.name);
}

/**
 * Per-workspace record of the allow-list (and whether the first-run question has
 * been asked). See the section header for why it lives here and not globally.
 */
export function harnessMarkerPath(workspace) {
	return join(workspace, '.cellar', 'harness.json');
}

/**
 * Read the marker, or null when absent/unreadable (→ treated as never written).
 *
 * @param {string} workspace
 * @returns {HarnessSetupMarker | null}
 */
export function readHarnessSetup(workspace) {
	const src = readConfigText(harnessMarkerPath(workspace));
	if (!src.exists || src.text === null) return null;
	try {
		const data = JSON.parse(src.text);
		return plainObject(data) ? data : null;
	} catch {
		return null;
	}
}

/** Known harness names from arbitrary input, deduped, in registry order. */
function normalizeNames(names) {
	const want = new Set(
		(Array.isArray(names) ? names : []).map((n) => getHarness(n)?.name).filter(Boolean)
	);
	return harnessNames().filter((n) => want.has(n));
}

/**
 * The harnesses Cellar may configure for this workspace.
 *
 * No marker at all ⇒ the registry defaults, so zero-config works before anything
 * is written. A marker with an explicit list wins outright, EMPTY INCLUDED — that
 * is what makes `cellar harness remove claude` stick rather than being undone by
 * the defaults on the next read.
 *
 * @param {string} workspace
 * @returns {string[]}
 */
export function readAllowList(workspace) {
	const m = readHarnessSetup(workspace);
	if (!m) return defaultAllowedHarnesses();
	if (Array.isArray(m.allowed)) return normalizeNames(m.allowed);
	// A marker predating the allow-list (never shipped in a release, but a dev
	// machine may hold one): its `configured` entries were harnesses the user asked
	// for, so honor them on top of the defaults. `declined` is deliberately ignored
	// — nothing is declined in this model.
	return normalizeNames([...defaultAllowedHarnesses(), ...(Array.isArray(m.configured) ? m.configured : [])]);
}

/**
 * Persist the allow-list. `promptedAt` is preserved across writes unless a new
 * one is passed, so adding a harness later never re-opens the first-run question.
 *
 * @param {string} workspace
 * @param {string[]} names
 * @param {{ promptedAt?: number }} [opts]
 */
export function writeAllowList(workspace, names, { promptedAt } = {}) {
	const prev = readHarnessSetup(workspace);
	const kept = typeof promptedAt === 'number' ? promptedAt : prev?.promptedAt;
	const data = { version: 2, allowed: normalizeNames(names) };
	if (typeof kept === 'number') data.promptedAt = kept;
	writeFileAtomic(harnessMarkerPath(workspace), JSON.stringify(data, null, 2) + '\n');
	return data;
}

/** Is Cellar allowed to configure this harness here? */
export function isHarnessAllowed(name, workspace) {
	const h = getHarness(name);
	return !!h && readAllowList(workspace).includes(h.name);
}

/**
 * Add a harness to the allow-list. Idempotent; `changed` is false when it was
 * already on the list (so a caller can stay quiet about a no-op).
 *
 * @returns {{ ok: boolean, changed: boolean }}
 */
export function allowHarness(name, workspace) {
	const h = getHarness(name);
	if (!h) return { ok: false, changed: false };
	const allowed = readAllowList(workspace);
	if (allowed.includes(h.name)) return { ok: true, changed: false };
	writeAllowList(workspace, [...allowed, h.name]);
	return { ok: true, changed: true };
}

/**
 * Take a harness off the allow-list: Cellar stops reconciling it. This does NOT
 * touch the harness's config file — the entry keeps working until the user asks
 * for it to be stripped (`stripHarness`), because "stop managing this" and
 * "delete this from my config" are different requests and only one of them is
 * destructive.
 *
 * Removing a DEFAULT harness persists an explicit empty/short list, which is what
 * makes the removal survive: `readAllowList` falls back to the defaults only when
 * no list was ever written.
 *
 * @returns {{ ok: boolean, changed: boolean }}
 */
export function disallowHarness(name, workspace) {
	const h = getHarness(name);
	if (!h) return { ok: false, changed: false };
	const allowed = readAllowList(workspace);
	if (!allowed.includes(h.name)) return { ok: true, changed: false };
	writeAllowList(
		workspace,
		allowed.filter((n) => n !== h.name)
	);
	return { ok: true, changed: true };
}

/**
 * Bring every allowed harness's config back in line — the self-heal the launcher
 * runs on EVERY start.
 *
 * It is just `configureHarness` per allowed harness, which is already idempotent
 * (`already` when the entry is correct, so the common case writes nothing) and
 * already repairs a missing or stale one. That is the whole mechanism: there is
 * no separate "repair" path that could drift from the write path.
 *
 * Never throws: a config that cannot be written is reported as `skipped`, because
 * agent wiring must never be a reason a notebook fails to launch.
 *
 * @param {string} workspace
 * @param {{ exclude?: string[] }} [opts] harnesses to leave alone this launch
 *        (`--no-mcp-config`); an exclusion is not a removal and is never persisted.
 * @returns {HarnessResult[]} one entry per harness actually considered
 */
export function reconcileHarnesses(workspace, { exclude = [] } = {}) {
	const skip = new Set(normalizeNames(exclude));
	const out = [];
	for (const name of readAllowList(workspace)) {
		if (skip.has(name)) continue;
		try {
			out.push(configureHarness(name, workspace));
		} catch (err) {
			const h = /** @type {{name:string,label:string,configPath:string}} */ (getHarness(name));
			out.push({
				ok: true,
				name: h.name,
				label: h.label,
				file: join(workspace, h.configPath),
				status: 'skipped',
				message: `could not be written (${err?.message ?? err})`
			});
		}
	}
	return out;
}

/**
 * Remove Cellar's own entry from a harness's config — the opt-in destructive half
 * of `cellar harness remove`.
 *
 * Refuses in exactly the cases the writers refuse (unreadable file, a `cellar`
 * server defined in some other legal form), for the same reason: this edits the
 * user's file, and a shape we did not write is not a shape we can safely remove.
 * Everything else in the file is preserved the same way a write preserves it.
 *
 * @param {string} name
 * @param {string} workspace
 * @returns {HarnessResult}
 */
export function stripHarness(name, workspace) {
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
	const base = { ok: true, name: h.name, label: h.label, file };
	const result = h.format === 'json' ? stripJsonConfig(file) : stripTomlConfig(file);
	return { ...base, ...result };
}

function stripJsonConfig(file) {
	const state = readJsonState(file);
	if (state.unreadable) {
		return { status: 'skipped', message: `${file} ${jsonRefusal(state)}; leaving it untouched` };
	}
	if (!state.present) return { status: 'already', message: 'no cellar entry to remove' };
	const servers = { ...(plainObject(state.config?.mcpServers) ? state.config.mcpServers : {}) };
	delete servers[SERVER_NAME];
	const config = { ...state.config, mcpServers: servers };
	writeFileAtomic(file, JSON.stringify(config, null, 2) + '\n');
	return { status: 'updated', message: `removed the ${SERVER_NAME} MCP server` };
}

function stripTomlConfig(file) {
	const { existing, state } = readCodexFile(file);
	if (state.kind === 'malformed') {
		const why = state.readError
			? `could not be read (${state.readError})`
			: 'could not be read as TOML with confidence';
		return { status: 'skipped', message: `${file} ${why}; leaving it untouched` };
	}
	if (state.kind === 'other-form') {
		return {
			status: 'skipped',
			message: `${file} defines ${TOML_TABLE.join('.')} in a form Cellar did not write (line ${state.line + 1}); remove it by hand`
		};
	}
	if (state.kind !== 'table') return { status: 'already', message: 'no cellar table to remove' };
	// The table's span runs from its header to the NEXT table header, so it already
	// carries the blank line that separated it - removing the span leaves exactly
	// one blank between the neighbours it sat between, and every other byte alone.
	const lines = [...state.doc.lines];
	lines.splice(state.table.start, state.table.end - state.table.start);
	let next = lines.join('\n');
	// Removing the LAST table leaves the separator blank line dangling at EOF.
	if (state.table.end >= state.doc.lines.length) next = next.replace(/(\r?\n)[ \t\r\n]*$/, '$1');
	if (next === existing) return { status: 'already', message: 'no cellar table to remove' };
	writeFileAtomic(file, next);
	return { status: 'updated', message: `removed [${TOML_TABLE.join('.')}]` };
}

// ---- First-run prompt ------------------------------------------------------

/** Has the first-run harness question already been asked in this workspace? */
export function harnessSetupDone(workspace) {
	const m = readHarnessSetup(workspace);
	return typeof m?.promptedAt === 'number';
}

/** Record that the question was asked, leaving the allow-list itself untouched. */
export function markHarnessPrompted(workspace, at = Date.now()) {
	return writeAllowList(workspace, readAllowList(workspace), { promptedAt: at });
}

/**
 * Should the launcher ask the first-run question? Pure decision, kept here rather
 * than inline in `bin/cellar.js` so each rule is directly testable: asking twice,
 * or asking a script, are both regressions with no visible symptom in a normal
 * interactive run.
 *
 * The question is only ever about harnesses NOT yet on the allow-list — an
 * allowed one is already being kept in place, so there is nothing to ask. That is
 * what makes a bare Enter safe: the answer can only ADD, so skipping leaves every
 * existing arrangement exactly as it was.
 *
 * `exclude` drops harnesses from the offer (the launcher passes the `.mcp.json`
 * harness when `--no-mcp-config` opts out of writing that file). An excluded
 * harness that is not yet allowed also makes `record` false: recording "asked"
 * over a partial view would suppress the question forever for a harness this
 * launch never showed.
 *
 * @param {string} workspace
 * @param {{ interactive?: boolean, exclude?: string[] }} [opts]
 * @returns {{ prompt: boolean,
 *            reason: 'already-asked'|'nothing-to-offer'|'non-interactive'|'ask',
 *            offered: string[], record: boolean, states: HarnessStateInfo[] }}
 */
export function shouldPromptHarnessSetup(workspace, { interactive = true, exclude = [] } = {}) {
	const skip = new Set(normalizeNames(exclude));
	const allowed = new Set(readAllowList(workspace));
	const offered = harnessNames().filter((n) => !skip.has(n) && !allowed.has(n));
	// Recording "asked" is only honest over the FULL set of harnesses this
	// workspace could be offered; a flag-filtered view must not close the question.
	const record = !harnessNames().some((n) => skip.has(n) && !allowed.has(n));
	const states = () => offered.map((n) => /** @type {HarnessStateInfo} */ (harnessState(n, workspace)));
	if (harnessSetupDone(workspace)) {
		return { prompt: false, reason: 'already-asked', offered, record: false, states: [] };
	}
	if (offered.length === 0) {
		return { prompt: false, reason: 'nothing-to-offer', offered, record: false, states: [] };
	}
	if (!interactive) return { prompt: false, reason: 'non-interactive', offered, record: false, states: [] };
	return { prompt: true, reason: 'ask', offered, record, states: states() };
}

/**
 * Resolve a free-text answer to the first-run prompt against the offered
 * harnesses. Accepts 1-based numbers, names (case-insensitive), `all`, and any
 * comma/space mix; an empty answer or a no/none/skip token means "no others".
 * Unknown tokens come back in `unknown` so the caller can say so instead of
 * silently dropping them.
 *
 * `answered` separates a real reply from one nothing in which resolved: an
 * all-typo answer is NOT a decision, so the caller records nothing and asks
 * again. An empty answer and an explicit no/skip ARE decisions — and harmless
 * ones here, since the only thing an answer can do is add.
 *
 * @param {string | null | undefined} answer
 * @param {string[]} [offered]
 * @returns {{ chosen: string[], unknown: string[], skipped: boolean, answered: boolean }}
 */
export function parseHarnessAnswer(answer, offered = harnessNames()) {
	if (answer === null || answer === undefined) {
		return { chosen: [], unknown: [], skipped: true, answered: false };
	}
	const raw = String(answer).trim();
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
