// @vitest-environment jsdom
//
// nbdev/Quarto `#|` directive comments (`src/lib/directiveComment.ts`).
//
// Cellar ACTS on `#| default_exp` (`server/export-py.ts`), so a directive must not
// read as a dead comment. The Python grammar tags it as an ordinary `Comment`, so
// the distinction is an extra class both render paths add. Three things are worth
// pinning, and the first two are where a regression would actually land:
//
//  1. WHAT counts as a directive — the pure rule, including the two things that
//     must NOT count (a trailing comment, a `#|` line inside a string literal).
//  2. That the LIVE editor and the STATIC no-editor render agree on the same
//     source. They are separate code paths sharing one rule; the whole point is
//     that a directive does not change appearance when the lazy editor is summoned.
//  3. That the rule reads only the text it needs, which is what lets the editor
//     plugin - it rebuilds on scroll, not only on edit - hand over its document
//     instead of a whole-document copy.
//
// The one-expression-wide wiring gets narrow, formatting-tolerant source guards at
// the end: vitest deliberately runs without the SvelteKit plugin, so no component
// here can be mounted, and the CSS cascade is only observable in a real browser
// (`tests/e2e/directive-comment-highlight.spec.ts` answers both for real).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EditorState, Text } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { python, pythonLanguage } from '@codemirror/lang-python';
import { DIRECTIVE_CLASS, directiveCommentRanges, directiveCommentHighlight } from '$lib/directiveComment';
import { EDITOR_THEME } from '$lib/editorTheme';
import { highlightLines } from '$lib/staticHighlight';

/** The directive ranges of a Python source, as the text they cover. */
function directivesIn(source: string): string[] {
	const tree = pythonLanguage.parser.parse(source);
	return directiveCommentRanges(source, tree).map((r) => source.slice(r.from, r.to));
}

/** Render `source` in a real (jsdom) editor and return the directive-marked text. */
function editorDirectives(source: string, extensions = [python(), directiveCommentHighlight]): string[] {
	const parent = document.createElement('div');
	document.body.appendChild(parent);
	const view = new EditorView({ parent, state: EditorState.create({ doc: source, extensions }) });
	const out = [...parent.querySelectorAll(`.${DIRECTIVE_CLASS}`)].map((n) => n.textContent ?? '');
	view.destroy();
	parent.remove();
	return out;
}

/** The per-line static render, joined — the class is what the CSS rule keys on. */
function staticLines(source: string, lang: 'python' | 'sql' | 'markdown' | 'plain' = 'python') {
	return highlightLines(source, lang);
}

describe('directiveCommentRanges — what counts as a directive', () => {
	it('matches the canonical nbdev spelling and covers the whole line', () => {
		expect(directivesIn('#| default_exp training\nx = 1')).toEqual(['#| default_exp training']);
	});

	it('matches with no space after # and with a space between # and |', () => {
		// Both are legal nbdev/Quarto, and both are what `storedExportTarget`'s own
		// `/^\s*#\s*\|/` accepts — the two rules must not disagree about the shape.
		expect(directivesIn('#|export')).toEqual(['#|export']);
		expect(directivesIn('# | export')).toEqual(['# | export']);
		expect(directivesIn('#  |  export')).toEqual(['#  |  export']);
	});

	it('matches an indented directive (only whitespace may precede it)', () => {
		expect(directivesIn('def f():\n    #| hide\n    pass')).toEqual(['#| hide']);
	});

	it('leaves an ordinary comment alone', () => {
		expect(directivesIn('# just a comment\n#not a directive either')).toEqual([]);
	});

	it('leaves a TRAILING comment alone — a directive owns its line', () => {
		// nbdev requires a directive on its own line, and `storedExportTarget`'s `^`
		// says the same. Highlighting `x = 1  #| foo` would claim Cellar acts on it.
		expect(directivesIn('x = 1  #| export')).toEqual([]);
	});

	it('leaves `#|` inside a string literal alone', () => {
		// The grammar decides, not a regex over raw text: this line is string
		// content, so it stays string-coloured.
		const src = 's = """\n#| default_exp nope\n"""';
		expect(directivesIn(src)).toEqual([]);
	});

	it('matches a directive Cellar does not act on', () => {
		// The recorded decision: `#|` is a syntactic class in the nbdev/Quarto
		// ecosystem regardless of whether THIS tool reads that particular one.
		// Highlighting only the recognised subset would render a valid nbdev
		// directive as a dead comment — the exact confusion this fixes.
		expect(directivesIn('#| hide_input\n#| echo: false\n#| some-future-directive')).toEqual([
			'#| hide_input',
			'#| echo: false',
			'#| some-future-directive'
		]);
	});

	it('returns every directive in document order', () => {
		const src = '#| default_exp a\nimport os\n#| export\ndef f(): pass\n#| hide';
		expect(directivesIn(src)).toEqual(['#| default_exp a', '#| export', '#| hide']);
	});

	it('reports exact document offsets, ending at the newline', () => {
		const src = 'x = 1\n#| export\ny = 2';
		const tree = pythonLanguage.parser.parse(src);
		expect(directiveCommentRanges(src, tree)).toEqual([{ from: 6, to: 15 }]);
		expect(src.slice(15)).toBe('\ny = 2');
	});

	it('honours the from/to window (the editor decorates visible ranges only)', () => {
		const src = '#| a\nx = 1\n#| b';
		const tree = pythonLanguage.parser.parse(src);
		expect(directiveCommentRanges(src, tree, 5).map((r) => src.slice(r.from, r.to))).toEqual(['#| b']);
	});
});

describe('the live editor', () => {
	it('marks a directive comment and nothing else', () => {
		expect(editorDirectives('#| export\nx = 1\n# plain comment')).toEqual(['#| export']);
	});

	it('marks it exactly once (no duplicate decoration)', () => {
		const marked = editorDirectives('#| default_exp training');
		expect(marked).toHaveLength(1);
	});

	it('WRAPS the comment token span rather than merging into it', () => {
		// The shape the CSS depends on, so it is pinned rather than assumed. A mark
		// decoration nests: <span class=directive><span class=TOKEN>…</span></span>.
		// A child's own `color` beats anything inherited from an ancestor whatever
		// the specificity, which is why `app.css` also targets the DESCENDANT - drop
		// that selector and the editor silently keeps painting comment grey.
		const parent = document.createElement('div');
		document.body.appendChild(parent);
		const view = new EditorView({
			parent,
			state: EditorState.create({
				doc: '#| export',
				extensions: [python(), EDITOR_THEME, directiveCommentHighlight]
			})
		});
		const mark = parent.querySelector(`.${DIRECTIVE_CLASS}`);
		expect(mark).not.toBeNull();
		// The comment token survives, as a descendant carrying its own class.
		const inner = mark!.querySelector('span');
		expect(inner).not.toBeNull();
		expect(inner!.className).not.toBe('');
		expect(inner!.textContent).toBe('#| export');
		view.destroy();
		parent.remove();
	});

	it('re-decorates after an edit turns a comment into a directive', () => {
		const parent = document.createElement('div');
		document.body.appendChild(parent);
		const view = new EditorView({
			parent,
			state: EditorState.create({ doc: '# export', extensions: [python(), directiveCommentHighlight] })
		});
		expect(parent.querySelectorAll(`.${DIRECTIVE_CLASS}`)).toHaveLength(0);
		view.dispatch({ changes: { from: 1, to: 1, insert: '|' } }); // '# export' -> '#| export'
		expect([...parent.querySelectorAll(`.${DIRECTIVE_CLASS}`)].map((n) => n.textContent)).toEqual([
			'#| export'
		]);
		view.destroy();
		parent.remove();
	});
});

describe('the static (no-editor) render', () => {
	it('marks a directive comment', () => {
		const [line] = staticLines('#| default_exp training');
		expect(line).toContain(DIRECTIVE_CLASS);
		expect(line).toContain('default_exp');
	});

	it('leaves an ordinary comment unmarked', () => {
		expect(staticLines('# an ordinary comment')[0]).not.toContain(DIRECTIVE_CLASS);
	});

	it('leaves a trailing comment and a string literal unmarked', () => {
		expect(staticLines('x = 1  #| export').join('\n')).not.toContain(DIRECTIVE_CLASS);
		expect(staticLines('s = """\n#| export\n"""').join('\n')).not.toContain(DIRECTIVE_CLASS);
	});

	it('does NOT mark `#|` in SQL or markdown — `#|` is a Python-family directive', () => {
		// Scoped deliberately: marking a `#` comment in a language that has no such
		// directive class would invent one. `langFor` in Cell.svelte/FileTab.svelte
		// adds the editor plugin only beside `python()`, and this is its static twin.
		expect(staticLines('#| export', 'sql').join('\n')).not.toContain(DIRECTIVE_CLASS);
		expect(staticLines('#| export', 'markdown').join('\n')).not.toContain(DIRECTIVE_CLASS);
		expect(staticLines('#| export', 'plain').join('\n')).not.toContain(DIRECTIVE_CLASS);
	});

	it('still returns exactly one entry per source line', () => {
		expect(staticLines('#| export\nx = 1\n# c')).toHaveLength(3);
	});
});

describe('the two render paths agree', () => {
	// The contract `staticHighlight.ts` exists to keep: an unfocused cell must look
	// like the editor that later replaces it. These are separate code paths, so the
	// agreement is asserted rather than assumed.
	const SOURCES = [
		'#| default_exp training\nimport os',
		'def f():\n    #| hide\n    return 1',
		'x = 1  #| export\n# plain\n#|export',
		's = """\n#| export\n"""\n#| really'
	];
	for (const src of SOURCES) {
		it(`marks the same lines for ${JSON.stringify(src.slice(0, 24))}…`, () => {
			const fromEditor = editorDirectives(src);
			const fromStatic = staticLines(src)
				.map((line, i) => (line.includes(DIRECTIVE_CLASS) ? src.split('\n')[i].trimStart() : null))
				.filter((v): v is string => v != null);
			expect(fromStatic).toEqual(fromEditor);
		});
	}
});

describe('wiring and scope', () => {
	// vitest deliberately runs without the SvelteKit plugin, so neither component can
	// be mounted here and the CSS cascade is only observable in a real browser - both
	// are asserted for real by `tests/e2e/directive-comment-highlight.spec.ts`. What
	// is left is one-expression-wide wiring, kept deliberately FORMATTING-TOLERANT: a
	// prettier reflow, a rename or an equivalent refactor must not fail the suite
	// while the behaviour is unchanged.
	const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
	const mentions = (src: string) => src.split('directiveCommentHighlight').length - 1;

	it('reaches both Python-family editor surfaces', () => {
		// Import + use, in each.
		expect(mentions(read('src/lib/Cell.svelte'))).toBeGreaterThanOrEqual(2);
		expect(mentions(read('src/lib/FileTab.svelte'))).toBeGreaterThanOrEqual(2);
	});

	it('never reaches the shared theme every language gets', () => {
		// The scope claim: `#|` carries no directive meaning in SQL, markdown, YAML or
		// TOML, so the plugin must stay beside `python()` and out of `EDITOR_THEME`.
		// The static half of that scope IS behavioural, above.
		expect(read('src/lib/editorTheme.ts')).not.toContain('directiveComment');
	});

	it('paints the editor through the DESCENDANT selector', () => {
		// The non-obvious one, and the reason it is pinned at all: CodeMirror's mark
		// decoration WRAPS the token span rather than merging classes (see the editor
		// test above), and a child's own `color` beats anything inherited from an
		// ancestor whatever the specificity - so without this the editor silently keeps
		// painting comment grey while the static render looks correct. That the cascade
		// then really lands is a browser question, answered by the e2e spec.
		expect(read('src/app.css')).toContain(`.cm-content .${DIRECTIVE_CLASS} span`);
	});
});

describe('the rule reads only what it needs', () => {
	// The editor plugin rebuilds on SCROLL as well as on edit and hands over
	// `view.state.doc` rather than a materialised string, so the rule must never read
	// the whole document. Asserted through the public text seam.
	function countingSource(source: string) {
		let read = 0;
		return {
			read: () => read,
			doc: {
				length: source.length,
				sliceString(from: number, to: number) {
					read += to - from;
					return source.slice(from, to);
				}
			}
		};
	}

	it('agrees with the plain-string call shape', () => {
		// One rule, two callers: the static path passes the source it already holds,
		// the editor passes its `Text`. They must not answer differently.
		const src = '#| default_exp a\nx = 1  #| trailing\ndef f():\n    #| hide\n    pass';
		const tree = pythonLanguage.parser.parse(src);
		const { doc } = countingSource(src);
		expect(directiveCommentRanges(doc, tree)).toEqual(directiveCommentRanges(src, tree));
	});

	it('slices a tiny fraction of a large document for one visible window', () => {
		const body = Array.from({ length: 2000 }, (_, i) => `value_${i} = ${i}  # ordinary`).join('\n');
		const src = `${body}\n#| export\n`;
		expect(src.length).toBeGreaterThan(40_000);
		const tree = pythonLanguage.parser.parse(src);
		const { doc, read } = countingSource(src);
		const found = directiveCommentRanges(doc, tree, src.length - 40, src.length);
		expect(found.map((r) => src.slice(r.from, r.to))).toEqual(['#| export']);
		expect(read()).toBeLessThan(1_000);
	});

	it('does not materialise the document when the editor rebuilds', () => {
		// The regression the seam exists for, at the surface that pays it.
		const parent = document.createElement('div');
		document.body.appendChild(parent);
		const view = new EditorView({
			parent,
			state: EditorState.create({
				doc: '#| export\nx = 1',
				extensions: [python(), directiveCommentHighlight]
			})
		});
		const real = Text.prototype.toString;
		let calls = 0;
		Text.prototype.toString = function (this: Text) {
			calls++;
			return real.call(this);
		};
		try {
			view.dispatch({ changes: { from: 15, insert: '\n#| hide' } });
			expect([...parent.querySelectorAll(`.${DIRECTIVE_CLASS}`)].map((n) => n.textContent)).toEqual([
				'#| export',
				'#| hide'
			]);
			expect(calls).toBe(0);
		} finally {
			Text.prototype.toString = real;
			view.destroy();
			parent.remove();
		}
	});
});
