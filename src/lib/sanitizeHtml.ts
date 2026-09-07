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
 *   {@link opensInNewTab} is the one place that distinction is decided.
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

/** The elements that navigate on click and therefore carry the policy. */
const LINK_TAGS = new Set(['A', 'AREA']);

/**
 * Does this `href` leave the current document?
 *
 * Everything does, EXCEPT a same-document fragment. `#section` and a bare `#`
 * are handled entirely by the browser (set the hash, scroll to the target, no
 * request, no unload), so they must stay in place - see the module header. A
 * missing or empty `href` is not a navigation at all (and is what an `href`
 * DOMPurify REFUSED, e.g. `javascript:`, leaves behind), so it gets nothing.
 *
 * Note this is deliberately not "is the URL cross-origin": a relative `./x.csv`
 * or `?q=1` really does unload the Cellar tab, so it opens out like any other.
 */
export function opensInNewTab(href: string | null | undefined): boolean {
	const h = (href ?? '').trim();
	if (h === '') return false;
	return !h.startsWith('#');
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
	if (!LINK_TAGS.has(node.tagName)) return;
	if (!opensInNewTab(node.getAttribute('href'))) {
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
 * here - do not call `DOMPurify.sanitize` directly, or that surface silently
 * opts out of the policy (pinned by a source guard in
 * `tests/unit/rendered-link-target.test.ts`).
 */
export function sanitizeHtml(dirty: string, config?: Config): string {
	ensureLinkPolicy();
	return config ? DOMPurify.sanitize(dirty, config) : DOMPurify.sanitize(dirty);
}
