/**
 * Cellar - assembling a notebook's Mojo cells into ONE `.mojo` module.
 *
 * The Python export (`server/export-py.ts`) concatenates the marked cells and
 * stamps a header; a Mojo target reuses that whole pipeline, because - measured
 * against Mojo 1.0.0 / max 26.5.0 - a Mojo module is BETTER suited to it than a
 * Python one:
 *
 *   - A `.mojo` file is an importable namespace with the same `import x` /
 *     `from x import y` syntax, and `__init__.mojo` means what `__init__.py`
 *     does.
 *   - A Mojo module has NO module-level execution at all: a bare statement or a
 *     module-level `var` is a hard compile error. So a module is DECLARATIONS
 *     ONLY, and cell ORDER does not matter - unlike Python, where a generated
 *     module runs top-down on import and a reordered export silently means
 *     something else.
 *   - Every remaining collision is a hard compile error rather than a silent
 *     divergence: a duplicate `struct`/`comptime`, or a `def` redefined with an
 *     identical signature. Same-name `def`s with different signatures overload
 *     cleanly, and duplicate import lines are fine.
 *
 * TWO transforms are all that separates a real Mojo notebook from a valid module,
 * and this file owns both:
 *
 *   1. **The `%%mojo` magic line.** A mojo cell may store its source with the
 *      header (pasted from Modular's own docs, or a `%%mojo build …` subcommand),
 *      and `%%mojo` is not valid Mojo. It is stripped.
 *   2. **`def main()`.** Modular's default `%%mojo` mode RUNS each cell as a whole
 *      program, so it forces a `main` into every cell - 5 of 5 cells in Modular's
 *      own documentation notebook - and two `main`s in one file is a hard
 *      `redefinition of function 'main'`. Measured: concatenating those 5 cells
 *      as written produces 4 errors, ALL of them `main`, and nothing else.
 *
 * ## The `main` rule, and why it is "the last one wins" rather than "drop them all"
 *
 * Among the exported cells, the LAST cell carrying a top-level `def main()` keeps
 * it; every earlier one loses its `main` block. Nothing else about those cells is
 * touched.
 *
 * Keeping one is worth doing because an importer does NOT inherit an imported
 * module's `main` (measured), so a module carrying exactly one is simultaneously
 * an importable library AND a program: `mojo run vectors.mojo`, or
 * `mojo build vectors.mojo -o vectors`. Notebook -> standalone executable is a
 * story the `.py` export structurally cannot tell.
 *
 * The LAST cell WITH a main rather than strictly the final exported cell: under
 * Modular's mode every cell has one, so the two readings coincide on a typical
 * notebook, and this one still yields a runnable module when the final exported
 * cell happens to be a helper.
 *
 * ## The loss is never silent, and it is announced in THREE places
 *
 * Dropping a `main` discards code the user wrote, so:
 *
 *   - **On the cell, in the notebook** - the surface that matters, because it is
 *     where the user is editing. `mojoMainDroppedIds` is the rule the browser
 *     derives that from, and it is the SAME rule the exporter applies, so the
 *     badge can never disagree with the file.
 *   - **In the generated module**, as a comment at each drop site
 *     (`MAIN_DROPPED_COMMENT`), for someone reading the `.mojo` who never saw the
 *     notebook.
 *   - **Once for the notebook**, as an `ExportHazard` naming every affected cell,
 *     which rides the export bar, the manual-export notice and the agent surface.
 *
 * ## KNOWN, ACCEPTED HAZARD (captain's decision, 2026-09-02)
 *
 * The entry point is POSITIONAL, so reordering cells - or appending a new
 * main-carrying cell - silently moves which `main` survives. An explicit per-cell
 * "this is the entry point" marker is a possible later increment and is
 * deliberately NOT in scope; the per-cell badge is what keeps the current choice
 * visible while editing.
 *
 * Browser-safe (no `node:` imports), because `LiveNotebook.svelte` derives the
 * per-cell badge from these same functions rather than from a second copy.
 */

import { hasMojoHeader } from './cellMagic';
import { isExportCell, type ExportLanguage } from './exportRole';
import type { CellMetadata } from './server/types';

/** The minimal cell shape these rules read (Cell/CellView/UICell are assignable). */
type MojoExportCell = {
	id: string;
	cell_type?: string;
	source?: string;
	metadata?: CellMetadata | null;
};

/**
 * The comment left in the generated module where a cell's `main` was removed.
 *
 * `#` is a Mojo comment, so it costs the module nothing, and it is placed AT the
 * drop site rather than in the header so a reader finds it beside the code that
 * is missing. It says what was removed and why in one breath - a reader of the
 * `.mojo` has no notebook in front of them.
 */
export const MAIN_DROPPED_COMMENT =
	"# CELLAR: this cell's `def main()` was NOT exported - a later exported cell\n" +
	'# defines main, and a Mojo module can hold only one.';

/** The visible label of the per-cell badge (kept here so UI and tests share it). */
export const MAIN_DROPPED_BADGE = 'main not exported';

/**
 * The per-cell warning's full sentence: what is not exported, and why.
 *
 * ONE wording, so the badge tooltip, the notebook-level hazard and any future
 * surface cannot describe the same cell differently (the `exportHazard.ts`
 * precedent). It states both halves the captain asked for - that this cell's
 * `main` is not being exported, and that a LATER exported cell has one.
 */
export const MAIN_DROPPED_REASON =
	"This cell's `def main()` is not exported: a later exported cell also defines main, " +
	'and a Mojo module can hold only one. The rest of this cell is exported normally.';

/** A top-level `def main()` block, as character offsets into the cell source. */
export interface MainBlock {
	start: number;
	end: number;
}

/**
 * `def main(` / `def main[` at the start of a logical line. Mojo 1.0 REMOVED `fn`
 * (`error: 'fn' has been removed; use 'def' instead`), so `def` is the only form,
 * and `main` may carry compile-time parameters in brackets before its arguments.
 */
const MAIN_DEF_RE = /^def\s+main\s*[([]/;

/** A line that is nothing but a decorator (`@parameter`, `@always_inline(...)`). */
const DECORATOR_RE = /^@/;

interface ScannedLine {
	/** Offset of the line's first character. */
	start: number;
	/** Offset just past the line's terminating newline (or of end-of-source). */
	end: number;
	text: string;
	indent: number;
	blank: boolean;
	/**
	 * The line is nothing but a `#` comment. Load-bearing rather than decoration: a
	 * comment produces no INDENT/DEDENT token, so a column-0 comment INSIDE a suite
	 * is legal (measured against Mojo 1.0.0 - `def main():` / `    print(1)` /
	 * `# a separator` / `    print(2)` compiles and runs, printing 1 then 2). Read as
	 * a top-level line it ended the body early and orphaned the indented code after
	 * it at file scope, which is a hard compile error in the generated module.
	 */
	comment: boolean;
	/** True when the line's first character is inside an unterminated `"""`/`'''`. */
	inString: boolean;
}

/**
 * Split a Mojo source into lines, marking the ones that begin inside a
 * triple-quoted string.
 *
 * The string tracking is not decoration: a docstring inside a function body is
 * indented at its opening quote but its CONTINUATION lines may sit at column 0,
 * so a plain indent scan would read `def main(` inside a docstring as a real
 * top-level definition and cut a hole in the middle of a string literal. Only
 * triple-quoted strings can span lines, so single-quoted ones need no state -
 * they open and close within one line - but their contents are skipped so a
 * `"""` appearing inside one does not open a block.
 */
function scanLines(src: string): ScannedLine[] {
	const out: ScannedLine[] = [];
	let i = 0;
	let triple: '"""' | "'''" | null = null;
	while (i <= src.length) {
		const nl = src.indexOf('\n', i);
		const stop = nl === -1 ? src.length : nl;
		const text = src.slice(i, stop);
		const trimmed = text.trim();
		out.push({
			start: i,
			end: nl === -1 ? src.length : nl + 1,
			text,
			indent: text.length - text.trimStart().length,
			blank: trimmed === '',
			// A `#` opening a line that STARTS inside a triple-quoted string is string
			// content, never a comment, so the state carried from the previous line
			// decides this too.
			comment: triple === null && trimmed.startsWith('#'),
			inString: triple !== null
		});
		// Walk the line's characters to carry the triple-quote state to the next one.
		for (let j = 0; j < text.length; ) {
			if (triple) {
				if (text.startsWith(triple, j)) {
					triple = null;
					j += 3;
				} else j++;
				continue;
			}
			if (text.startsWith('"""', j) || text.startsWith("'''", j)) {
				triple = text.slice(j, j + 3) as '"""' | "'''";
				j += 3;
				continue;
			}
			const ch = text[j];
			if (ch === '#') break; // a comment runs to end of line
			if (ch === '"' || ch === "'") {
				// A single-quoted string: skip to its close so a `"""` inside it is inert.
				j++;
				while (j < text.length && text[j] !== ch) j += text[j] === '\\' ? 2 : 1;
				j++;
				continue;
			}
			j++;
		}
		if (nl === -1) break;
		i = nl + 1;
	}
	return out;
}

/** Net bracket depth a line contributes, ignoring comments and string literals. */
function bracketDelta(text: string): number {
	let depth = 0;
	for (let j = 0; j < text.length; j++) {
		const ch = text[j];
		if (ch === '#') break;
		if (ch === '"' || ch === "'") {
			const q = ch;
			j++;
			while (j < text.length && text[j] !== q) j += text[j] === '\\' ? 2 : 1;
			continue;
		}
		if (ch === '(' || ch === '[' || ch === '{') depth++;
		else if (ch === ')' || ch === ']' || ch === '}') depth--;
	}
	return depth;
}

/**
 * The span of a top-level `def main(...)` block in a Mojo cell, or null.
 *
 * The block is the `def` line (continued across lines while its brackets are
 * open), every following blank, COMMENT or INDENTED line, and any decorator lines
 * immediately above it - a decorator left behind with its `def` removed is a
 * compile error, which is the one thing this transform must never produce.
 * Trailing blank and comment lines are left OUT of the span, so they stay in the
 * residue and the surrounding blocks keep their own spacing.
 *
 * The FIRST such block wins. A cell with two top-level `main`s does not compile
 * on its own either, so there is no honest second answer to give.
 */
export function findTopLevelMain(source: string | null | undefined): MainBlock | null {
	const src = String(source ?? '');
	const lines = scanLines(src);
	let at = -1;
	for (let i = 0; i < lines.length; i++) {
		const l = lines[i];
		if (l.inString || l.blank || l.indent !== 0) continue;
		if (MAIN_DEF_RE.test(l.text)) {
			at = i;
			break;
		}
	}
	if (at === -1) return null;
	// Decorators immediately above, contiguously (blank lines between a decorator
	// and its `def` are legal but vanishingly rare; a blank stops the walk).
	let first = at;
	while (first > 0) {
		const prev = lines[first - 1];
		if (prev.inString || prev.blank || prev.indent !== 0 || !DECORATOR_RE.test(prev.text)) break;
		first--;
	}
	// The `def` header, continued while its brackets stay open.
	let last = at;
	let depth = bracketDelta(lines[at].text);
	while (depth > 0 && last + 1 < lines.length) {
		last++;
		depth += bracketDelta(lines[last].text);
	}
	// The body: every following blank, COMMENT or indented line, up to the next
	// top-level one. A comment-only line at column 0 does not end a suite (see
	// `ScannedLine.comment`), so it may not end the block either.
	let end = last;
	for (let i = last + 1; i < lines.length; i++) {
		const l = lines[i];
		if (l.inString || l.blank || l.comment || l.indent > 0) {
			end = i;
			continue;
		}
		break;
	}
	// Give trailing blank AND comment lines back to the residue. A comment sitting
	// between `main` and the next top-level definition belongs to what FOLLOWS, so
	// swallowing it into the dropped block would silently delete it; one INSIDE the
	// body, with indented code after it, is not trailing and stays in the block.
	while (end > last && (lines[end].blank || lines[end].comment)) end--;
	return { start: lines[first].start, end: lines[end].end };
}

/** Does this Mojo source define a top-level `main`? */
export function hasTopLevelMain(source: string | null | undefined): boolean {
	return findTopLevelMain(source) !== null;
}

/**
 * Strip a leading `%%mojo …` cell-magic header, and any blank lines above it.
 *
 * `%%mojo` is IPython syntax, not Mojo (`error: unexpected token in expression`),
 * and it is Cellar's own run-time wrapper - so removing it restores exactly the
 * Mojo the user wrote. A source with no header is returned untouched, so this is
 * a no-op for the ordinary Cellar mojo cell whose stored source is already bare.
 */
export function stripMojoMagicHeader(source: string): string {
	if (!hasMojoHeader(source)) return source;
	// Cut through the magic LINE, which is the first NON-BLANK one and not simply
	// the first: IPython tolerates blank lines above a cell magic and
	// `cellMagicName` - the rule `hasMojoHeader` asks - skips them, so a source
	// opening with a newline is a `%%mojo` cell whose header sits on line 2. Cutting
	// at the first newline there removed the blank line and LEFT the header, which
	// is a hard compile error in the generated module (`error: unexpected token in
	// expression`, measured against Mojo 1.0.0) - and the cell is eligible for a
	// `.mojo` target precisely BECAUSE of that header, so it is exportable.
	let i = 0;
	while (i < source.length) {
		const nl = source.indexOf('\n', i);
		const stop = nl === -1 ? source.length : nl;
		if (source.slice(i, stop).trim() !== '') return nl === -1 ? '' : source.slice(nl + 1);
		if (nl === -1) break;
		i = nl + 1;
	}
	return '';
}

/**
 * Replace a cell's top-level `main` block with `MAIN_DROPPED_COMMENT`.
 *
 * Only the block goes: everything else the cell declares is exported verbatim,
 * which is what keeps the module's contents byte-identical to the cells that
 * produced them.
 */
export function dropMainBlock(source: string): string {
	const block = findTopLevelMain(source);
	if (!block) return source;
	return source.slice(0, block.start) + MAIN_DROPPED_COMMENT + '\n' + source.slice(block.end);
}

/**
 * Which of the exported sources keeps its `main`, and which lose theirs.
 *
 * `keep` is the index of the LAST source carrying a top-level `main` (null when
 * none does - a plain library module, which is a perfectly good outcome and no
 * kind of error). `dropped` lists every earlier main-carrying index, in document
 * order, which is also the order the notebook-level notice names them in.
 */
export function planMojoMains(sources: readonly string[]): { keep: number | null; dropped: number[] } {
	const carriers: number[] = [];
	sources.forEach((src, i) => {
		if (hasTopLevelMain(src)) carriers.push(i);
	});
	if (!carriers.length) return { keep: null, dropped: [] };
	return { keep: carriers[carriers.length - 1], dropped: carriers.slice(0, -1) };
}

/**
 * The exported sources as they will appear in the `.mojo` module: magic headers
 * stripped, and every `main` but the last replaced by the drop comment.
 *
 * ONE function for both halves of that rule, so a future edit cannot strip a
 * header without applying the `main` plan the badge and the hazard are derived
 * from - the plan is computed on the ALREADY-stripped sources, since a `%%mojo`
 * header does not change whether a cell defines `main` but a future transform
 * might.
 */
export function mojoModuleSources(exportedSources: readonly string[]): {
	sources: string[];
	dropped: number[];
} {
	const stripped = exportedSources.map((s) => stripMojoMagicHeader(s));
	const { dropped } = planMojoMains(stripped);
	const drop = new Set(dropped);
	return { sources: stripped.map((s, i) => (drop.has(i) ? dropMainBlock(s) : s)), dropped };
}

/**
 * The ids of the cells whose `main` the next export will DROP - what the notebook
 * renders its per-cell warning from.
 *
 * Derived from the same `isExportCell` filter and the same `planMojoMains` rule
 * the exporter runs, over the cells the browser already holds, so the badge is
 * exact and updates as the user types rather than waiting on a round trip: add a
 * `main` to a later exported cell and the earlier one's badge appears; remove it
 * and the badge clears.
 *
 * Empty for any target that is not `.mojo` - there is no Mojo module for the
 * warning to be about.
 */
export function mojoMainDroppedIds(
	cells: readonly MojoExportCell[] | null | undefined,
	lang: ExportLanguage | null
): Set<string> {
	const out = new Set<string>();
	if (lang !== 'mojo') return out;
	const exported = (cells ?? []).filter((c) => isExportCell(c, 'mojo'));
	const stripped = exported.map((c) => stripMojoMagicHeader(String(c.source ?? '')));
	for (const i of planMojoMains(stripped).dropped) out.add(exported[i].id);
	return out;
}
