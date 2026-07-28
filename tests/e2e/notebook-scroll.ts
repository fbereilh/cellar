import type { Page } from '@playwright/test';

/**
 * Shared browser-side helpers for the notebook's scroll pane, used by the cell
 * virtualization specs (P2 windowing, P3 pinning, P4 jump paths).
 *
 * The pane is the shell's `overflow-y-auto` ancestor of the notebook (each open
 * notebook tab gets its own), so every helper walks up from a mounted cell to the
 * first scrollable ancestor — the same walk `LiveNotebook.scrollParent` does. That
 * walk is repeated inside each `page.evaluate` body because an evaluate runs in the
 * browser and cannot close over module scope.
 */

/** Read a scroll metric off the notebook's pane (-1 when there is no pane). */
export async function paneMetric(page: Page, prop: 'scrollTop' | 'scrollHeight' | 'clientHeight'): Promise<number> {
	return page.evaluate((p) => {
		let pane = document.querySelector('[data-testid="cell"]') as HTMLElement | null;
		while (pane) {
			const s = getComputedStyle(pane);
			if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && pane.scrollHeight > pane.clientHeight) break;
			pane = pane.parentElement;
		}
		return pane ? (pane as unknown as Record<string, number>)[p] : -1;
	}, prop);
}

/** Jump the pane's scroll offset (the browser clamps it to the scrollable range). */
export async function setScrollTop(page: Page, top: number): Promise<void> {
	await page.evaluate((t) => {
		let pane = document.querySelector('[data-testid="cell"]') as HTMLElement | null;
		while (pane) {
			const s = getComputedStyle(pane);
			if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && pane.scrollHeight > pane.clientHeight) {
				pane.scrollTop = t;
				return;
			}
			pane = pane.parentElement;
		}
	}, top);
}

/** Scroll as far down as the pane allows. */
export async function scrollToBottom(page: Page): Promise<void> {
	await page.evaluate(() => {
		let pane = document.querySelector('[data-testid="cell"]') as HTMLElement | null;
		while (pane) {
			const s = getComputedStyle(pane);
			if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && pane.scrollHeight > pane.clientHeight) {
				pane.scrollTop = pane.scrollHeight;
				return;
			}
			pane = pane.parentElement;
		}
	});
}

/** True when the cell has a real DOM node (i.e. it is mounted, not a spacer). */
export async function isCellMounted(page: Page, id: string): Promise<boolean> {
	return page.evaluate((cellId) => !!document.querySelector(`[data-cell-id="${CSS.escape(cellId)}"]`), id);
}

/** The mounted cell's rendered card height in px, or null when it is a spacer. */
export async function cellHeight(page: Page, id: string): Promise<number | null> {
	return page.evaluate((cellId) => {
		const el = document.querySelector(`[data-cell-id="${CSS.escape(cellId)}"]`) as HTMLElement | null;
		return el ? el.offsetHeight : null;
	}, id);
}

/** Viewport-relative top of a mounted cell, or null when it is a spacer. */
export async function cellTop(page: Page, id: string): Promise<number | null> {
	return page.evaluate((cellId) => {
		const el = document.querySelector(`[data-cell-id="${CSS.escape(cellId)}"]`) as HTMLElement | null;
		return el ? el.getBoundingClientRect().top : null;
	}, id);
}

/** True when the cell is mounted AND its box overlaps the pane's visible rect. */
export async function cellIsOnScreen(page: Page, id: string): Promise<boolean> {
	return page.evaluate((cellId) => {
		let pane = document.querySelector('[data-testid="cell"]') as HTMLElement | null;
		while (pane) {
			const s = getComputedStyle(pane);
			if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && pane.scrollHeight > pane.clientHeight) break;
			pane = pane.parentElement;
		}
		const el = document.querySelector(`[data-cell-id="${CSS.escape(cellId)}"]`) as HTMLElement | null;
		if (!pane || !el) return false;
		const view = pane.getBoundingClientRect();
		const r = el.getBoundingClientRect();
		return r.bottom > view.top && r.top < view.bottom;
	}, id);
}

/**
 * Every box from the element matching `selector` up to `<html>` INCLUSIVE whose
 * content is wider than it is, nearest first (each as a `tag.class sw>cw`
 * descriptor, so a failure names the offending box and by how much); `null` when
 * the selector matches nothing.
 *
 * `scrollWidth > clientWidth` catches BOTH shapes of the same regression: a box
 * that scrolls sideways, and a box that CLIPS the excess out of view. That is why
 * the walk is inclusive and covers the whole chain rather than naming one
 * element - the layers answer in different ways and only the innermost one can
 * answer at all:
 *
 *   • The notebook cell card is `overflow-hidden`, so it absorbs anything too
 *     wide and reports it here. It is the innermost boundary, so it is what makes
 *     an assertion over an output REACHABLE - measured 5000>904 against a
 *     deliberately oversized child.
 *   • The notebook's pane is `overflow-y-auto`, and CSS computes the other axis
 *     of a non-visible overflow to `auto`, so it is the layer that would grow a
 *     real sideways scrollbar.
 *   • `document.documentElement` can never answer: the shell root
 *     (`flex h-screen flex-col overflow-hidden`) and `<main>` are `overflow-hidden`
 *     too, so overflow is clipped long before it reaches the root. An assertion
 *     measured there is structurally incapable of failing - do not reduce this
 *     walk back to it.
 */
export async function horizontallyOverflowingBoxes(page: Page, selector: string): Promise<string[] | null> {
	return page.evaluate((sel) => {
		const start = document.querySelector(sel) as HTMLElement | null;
		if (!start) return null;
		const out: string[] = [];
		for (let el: HTMLElement | null = start; el; el = el.parentElement) {
			if (el.scrollWidth > el.clientWidth) {
				const raw = typeof el.className === 'string' ? el.className.trim() : '';
				const cls = raw ? '.' + raw.split(/\s+/).join('.') : '';
				out.push(`${el.tagName.toLowerCase()}${cls} ${el.scrollWidth}>${el.clientWidth}`);
			}
		}
		return out;
	}, selector);
}

/** The `data-cell-id`s currently mounted, in document order. */
export async function mountedCellIds(page: Page): Promise<string[]> {
	return page.evaluate(() =>
		Array.from(document.querySelectorAll('[data-cell-id]')).map((el) => (el as HTMLElement).dataset.cellId as string)
	);
}

/**
 * Stamp a marker attribute on a mounted cell's node. A Svelte re-mount builds a
 * FRESH element, so a surviving marker proves the node was never unmounted — the
 * load-bearing assertion for pinning (a cell's editor state lives in that node).
 */
export async function markCellNode(page: Page, id: string, marker: string): Promise<boolean> {
	return page.evaluate(
		({ cellId, m }) => {
			const el = document.querySelector(`[data-cell-id="${CSS.escape(cellId)}"]`) as HTMLElement | null;
			if (!el) return false;
			el.setAttribute('data-e2e-marker', m);
			return true;
		},
		{ cellId: id, m: marker }
	);
}

/** True when the cell's node still carries the marker (never re-mounted). */
export async function cellNodeMarked(page: Page, id: string, marker: string): Promise<boolean> {
	return page.evaluate(
		({ cellId, m }) => {
			const el = document.querySelector(`[data-cell-id="${CSS.escape(cellId)}"]`) as HTMLElement | null;
			return !!el && el.getAttribute('data-e2e-marker') === m;
		},
		{ cellId: id, m: marker }
	);
}
