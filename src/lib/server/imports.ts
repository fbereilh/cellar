/**
 * Cellar — Python import extraction, dedup and canonical rendering.
 *
 * Pure and side-effect free: no kernel, no filesystem, no notebook. Everything
 * the imports cell does (consolidate, agent routing) is expressed as functions
 * over source strings, so the interesting logic is testable without a kernel and
 * without a document.
 *
 * WHY NOT THE KERNEL'S `ast` MODULE. Parsing through the live kernel would be
 * "more correct" on paper and worse in practice: it can only run when a kernel
 * exists (Cellar deliberately never force-boots one), it must queue behind
 * whatever cell is executing (so consolidating a notebook could block for as long
 * as a user's long-running cell), and it would make a purely structural document
 * edit depend on the runtime. So we tokenize here instead — but tokenize, never
 * regex-scan: the whole point of the exercise is that
 *
 *     s = """
 *     import evil
 *     """
 *     if TYPE_CHECKING:
 *         import pandas
 *
 * contains no import this module may touch. `logicalLines()` below is a real
 * Python line tokenizer — it understands comments, all four string forms
 * (single/triple × quote char), string prefixes, escapes, bracket continuation
 * and backslash continuation — and it reports each logical line's INDENT. Only a
 * logical line at indent 0 whose first token is `import`/`from` is module level,
 * because a statement inside a def/class/if/try body is indented by definition.
 *
 * Anything that does not parse into a record we can canonically re-render is left
 * exactly where it is. Removing a line we cannot faithfully reproduce would break
 * the user's cell, so "I don't understand this" always means "don't touch it".
 */

const OPEN = '([{';
const CLOSE = ')]}';

/** A Python LOGICAL line: `[start, end)` spans every physical line the statement
 * occupies (trailing newline included); `indent` is its first line's leading
 * whitespace width; `raw` is the verbatim slice. */
export interface LogicalLine {
	start: number;
	end: number;
	indent: number;
	raw: string;
}

/** A plain `import a.b` / `import a.b as c`, one per bound module name. */
export interface ImportRecordPlain {
	kind: 'import';
	module: string;
	alias: string | null;
}

/** A `from .x import y` / `from x import y as z` / `from x import *`, one per name. */
export interface ImportRecordFrom {
	kind: 'from';
	level: number;
	module: string;
	name: string;
	alias: string | null;
}

/** One bound name lifted from an import statement — the unit dedup/merging works on. */
export type ImportRecord = ImportRecordPlain | ImportRecordFrom;

/** The result of extracting module-level imports out of a source string. */
export interface ExtractResult {
	statements: string[];
	source: string;
	changed: boolean;
}

/**
 * Index just past the string literal starting at `i` (which must be a quote).
 * Handles triple quotes and backslash escapes — including inside raw strings,
 * where a backslash still prevents a quote from terminating the literal. An
 * unterminated literal runs to end of input (the source is mid-edit; treating the
 * rest as string data is the conservative read).
 */
function skipString(src: string, i: number): number {
	const q = src[i];
	const triple = src[i + 1] === q && src[i + 2] === q;
	const term = triple ? q + q + q : q;
	let k = i + term.length;
	while (k < src.length) {
		if (src[k] === '\\') {
			k += 2;
			continue;
		}
		if (!triple && src[k] === '\n') return k; // an unterminated single-quoted string ends at EOL
		if (src.startsWith(term, k)) return k + term.length;
		k++;
	}
	return src.length;
}

/**
 * Split `source` into Python LOGICAL lines: `{ start, end, indent, raw }`, where
 * `[start, end)` spans every physical line the statement occupies (trailing
 * newline included) and `indent` is the leading-whitespace width of its first
 * physical line. Blank and comment-only lines come back as their own entries with
 * no code in them, which is exactly what the callers want (they never match an
 * import, and they survive a strip untouched).
 */
export function logicalLines(source: string): LogicalLine[] {
	const out: LogicalLine[] = [];
	let i = 0;
	while (i < source.length) {
		const start = i;
		let j = i;
		while (j < source.length && (source[j] === ' ' || source[j] === '\t')) j++;
		const indent = j - i;

		let k = j;
		let depth = 0;
		while (k < source.length) {
			const ch = source[k];
			if (ch === '#') {
				while (k < source.length && source[k] !== '\n') k++;
				continue;
			}
			if (ch === '"' || ch === "'") {
				k = skipString(source, k);
				continue;
			}
			if (ch === '\\' && (source[k + 1] === '\n' || (source[k + 1] === '\r' && source[k + 2] === '\n'))) {
				k += source[k + 1] === '\r' ? 3 : 2;
				continue;
			}
			if (OPEN.includes(ch)) {
				depth++;
				k++;
				continue;
			}
			if (CLOSE.includes(ch)) {
				if (depth > 0) depth--;
				k++;
				continue;
			}
			if (ch === '\n') {
				k++;
				if (depth > 0) continue; // an open bracket continues the logical line
				break;
			}
			k++;
		}
		out.push({ start, end: k, indent, raw: source.slice(start, k) });
		if (k === start) break; // defensive: never loop on a zero-width line
		i = k;
	}
	return out;
}

/** Drop comments and fold line continuations out of a logical line's text. */
function stripComments(text: string): string {
	let out = '';
	let k = 0;
	while (k < text.length) {
		const ch = text[k];
		if (ch === '#') {
			while (k < text.length && text[k] !== '\n') k++;
			continue;
		}
		if (ch === '"' || ch === "'") {
			const e = skipString(text, k);
			out += text.slice(k, e);
			k = e;
			continue;
		}
		if (ch === '\\' && (text[k + 1] === '\n' || (text[k + 1] === '\r' && text[k + 2] === '\n'))) {
			out += ' ';
			k += text[k + 1] === '\r' ? 3 : 2;
			continue;
		}
		out += ch;
		k++;
	}
	return out;
}

/** Split on top-level `;` (never inside brackets). Import statements hold no strings. */
function splitSimpleStatements(code: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let cur = '';
	for (const ch of code) {
		if (OPEN.includes(ch)) depth++;
		else if (CLOSE.includes(ch) && depth > 0) depth--;
		if (ch === ';' && depth === 0) {
			parts.push(cur);
			cur = '';
			continue;
		}
		cur += ch;
	}
	parts.push(cur);
	return parts.map((p) => p.trim()).filter(Boolean);
}

/** Split on top-level `,` (never inside brackets). */
function splitCommas(text: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let cur = '';
	for (const ch of text) {
		if (OPEN.includes(ch)) depth++;
		else if (CLOSE.includes(ch) && depth > 0) depth--;
		if (ch === ',' && depth === 0) {
			parts.push(cur);
			cur = '';
			continue;
		}
		cur += ch;
	}
	parts.push(cur);
	return parts.map((p) => p.trim()).filter(Boolean);
}

const DOTTED = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/;
const NAME = /^[A-Za-z_]\w*$/;

/** `x`, `x as y` → `{ name, alias }`, or null when it isn't a plain name/alias pair. */
function parseAliased(part: string, namePattern: RegExp): { name: string; alias: string | null } | null {
	const m = /^(\S+)(?:\s+as\s+([A-Za-z_]\w*))?$/.exec(part.replace(/\s+/g, ' ').trim());
	if (!m) return null;
	if (!namePattern.test(m[1])) return null;
	return { name: m[1], alias: m[2] ?? null };
}

/**
 * Parse ONE import statement into records, one per bound name — the unit dedup
 * and merging work on. Returns null (not an empty list) when the statement is not
 * an import we can canonically re-render, which the callers read as "leave this
 * source line alone".
 *
 *   import a.b, c as d   → [{kind:'import', module:'a.b'}, {kind:'import', module:'c', alias:'d'}]
 *   from .x import y, *  → [{kind:'from', level:1, module:'x', name:'y'}, …]
 */
export function parseImportStatement(code: string): ImportRecord[] | null {
	const text = code.replace(/\s+/g, ' ').trim();

	if (/^import\s/.test(text)) {
		const records: ImportRecord[] = [];
		for (const part of splitCommas(text.slice('import '.length))) {
			const p = parseAliased(part, DOTTED);
			if (!p) return null;
			records.push({ kind: 'import', module: p.name, alias: p.alias });
		}
		return records.length ? records : null;
	}

	if (/^from\s/.test(text)) {
		const m = /^from\s+(\.*)([A-Za-z_][\w.]*)?\s+import\s+(.+)$/.exec(text);
		if (!m) return null;
		const level = m[1].length;
		const module = m[2] ?? '';
		if (!level && !module) return null; // `from  import x` is not a thing
		if (module && !DOTTED.test(module)) return null;
		let names = m[3].trim();
		if (names.startsWith('(') && names.endsWith(')')) names = names.slice(1, -1);
		const records: ImportRecord[] = [];
		for (const part of splitCommas(names)) {
			if (part === '*') {
				records.push({ kind: 'from', level, module, name: '*', alias: null });
				continue;
			}
			const p = parseAliased(part, NAME);
			if (!p) return null;
			records.push({ kind: 'from', level, module, name: p.name, alias: p.alias });
		}
		return records.length ? records : null;
	}

	return null;
}

/** The canonical one-line rendering of a single record. Also its dedup key. */
export function renderImport(rec: ImportRecord): string {
	if (rec.kind === 'import') {
		return rec.alias ? `import ${rec.module} as ${rec.alias}` : `import ${rec.module}`;
	}
	const from = `from ${'.'.repeat(rec.level)}${rec.module}`;
	return rec.alias ? `${from} import ${rec.name} as ${rec.alias}` : `${from} import ${rec.name}`;
}

/** Parse a list of canonical statement strings back into records. */
function recordsOf(statements: string[]): ImportRecord[] {
	const out: ImportRecord[] = [];
	for (const s of statements) {
		const recs = parseImportStatement(s);
		if (recs) out.push(...recs);
	}
	return out;
}

/**
 * Extract every MODULE-LEVEL import from `source`.
 *
 * Returns the canonical statements (one per bound name, expanded and
 * deduplicated in document order) and the source with those statements removed.
 * Imports nested in a def/class/if/try body are indented and therefore invisible
 * here, by construction — a nested import is a deliberate choice (lazy loading,
 * `TYPE_CHECKING`) and moving it would change the program.
 *
 * A logical line that MIXES imports with other statements (`import os; run()`)
 * has only its import parts lifted; the rest is rewritten in place. Because that
 * rewrite drops the line's original comments, it only happens on a line we fully
 * understand.
 */
export function extractTopLevelImports(source: string | null | undefined): ExtractResult {
	const src = source ?? '';
	const statements: string[] = [];
	const seen = new Set<string>();
	const edits: { start: number; end: number; text: string }[] = [];

	for (const line of logicalLines(src)) {
		if (line.indent !== 0) continue;
		const code = stripComments(line.raw).replace(/\s+/g, ' ').trim();
		if (!/^(import|from)\s/.test(code)) continue;

		const parts = splitSimpleStatements(code);
		const kept: string[] = [];
		const lifted: ImportRecord[] = [];
		let understood = true;
		for (const part of parts) {
			if (!/^(import|from)\s/.test(part)) {
				kept.push(part);
				continue;
			}
			const recs = parseImportStatement(part);
			if (!recs) {
				understood = false; // an import we cannot re-render: leave the whole line be
				break;
			}
			lifted.push(...recs);
		}
		if (!understood || !lifted.length) continue;

		for (const rec of lifted) {
			const key = renderImport(rec);
			if (seen.has(key)) continue;
			seen.add(key);
			statements.push(key);
		}
		edits.push({ start: line.start, end: line.end, text: kept.length ? kept.join('; ') + '\n' : '' });
	}

	if (!edits.length) return { statements: [], source: src, changed: false };

	// Rebuild the source without the lifted lines, remembering each SEAM: the exact
	// offset a whole line was cut out of. Tidying is done at those offsets only —
	// a global `\n{3,}` collapse would also reformat the inside of a docstring that
	// happens to share the cell.
	let out = '';
	const seams: number[] = [];
	let cursor = 0;
	for (const e of edits) {
		out += src.slice(cursor, e.start);
		if (!e.text) seams.push(out.length); // a rewritten line leaves content, not a seam
		out += e.text;
		cursor = e.end;
	}
	out += src.slice(cursor);

	// Right-to-left, so an earlier seam's offset is never invalidated. A seam at the
	// very top swallows the blank run the import block left above the code; anywhere
	// else, the newlines that closed around the gap collapse back to a single blank
	// line at most.
	for (let i = seams.length - 1; i >= 0; i--) {
		const p = seams[i];
		let before = 0;
		while (p - before - 1 >= 0 && out[p - before - 1] === '\n') before++;
		let after = 0;
		while (p + after < out.length && out[p + after] === '\n') after++;
		if (p - before === 0) {
			out = out.slice(0, p) + out.slice(p + after); // leading blank lines
			continue;
		}
		const excess = before + after - 2;
		if (excess > 0) out = out.slice(0, p) + '\n'.repeat(Math.max(0, after - excess)) + out.slice(p + after);
	}

	return { statements, source: out.replace(/\s+$/, ''), changed: true };
}

/** Does `source` hold at least one module-level import? */
export function hasTopLevelImports(source: string | null | undefined): boolean {
	return extractTopLevelImports(source).statements.length > 0;
}

/**
 * Is `source` nothing but module-level imports, comments and blank lines? Such a
 * cell can be ADOPTED as the notebook's imports cell rather than having a second
 * one created above it (a notebook whose first cell is already the import block
 * is the overwhelmingly common shape).
 */
export function isImportsOnly(source: string | null | undefined): boolean {
	const { source: rest } = extractTopLevelImports(source);
	return logicalLines(rest).every((l) => stripComments(l.raw).trim() === '');
}

/**
 * Render records as the imports cell's body: `__future__` first (the language
 * requires it), then plain `import` lines, then absolute `from … import` lines,
 * then relative ones — each group sorted and separated by a blank line. Names of
 * the same module merge onto one `from` line.
 *
 * Deliberately NOT isort's stdlib/third-party/local grouping: that needs a
 * package classification Cellar has no business guessing, and a wrong guess
 * reshuffles a human's file on every agent write. Sorting is by code unit so the
 * result is byte-stable across machines and locales.
 */
export function renderImportsBlock(records: ImportRecord[]): string {
	/** A `from`-import group: one target module, its bound names keyed by render string. */
	interface FromGroup {
		level: number;
		module: string;
		names: Map<string, ImportRecordFrom>;
	}
	const future: ImportRecordFrom[] = [];
	const plain = new Map<string, ImportRecordPlain>(); // groupKey → record
	const froms = new Map<string, FromGroup>(); // groupKey → { level, module, names: Map<renderKey, rec> }

	for (const rec of records) {
		if (rec.kind === 'from' && rec.level === 0 && rec.module === '__future__') {
			if (!future.some((r) => r.name === rec.name && r.alias === rec.alias)) future.push(rec);
			continue;
		}
		if (rec.kind === 'import') {
			plain.set(renderImport(rec), rec);
			continue;
		}
		const key = `${rec.level}:${rec.module}`;
		const group = froms.get(key) ?? { level: rec.level, module: rec.module, names: new Map() };
		group.names.set(renderImport(rec), rec);
		froms.set(key, group);
	}

	const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
	const groups: string[][] = [];

	if (future.length) {
		const names = future
			.map((r) => (r.alias ? `${r.name} as ${r.alias}` : r.name))
			.sort(byCodeUnit);
		groups.push([`from __future__ import ${names.join(', ')}`]);
	}

	const plainLines = [...plain.values()]
		.sort((a, b) => byCodeUnit(a.module, b.module) || byCodeUnit(a.alias ?? '', b.alias ?? ''))
		.map(renderImport);
	if (plainLines.length) groups.push(plainLines);

	const renderFrom = (g: FromGroup): string => {
		const names = [...g.names.values()]
			.sort((a, b) => byCodeUnit(a.name, b.name) || byCodeUnit(a.alias ?? '', b.alias ?? ''))
			.map((r) => (r.alias ? `${r.name} as ${r.alias}` : r.name));
		return `from ${'.'.repeat(g.level)}${g.module} import ${names.join(', ')}`;
	};
	const sortFroms = (list: FromGroup[]): string[] =>
		list.sort((a, b) => byCodeUnit(a.module, b.module) || a.level - b.level).map(renderFrom);

	// Absolute from-imports, then relative ones — their own group, as a human would
	// write them.
	const all = [...froms.values()];
	const absolute = sortFroms(all.filter((g) => g.level === 0));
	const relative = sortFroms(all.filter((g) => g.level > 0));
	if (absolute.length) groups.push(absolute);
	if (relative.length) groups.push(relative);

	return groups.map((g) => g.join('\n')).join('\n\n');
}

/**
 * Merge `incoming` canonical import statements into the imports cell's `existing`
 * source. Returns the new source and the statements that were genuinely NEW.
 *
 * When nothing is new the existing source is returned UNTOUCHED — not re-rendered.
 * That is what makes "Consolidate imports" idempotent in the strong sense: run it
 * twice and the second run produces no document change at all, so it cannot churn
 * a human's hand-formatted import block (or its comments) on every agent write.
 *
 * Non-import content already in the imports cell is preserved below the rendered
 * block, so a cell that also holds, say, a `pd.set_option(...)` keeps it.
 */
export function mergeImportSources(
	existing: string | null | undefined,
	incoming: string[]
): { source: string; added: string[] } {
	const current = extractTopLevelImports(existing ?? '');
	const have = new Set(current.statements);
	const added: string[] = [];
	for (const stmt of incoming) {
		if (have.has(stmt)) continue;
		have.add(stmt);
		added.push(stmt);
	}
	if (!added.length) return { source: existing ?? '', added: [] };

	const block = renderImportsBlock(recordsOf([...current.statements, ...added]));
	const leftover = current.source.trim();
	return { source: leftover ? `${block}\n\n${leftover}` : block, added };
}
