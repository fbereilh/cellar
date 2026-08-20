// The DOM ids that tie the tab strip to the panes it switches between.
//
// The strip is a `role="tablist"` of `role="tab"` elements and each pane is the
// `role="tabpanel"` its tab controls, so the two halves - which live in
// different components (`Navbar.svelte` and `+page.svelte`) - have to agree on
// one id scheme. They agree by CALLING the same two functions rather than each
// interpolating the same template, which is how such a pairing silently drifts.
//
// A tab id is already unique per open tab (`notebook`, or `file:<workspace path>`),
// so it is namespaced rather than hashed: the ids stay readable in the DOM.
//
// The one thing a tab id may NOT be pasted into a DOM id raw is ASCII
// WHITESPACE. `my report.html` is an ordinary filename, an HTML `id` may not
// contain whitespace, and - concretely - `aria-controls`/`aria-labelledby` are
// IDREF *LISTS*, so `tabpanel:file:my report.html` parses as two tokens and
// NEITHER resolves: the tab loses the pane it controls and the pane loses its
// accessible name, silently, for exactly those files. So the whitespace is
// percent-encoded on the way in.
//
// The encoding must be INJECTIVE or the fix trades a broken pairing for a
// colliding one: a plain `replace(/\s/g, '-')` maps `a b` and `a-b` onto the
// same id, i.e. two open tabs claiming one DOM id. Percent-encoding `%` itself
// alongside the whitespace, in ONE pass (so an encoded byte is never re-read as
// a source character), keeps distinct tab ids distinct and keeps the mapping
// stable for a given tab id.

/** ASCII whitespace (the characters an HTML `id` may not contain), plus the escape character itself. */
const NEEDS_ESCAPE = /[%\t\n\f\r ]/g;

function escapeForDomId(id: string): string {
	return id.replace(NEEDS_ESCAPE, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

/** The DOM id of the tab control for tab `id`. */
export function tabDomId(id: string): string {
	return `tab:${escapeForDomId(id)}`;
}

/** The DOM id of the pane that tab `id` controls. */
export function tabPanelDomId(id: string): string {
	return `tabpanel:${escapeForDomId(id)}`;
}
