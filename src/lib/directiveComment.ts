/**
 * nbdev / Quarto `#|` DIRECTIVE comments, told apart from ordinary comments.
 *
 * A line like `#| default_exp training` is not a dead comment: Cellar ACTS on it
 * (`server/export-py.ts` resolves `#|default_exp` into the notebook's export
 * target, and nbdev reads `#| export`, `#| hide`, … the same way). The Python
 * grammar tags the whole line as an ordinary `Comment`, so a tag-based rule in
 * `editorTheme.ts` cannot separate the two — hence this module, which finds the
 * directive ranges and hands them to the two render paths as an extra class:
 *
 *   - the live editor, via {@link directiveCommentHighlight} (a decoration plugin,
 *     the `cmSearchHighlight.ts` shape);
 *   - the static, no-editor render, via `staticHighlight.ts`, which already has the
 *     parse tree in hand.
 *
 * Both call {@link directiveCommentRanges}, so the two surfaces cannot drift: a
 * directive looks identical before and after the lazy editor is summoned, which is
 * the same pixel-for-pixel contract `staticHighlight.ts` exists to keep. The colour
 * lives in `app.css` beside `--cellar-cm-tok-comment` (one definition, resolved by
 * `light-dark()` like every other token), NOT here — see {@link DIRECTIVE_CLASS}.
 *
 * PRESENTATION ONLY. Nothing here parses a directive's NAME or changes what any
 * directive DOES; `storedExportTarget` in `server/export-py.ts` remains the sole
 * reader of `#|default_exp`.
 *
 * TWO RULES DECIDE WHAT COUNTS, and both are deliberate:
 *
 *  1. **The grammar must agree it is a comment.** Ranges are taken from `Comment`
 *     nodes in the parse tree, never from a regex over raw text — so a `#|` line
 *     inside a triple-quoted string (or any other literal) is string content and
 *     stays string-coloured. That is also what keeps this cheap on the static path,
 *     where the tree has already been parsed for highlighting anyway.
 *  2. **Every `#|` line is a directive, not only the ones Cellar understands.**
 *     `#|` is a real syntactic class in the nbdev/Quarto ecosystem regardless of
 *     whether THIS tool acts on that particular one; highlighting only the
 *     recognised subset would render a valid-but-unrecognised nbdev directive as a
 *     dead comment, which is exactly the confusion this fixes. So no directive-name
 *     allowlist is kept here, and adding one would be a regression.
 *
 * The shape matched is nbdev's own: a comment that is the FIRST thing on its line
 * (only whitespace may precede it) whose text opens `#`, optional whitespace, `|` —
 * i.e. the same shape `storedExportTarget` matches with
 * `/^\s*#\s*\|\s*default_exp\s+([^\s#]+)/m`. A TRAILING comment (`x = 1  #| foo`)
 * is not a directive: nbdev requires its own line, and so does that regex's `^`.
 */

import { syntaxTree } from '@codemirror/language';
import { Decoration, ViewPlugin, EditorView } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import type { Tree } from '@lezer/common';

/**
 * The class both render paths put on a directive comment. Its colour is
 * `--cellar-cm-tok-directive`, defined ONCE in `app.css` next to the other
 * `--cellar-cm-tok-*` vars and applied there under a two-class selector
 * (`.cm-content .cellar-directive`, `.cm-static-content .cellar-directive`) so it
 * out-specifies the highlight style's own single-class comment rule in BOTH
 * surfaces without depending on stylesheet order.
 */
export const DIRECTIVE_CLASS = 'cellar-directive';

/** The directive opener, anchored at the start of a comment token's own text. */
const DIRECTIVE_OPENER = /^#[ \t]*\|/;

/** A half-open `[from, to)` document range. */
export interface DirectiveRange {
	from: number;
	to: number;
}

/** True when only whitespace separates `pos` from the start of its line. */
function atLineStart(source: string, pos: number): boolean {
	for (let i = pos - 1; i >= 0; i--) {
		const ch = source[i];
		if (ch === '\n') return true;
		if (ch !== ' ' && ch !== '\t' && ch !== '\r') return false;
	}
	return true; // reached the start of the document
}

/**
 * Every `#|` directive comment in `source` between `from` and `to`, in document
 * order (so the result can feed a `RangeSetBuilder` directly). `tree` must be the
 * parse of `source`: a range is emitted only for a node the grammar itself calls a
 * `Comment`, which is what keeps `#|` inside a string from being decorated.
 *
 * Pure and DOM-free — the editor plugin and the static renderer share it.
 */
export function directiveCommentRanges(
	source: string,
	tree: Tree,
	from = 0,
	to = source.length
): DirectiveRange[] {
	const out: DirectiveRange[] = [];
	tree.iterate({
		from,
		to,
		enter(node) {
			// Grammar-agnostic: Python calls it `Comment`, other grammars `LineComment`.
			if (!node.name.endsWith('Comment')) return;
			const text = source.slice(node.from, node.to);
			if (!DIRECTIVE_OPENER.test(text)) return;
			if (!atLineStart(source, node.from)) return; // a TRAILING comment is not a directive
			out.push({ from: node.from, to: node.to });
		}
	});
	return out;
}

const directiveMark = Decoration.mark({ class: DIRECTIVE_CLASS });

/**
 * The editor extension. Add it BESIDE a Python-family grammar (see `Cell.svelte`'s
 * `langFor` and `FileTab.svelte`'s), never globally: `#|` means nothing in YAML,
 * TOML or markdown, and decorating a comment there would invent a directive class
 * that ecosystem does not have.
 */
export const directiveCommentHighlight = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;
		constructor(view: EditorView) {
			this.decorations = this.build(view);
		}
		update(u: ViewUpdate) {
			// The tree identity is checked as well as doc/viewport: CodeMirror parses
			// incrementally in the background, so a large document's comments can be
			// tokenized a beat AFTER the change that introduced them.
			if (
				u.docChanged ||
				u.viewportChanged ||
				syntaxTree(u.startState) !== syntaxTree(u.state)
			)
				this.decorations = this.build(u.view);
		}
		build(view: EditorView): DecorationSet {
			const builder = new RangeSetBuilder<Decoration>();
			const source = view.state.doc.toString();
			const tree = syntaxTree(view.state);
			// Visible ranges only, and they arrive sorted — which is what the builder
			// requires, and what keeps this off the whole document on every update.
			// `tree.iterate` enters a node that merely OVERLAPS its window, so a
			// comment straddling two visible ranges would otherwise be added twice;
			// `lastEnd` drops the repeat (directive ranges never overlap each other).
			let lastEnd = -1;
			for (const { from, to } of view.visibleRanges)
				for (const r of directiveCommentRanges(source, tree, from, to)) {
					if (r.from < lastEnd) continue;
					builder.add(r.from, r.to, directiveMark);
					lastEnd = r.to;
				}
			return builder.finish();
		}
	},
	{ decorations: (v) => v.decorations }
);
