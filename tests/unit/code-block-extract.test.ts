// @vitest-environment jsdom
//
// Lifting a RENDERED code block into a notebook cell (`$lib/codeBlockExtract`).
//
// It runs under jsdom rather than the suite's default `node` environment on
// purpose, and that is the point of the file rather than a detail: the source a
// cell is created from is read back out of the RENDERED DOM, so the only test
// that can prove byte-exactness is one that drives the REAL pipeline the browser
// drives - markdown-it's escaping, DOMPurify's sanitizer, and `textContent`'s
// decoding - and then compares against the string that went in. A test that
// parsed the markdown a second way would be asserting its own parser.
//
// The two cases the brief calls out - a block containing BACKTICKS and a block
// containing MARKDOWN - are exactly the two an escaping or a re-parsing bug
// destroys silently: the first survives only if nothing re-reads the fence
// markers, the second only if nothing re-renders the extracted text.

import { describe, it, expect, beforeEach } from 'vitest';
import { renderChatReply, renderMarkdown, renderOutputMarkdown } from '$lib/markdown';
import {
	CODE_BLOCK_ATTR,
	EXTRACT_TESTID,
	EXTRACTED_LABEL,
	codeBlockText,
	decorateCodeBlocks,
	extractLabel,
	fenceCellType,
	fenceLanguage,
	flashExtracted,
	readCodeBlock,
	targetCodeBlock
} from '$lib/codeBlockExtract';

/** Render `src` the way a chat reply is rendered, decorate it, and hand back the host. */
function rendered(src: string, render: (s: string) => string = renderChatReply): HTMLElement {
	const host = document.createElement('div');
	host.className = 'cellar-md';
	host.innerHTML = render(src);
	decorateCodeBlocks(host);
	return host;
}

/** Every decorated block of `host`, read as the cells they would become. */
const blocksOf = (host: HTMLElement) =>
	Array.from(host.querySelectorAll(`[${CODE_BLOCK_ATTR}]`)).map((b) => readCodeBlock(b));

/** A fenced block, written the way a model writes one. */
const fence = (info: string, body: string, ticks = '```') => `${ticks}${info}\n${body}\n${ticks}`;

beforeEach(() => {
	document.body.innerHTML = '';
});

describe('the fence info string picks the cell type', () => {
	it('maps the tags that name a logical type', () => {
		expect(fenceCellType('python')).toBe('code');
		expect(fenceCellType('py')).toBe('code');
		expect(fenceCellType('python3')).toBe('code');
		expect(fenceCellType('ipython')).toBe('code');
		expect(fenceCellType('sql')).toBe('sql');
		expect(fenceCellType('markdown')).toBe('markdown');
		expect(fenceCellType('md')).toBe('markdown');
	});

	it('reads an UNKNOWN or ABSENT tag as a code cell', () => {
		for (const tag of ['bash', 'sh', 'json', 'text', 'rust', 'diff', '', null, undefined]) {
			expect(fenceCellType(tag), `tag ${JSON.stringify(tag)}`).toBe('code');
		}
	});

	it('ignores case and anything after the first word', () => {
		expect(fenceCellType('Python')).toBe('code');
		expect(fenceCellType('SQL')).toBe('sql');
		expect(fenceCellType('  markdown  ')).toBe('markdown');
		expect(fenceCellType('python title=setup.py')).toBe('code');
		expect(fenceCellType('sql,linenums')).toBe('sql');
		expect(fenceCellType('md{highlight}')).toBe('markdown');
	});

	it('never produces a type a .py notebook would refuse', () => {
		// `chat` and `raw` are `PY_UNSUPPORTED_TYPES`. No fence tag may reach them, so
		// no extraction can ever be refused for its type - on ANY notebook format.
		for (const tag of ['chat', 'raw', 'Chat', 'RAW']) {
			expect(['code', 'sql', 'markdown']).toContain(fenceCellType(tag));
		}
	});
});

describe('the source is byte-exact through render -> sanitize -> read', () => {
	it('round-trips a plain python block', () => {
		const body = 'import pandas as pd\ndf = pd.read_csv("a.csv")\ndf.head()';
		const [block] = blocksOf(rendered(fence('python', body)));
		expect(block).toEqual({ source: body, cellType: 'code', language: 'python' });
	});

	it('round-trips a block CONTAINING BACKTICKS, fence markers and all', () => {
		// A four-backtick fence whose body is itself a three-backtick fence. Nothing
		// may re-read those markers: the inner fence is content.
		const body = ['Run this:', '```python', 'print("hi")', '```', 'done `x` here'].join('\n');
		const [block] = blocksOf(rendered(fence('markdown', body, '````')));
		expect(block?.source).toBe(body);
		expect(block?.source).toContain('```python');
		expect(block?.cellType).toBe('markdown');
	});

	it('round-trips a block CONTAINING MARKDOWN, unrendered', () => {
		const body = ['# Heading', '', '- **bold** item', '- [link](https://example.com)', '', '> quote'].join('\n');
		const [block] = blocksOf(rendered(fence('markdown', body)));
		expect(block?.source).toBe(body);
		// The markdown inside the block is TEXT, not markup: nothing rendered it.
		expect(block?.source).toContain('**bold**');
		expect(block?.source).not.toContain('<strong>');
		expect(block?.cellType).toBe('markdown');
	});

	it('re-encodes no entity: <, >, ", & and a literal &amp; all survive', () => {
		const body = ['if a < b and c > d:', '    s = "x & y"', '    t = \'&amp;\'', "    u = '<script>'"].join('\n');
		const [block] = blocksOf(rendered(fence('python', body)));
		expect(block?.source).toBe(body);
		// The literal five characters the user typed, not the entity they escaped to.
		expect(block?.source).toContain("'&amp;'");
		expect(block?.source).toContain('<script>');
	});

	it('damages no leading or trailing whitespace', () => {
		const body = ['def f():', '    if x:', '        return 1  ', '', '    return 0'].join('\n');
		const [block] = blocksOf(rendered(fence('python', body)));
		expect(block?.source).toBe(body);
	});

	it('drops the fence terminator, and ONLY it', () => {
		// The fence's own line terminator is not content; a blank line the user wrote
		// before the closing fence is.
		expect(codeBlockText({ textContent: 'x = 1\n' } as Element)).toBe('x = 1');
		expect(codeBlockText({ textContent: 'x = 1\n\n' } as Element)).toBe('x = 1\n');
		expect(codeBlockText({ textContent: 'x = 1' } as Element)).toBe('x = 1');
		expect(codeBlockText({ textContent: '' } as Element)).toBe('');
		expect(codeBlockText(null)).toBe('');
	});

	it('handles a fence indented inside a list item', () => {
		const src = ['1. First do this:', '', '    ```python', '    x = 1', '    y = 2', '    ```', ''].join('\n');
		const [block] = blocksOf(rendered(src));
		// markdown-it strips the list indentation; the block's own text is what shows.
		expect(block?.source).toBe('x = 1\ny = 2');
		expect(block?.cellType).toBe('code');
	});

	it('reads an INDENTED code block (no fence, no tag) as a code cell', () => {
		const [block] = blocksOf(rendered('paragraph\n\n    x = 1\n    y = 2\n'));
		expect(block).toEqual({ source: 'x = 1\ny = 2', cellType: 'code', language: null });
	});
});

describe('every notebook markdown surface is covered', () => {
	// One rule, whichever renderer produced the prose: a chat reply, a markdown
	// CELL, and a kernel `display(Markdown(...))` payload all render into
	// `.cellar-md` inside `Cell.svelte`, so all three decorate identically.
	for (const [name, render] of [
		['chat reply', renderChatReply],
		['markdown cell', renderMarkdown],
		['kernel markdown output', renderOutputMarkdown]
	] as const) {
		it(`decorates a ${name}`, () => {
			const [block] = blocksOf(rendered(fence('sql', 'select 1', '```'), render));
			expect(block).toEqual({ source: 'select 1', cellType: 'sql', language: 'sql' });
		});
	}
});

describe('decoration', () => {
	it('wraps every block, keeps document order, and hangs one control on each', () => {
		const host = rendered([fence('python', 'a = 1'), 'prose', fence('sql', 'select 2'), fence('', 'plain')].join('\n\n'));
		const blocks = Array.from(host.querySelectorAll(`[${CODE_BLOCK_ATTR}]`));
		expect(blocks).toHaveLength(3);
		expect(blocks.map((b) => readCodeBlock(b)?.source)).toEqual(['a = 1', 'select 2', 'plain']);
		for (const b of blocks) {
			expect(b.querySelectorAll(`[data-testid="${EXTRACT_TESTID}"]`)).toHaveLength(1);
			expect(b.querySelector('pre > code')).toBeTruthy();
		}
	});

	it('is IDEMPOTENT - a second pass adds nothing and moves nothing', () => {
		const host = rendered(fence('python', 'a = 1'));
		const pre = host.querySelector('pre');
		const wrap = host.querySelector(`[${CODE_BLOCK_ATTR}]`);
		expect(decorateCodeBlocks(host)).toBe(0);
		expect(host.querySelectorAll(`[${CODE_BLOCK_ATTR}]`)).toHaveLength(1);
		expect(host.querySelectorAll(`[data-testid="${EXTRACT_TESTID}"]`)).toHaveLength(1);
		expect(host.querySelector('pre')).toBe(pre);
		expect(pre?.parentElement).toBe(wrap);
	});

	it('reports 0 for prose with no code, and for no root at all', () => {
		expect(decorateCodeBlocks(rendered('just **prose** and `inline code`'))).toBe(0);
		expect(decorateCodeBlocks(null)).toBe(0);
		expect(decorateCodeBlocks(undefined)).toBe(0);
	});

	it('leaves INLINE code alone - only a block gets a control', () => {
		const host = rendered('prose with `x = 1` inline\n\n' + fence('python', 'y = 2'));
		expect(host.querySelectorAll(`[data-testid="${EXTRACT_TESTID}"]`)).toHaveLength(1);
		expect(host.textContent).toContain('x = 1');
	});

	it('adds NO TEXT NODE, so find-in-page ordinals cannot slide', () => {
		// `domHighlight.ts` walks every text node under the rendered surface to build
		// its Ranges. A visible word on the control would be counted as a match.
		const src = fence('python', 'a = 1');
		const plain = document.createElement('div');
		plain.innerHTML = renderChatReply(src);
		const decorated = rendered(src);
		expect(decorated.textContent).toBe(plain.textContent);
		const btn = decorated.querySelector(`[data-testid="${EXTRACT_TESTID}"]`);
		expect(btn?.textContent).toBe('');
		expect(btn?.getAttribute('aria-label')).toBe(extractLabel('code'));
	});

	it('names the cell type it will create on the control itself', () => {
		const host = rendered([fence('sql', 'select 1'), fence('md', '# hi')].join('\n\n'));
		const labels = Array.from(host.querySelectorAll(`[data-testid="${EXTRACT_TESTID}"]`)).map((b) => b.getAttribute('aria-label'));
		expect(labels).toEqual([extractLabel('sql'), extractLabel('markdown')]);
	});
});

describe('reading a block from anywhere inside it', () => {
	it('answers the same for the wrapper, the pre, the code and the control', () => {
		const host = rendered(fence('python', 'a = 1'));
		const wrap = host.querySelector(`[${CODE_BLOCK_ATTR}]`)!;
		for (const el of [wrap, wrap.querySelector('pre')!, wrap.querySelector('code')!, wrap.querySelector('button')!]) {
			expect(readCodeBlock(el)?.source).toBe('a = 1');
		}
	});

	it('is null when there is no block to read', () => {
		expect(readCodeBlock(null)).toBeNull();
		expect(readCodeBlock(document.createElement('div'))).toBeNull();
	});
});

describe('the keyboard route resolves its target', () => {
	it('prefers the HOVERED block over the focused one', () => {
		// jsdom implements neither `:hover` nor `:focus-within`, so the resolution
		// ORDER is driven through a stubbed `matches` - the real pseudo-classes are
		// what `tests/e2e/code-block-extract.spec.ts` exercises in a real browser.
		const host = rendered([fence('python', 'a = 1'), fence('python', 'b = 2')].join('\n\n'));
		host.setAttribute('id', 'host');
		document.body.appendChild(host);
		const [first, second] = Array.from(host.querySelectorAll(`[${CODE_BLOCK_ATTR}]`));
		stubMatches(first, [':focus-within']);
		stubMatches(second, [':hover']);
		expect(readCodeBlock(targetCodeBlock(host))?.source).toBe('b = 2');
	});

	it('falls back to FOCUS when nothing is hovered', () => {
		const host = rendered([fence('python', 'a = 1'), fence('python', 'b = 2')].join('\n\n'));
		document.body.appendChild(host);
		const [, second] = Array.from(host.querySelectorAll(`[${CODE_BLOCK_ATTR}]`));
		stubMatches(second, [':focus-within']);
		expect(readCodeBlock(targetCodeBlock(host))?.source).toBe('b = 2');
	});

	it('is null with neither, and with no root', () => {
		const host = rendered(fence('python', 'a = 1'));
		document.body.appendChild(host);
		expect(targetCodeBlock(host)).toBeNull();
		expect(targetCodeBlock(null)).toBeNull();
	});

	it('never reaches a block outside its own root', () => {
		const mine = rendered(fence('python', 'mine = 1'));
		const theirs = rendered(fence('python', 'theirs = 1'));
		document.body.append(mine, theirs);
		stubMatches(theirs.querySelector(`[${CODE_BLOCK_ATTR}]`)!, [':hover']);
		expect(targetCodeBlock(mine)).toBeNull();
		expect(readCodeBlock(targetCodeBlock(theirs))?.source).toBe('theirs = 1');
	});
});

describe('the control confirms, and says what a repeat does', () => {
	it('flips to the check transiently but renames permanently', async () => {
		const host = rendered(fence('python', 'a = 1'));
		document.body.appendChild(host);
		const btn = host.querySelector(`[data-testid="${EXTRACT_TESTID}"]`)!;
		expect(btn.getAttribute('aria-label')).toBe(extractLabel('code'));

		flashExtracted(btn, 5);
		expect(btn.getAttribute('data-extracted')).toBe('true');
		expect(btn.getAttribute('aria-label')).toBe(EXTRACTED_LABEL);
		expect(btn.getAttribute('title')).toBe(EXTRACTED_LABEL);

		await new Promise((r) => setTimeout(r, 25));
		// The check expires - it claimed one click landed. The NAME does not: that a
		// repeat makes ANOTHER cell stays true, and stating it before the second
		// click is the whole point.
		expect(btn.getAttribute('data-extracted')).toBeNull();
		expect(btn.getAttribute('aria-label')).toBe(EXTRACTED_LABEL);
	});

	it('is inert on a non-element', () => {
		expect(() => flashExtracted(null)).not.toThrow();
		expect(() => flashExtracted(undefined)).not.toThrow();
	});
});

/** Make `el.matches(sel)` true for `selectors`, keeping its real answers otherwise. */
function stubMatches(el: Element, selectors: string[]): void {
	const real = el.matches.bind(el);
	el.matches = (sel: string) => (selectors.includes(sel) ? true : real(sel));
}
