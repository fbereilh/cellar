// Static, read-only syntax highlighting for the lazy-editor path.
//
// A big notebook used to build one full CodeMirror `EditorView` (+ a
// `ResizeObserver`) per cell on open — tens of MB and seconds of mount before a
// single keystroke. The interim fix (see `Cell.svelte`) is to render every cell's
// SOURCE without a live editor and build the real `EditorView` only on first
// edit-intent. This module produces that static render: it parses the source with
// the SAME Lezer grammar CodeMirror uses and walks it with the SAME shared
// `cellarHighlightStyle`, so an unfocused cell highlights pixel-for-pixel like the
// editor that later replaces it (the generated classes resolve against the same
// `--cellar-cm-tok-*` custom properties in `app.css`).
//
// It is deliberately cheap: parsing + a tree walk, no editor state, no DOM
// observers. The only browser-only step is mounting the highlight style's
// `StyleModule` so its classes carry color; the HTML generation itself is pure, so
// this is unit-testable under Node (vitest) without a DOM.

import { highlightTree } from '@lezer/highlight';
import { StyleModule } from 'style-mod';
import { pythonLanguage } from '@codemirror/lang-python';
import { markdownLanguage } from '@codemirror/lang-markdown';
import { StandardSQL } from '@codemirror/lang-sql';
import { cellarHighlightStyle } from '$lib/editorTheme';

export type StaticLang = 'python' | 'markdown' | 'sql';

// Above this source size we skip the parse+highlight and fall back to plain
// escaped text. A cell this large is rare, and highlighting it eagerly for every
// such cell on open would erode the very win this path exists for; the moment the
// user focuses it the real editor takes over and highlights properly.
const MAX_HIGHLIGHT_CHARS = 20_000;

function parserFor(lang: StaticLang) {
	switch (lang) {
		case 'markdown':
			return markdownLanguage.parser;
		case 'sql':
			return StandardSQL.language.parser;
		default:
			return pythonLanguage.parser;
	}
}

// Mount the shared highlight style's StyleModule into the document exactly once,
// so the opaque token classes it generates carry their colors even before ANY
// live editor exists (a freshly opened notebook builds zero editors). CodeMirror
// mounts the same module when an editor is later built; `StyleModule.mount`
// dedupes by module identity, so mounting here first is harmless. A no-op under
// Node (no `document`), where this module is only exercised for its pure output.
let mounted = false;
function ensureStyleMounted(): void {
	if (mounted || typeof document === 'undefined') return;
	if (cellarHighlightStyle.module) StyleModule.mount(document, cellarHighlightStyle.module);
	mounted = true;
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
function escapeHtml(s: string): string {
	return s.replace(/[&<>]/g, (c) => ESCAPES[c]);
}

function plainLines(source: string): string[] {
	return source.split('\n').map(escapeHtml);
}

/**
 * Highlight `source` into an array of per-line HTML strings (one entry per line,
 * so the caller can render a line-number gutter alongside). A highlighted range
 * that crosses a newline — a triple-quoted string, a block comment — is split at
 * each newline so every visual line renders independently. The returned strings
 * are HTML-escaped and safe to inject with `{@html}`.
 *
 * Returns exactly `source.split('\n').length` entries. Falls back to plain
 * escaped text for oversized sources or on any parse error, so it can never throw
 * into the render path.
 */
export function highlightLines(source: string, lang: StaticLang): string[] {
	if (source.length > MAX_HIGHLIGHT_CHARS) return plainLines(source);
	ensureStyleMounted();
	let tree;
	try {
		tree = parserFor(lang).parse(source);
	} catch {
		return plainLines(source);
	}
	const lines: string[] = [''];
	let pos = 0;
	// Append `text` (optionally wrapped in `cls`), splitting it across line
	// boundaries so a multi-line token contributes to several output lines.
	const emit = (text: string, cls: string | null) => {
		const parts = text.split('\n');
		for (let i = 0; i < parts.length; i++) {
			if (i > 0) lines.push('');
			if (parts[i] === '') continue;
			const seg = escapeHtml(parts[i]);
			lines[lines.length - 1] += cls ? `<span class="${cls}">${seg}</span>` : seg;
		}
	};
	highlightTree(tree, cellarHighlightStyle, (from, to, cls) => {
		if (from > pos) emit(source.slice(pos, from), null); // untokenized gap
		emit(source.slice(from, to), cls);
		pos = to;
	});
	if (pos < source.length) emit(source.slice(pos), null);
	return lines;
}
