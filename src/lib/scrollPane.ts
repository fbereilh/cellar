/**
 * The scroll pane a notebook lives in, and the band at its top that the
 * notebook toolbar's sticky compact row covers.
 */

/**
 * The scrollable ancestor of `el` (the shell gives each notebook tab its own
 * `overflow-y-auto` pane). Null means the viewport scrolls.
 */
export function scrollParent(el: HTMLElement): HTMLElement | null {
	for (let p = el.parentElement; p; p = p.parentElement) {
		const oy = getComputedStyle(p).overflowY;
		if (oy === 'auto' || oy === 'scroll') return p;
	}
	return null;
}

/**
 * The height of the band the sticky toolbar covers, read from the pane's own
 * `scroll-padding-top` so native `scrollIntoView`, the hand-rolled jump paths
 * and the editor's cursor scrolling keep one number.
 */
export function stickyTopInset(pane: HTMLElement): number {
	return parseFloat(getComputedStyle(pane).scrollPaddingTop) || 0;
}
