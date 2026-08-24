/**
 * Cellar - lifting a RENDERED code block out of prose and into a real notebook
 * cell (pure, browser-safe).
 *
 * A chat reply is markdown, and most of its value is the fenced code it carries:
 * the everyday move after reading one is "now run that". Before this, that meant
 * selecting the block by hand, creating a cell and pasting - three gestures over
 * a selection that is easy to get wrong at the fence boundaries. The same is true
 * of a markdown CELL holding a snippet and of a kernel `display(Markdown(...))`
 * payload, so the affordance hangs on the rendered BLOCK rather than on the chat
 * cell: one rule, every `.cellar-md` surface a NOTEBOOK renders.
 *
 * Deliberately NOT the `.md` file preview (`MarkdownView.svelte`), which renders
 * through the same `renderMarkdown` but lives in a file tab with no notebook to
 * extract into. That is why the decoration is driven by `Cell.svelte` rather than
 * emitted by the markdown renderer: a control baked into the HTML STRING would
 * appear on every surface sharing the engine, including the one where it cannot
 * work - and would widen what the output sanitizer has to pass, for a control
 * the model's own markdown must never be able to forge.
 *
 * ## Where the source comes from, and why it is byte-exact
 *
 * From the RENDERED DOM (`<pre><code>`'s `textContent`), never from a second
 * parse of the markdown source. markdown-it escapes a fence's content with
 * `escapeHtml` (`&<>"`), DOMPurify passes text nodes through untouched, and
 * `textContent` decodes back - so the round trip is exact for backticks, angle
 * brackets, quotes and literal `&amp;`-shaped text alike. It also means there is
 * no "the Nth fence in the source is the Nth `<pre>` in the output" correlation
 * to get wrong, which an indented code block or a fence inside a list would
 * break silently. The one adjustment is {@link codeBlockText}'s single trailing
 * newline - see there.
 *
 * ## What it produces
 *
 * The fence's info string picks the cell's LOGICAL type where it maps onto one
 * ({@link fenceCellType}); an unknown tag, or no tag at all, yields a `code`
 * cell - which is what a notebook user wants for a `bash` or `json` block anyway
 * (they add the `!` or the magic themselves). `chat` and `raw` are deliberately
 * unreachable: a fence cannot express a question for the model, and no fence tag
 * means "verbatim text for a downstream tool". That is also what keeps this
 * feature clear of `PY_UNSUPPORTED_TYPES` - the three types it can produce are
 * exactly the three EVERY notebook can hold, `.py` included, so no extraction
 * can be refused for its type.
 */

import type { LogicalCellType } from '$lib/server/types';

/**
 * Marks a decorated block - set on the `<pre>` ITSELF (see
 * {@link decorateCodeBlocks} for why nothing is ever re-parented). An ATTRIBUTE
 * rather than a class because it is the contract two files share -
 * `Cell.svelte` decorates, `LiveNotebook.svelte` resolves the shortcut's target
 * against it - while the class beside it is styling only, and a styling class is
 * the kind of thing a redesign renames.
 */
export const CODE_BLOCK_ATTR = 'data-cellar-code-block';

/** The decorated `<pre>`'s styling hook (`.cellar-code-block` in `app.css`). */
export const CODE_BLOCK_CLASS = 'cellar-code-block';

/** The extract control's test id, shared by the decorator and both test suites. */
export const EXTRACT_TESTID = 'extract-code';

/** The name the control takes once this block has been extracted at least once. */
export const EXTRACTED_LABEL = 'Extracted - click again for another cell';

/** Fence info strings that name a logical cell type. Anything else is `code`. */
const FENCE_TYPES: Record<string, LogicalCellType> = {
	python: 'code',
	py: 'code',
	python3: 'code',
	ipython: 'code',
	sql: 'sql',
	markdown: 'markdown',
	md: 'markdown'
};

/**
 * The logical cell type a fence's info string asks for. Case- and
 * decoration-insensitive: the `language-…` class carries the info string's first
 * word, but a fence may legitimately be written ```` ```Python ```` or
 * ```` ```python title=x ````, and the cell's type must not turn on that.
 *
 * Everything unrecognized - and an absent tag - is a `code` cell. That default is
 * the honest one: an unknown tag says the block is code of SOME language, and the
 * notebook's language is Python.
 */
export function fenceCellType(info: string | null | undefined): LogicalCellType {
	const tag = String(info ?? '')
		.trim()
		.split(/[\s,{]/, 1)[0]
		.toLowerCase();
	return FENCE_TYPES[tag] ?? 'code';
}

/**
 * The fence's info tag, read off markdown-it's `class="language-…"`. Null for an
 * indented code block (which carries no class) and for any `<code>` with no
 * language class - both of which {@link fenceCellType} then reads as `code`.
 */
export function fenceLanguage(code: Element | null | undefined): string | null {
	if (!code) return null;
	for (const cls of Array.from(code.classList ?? [])) {
		if (cls.startsWith('language-')) return cls.slice('language-'.length) || null;
	}
	return null;
}

/**
 * The block's text as a CELL SOURCE: its rendered text with at most ONE trailing
 * newline removed.
 *
 * That newline is the fence's own line terminator, not content - markdown-it's
 * fence content is the raw lines INCLUDING the last one's `\n`, so
 * ```` ```\nx = 1\n``` ```` renders the text `"x = 1\n"`. A cell holding that
 * opens with a phantom empty last line, which is not what the block showed. ONE
 * newline, never a greedy trim: a block that deliberately ends in a blank line
 * (`"x = 1\n\n"`) keeps it, and leading whitespace and indentation are never
 * touched at all.
 */
export function codeBlockText(code: Element | null | undefined): string {
	const text = code?.textContent ?? '';
	return text.endsWith('\n') ? text.slice(0, -1) : text;
}

/** What one rendered block yields: the cell to create from it. */
export interface ExtractedCodeBlock {
	/** The block's content, byte-exact (see {@link codeBlockText}). */
	source: string;
	/** The logical type the fence's info string asks for. */
	cellType: LogicalCellType;
	/** The raw info tag, for the control's name; null when the fence carried none. */
	language: string | null;
}

/**
 * Read a decorated block - the `<pre>` itself, or anything inside it - as the
 * cell it would become. Null when the element holds no `<pre><code>`, so a
 * caller does nothing rather than creating an empty cell.
 */
export function readCodeBlock(el: Element | null | undefined): ExtractedCodeBlock | null {
	const block = el?.closest?.(`[${CODE_BLOCK_ATTR}]`) ?? el ?? null;
	const code = block?.querySelector?.('pre > code') ?? null;
	if (!code) return null;
	const language = fenceLanguage(code);
	return { source: codeBlockText(code), cellType: fenceCellType(language), language };
}

/** The control's name - it states the cell it will create, so the type is visible. */
export function extractLabel(cellType: LogicalCellType): string {
	return `Extract to a new ${cellType} cell below`;
}

/** `matches` throws on a selector an engine does not support; read that as no match. */
function safeMatches(el: Element, selector: string): boolean {
	try {
		return el.matches(selector);
	} catch {
		return false;
	}
}

/**
 * The block the KEYBOARD route acts on: the one under the pointer, else the one
 * holding focus. Scoped to `root` (one notebook), so a block in another mounted
 * notebook is never reachable.
 *
 * HOVER WINS over focus, and the losing case is decided rather than accidental.
 * Focus lands inside a block only by clicking or tabbing to its own control, and
 * it STAYS there afterwards - so focus-first meant that having extracted block 1
 * by clicking, moving the mouse to block 2 and pressing the chord extracted
 * block 1 AGAIN. Hover-first's bad case needs the pointer to be resting on a
 * different code block while you tab to this one's control: rarer, and visible on
 * screen. With no pointer at all - a keyboard-only user, a touch device - nothing
 * is hovered and focus is what answers, which is what keeps the chord usable
 * without a mouse.
 *
 * `:hover` / `:focus-within` are read off the live document rather than tracked
 * in component state: they ARE the browser's own answer to this question, and a
 * tracked mirror can only drift (a pointer that leaves because the content
 * re-rendered under it fires no leave event).
 */
export function targetCodeBlock(root: ParentNode | null | undefined): Element | null {
	if (!root) return null;
	const blocks = Array.from(root.querySelectorAll(`[${CODE_BLOCK_ATTR}]`));
	// Last match, not first: `:hover` matches every element under the pointer, and
	// document order puts the innermost last.
	const hovered = blocks.filter((b) => safeMatches(b, ':hover')).at(-1);
	if (hovered) return hovered;
	return blocks.filter((b) => safeMatches(b, ':focus-within')).at(-1) ?? null;
}

/**
 * The two glyphs a control carries at once - an arrow sending the block down into
 * a cell, and the check that confirms one landed. BOTH are built in and CSS shows
 * one, because the confirmation is an attribute flip on an element the decorator
 * no longer holds a reference to; swapping `<path>` data instead would mean
 * re-entering the DOM on a timer for a purely visual state.
 */
const ICONS: Record<'extract' | 'done', string[]> = {
	extract: ['M12 4v9', 'm8 11 4 4 4-4', 'M5 20h14'],
	done: ['m20 6-11 11-5-5']
};

function buildIcon(doc: Document, name: 'extract' | 'done'): SVGSVGElement {
	const NS = 'http://www.w3.org/2000/svg';
	const svg = doc.createElementNS(NS, 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('fill', 'none');
	svg.setAttribute('stroke', 'currentColor');
	svg.setAttribute('stroke-width', name === 'done' ? '2.4' : '2');
	svg.setAttribute('stroke-linecap', 'round');
	svg.setAttribute('stroke-linejoin', 'round');
	svg.setAttribute('aria-hidden', 'true');
	svg.setAttribute('class', 'h-3.5 w-3.5');
	svg.setAttribute('data-icon', name);
	for (const d of ICONS[name]) {
		const path = doc.createElementNS(NS, 'path');
		path.setAttribute('d', d);
		svg.appendChild(path);
	}
	return svg;
}

/**
 * The control itself: icon-only, quiet at rest and full-strength on hover/focus.
 * It sits in a strip `app.css` reserves at the top of the `<pre>`, so it covers
 * no code at any scroll offset and the block never moves as it brightens.
 */
function buildExtractButton(doc: Document, block: ExtractedCodeBlock | null): HTMLButtonElement {
	const label = extractLabel(block?.cellType ?? 'code');
	const btn = doc.createElement('button');
	btn.setAttribute('type', 'button');
	btn.className = 'cellar-code-extract btn btn-ghost btn-xs btn-square';
	btn.setAttribute('data-testid', EXTRACT_TESTID);
	btn.setAttribute('aria-label', label);
	btn.setAttribute('title', label);
	btn.appendChild(buildIcon(doc, 'extract'));
	btn.appendChild(buildIcon(doc, 'done'));
	return btn;
}

/**
 * Decorate every undecorated `<pre><code>` under `root` with an extract control.
 * Returns how many blocks it decorated, which is what makes it testable without
 * a snapshot of the markup.
 *
 * IT MOVES NO NODE, and that is the load-bearing property rather than an
 * implementation detail. The markup this walks is a FRAGMENT some renderer put
 * there - here Svelte's `{@html}` - and such a renderer tracks its fragment by
 * the identity and sibling position of the TOP-LEVEL nodes it inserted: Svelte
 * records the first and last of them and, on the next in-place swap, tears the
 * fragment down by walking `nextSibling` from one to the other and removing each
 * (`remove_effect_dom`). An earlier version put a wrapper `<div>` where the
 * `<pre>` was and moved the `<pre>` inside it, which takes the `<pre>` out of
 * that sibling chain: the walk then descends into the wrapper, removes the
 * `<pre>` and the control, and STOPS - orphaning the empty wrapper and every
 * remaining sibling of the old fragment, which accumulate beside the new render.
 *
 * Svelte happens to spare Cellar today, because each `{@html}` in `Cell.svelte`
 * is the only child of its container and so takes the `innerHTML =` path that
 * clears everything; that is one added sibling away from not being true, and it
 * is not a property this module can see or assert. So the decoration is
 * expressed as something no fragment renderer can be broken by: the `<pre>`
 * keeps its identity, its parent and its siblings, and gains only an attribute,
 * a class and one appended child. It also means a find-in-page Range already
 * pointing into the block is untouched, rather than merely surviving a move.
 *
 * The horizontal scroll moves with it, onto the `<code>` (`app.css`), so the
 * `<pre>` can host the absolutely-positioned control without it scrolling away -
 * a `<button>` is phrasing content, so it is legal there.
 *
 * IDEMPOTENT: an already-decorated `<pre>` is skipped, so re-running after an
 * unrelated re-render neither duplicates a control nor touches a block again.
 *
 * The control carries NO TEXT NODE - the glyph is an inline SVG and the name
 * rides `aria-label`. That is load-bearing rather than a style choice: find-in-
 * page walks every text node under the rendered surface to build its highlight
 * Ranges (`domHighlight.ts`), so a visible word here would be counted as a match
 * and would slide every later ordinal in the cell.
 */
export function decorateCodeBlocks(root: ParentNode | null | undefined): number {
	if (!root) return 0;
	const doc = (root as Element).ownerDocument ?? (root as unknown as Document);
	if (typeof doc?.createElement !== 'function') return 0;
	let decorated = 0;
	for (const code of Array.from(root.querySelectorAll('pre > code'))) {
		const pre = code.parentElement;
		if (!pre || pre.hasAttribute(CODE_BLOCK_ATTR)) continue;
		pre.setAttribute(CODE_BLOCK_ATTR, '');
		pre.classList.add(CODE_BLOCK_CLASS);
		pre.appendChild(buildExtractButton(doc, readCodeBlock(pre)));
		decorated++;
	}
	return decorated;
}

/**
 * The confirmation an extraction leaves on the control, in two parts that expire
 * differently on purpose.
 *
 * The CHECK is transient (`data-extracted`, cleared after `ms`) - it says "that
 * click landed", exactly as the cell toolbar's copy buttons confirm, and would be
 * a lie left standing. The NAME is not: once a block has been extracted the
 * control permanently reads {@link EXTRACTED_LABEL}, because that is a fact about
 * this block which stays true, and it is what makes the repeat behaviour obvious
 * BEFORE the second click rather than after it.
 *
 * Repeated extraction INSERTS AGAIN; it is deliberately not a no-op. A duplicate
 * cell is one `dd` away, whereas a no-op would have to explain itself against a
 * cell the user may since have edited, moved or deleted - and a control that
 * silently does nothing is the one outcome to avoid.
 *
 * STATED RESIDUAL: that name lives on the button {@link decorateCodeBlocks}
 * appends, so ANY re-render of the rendered markdown rebuilds it and the block
 * offers to extract again as if for the first time. Windowing a scrolled-away
 * cell out is only one instance and not the everyday one - a heading FOLD drops
 * the body via `{#if}`, a full-cell collapse drops the whole container, and an
 * in-place `{@html}` swap from a remote or agent edit replaces the fragment;
 * each of those resets the label. Only the label: the extracted CELL is a
 * document mutation and is durable regardless. Accepted rather than lifted into
 * the notebook (where per-cell state that must outlive a re-render belongs): a
 * durable record would need a stable per-BLOCK key, which only the block's own
 * content can supply, and it would buy a label - while the fact it reports is
 * already on screen as the extracted cell sitting below.
 */
export function flashExtracted(btn: Element | null | undefined, ms = 1200): void {
	if (!btn || typeof btn.setAttribute !== 'function') return;
	btn.setAttribute('data-extracted', 'true');
	btn.setAttribute('aria-label', EXTRACTED_LABEL);
	btn.setAttribute('title', EXTRACTED_LABEL);
	btn.ownerDocument?.defaultView?.setTimeout(() => btn.removeAttribute('data-extracted'), ms);
}
