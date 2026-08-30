/**
 * A small, byte-preserving TOML reader/editor.
 *
 * Cellar edits two TOML files it does not own: an agent harness's
 * `.codex/config.toml` (`harness.js`) and, when the user asks for it, an nbdev
 * project's `pyproject.toml` (`nbdev.ts`). Both carry a great deal that is none
 * of Cellar's business, so this is deliberately NOT a parse/serialize round trip
 * - it is a SCANNER that resolves where a key's value lives, plus splices that
 * replace only those physical lines. Comments, key order, spacing and line
 * endings everywhere else survive byte-for-byte.
 *
 * It lives in its own module for the reason `write-file-atomic.js` does: two
 * writers now need it, and a second copy of a scanner whose whole job is
 * deciding what is STRUCTURE and what is a VALUE is how the two come to read one
 * file differently. Node builtins only (in fact none at all - pure string work),
 * so it rides `package.json` `files` alongside `harness.js`, which imports it.
 *
 * The doctrine every consumer inherits: anything this cannot read with
 * confidence comes back `malformed`, and a malformed file is REFUSED, never
 * rewritten around.
 */

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
export function scanLine(line, state) {
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
export function bracketDelta(masked) {
	let d = 0;
	for (const c of masked) {
		if (c === '[') d++;
		else if (c === ']') d--;
	}
	return d;
}

/** Strip a quoted TOML key/value token to its text; plain tokens pass through. */
export function unquote(tok) {
	const t = tok.trim();
	if (t.length >= 2 && ((t[0] === '"' && t.at(-1) === '"') || (t[0] === "'" && t.at(-1) === "'"))) {
		const inner = t.slice(1, -1);
		return t[0] === '"' ? inner.replace(/\\(.)/g, '$1') : inner;
	}
	return t;
}

/** Split a dotted TOML key path on `.` outside quotes, or null if malformed. */
export function splitDotted(text) {
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
export function parseTableHeader(code) {
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
export function parseKeyPath(code) {
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
export function dominantEol(text) {
	const crlf = (text.match(/\r\n/g) ?? []).length;
	const lf = (text.match(/\n/g) ?? []).length - crlf;
	return crlf > lf ? '\r\n' : '\n';
}

export function parseTomlDoc(text) {
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

export const samePath = (a, b) => a.length === b.length && a.every((s, i) => s === b[i]);

/** Parse a bracketed TOML array of strings, or null when it is anything else. */
export function parseStringArray(text) {
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
 * A single-line quoted TOML string value, or null for anything else.
 *
 * The refusing sibling of `parseStringArray`, and refusing is the contract: a
 * multi-line triple-quoted value, an array, an inline table, a number or a bare
 * token is a legal TOML value this reader will not guess at, and a caller that
 * cannot read a value must say so rather than substitute one. `unquote` handles
 * both the basic and the literal quoting forms.
 */
export function parseTomlString(text) {
	const t = text.trim();
	if (t.startsWith('"""') || t.startsWith("'''")) return null;
	if (!/^(".*"|'.*')$/s.test(t)) return null;
	return unquote(t);
}

/**
 * Read a `key = value` assignment out of a table, using the span `parseTomlDoc`
 * already resolved (so a value continuing onto later lines - `args = [\n "mcp"\n]`
 * - is joined, and text that merely LOOKS like this key inside a multi-line
 * string is not a candidate at all: it was never recorded as a key).
 */
export function readAssignment(doc, table, key) {
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

/** Find a non-array-of-tables table by its dotted key path, or null. */
export function findTable(doc, path) {
	return doc.tables.find((t) => !t.isArray && samePath(t.key, path)) ?? null;
}

/**
 * Is `path` reachable as anything OTHER than a plain `[table]` - an inline
 * table, a dotted key, or a PREFIX of it assigned as a value? Returns the line
 * it was found on, else null.
 *
 * The prefix case has to count: TOML forbids extending an inline table, so
 * appending `[a.b]` under an existing `a = { … }` would leave the whole file
 * unparseable, taking every other setting down with it.
 */
export function otherFormLine(doc, path) {
	for (const k of doc.keys) {
		const full = [...k.table, ...k.path];
		const shared = Math.min(full.length, path.length);
		if (samePath(full.slice(0, shared), path.slice(0, shared))) return k.line;
	}
	return null;
}

/**
 * Apply per-key edits inside an existing table and return the new text.
 *
 * Each edit is `{ replace, text }`:
 *   - `text === null`        leave the key alone (it already says what we want).
 *     A splice replaces whole physical LINES, so rewriting a key to change
 *     nothing would destroy that line's own trailing comment and spacing - the
 *     byte preservation this module exists for, applied per key rather than per
 *     table.
 *   - `replace` set          splice those lines for `text`.
 *   - `replace === null`     the key is absent; insert `text` right after the
 *     table header so the table stays self-describing.
 *
 * An inserted line wears the file's own ending; `doc.lines` are joined with '\n'
 * and each already carries its own '\r', so untouched lines are byte-identical.
 */
export function editTable(doc, table, edits) {
	const lines = [...doc.lines];
	const nl = (text) => (doc.eol === '\r\n' ? text + '\r' : text);
	// Replace from the bottom up so an earlier edit cannot shift a later index.
	const present = edits.filter((e) => e.replace && e.text !== null);
	for (const e of [...present].sort((a, b) => b.replace.first - a.replace.first)) {
		lines.splice(e.replace.first, e.replace.last - e.replace.first + 1, nl(e.text));
	}
	const missing = edits.filter((e) => !e.replace && e.text !== null).map((e) => nl(e.text));
	if (missing.length) lines.splice(table.start + 1, 0, ...missing);
	return lines.join('\n');
}

/**
 * Append a whole table, separated by exactly one blank line, in the file's own
 * line ending (an LF block appended to a CRLF config is a whole-file diff).
 *
 * @param {string} text  the existing file
 * @param {string[]} block  the header line and its keys, already rendered
 */
export function appendTomlTable(text, block) {
	const eol = dominantEol(text);
	let body = text;
	if (body !== '' && !body.endsWith('\n')) body += eol;
	if (body.trim() !== '' && !body.endsWith(eol + eol)) body += eol;
	return body + block.join(eol) + eol;
}
