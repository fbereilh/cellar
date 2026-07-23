/**
 * Cellar — HTML file identity + the sandboxed-preview's one known limitation
 * (shared, browser-safe, pure).
 *
 * An `.html`/`.htm` file opens in a file tab that defaults to a RENDERED preview
 * (a sandboxed iframe) with a Preview/Source toggle — the common case being the
 * self-contained exports a data notebook produces (plotly/bokeh, nbconvert
 * reports). See `HtmlPreview.svelte` for the sandbox model.
 *
 * The preview renders through `srcdoc`, which gives the frame an **opaque**
 * origin — that is exactly what makes it safe, and it is also why a page that
 * pulls a sibling file off disk (`<script src="plot_files/main.js">`) cannot
 * load it: a relative URL in a `srcdoc` document resolves against the APP's URL,
 * not the file's folder, and the app serves no such path. Rather than let that
 * render as a mysteriously blank page, `hasRelativeAssetRefs()` detects the case
 * so the tab can say so in one line.
 *
 * No Node/DOM APIs (a string scan, never a DOM parse), so it is safe on either
 * side and cheap enough to run on every toggle into Preview.
 */

/** Lowercase extension of a path (no dot), or '' when it has none. */
function extOf(path: string): string {
	const name = path.split(/[/\\]/).pop() ?? path;
	const dot = name.lastIndexOf('.');
	return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** True when `path` names an HTML file the shell opens with a rendered preview. */
export function isHtmlPath(path: string): boolean {
	const ext = extOf(path);
	return ext === 'html' || ext === 'htm';
}

/**
 * Elements whose `src` (or, for `<link>`, `href`) makes the browser FETCH a
 * subresource. Plain `<a href>` is deliberately excluded: a relative link is a
 * navigation the user has not asked for yet, not a broken render.
 */
const SUBRESOURCE_TAG = /<(link|script|img|iframe|frame|source|audio|video|embed|track|object)\b([^>]*)>/gi;

/** `src="…"` / `href="…"` / `data="…"`, quoted or bare, inside one tag's attributes. */
const URL_ATTR = /\b(?:src|href|data)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

/**
 * A reference that resolves WITHOUT the file's folder: absolute URLs, protocol-
 * relative URLs, inline data/blob payloads, and in-page fragments. Everything
 * else is folder-relative (`plot_files/x.js`, `./a.css`, `../lib/b.js`) or
 * root-relative (`/assets/x.js`) — neither survives the srcdoc sandbox.
 */
function resolvesWithoutFolder(url: string): boolean {
	const u = url.trim();
	if (!u) return true;
	if (u.startsWith('#')) return true;
	if (u.startsWith('//')) return true;
	// A scheme (http:, https:, data:, blob:, javascript:, mailto:, about:, file:).
	return /^[a-z][a-z0-9+.-]*:/i.test(u);
}

/**
 * True when the document loads at least one subresource by a path relative to
 * the file on disk — i.e. content the sandboxed preview cannot resolve. A
 * self-contained export (everything inline, or CDN URLs) returns false.
 */
export function hasRelativeAssetRefs(html: string): boolean {
	SUBRESOURCE_TAG.lastIndex = 0;
	let tag: RegExpExecArray | null;
	while ((tag = SUBRESOURCE_TAG.exec(html))) {
		const attrs = tag[2] ?? '';
		URL_ATTR.lastIndex = 0;
		let attr: RegExpExecArray | null;
		while ((attr = URL_ATTR.exec(attrs))) {
			const value = attr[1] ?? attr[2] ?? attr[3] ?? '';
			if (!resolvesWithoutFolder(value)) return true;
		}
	}
	return false;
}
