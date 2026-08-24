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
import { DEFAULT_SHORTCUTS, CATEGORIES, bindingsCollide, modesOverlap, shortcuts, typingHazards } from '$lib/shortcuts.svelte';
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
	it('marks every block, keeps document order, and hangs one control on each', () => {
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
		const parent = pre?.parentElement;
		expect(decorateCodeBlocks(host)).toBe(0);
		expect(host.querySelectorAll(`[${CODE_BLOCK_ATTR}]`)).toHaveLength(1);
		expect(host.querySelectorAll(`[data-testid="${EXTRACT_TESTID}"]`)).toHaveLength(1);
		expect(host.querySelector('pre')).toBe(pre);
		expect(pre?.parentElement).toBe(parent);
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

/**
 * Decoration must leave the RENDERED FRAGMENT alone as a sibling chain, because
 * the fragment is not ours: `{@html}` put it there and reclaims it by node
 * identity and sibling position. Svelte records the first and last top-level node
 * it inserted (`assign_nodes`) and, on the next in-place swap, walks `nextSibling`
 * from one to the other removing each (`remove_effect_dom`) - so a decorator that
 * lifts a top-level node out of that chain leaves the walk stranded inside
 * whatever it was lifted into, and every node after it survives into the next
 * render.
 *
 * `removeFragment` below is that walk, in the same five lines Svelte spends on it.
 * It is modelled rather than imported because the function is not part of any
 * public export of `svelte`; what it does is nonetheless a contract this module
 * has to hold against ANY such renderer, so it is asserted directly rather than
 * left to whether one particular Svelte code path happens to spare us today (each
 * `{@html}` in `Cell.svelte` is currently the only child of its container, which
 * takes an `innerHTML =` path that clears everything - a property one added
 * sibling away from changing, and one this module cannot see).
 */
describe('the rendered fragment survives decoration as a sibling chain', () => {
	/** Remove the fragment `[start..end]` the way `{@html}` teardown does. */
	function removeFragment(start: ChildNode | null, end: ChildNode | null): void {
		let node = start;
		while (node !== null) {
			const next: ChildNode | null = node === end ? null : node.nextSibling;
			node.remove();
			node = next;
		}
	}

	/** A container holding `src` exactly as `{@html}` inserts it, then decorated. */
	function fragment(src: string) {
		const host = document.createElement('div');
		host.className = 'cellar-md';
		document.body.appendChild(host);
		host.innerHTML = renderChatReply(src);
		// The boundary is recorded BEFORE decoration, which is the whole point: the
		// renderer took it when it inserted the fragment, and never revisits it.
		const start = host.firstChild;
		const end = host.lastChild;
		const before = Array.from(host.childNodes);
		decorateCodeBlocks(host);
		return { host, start, end, before };
	}

	it('leaves the top-level nodes the SAME nodes, in the same order', () => {
		const { host, before } = fragment([fence('python', 'a = 1'), 'Some prose after it.'].join('\n\n'));
		expect(Array.from(host.childNodes)).toEqual(before);
		// And the block really was decorated - otherwise this passes vacuously.
		expect(host.querySelectorAll(`[data-testid="${EXTRACT_TESTID}"]`)).toHaveLength(1);
	});

	it('a fragment BEGINNING with a code block still tears down completely', () => {
		// The reachable shape: a reply (or a markdown cell body) that opens with a
		// fence. Re-parenting the leading `<pre>` strands the walk inside the wrapper,
		// so the prose after it survives and duplicates against the next render.
		const { host, start, end } = fragment([fence('python', 'a = 1'), 'Some prose after it.'].join('\n\n'));
		removeFragment(start, end);
		expect(host.innerHTML).toBe('');
	});

	it('a fragment that IS one code block still tears down completely', () => {
		// `start === end === the <pre>`, so the walk removes exactly one node: a
		// wrapper would be left behind with a dead extract control inside it, once per
		// in-place re-render.
		const { host, start, end } = fragment(fence('python', 'a = 1'));
		removeFragment(start, end);
		expect(host.innerHTML).toBe('');
	});

	it('a fragment ENDING with a code block still tears down completely', () => {
		const { host, start, end } = fragment(['Some prose first.', fence('sql', 'select 1')].join('\n\n'));
		removeFragment(start, end);
		expect(host.innerHTML).toBe('');
	});
});

describe('reading a block from anywhere inside it', () => {
	it('answers the same for the pre, the code and the control', () => {
		const host = rendered(fence('python', 'a = 1'));
		const block = host.querySelector(`[${CODE_BLOCK_ATTR}]`)!;
		for (const el of [block, block.querySelector('code')!, block.querySelector('button')!]) {
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

describe('BOTH keyboard routes are first-class registry entries', () => {
	// Registered rather than hard-wired, so Settings lists and rebinds them like
	// every other binding - a keyboard route this app does not list is one nobody
	// finds. TWO entries because a binding carries a single `mode` and these differ:
	// the primary bare `e` in command mode, and `Mod-Shift-e` anywhere.
	//
	// The command-mode one is not a convenience: `Mod-Shift-e` is Ctrl+Shift+E on
	// Windows/Linux, which Firefox binds to the Network Monitor, and a devtools
	// chord is not cancellable by page JS - so without it a Firefox user has no
	// keyboard route at all.
	const entryOf = (id: string) => DEFAULT_SHORTCUTS.find((x) => x.id === id);
	const command = entryOf('extract-code-block');
	const anywhere = entryOf('extract-code-block-anywhere');
	const both = () => [command!, anywhere!];

	it('declares the command-mode route on the bare letter `e`', () => {
		expect(command).toBeDefined();
		expect(command!.keys).toEqual(['e']);
		expect(command!.mode).toBe('command');
	});

	it('declares the anywhere route on `Mod-Shift-e`, active in edit mode too', () => {
		expect(anywhere).toBeDefined();
		expect(anywhere!.keys).toEqual(['Mod-Shift-e']);
		expect(anywhere!.mode).toBe('global');
	});

	it('gives each a listable category and its own description', () => {
		for (const e of both()) {
			// Settings renders only the categories in CATEGORIES, so one outside that
			// list would silently not appear at all.
			expect(CATEGORIES).toContain(e.category);
			expect(e.description.length).toBeGreaterThan(0);
		}
		// Distinguishable rows: two identically-worded ones would read as a duplicate.
		expect(command!.description).not.toBe(anywhere!.description);
	});

	it('neither collides with any other binding in an overlapping mode', () => {
		// A collision does not error - it SHADOWS, and whichever entry `lookup`
		// reaches first wins. That is silent, so it is asserted rather than assumed.
		// The two are checked against EACH OTHER too: `command` and `global` overlap.
		for (const e of both()) {
			const clashes = DEFAULT_SHORTCUTS.filter(
				(other) =>
					other.id !== e.id &&
					modesOverlap(e.mode, other.mode) &&
					other.keys.some((k) => e.keys.some((mine) => bindingsCollide(mine, k)))
			);
			expect(clashes.map((c) => c.id)).toEqual([]);
			expect(shortcuts.conflicts.has(e.id)).toBe(false);
		}
	});

	it('neither is a typing hazard', () => {
		// A bare printable chord bound OUTSIDE command mode makes that character
		// untypable in every cell. `e` is safe because command mode is exactly where
		// bare letters belong; `Mod-Shift-e` is safe because it carries modifiers.
		for (const e of both()) expect(typingHazards(e)).toEqual([]);
	});

	it('each resolves in the mode it claims', () => {
		expect(shortcuts.lookup('command', 'e')?.id).toBe('extract-code-block');
		// `e` must stay typable: it is bound in command mode only.
		expect(shortcuts.lookup('edit', 'e')).toBeUndefined();
		expect(shortcuts.lookup('command', 'Mod-Shift-e')?.id).toBe('extract-code-block-anywhere');
		expect(shortcuts.lookup('edit', 'Mod-Shift-e')?.id).toBe('extract-code-block-anywhere');
	});
});
