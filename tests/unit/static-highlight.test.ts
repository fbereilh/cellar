import { describe, it, expect } from 'vitest';
import { highlightLines } from '../../src/lib/staticHighlight';

// `highlightLines` powers the lazy-editor static render: an unfocused cell shows
// its source WITHOUT building a CodeMirror EditorView, highlighted with the SAME
// grammar + shared highlight style the editor uses. These tests exercise the pure
// HTML generation (no DOM needed — the only browser-only step is mounting the
// style module, which is a no-op under Node). The invariant that matters for the
// render is: exactly one output entry per source line, with token markup and HTML
// escaping, and multi-line tokens split at newlines so line numbers stay aligned.

describe('highlightLines', () => {
	it('returns exactly one entry per source line', () => {
		const src = 'a = 1\nb = 2\nc = 3';
		expect(highlightLines(src, 'python')).toHaveLength(3);
	});

	it('preserves a trailing blank line as its own (empty) entry', () => {
		// 'x\n' splits into ['x', ''] — the gutter must show a line number for the
		// empty final line, so the count is load-bearing.
		expect(highlightLines('x = 1\n', 'python')).toHaveLength(2);
	});

	it('wraps keywords in a highlight span (so the static view is colored)', () => {
		const [line] = highlightLines('import os', 'python');
		expect(line).toContain('<span class="');
		expect(line).toContain('import');
	});

	it('escapes HTML-special characters in the source', () => {
		// A comparison operator and an ampersand must never reach {@html} unescaped.
		const out = highlightLines('a < b & c > d', 'python').join('\n');
		expect(out).toContain('&lt;');
		expect(out).toContain('&amp;');
		expect(out).toContain('&gt;');
		expect(out).not.toMatch(/[^&]< b/); // no raw '<' followed by text
	});

	it('splits a token that spans multiple lines at each newline', () => {
		// A triple-quoted string is ONE Lezer node spanning three lines; each line
		// must render independently so it aligns beside its own line number.
		const src = 's = """line one\nline two\nline three"""';
		const lines = highlightLines(src, 'python');
		expect(lines).toHaveLength(3);
		// The string content survives on the right lines (escaped/spanned, but present).
		expect(lines[0]).toContain('line one');
		expect(lines[1]).toContain('line two');
		expect(lines[2]).toContain('line three');
		// No entry smuggles a literal newline across the line boundary.
		expect(lines.every((l) => !l.includes('\n'))).toBe(true);
	});

	it('highlights markdown and sql sources without throwing', () => {
		expect(highlightLines('# Heading\n\ntext', 'markdown')).toHaveLength(3);
		expect(highlightLines('SELECT * FROM t', 'sql')[0]).toContain('SELECT');
	});

	it('falls back to plain escaped lines for an oversized source', () => {
		const big = 'x'.repeat(20_001);
		const lines = highlightLines(big + '\n<b>', 'python');
		expect(lines).toHaveLength(2);
		expect(lines[1]).toBe('&lt;b&gt;'); // escaped, no highlight spans
	});
});
