// Shared CodeMirror editor theming for Cellar. The editor must follow the app's
// light/dark theme - a dark editor on a light page (and vice-versa) reads as a
// bug. Both the notebook cells (`Cell.svelte`) and file tabs (`FileTab.svelte`)
// import from here so the light-vs-dark decision stays in one place.

import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { oneDark } from '@codemirror/theme-one-dark';

// Light editor palette = pygments "default" (the standard Jupyter light syntax
// scheme), on a subtle light-grey editor surface (stark white reads as too harsh
// against the app's light theme; this soft grey keeps the code area distinct
// while preserving syntax-color contrast).
const LIGHT_EDITOR_BG = '#f6f6f6';
const jupyterLightHighlight = HighlightStyle.define([
	{ tag: [t.comment, t.lineComment, t.blockComment], color: '#408080', fontStyle: 'italic' },
	{ tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword], color: '#008000', fontWeight: 'bold' },
	{ tag: [t.string, t.special(t.string), t.regexp], color: '#ba2121' },
	{ tag: [t.number, t.integer, t.float], color: '#666666' },
	{ tag: [t.bool, t.null, t.atom], color: '#008000', fontWeight: 'bold' },
	{ tag: [t.function(t.variableName), t.function(t.definition(t.variableName))], color: '#0000ff' },
	{ tag: [t.definition(t.variableName)], color: '#19177c' },
	{ tag: [t.className, t.typeName, t.namespace], color: '#0000ff', fontWeight: 'bold' },
	{ tag: [t.standard(t.variableName), t.self], color: '#008000' },
	{ tag: [t.operator], color: '#666666' },
	{ tag: [t.meta], color: '#aa22ff' },
	{ tag: [t.heading], color: '#000080', fontWeight: 'bold' },
	{ tag: [t.link, t.url], color: '#0000ff', textDecoration: 'underline' },
	{ tag: [t.emphasis], fontStyle: 'italic' },
	{ tag: [t.strong], fontWeight: 'bold' }
]);
const jupyterLightTheme = EditorView.theme(
	{
		'&': { color: '#1a1a1a', backgroundColor: LIGHT_EDITOR_BG },
		'.cm-content': { backgroundColor: LIGHT_EDITOR_BG },
		'.cm-gutters': { backgroundColor: LIGHT_EDITOR_BG, border: 'none' },
		'.cm-cursor, .cm-dropCursor': { borderLeftColor: '#1a1a1a' },
		'.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: '#d7d4f0' },
		'.cm-activeLine': { backgroundColor: 'rgba(0, 0, 0, 0.045)' },
		'.cm-activeLineGutter': { backgroundColor: 'transparent' },
		'.cm-lineNumbers .cm-gutterElement': { color: '#b8b8c0' },
		'.cm-matchingBracket': { backgroundColor: '#c2f0c2', color: 'inherit' }
	},
	{ dark: false }
);

// Fallback classification of the app's theme names by lightness. The live source
// of truth is the resolved `color-scheme` daisyUI applies to `<html data-theme>`
// (see below), so any new light theme is handled automatically; this set only
// matters before the DOM exists (SSR) or if `color-scheme` is unavailable. Keep
// it in sync with the light themes offered in `Settings.svelte`.
const LIGHT_THEMES = new Set(['nord']);

// Is the app currently rendering a light theme? Prefer the resolved
// `color-scheme` daisyUI sets on `<html>` for the active `data-theme` - that is
// the reliable, theme-agnostic source of truth, so every light theme the app can
// be in gets the light editor and every dark theme gets `oneDark`. The
// `appTheme` name is only a fallback for SSR / an unset color-scheme (and, when
// passed from a Svelte `$effect`, the reactive trigger that re-runs the check on
// each theme change).
export function isLightTheme(appTheme) {
	if (typeof document !== 'undefined') {
		const scheme = getComputedStyle(document.documentElement).colorScheme;
		if (scheme === 'dark') return false;
		if (scheme === 'light') return true;
	}
	return LIGHT_THEMES.has(appTheme);
}

// Editor theme extensions for the current app theme: the Jupyter light scheme
// for light themes, the bundled `oneDark` for dark ones.
export function editorThemeExtensions(appTheme) {
	return isLightTheme(appTheme)
		? [jupyterLightTheme, syntaxHighlighting(jupyterLightHighlight)]
		: [oneDark];
}
