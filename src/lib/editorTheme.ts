// Shared CodeMirror editor theming for Cellar. The editor must follow the app's
// light/dark theme - a dark editor on a light page (and vice-versa) reads as a
// bug. Both the notebook cells (`Cell.svelte`) and file tabs (`FileTab.svelte`)
// import from here so the light-vs-dark decision stays in one place.
//
// That decision is made *entirely in CSS*. Every color below is a
// `--cellar-cm-*` custom property, resolved in `app.css` with `light-dark()`
// against the `color-scheme` daisyUI puts on `<html data-theme>`. Consequences:
//
//   1. `EDITOR_THEME` is a single, constant extension. It never changes, so a
//      theme toggle dispatches NOTHING into any editor. This is load-bearing:
//      swapping a theme through a `Compartment` makes CodeMirror re-mount the
//      one shared `<style>` element it keeps in `document.head`, which
//      invalidates style for the whole document. Doing that once per mounted
//      editor turned a theme toggle into N full-document style+layout recalcs
//      (~16ms each, ~800ms of blocked main thread at 61 cells). Now a toggle is
//      a plain CSS repaint. Do NOT reintroduce a theme Compartment here.
//   2. Any theme the app grows, light or dark, is handled with no work here -
//      `light-dark()` reads the resolved `color-scheme`, never a theme-name
//      allowlist.
//
// The palettes: light is pygments "default" (the standard Jupyter light syntax
// scheme) on the faintly-tinted editor surface; dark is One Dark, ported
// verbatim from `@codemirror/theme-one-dark`. Because both now live in one
// static theme, the editor never sets CodeMirror's `dark` flag, so this theme
// must supply every color the library's own `&light`/`&dark` base rules would
// otherwise have picked - hence the long list below (panels, tooltips, buttons
// and text fields are the search panel and the autocomplete popup).
//
// One rule about backgrounds: paint the editor surface on `&` (`.cm-editor`)
// and NOWHERE below it. `drawSelection` renders the selection into
// `.cm-selectionLayer`, a sibling of `.cm-content` at `z-index: -2`, so any
// opaque background on `.cm-content` (or `.cm-scroller`) hides every selection
// rectangle behind it.

import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

const c = (name) => `var(--cellar-cm-${name})`;

const cellarEditorTheme = EditorView.theme({
	'&': { color: c('fg'), backgroundColor: c('bg') },
	// No `backgroundColor` here. `drawSelection` paints the selection into
	// `.cm-selectionLayer`, a *sibling* of `.cm-content` at `z-index: -2`, so an
	// opaque `.cm-content` background paints straight over every selection
	// rectangle. What survived was `.cm-activeLine`, a full-width tint on a child
	// of `.cm-content` - so dragging across a few characters looked like the whole
	// line highlighting. `&` above already paints the editor surface.
	'.cm-content': { caretColor: c('cursor') },
	'.cm-cursor, .cm-dropCursor': { borderLeftColor: c('cursor') },
	'&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
		{ backgroundColor: c('selection') },
	'.cm-selectionMatch': { backgroundColor: c('selection-match') },
	'.cm-activeLine': { backgroundColor: c('active-line') },
	'.cm-specialChar': { color: c('special-char') },

	'.cm-gutters': { backgroundColor: c('bg'), color: c('gutter-fg'), border: 'none' },
	'.cm-activeLineGutter': { backgroundColor: c('active-line-gutter') },
	'.cm-lineNumbers .cm-gutterElement': { color: c('line-number-fg') },
	'.cm-foldPlaceholder': { backgroundColor: 'transparent', border: 'none', color: c('fold-placeholder') },

	// Also matched focused, because `@codemirror/language`'s own bracket rules
	// are `&.cm-focused`-scoped and would otherwise out-specify these.
	'.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
		backgroundColor: c('matching-bracket'),
		color: 'inherit'
	},
	'.cm-nonmatchingBracket, &.cm-focused .cm-nonmatchingBracket': {
		backgroundColor: c('nonmatching-bracket'),
		color: 'inherit'
	},

	// Search panel + its controls.
	'.cm-panels': { backgroundColor: c('panel-bg'), color: c('panel-fg') },
	'.cm-panels.cm-panels-top': { borderBottom: `1px solid ${c('panel-border')}` },
	'.cm-panels.cm-panels-bottom': { borderTop: `1px solid ${c('panel-border')}` },
	'.cm-searchMatch': { backgroundColor: c('search-match'), outline: `1px solid ${c('search-match-outline')}` },
	'.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: c('search-match-selected') },
	'.cm-button': {
		backgroundImage: `linear-gradient(${c('button-bg-top')}, ${c('button-bg-bottom')})`,
		border: `1px solid ${c('button-border')}`,
		color: c('panel-fg'),
		'&:active': { backgroundImage: `linear-gradient(${c('button-bg-bottom')}, ${c('button-bg-top')})` }
	},
	'.cm-textfield': {
		backgroundColor: c('textfield-bg'),
		color: c('panel-fg'),
		border: `1px solid ${c('textfield-border')}`
	},

	// Autocomplete popup + tooltips.
	'.cm-tooltip': { border: `1px solid ${c('tooltip-border')}`, backgroundColor: c('tooltip-bg'), color: c('tooltip-fg') },
	'.cm-tooltip-section:not(:first-child)': { borderTop: `1px solid ${c('tooltip-border')}` },
	'.cm-tooltip .cm-tooltip-arrow:before': { borderTopColor: 'transparent', borderBottomColor: 'transparent' },
	'.cm-tooltip .cm-tooltip-arrow:after': { borderTopColor: c('tooltip-bg'), borderBottomColor: c('tooltip-bg') },
	'.cm-tooltip-autocomplete > ul > li[aria-selected]': {
		backgroundColor: c('autocomplete-selected-bg'),
		color: c('autocomplete-selected-fg')
	},
	'.cm-tooltip-autocomplete-disabled > ul > li[aria-selected]': { backgroundColor: c('autocomplete-disabled-bg') },
	'.cm-snippetField': { backgroundColor: c('snippet-field') }
});

// One highlight style for both schemes. Where the two palettes group tags
// differently (pygments paints `operator` and `operatorKeyword` alike, One Dark
// does not) the tag gets its own token var rather than being forced into a
// shared group. Where one palette leaves a tag unstyled, its var resolves to
// `--cellar-cm-fg`, i.e. exactly the color that tag inherits today.
const cellarHighlightStyle = HighlightStyle.define([
	{ tag: [t.comment, t.lineComment, t.blockComment], color: c('tok-comment'), fontStyle: c('tok-comment-style') },
	{ tag: [t.meta], color: c('tok-meta') },
	{ tag: [t.annotation], color: c('tok-annotation') },

	{ tag: [t.keyword, t.controlKeyword], color: c('tok-keyword'), fontWeight: c('tok-keyword-weight') },
	{ tag: [t.operatorKeyword], color: c('tok-operator-keyword'), fontWeight: c('tok-keyword-weight') },
	{ tag: [t.modifier], color: c('tok-modifier'), fontWeight: c('tok-keyword-weight') },

	{ tag: [t.string, t.processingInstruction], color: c('tok-string') },
	{ tag: [t.special(t.string), t.regexp, t.escape], color: c('tok-regexp') },
	{ tag: [t.number, t.integer, t.float], color: c('tok-number') },
	{ tag: [t.bool, t.null, t.atom], color: c('tok-atom'), fontWeight: c('tok-atom-weight') },
	{ tag: [t.special(t.variableName), t.color, t.constant(t.name)], color: c('tok-constant') },

	{ tag: [t.name, t.propertyName, t.macroName, t.character], color: c('tok-name') },
	{ tag: [t.function(t.variableName), t.function(t.definition(t.variableName))], color: c('tok-function') },
	{ tag: [t.labelName], color: c('tok-label') },
	{ tag: [t.definition(t.variableName), t.definition(t.name)], color: c('tok-definition') },
	{ tag: [t.className, t.typeName, t.namespace], color: c('tok-type'), fontWeight: c('tok-type-weight') },
	{ tag: [t.standard(t.variableName), t.standard(t.name)], color: c('tok-builtin') },
	{ tag: [t.self], color: c('tok-self') },
	{ tag: [t.operator], color: c('tok-operator') },

	{ tag: [t.inserted], color: c('tok-inserted') },
	{ tag: [t.deleted], color: c('tok-deleted') },
	{ tag: [t.changed], color: c('tok-changed') },
	{ tag: [t.invalid], color: c('tok-invalid') },

	{ tag: [t.heading], color: c('tok-heading'), fontWeight: 'bold' },
	{ tag: [t.link], color: c('tok-link'), textDecoration: 'underline' },
	{ tag: [t.url], color: c('tok-url'), textDecoration: 'underline' },
	{ tag: [t.emphasis], fontStyle: 'italic' },
	{ tag: [t.strong], fontWeight: 'bold' },
	{ tag: [t.strikethrough], textDecoration: 'line-through' }
]);

// The editor's theme extension. Constant by design - see the header comment.
export const EDITOR_THEME = [cellarEditorTheme, syntaxHighlighting(cellarHighlightStyle)];
