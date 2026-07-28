/**
 * The height a rich `text/html` output's iframe reports up to the app
 * (`HtmlOutput.svelte`'s `buildSrcdoc` injects this function into the srcdoc and
 * calls it; the parent then clamps the result to its own max and 40px floor).
 *
 * A bare `scrollHeight` is the content height and EXCLUDES the horizontal
 * scrollbar. That used to be academic - with the browser's default 1px cell
 * padding a table almost never overflowed - but the output stylesheet now keeps
 * tables real tables, so a genuinely wide one deliberately overflows and scrolls
 * the output document. Where the platform paints a classic, space-taking
 * scrollbar (Windows, Linux) that bar then eats ~15px of a frame sized to the
 * content exactly, so the frame ALSO grows a vertical scrollbar and clips its
 * last row. So the gutter is added back, but only when a horizontal scrollbar is
 * really there.
 *
 * `viewportHeight` is `window.innerHeight` (the viewport INCLUDING any rendered
 * scrollbar) and `clientHeight` is `documentElement.clientHeight` (the same
 * viewport EXCLUDING it), so their difference is the gutter and nothing else.
 * Do not re-derive it from the root element's own `offsetHeight`: that is the
 * `<html>` box's content-driven height, not the viewport, so the difference is
 * an arbitrary number that grows with the content - and because the parent
 * feeds the reported height straight back as the frame height, it makes the
 * measurement oscillate instead of settling.
 *
 * Pure and self-contained on purpose: it is serialized into the srcdoc with
 * `toString()`, so it may not reference anything in module scope.
 */
export function reportedHeight(
	scrollHeight: number,
	scrollWidth: number,
	clientWidth: number,
	viewportHeight: number,
	clientHeight: number
): number {
	const gutter = scrollWidth > clientWidth ? Math.max(0, viewportHeight - clientHeight) : 0;
	return scrollHeight + gutter;
}
