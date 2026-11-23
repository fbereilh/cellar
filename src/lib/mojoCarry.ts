/**
 * Cellar - Mojo declaration carry-over (the pure rules).
 *
 * Every Mojo cell runs as its own `mojo run` subprocess (see `server/mojo.ts`), so
 * nothing a cell DECLARES outlives it. That is Modular's design and it makes a
 * notebook unusable for the ordinary workflow: define a struct in one cell, use it
 * in the next. Evcxr solves the same problem for Rust by carrying items forward,
 * and this module is that half for Mojo: the declarations of cells that already
 * ran are appended to the program of the cell that runs now.
 *
 * WHAT CARRIES, AND WHAT DOES NOT. Top-level `def`, `struct`, `trait`, `comptime`
 * (and the legacy `alias`) declarations and `import` statements carry. VALUES DO
 * NOT: a `var` lives inside a `main` that already exited with its process, and
 * re-running an earlier cell's `main` to rebuild it would repeat that cell's side
 * effects. `main` itself never carries.
 *
 * THREE DECISIONS, each one measured against a real Mojo 1.2.0:
 *
 * 1. CARRIED CODE GOES AFTER THE CELL'S OWN SOURCE. Mojo resolves a declaration
 *    that appears later in the file (a struct, a def, an import and a comptime all
 *    resolve from a `main` above them). So the cell's text stays at line 1 and a
 *    compiler diagnostic about it keeps a cell-relative line number. A line number
 *    past the cell's own length names carried code.
 *
 * 2. ONLY WHAT THE CELL REACHES IS CARRIED - a dependency closure, not "everything
 *    so far". A redefinition with an identical signature is a hard compile error,
 *    so carrying everything would break the notebook Modular's docs teach, where
 *    every cell is a complete program that re-declares its own helpers. Two rules
 *    prevent that: a name the running cell declares itself SHADOWS every carried
 *    one, and a carried block is included only when the cell (or a block already
 *    included) mentions its name. A self-contained cell therefore compiles
 *    byte-for-byte as it always did.
 *
 *    "Mentions" is a plain identifier scan of the text, strings and comments
 *    included. Over-inclusion is the safe direction: an unused declaration or a
 *    repeated import costs nothing (both measured), while a missed one is the
 *    `use of unknown declaration` this feature exists to remove.
 *
 * 3. PER NAME, THE CELL THAT RAN LAST WINS, with every block of that name in that
 *    cell (so overloads written together travel together). Re-running a cell with a
 *    changed definition replaces the old one, which is what a notebook user means.
 *
 * A CELL WITH NO `main` GETS A NO-OP ONE. A module without `main` is refused by
 * `mojo run`, so a cell holding only definitions could never run "ok" and could
 * never contribute them. `def main(): pass` appended to it compiles and prints
 * nothing.
 *
 * STATED LIMITS, deliberate:
 *   - Overloads of one name split across cells are not merged. The latest cell wins.
 *   - Carried code compiled when its own cell ran. If a later cell has since
 *     redefined something it depends on incompatibly, the error names carried code.
 *   - A `from x import *` exposes no names to scan for, so it carries only alongside
 *     another block from its own cell.
 *
 * Browser-safe and pure: no I/O, no server imports. `server/mojo-session.ts` owns
 * WHICH cells have run. This module only decides what a program is made of.
 */

import { hasMojoHeader } from './cellMagic';
import { hasTopLevelMain, scanLines } from './mojoExport';

export type MojoDeclKind = 'def' | 'struct' | 'trait' | 'comptime' | 'import' | 'other';

/** One top-level statement of a Mojo source, with the names it binds at file scope. */
export interface MojoBlock {
	kind: MojoDeclKind;
	/** Names this block declares. Empty for `other` and for a star import. */
	names: string[];
	/** The block's exact text, without trailing blank or comment lines. */
	text: string;
}

/** A cell that already ran successfully, as the carry-over rule needs to see it. */
export interface CarriedCell {
	/** Run order within the session. Higher ran later. */
	seq: number;
	/** The bare Mojo source that ran. */
	source: string;
}

export interface MojoProgram {
	/** The Mojo text to compile. Starts with the cell's own source, unchanged. */
	program: string;
	/** True when a no-op `main` was appended because the cell declares none. */
	synthesizedMain: boolean;
	/** Names taken from earlier cells, in the order their blocks are appended. */
	carried: string[];
}

/** The line that separates a cell's own source from what Cellar appended to it. */
export const MOJO_CARRY_MARKER = '# -- carried over by Cellar from cells that ran earlier in this session --';

/** The entry point appended to a cell that declares none. */
export const MOJO_SYNTHESIZED_MAIN = 'def main():\n    pass';

const IDENT = '[A-Za-z_][A-Za-z0-9_]*';
const DECL_RE = new RegExp(`^(def|struct|trait|comptime|alias)\\s+(${IDENT})`);
const FROM_IMPORT_RE = /^from\s+\S+\s+import\b([\s\S]*)$/;
const PLAIN_IMPORT_RE = /^import\b([\s\S]*)$/;
const IDENT_RE = new RegExp(IDENT, 'g');
const NAME_RE = new RegExp(`^${IDENT}$`);
const NOT_A_NAME = new Set(['if', 'for', 'while', 'assert']);

/** Drop a trailing `# comment` from each line. Import lists hold no string literals. */
function stripLineComments(text: string): string {
	return text
		.split('\n')
		.map((l) => {
			const at = l.indexOf('#');
			return at === -1 ? l : l.slice(0, at);
		})
		.join('\n');
}

/** The names an import list binds: `a, b as c` binds `a` and `c`. A `*` binds none we can name. */
function importedNames(list: string, dotted: boolean): string[] {
	const names: string[] = [];
	for (const raw of stripLineComments(list).replace(/[()\\]/g, ' ').split(',')) {
		const item = raw.trim().replace(/\s+/g, ' ');
		if (item === '' || item === '*') continue;
		const alias = / as (\S+)$/.exec(item);
		// `import a.b.c` binds the first segment, which is how the code then spells it.
		const name = alias ? alias[1] : dotted ? item.split('.')[0] : item;
		if (NAME_RE.test(name)) names.push(name);
	}
	return names;
}

function classify(text: string): { kind: MojoDeclKind; names: string[] } {
	// A decorated declaration is classified by the line under its decorators.
	const lines = scanLines(text);
	const head = lines.find((l) => !l.blank && !l.comment && !l.inString && !l.continued && !l.text.startsWith('@'));
	const body = head ? text.slice(head.start) : text;
	const decl = DECL_RE.exec(body);
	// `comptime if` / `comptime for` are statements, not a named declaration.
	if (decl && !NOT_A_NAME.has(decl[2])) {
		const kind = decl[1] === 'alias' ? 'comptime' : (decl[1] as MojoDeclKind);
		return { kind, names: [decl[2]] };
	}
	const from = FROM_IMPORT_RE.exec(body);
	if (from) return { kind: 'import', names: importedNames(from[1], false) };
	const plain = PLAIN_IMPORT_RE.exec(body);
	if (plain) return { kind: 'import', names: importedNames(plain[1], true) };
	return { kind: 'other', names: [] };
}

/**
 * Split a Mojo source into its top-level statements.
 *
 * A statement starts at a column-0 line that is not blank, not a comment, not
 * inside a triple-quoted string and not a bracketed continuation (the same four
 * tests `mojoExport.ts` uses to find `main`, through the same scanner). It runs to
 * the next such line. Decorator lines belong to the declaration below them.
 */
export function topLevelBlocks(source: string | null | undefined): MojoBlock[] {
	const src = String(source ?? '');
	const lines = scanLines(src);
	const isHead = (i: number): boolean => {
		const l = lines[i];
		return !l.blank && !l.comment && !l.inString && !l.continued && l.indent === 0;
	};
	const heads: number[] = [];
	for (let i = 0; i < lines.length; i++) if (isHead(i)) heads.push(i);

	const out: MojoBlock[] = [];
	let start = -1; // the first decorator line of a pending declaration
	for (let h = 0; h < heads.length; h++) {
		const at = heads[h];
		const next = h + 1 < heads.length ? heads[h + 1] : lines.length;
		if (start === -1) start = at;
		// A decorator's own statement ends where the next head begins. Keep going.
		if (lines[at].text.startsWith('@') && h + 1 < heads.length) continue;
		let last = next - 1;
		while (last > at && (lines[last].blank || lines[last].comment)) last--;
		const text = src.slice(lines[start].start, lines[last].end).replace(/\n$/, '');
		out.push({ ...classify(text), text });
		start = -1;
	}
	return out;
}

/** Every identifier-shaped word in a text. Deliberately includes strings and comments. */
function identifiers(text: string): Set<string> {
	return new Set(text.match(IDENT_RE) ?? []);
}

interface Provided {
	seq: number;
	/** Position of the cell among the carried cells, to keep one cell's blocks apart. */
	cell: number;
	/** Position of the block inside its cell. */
	index: number;
	block: MojoBlock;
}

/**
 * Build the Mojo program for one cell run.
 *
 * `carried` holds the cells that already ran successfully in this session,
 * without the running cell itself: a re-run replaces its own old definitions.
 */
export function buildMojoProgram(cellSource: string | null | undefined, carried: readonly CarriedCell[]): MojoProgram {
	const source = String(cellSource ?? '');
	// An empty cell runs nothing, and a `%%mojo …` header is the user speaking to
	// the magic directly (it may be `%%mojo build`). Both are left exactly alone.
	if (source.trim() === '' || hasMojoHeader(source)) return { program: source, synthesizedMain: false, carried: [] };

	const own = new Set<string>();
	for (const b of topLevelBlocks(source)) for (const n of b.names) own.add(n);

	// Per name: the blocks of the cell that ran last. Walking in run order lets a
	// later cell simply overwrite an earlier one's entry.
	const providers = new Map<string, Provided[]>();
	const cellImports = new Map<number, Provided[]>();
	const inRunOrder = carried.map((c, cell) => ({ c, cell })).sort((x, y) => x.c.seq - y.c.seq || x.cell - y.cell);
	for (const { c, cell } of inRunOrder) {
		if (hasMojoHeader(c.source)) continue;
		const mine = new Map<string, Provided[]>();
		topLevelBlocks(c.source).forEach((block, index) => {
			if (block.kind === 'other') return;
			if (block.kind === 'def' && block.names[0] === 'main') return;
			const entry: Provided = { seq: c.seq, cell, index, block };
			if (block.kind === 'import') cellImports.set(cell, [...(cellImports.get(cell) ?? []), entry]);
			for (const name of block.names) mine.set(name, [...(mine.get(name) ?? []), entry]);
		});
		for (const [name, entries] of mine) providers.set(name, entries);
	}

	const included = new Set<Provided>();
	const visited = new Set<string>();
	const queue = [...identifiers(source)];
	const include = (p: Provided) => {
		if (included.has(p)) return;
		included.add(p);
		for (const id of identifiers(p.block.text)) queue.push(id);
	};
	while (queue.length > 0) {
		const name = queue.pop() as string;
		if (visited.has(name) || own.has(name)) continue;
		visited.add(name);
		for (const p of providers.get(name) ?? []) {
			include(p);
			// A carried declaration compiled against its own cell's imports, which may
			// bind names no scan can see (`from x import *`).
			if (p.block.kind !== 'import') {
				for (const imp of cellImports.get(p.cell) ?? []) {
					if (imp.block.names.length > 0 && imp.block.names.every((n) => own.has(n))) continue;
					include(imp);
				}
			}
		}
	}

	const synthesizedMain = !hasTopLevelMain(source);
	const blocks = [...included].sort((a, b) => a.seq - b.seq || a.cell - b.cell || a.index - b.index);
	// Two cells importing the same thing would repeat it. Harmless, but noise.
	const texts: string[] = [];
	for (const p of blocks) if (!(p.block.kind === 'import' && texts.includes(p.block.text))) texts.push(p.block.text);

	let program = source;
	if (synthesizedMain || texts.length > 0) {
		if (!program.endsWith('\n')) program += '\n';
		if (synthesizedMain) program += `\n${MOJO_SYNTHESIZED_MAIN}\n`;
		if (texts.length > 0) program += `\n${MOJO_CARRY_MARKER}\n${texts.join('\n\n')}\n`;
	}
	const names: string[] = [];
	for (const p of blocks) for (const n of p.block.names) if (!names.includes(n)) names.push(n);
	return { program, synthesizedMain, carried: names };
}
