/**
 * Cellar - the ONE browser-side HTML sanitize boundary, and the ONE link-target
 * policy that rides on it.
 *
 * ## Why the two live together
 *
 * Cellar is a LIVE SESSION: the kernel, the running notebook and every unsaved
 * editor buffer live in the browser tab that renders them. A `<a href>` in a
 * markdown cell, in a model's chat reply, in a kernel's `display(Markdown(...))`
 * or in a widget's `text/html` repr therefore is not an ordinary link - clicking
 * it navigates that tab away and takes the session with it. So every link Cellar
 * RENDERS from notebook content opens in a new tab, with
 * `rel="noreferrer noopener"` so the opened page gets no handle on the window it
 * came from (the same pair `ChatPanel.svelte` and `Databricks.svelte` already
 * write by hand on their own hardcoded links).
 *
 * Applying it HERE - at the sanitize boundary - rather than at each renderer is
 * what makes it inheritable: `markdown.ts` funnels all three of its renderers
 * through one `sanitize()`, and the two widget surfaces sanitize raw `text/html`
 * directly, so a link cannot reach the page without passing through this
 * function. A renderer added later inherits the policy instead of having to
 * remember it.
 *
 * ## Why a DOMPurify HOOK rather than the markdown-it renderer
 *
 * DOMPurify's default attribute allowlist does NOT include `target`, so a
 * `target="_blank"` written by a markdown-it `link_open` rule is stripped a step
 * later and the whole thing is silently inert (measured, not assumed). The
 * alternatives are widening `ALLOWED_ATTR` - a deliberate widening of the
 * security surface `markdown.ts` pins the exact width of by test - or setting the
 * attribute AFTER the attribute filter has run, which is what
 * `afterSanitizeAttributes` is for. The hook also covers the raw-`text/html`
 * widget surfaces, which have no markdown-it at all.
 *
 * ## What is deliberately NOT covered
 *
 * - **Cellar's own chrome.** Nothing the app authors is sanitized, so no
 *   in-app navigation can reach this hook. Internal links keep navigating in
 *   place by construction, not by an exception in the rule.
 * - **A SAME-DOCUMENT anchor (`#section`, or a bare `#`).** Those do not
 *   navigate anywhere - the browser scrolls in place - so opening one in a new
 *   tab would be wrong, and would land the reader in a second copy of the app.
 *   {@link opensInNewTab} is the one place that distinction is decided, and it
 *   is the ONLY thing that stays in place: an EMPTY `href` does not (see there).
 * - **The iframed surfaces.** A rich `text/html` cell output
 *   (`HtmlOutput.svelte`) and the `.html` file preview (`HtmlPreview.svelte`)
 *   render inside a sandboxed iframe whose srcdoc already carries
 *   `<base target="_blank">`, and whose sandbox omits
 *   `allow-popups-to-escape-sandbox`, so a popup it opens inherits the frame's
 *   opaque origin and can reach neither `window.opener` nor Cellar's own origin.
 *   Those never pass through this function and need nothing from it.
 * - **The HTML export** (`server/export-html.ts`). That artifact is a file, not
 *   the live session, and it has no DOM and so no DOMPurify; opened inside
 *   Cellar it is the iframed preview above, which already opens its links out.
 */
import DOMPurify from 'dompurify';
import type { Config } from 'dompurify';

/**
 * The `rel` every new-tab link carries. `noopener` is what denies the opened
 * page a `window.opener` handle on the Cellar session; `noreferrer` implies it
 * and also withholds the referrer. Both are written, matching the pair the app's
 * hand-authored external links already use.
 */
export const NEW_TAB_REL = 'noreferrer noopener';

/**
 * The elements that navigate on click and therefore carry the policy, compared
 * against `localName` and NOT `tagName`.
 *
 * That is a correctness rule, not a style choice: only an element in the HTML
 * namespace uppercases its `tagName`, so an `<a>` inside an `<svg>` - which is
 * in the SVG namespace - reports `'a'` and silently missed an uppercase set,
 * bypassing the policy entirely. It is reachable: neither sanitize config
 * restricts `ALLOWED_TAGS`/`USE_PROFILES`, so DOMPurify's default profile keeps
 * SVG, and the two widget surfaces hand a kernel's raw `text/html` straight to
 * {@link sanitizeHtml}. `localName` is lowercase in both namespaces.
 */
const LINK_TAGS = new Set(['a', 'area']);

/**
 * SVG 1.1's link spelling, which browsers still honour and DOMPurify's default
 * profile still keeps (measured: `xlink:href` survives sanitizing on an SVG
 * `<a>`, and a `javascript:` value in it is refused exactly like the plain
 * spelling). So the policy has to read BOTH, or an `<svg><a xlink:href=...>`
 * navigates the live session away with no target on it.
 */
const XLINK_NS = 'http://www.w3.org/1999/xlink';

/**
 * The href this element would actually follow. `href` wins where both are
 * present (SVG 2's own precedence); the namespaced read is tried before the
 * qualified-name one because that is how the HTML parser stores `xlink:href`
 * inside foreign content.
 */
function linkHref(node: Element): string | null {
	const href = node.getAttribute('href');
	if (href !== null) return href;
	return node.getAttributeNS(XLINK_NS, 'href') ?? node.getAttribute('xlink:href');
}

/**
 * Does this `href` leave the current document?
 *
 * Everything does, EXCEPT a same-document fragment. `#section` and a bare `#`
 * are handled entirely by the browser (set the hash, scroll to the target, no
 * request, no unload), so they must stay in place - see the module header.
 *
 * ABSENT and EMPTY are different cases and must not share a branch:
 *
 * - `null`/`undefined` - there is no `href` attribute, so there is nothing to
 *   follow and a click does nothing. This is also what DOMPurify leaves behind
 *   when it REFUSES an href (a `javascript:` URL): it REMOVES the attribute
 *   rather than blanking it (measured). No target.
 * - `''` or whitespace-only - the attribute is PRESENT and empty, which
 *   resolves to the current document's URL, so a click RELOADS the Cellar tab
 *   and destroys the live session it holds (kernel, running notebook, unsaved
 *   editor buffers). That is precisely the harm this whole module exists to
 *   prevent, so it opens out like any other outbound link. It is reachable from
 *   ordinary content: markdown-it renders the empty link `[x]()` as
 *   `<a href="">`, and DOMPurify keeps an empty value. The cost is that a stray
 *   `[x]()` opens a SECOND Cellar tab - odd, but harmless (two tabs against one
 *   instance is a supported, tested arrangement: kernels are server-side and per
 *   notebook, and runs are serialized by the server-side run queue), and a
 *   destroyed session is not.
 *
 * Note this is deliberately not "is the URL cross-origin": a relative `./x.csv`
 * or `?q=1` really does unload the Cellar tab, so it opens out like any other.
 */
export function opensInNewTab(href: string | null | undefined): boolean {
	if (href === null || href === undefined) return false;
	return !href.trim().startsWith('#');
}

/**
 * Apply the policy to one already-sanitized element. Takes the element rather
 * than reaching for a document, so it is callable from the DOMPurify hook and
 * directly from a test.
 *
 * A link that stays in place has any `target` REMOVED rather than left alone:
 * the attribute cannot have come from Cellar (DOMPurify strips `target`, and
 * `html:false` escapes raw HTML in markdown anyway), so leaving one would mean
 * honoring a target from untrusted content on exactly the links this rule says
 * must not open a tab.
 */
export function applyLinkPolicy(node: Element): void {
	if (!LINK_TAGS.has(node.localName)) return;
	if (!opensInNewTab(linkHref(node))) {
		node.removeAttribute('target');
		return;
	}
	node.setAttribute('target', '_blank');
	node.setAttribute('rel', NEW_TAB_REL);
}

/**
 * DOMPurify's hooks are global to the instance, so the install is idempotent and
 * lazy: `DOMPurify.addHook` does not exist until a DOM does (the module's own
 * `isSupported` is false under plain Node), and every caller here is already
 * `browser`-guarded, so the first real sanitize is the first moment it can be
 * installed.
 */
let installed = false;
function ensureLinkPolicy(): void {
	if (installed || typeof DOMPurify.addHook !== 'function') return;
	DOMPurify.addHook('afterSanitizeAttributes', (node) => {
		applyLinkPolicy(node as Element);
	});
	installed = true;
}

/**
 * Sanitize untrusted HTML for rendering, applying the link policy above.
 *
 * Every browser-side `{@html}` of notebook / kernel / model content goes through
 * here - do not import `dompurify` for a value anywhere else, or that surface
 * silently opts out of the policy (pinned by a source guard in
 * `tests/unit/rendered-link-target.test.ts`, which flags any non-type import of
 * the module outside this file, so an alias or a re-exported wrapper cannot slip
 * past it either).
 */
export function sanitizeHtml(dirty: string, config?: Config): string {
	ensureLinkPolicy();
	return config ? DOMPurify.sanitize(dirty, config) : DOMPurify.sanitize(dirty);
}
