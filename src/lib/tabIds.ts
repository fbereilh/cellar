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

/** The DOM id of the tab control for tab `id`. */
export function tabDomId(id: string): string {
	return `tab:${id}`;
}

/** The DOM id of the pane that tab `id` controls. */
export function tabPanelDomId(id: string): string {
	return `tabpanel:${id}`;
}
