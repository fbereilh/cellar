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
 * One pass over the document: either a comment opener, or an element whose `src`
 * (or, for `<link>`, `href`) makes the browser FETCH a subresource. Plain
 * `<a href>` is deliberately excluded: a relative link is a navigation the user
 * has not asked for yet, not a broken render.
 *
 * `<script>`/`<style>` are in the list for their own attributes AND because they
 * open a raw-text body: a self-contained export inlines a minified bundle whose
 * string literals build `<img src="…">` markup, so scanning that body would
 * report the very file this preview targets as having unresolvable assets.
 */
const TOKEN =
	/<!--|<(link|script|style|img|iframe|frame|source|audio|video|embed|track|object)\b([^>]*)>/gi;

/** Closers for the two raw-text bodies `TOKEN` skips over. */
const CLOSE_TAG: Record<string, RegExp> = {
	script: /<\/\s*script\b/gi,
	style: /<\/\s*style\b/gi
};

/**
 * `src="…"` / `href="…"` / `data="…"`, quoted or bare, inside one tag's
 * attributes. The name is anchored to an attribute boundary rather than `\b`,
 * because `-` is a non-word character: `\bsrc=` matches inside `data-src=`, and
 * a lazy-loading page whose real refs are all absolute would be misreported.
 */
const URL_ATTR = /(?:^|[\s/])(?:src|href|data)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

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

/** True when one tag's attribute text carries a folder-relative subresource ref. */
function attrsRefRelative(attrs: string): boolean {
	URL_ATTR.lastIndex = 0;
	let attr: RegExpExecArray | null;
	while ((attr = URL_ATTR.exec(attrs))) {
		const value = attr[1] ?? attr[2] ?? attr[3] ?? '';
		if (!resolvesWithoutFolder(value)) return true;
	}
	return false;
}

/**
 * True when the document loads at least one subresource by a path relative to
 * the file on disk — i.e. content the sandboxed preview cannot resolve. A
 * self-contained export (everything inline, or CDN URLs) returns false.
 *
 * Markup-shaped text that a browser never treats as markup — an HTML comment,
 * or a string inside a `<script>`/`<style>` body — is skipped, so an inlined
 * bundle cannot fake a reference the page does not actually load.
 */
export function hasRelativeAssetRefs(html: string): boolean {
	TOKEN.lastIndex = 0;
	let token: RegExpExecArray | null;
	while ((token = TOKEN.exec(html))) {
		if (token[0] === '<!--') {
			const end = html.indexOf('-->', TOKEN.lastIndex);
			// Unterminated: a browser comments out the rest of the document.
			if (end === -1) return false;
			TOKEN.lastIndex = end + 3;
			continue;
		}
		if (attrsRefRelative(token[2] ?? '')) return true;

		const closer = CLOSE_TAG[token[1].toLowerCase()];
		if (closer) {
			closer.lastIndex = TOKEN.lastIndex;
			const close = closer.exec(html);
			// Unterminated: a browser reads the rest of the document as raw text.
			if (!close) return false;
			TOKEN.lastIndex = close.index;
		}
	}
	return false;
}
