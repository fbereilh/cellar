/**
 * CodeMirror search-highlight extension (Search P4) for the built cell editor.
 *
 * `@codemirror/search`'s own highlighter only paints when its panel is OPEN
 * (`searchHighlighter` returns `Decoration.none` while `!panel`), so we cannot just
 * drive `setSearchQuery` - we'd have to pop the panel in every code cell. Instead
 * this is a tiny decoration plugin that reuses the same `SearchQuery` matcher (so
 * case/whole-word semantics match the engine) and the same `.cm-searchMatch` /
 * `.cm-searchMatch-selected` classes the theme already styles (`editorTheme.ts`),
 * but is driven by our own state effect and paints without any panel.
 *
 * The query is pushed via {@link setCmSearch}; the plugin decorates every match in
 * the doc and marks the `activeOrdinal`-th one as selected. CM maintains the
 * decorations across its own re-renders (scroll, edit), so a highlighted cell stays
 * correct without us re-walking its DOM.
 */

import { StateEffect, StateField, RangeSetBuilder } from '@codemirror/state';
import { Decoration, ViewPlugin, EditorView } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { SearchQuery } from '@codemirror/search';

/** The current per-editor search spec, or null to clear. */
export interface CmSearchSpec {
	query: string;
	caseSensitive: boolean;
	wholeWord: boolean;
	/** 0-based index of the active match to emphasize, or null (none in this editor). */
	activeOrdinal: number | null;
}

export const setCmSearch = StateEffect.define<CmSearchSpec | null>();

const cmSearchField = StateField.define<CmSearchSpec | null>({
	create: () => null,
	update(value, tr) {
		for (const e of tr.effects) if (e.is(setCmSearch)) value = e.value;
		return value;
	}
});

const matchMark = Decoration.mark({ class: 'cm-searchMatch' });
const activeMark = Decoration.mark({ class: 'cm-searchMatch cm-searchMatch-selected' });

/** The active match's document range, for scroll-into-view (null if none). */
export function activeCmMatch(view: EditorView): { from: number; to: number } | null {
	const spec = view.state.field(cmSearchField, false);
	if (!spec || !spec.query || spec.activeOrdinal == null) return null;
	const q = new SearchQuery({
		search: spec.query,
		caseSensitive: spec.caseSensitive,
		wholeWord: spec.wholeWord
	});
	if (!q.valid) return null;
	const cursor = q.getCursor(view.state, 0, view.state.doc.length);
	let i = 0;
	for (let it = cursor.next(); !it.done; it = cursor.next()) {
		if (i === spec.activeOrdinal) return { from: it.value.from, to: it.value.to };
		i++;
	}
	return null;
}

const highlighter = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;
		constructor(view: EditorView) {
			this.decorations = this.build(view);
		}
		update(u: ViewUpdate) {
			if (
				u.docChanged ||
				u.viewportChanged ||
				u.startState.field(cmSearchField, false) !== u.state.field(cmSearchField, false)
			)
				this.decorations = this.build(u.view);
		}
		build(view: EditorView): DecorationSet {
			const builder = new RangeSetBuilder<Decoration>();
			const spec = view.state.field(cmSearchField, false);
			if (!spec || !spec.query) return builder.finish();
			const q = new SearchQuery({
				search: spec.query,
				caseSensitive: spec.caseSensitive,
				wholeWord: spec.wholeWord
			});
			if (!q.valid) return builder.finish();
			// Cell editors are small, so decorate every match in doc order (the builder
			// needs sorted adds; the cursor yields matches in order). Empty matches
			// can't occur for a literal query, so from<to always holds.
			const cursor = q.getCursor(view.state, 0, view.state.doc.length);
			let i = 0;
			for (let it = cursor.next(); !it.done; it = cursor.next()) {
				const { from, to } = it.value;
				builder.add(from, to, i === spec.activeOrdinal ? activeMark : matchMark);
				i++;
			}
			return builder.finish();
		}
	},
	{ decorations: (v) => v.decorations }
);

/** The editor extension: the query state field + the decorating view plugin. */
export const cmSearchHighlight = [cmSearchField, highlighter];
