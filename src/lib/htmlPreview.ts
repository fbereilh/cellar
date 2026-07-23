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
 * navigation the user has not asked for yet, not a broken render. `<link>` is
 * further narrowed by its `rel` (see `LINK_FETCH_RELS`).
 *
 * `<script>`/`<style>` are here for their own attributes; their BODIES are
 * skipped separately (see `RAW_TEXT_TAGS`).
 */
const SUBRESOURCE_TAGS = new Set([
	'link',
	'script',
	'style',
	'img',
	'iframe',
	'frame',
	'source',
	'audio',
	'video',
	'embed',
	'track',
	'object'
]);

/**
 * Elements whose CONTENT the scan must not read as live markup: a self-contained
 * export inlines a minified bundle whose string literals build `<img src="…">`
 * markup, and reporting that would put the notice on exactly the file the
 * preview targets. `<textarea>`/`<title>` are the same class — displayed text
 * that merely looks like a tag.
 *
 * `<template>` is here for the same OUTCOME by a different route: its content IS
 * parsed as markup, but into an inert fragment that fetches nothing until a
 * script clones it. (A nested `<template>` ends the skip at the inner close —
 * accepted, since it only returns the scan to today's behavior.)
 */
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title', 'template']);

/** The attribute NAMES that carry a fetched URL. Longest is 4 chars (`href`). */
const URL_ATTRS = new Set(['src', 'href', 'data']);

/**
 * The `<link>` relations a browser fetches to RENDER the page. A `<link>` is the
 * one subresource element whose `href` may just as well be metadata: `canonical`
 * and `alternate` are never fetched at all, and `icon` is chrome, not content —
 * a missing favicon is not a broken render. Reporting those would be an
 * over-report, the direction this module's contract singles out as the one to
 * avoid, so an unrecognized (or absent) `rel` does NOT convict.
 */
const LINK_FETCH_RELS = new Set(['stylesheet', 'preload', 'modulepreload']);

/** True when a `<link>`'s (possibly multi-token, possibly empty) `rel` fetches. */
function linkFetchesToRender(rel: string): boolean {
	for (const token of rel.split(/\s+/)) {
		if (token && LINK_FETCH_RELS.has(token)) return true;
	}
	return false;
}

/** ASCII letter or digit — the only characters a tag name is scanned from. */
const NAME_CHAR = /[a-z0-9]/i;

/** Longest name either set holds, so a longer one is skipped without slicing. */
const MAX_TAG_LEN = Math.max(
	...[...SUBRESOURCE_TAGS, ...RAW_TEXT_TAGS].map((tag) => tag.length)
);

function isSpace(c: string): boolean {
	return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
}

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
 * Walk one tag's attributes from just after its name, QUOTE-AWARE, and report
 * where the tag ends plus (when `wantUrls`) whether a URL attribute holds a
 * folder-relative ref and (when `wantRel`) the tag's `rel` value — read in the
 * same pass because attribute order is arbitrary (`<link href=… rel=…>`).
 *
 * Respecting quotes is what keeps a self-contained export off the notice: a
 * value may legally contain `>` (an inline `data:image/svg+xml` URI carries a
 * whole `<svg …></svg>`), so ending the tag at the first `>` would truncate it
 * and read the remainder as bare attributes. It also means only attribute NAMES
 * are matched, so `src=`-shaped text inside some other attribute's value (an
 * `alt`, a `title`) is never mistaken for a reference.
 *
 * Nothing is allocated per attribute unless the name is the length of one of
 * `src`/`href`/`data`, nor per value unless that name is one of them.
 */
function scanTag(
	html: string,
	start: number,
	wantUrls: boolean,
	wantRel: boolean
): { end: number; relative: boolean; rel: string } {
	const n = html.length;
	let i = start;
	let relative = false;
	let rel = '';
	while (i < n) {
		const c = html[i];
		if (c === '>') return { end: i + 1, relative, rel };
		if (isSpace(c) || c === '/') {
			i++;
			continue;
		}

		const nameStart = i;
		while (i < n && !isSpace(html[i]) && html[i] !== '=' && html[i] !== '>' && html[i] !== '/') i++;
		const nameLen = i - nameStart;
		while (i < n && isSpace(html[i])) i++;
		// A valueless attribute (`<img hidden>`); re-read the delimiter at the top.
		if (html[i] !== '=') continue;
		i++;
		while (i < n && isSpace(html[i])) i++;

		const quote = html[i];
		let valueStart: number;
		let valueEnd: number;
		if (quote === '"' || quote === "'") {
			valueStart = i + 1;
			const close = html.indexOf(quote, valueStart);
			// Unterminated: a browser swallows the rest of the document as the value.
			valueEnd = close === -1 ? n : close;
			i = close === -1 ? n : close + 1;
		} else {
			valueStart = i;
			while (i < n && !isSpace(html[i]) && html[i] !== '>') i++;
			valueEnd = i;
		}

		if ((wantUrls || wantRel) && (nameLen === 3 || nameLen === 4)) {
			const name = html.slice(nameStart, nameStart + nameLen).toLowerCase();
			if (wantRel && name === 'rel') {
				rel = html.slice(valueStart, valueEnd).trim().toLowerCase();
			} else if (
				wantUrls &&
				!relative &&
				URL_ATTRS.has(name) &&
				!resolvesWithoutFolder(html.slice(valueStart, valueEnd))
			) {
				relative = true;
			}
		}
	}
	return { end: n, relative, rel };
}

/**
 * Index of the `</tag` that closes a raw-text body (`<script>`/`<style>`), or
 * -1 when the document never closes it.
 */
function rawTextEnd(html: string, from: number, tag: string): number {
	const n = html.length;
	let i = from;
	for (;;) {
		const lt = html.indexOf('</', i);
		if (lt === -1) return -1;
		let p = lt + 2;
		while (p < n && isSpace(html[p])) p++;
		if (html.slice(p, p + tag.length).toLowerCase() === tag) {
			const after = html[p + tag.length];
			if (after === undefined || !NAME_CHAR.test(after)) return lt;
		}
		i = lt + 2;
	}
}

/**
 * True when the document loads at least one subresource by a path relative to
 * the file on disk — i.e. content the sandboxed preview cannot resolve. A
 * self-contained export (everything inline, or CDN URLs) returns false.
 *
 * Markup a browser never fetches from — an HTML comment, an inert body
 * (`<script>`/`<style>`/`<textarea>`/`<title>`/`<template>`), the inside of an
 * attribute VALUE, or a `<link>` whose `rel` the browser does not fetch to
 * render — is skipped, so an inlined bundle cannot fake a reference the page
 * does not actually load. Under-reporting is the safe direction: a false notice
 * on a genuinely self-contained export is worse than a missing one, so anything
 * the scan cannot read confidently (an unterminated comment, quote or raw-text
 * body) ends the scan rather than convicting.
 *
 * Known misses, deliberately not chased — each needs its own parsing, and a
 * missed ref costs only the notice, not the render: `<img srcset>` (a
 * comma-separated descriptor list), `<video poster>`, and `url(…)` inside a
 * `<style>` body or a `style=` attribute. Plain `<a href>` is excluded by
 * design, per above.
 */
export function hasRelativeAssetRefs(html: string): boolean {
	const n = html.length;
	let i = 0;
	while (i < n) {
		const lt = html.indexOf('<', i);
		if (lt === -1) return false;
		if (html.startsWith('<!--', lt)) {
			const end = html.indexOf('-->', lt + 4);
			// Unterminated: a browser comments out the rest of the document.
			if (end === -1) return false;
			i = end + 3;
			continue;
		}

		const nameStart = lt + 1;
		let p = nameStart;
		while (p < n && NAME_CHAR.test(html[p])) p++;
		const nameLen = p - nameStart;
		if (nameLen === 0) {
			// A closing tag, or a bare `<` in text — neither opens an element.
			i = lt + 1;
			continue;
		}

		const tag = nameLen <= MAX_TAG_LEN ? html.slice(nameStart, p).toLowerCase() : '';
		const isLink = tag === 'link';
		const scanned = scanTag(html, p, SUBRESOURCE_TAGS.has(tag), isLink);
		if (scanned.relative && (!isLink || linkFetchesToRender(scanned.rel))) return true;
		i = scanned.end;

		if (RAW_TEXT_TAGS.has(tag)) {
			const close = rawTextEnd(html, i, tag);
			// Unterminated: a browser reads the rest of the document as raw text.
			if (close === -1) return false;
			i = close;
		}
	}
	return false;
}
