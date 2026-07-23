<script lang="ts">
	/**
	 * Cellar — rendered preview of a whole `.html` file, inside a **sandboxed
	 * iframe**. This is the default view of an HTML file tab (a saved plotly /
	 * bokeh export or an nbconvert report just displays, like a browser); the
	 * tab's Preview/Source toggle swaps it for the CodeMirror editor.
	 *
	 * SECURITY — the file is untrusted content, so the frame is origin-isolated
	 * from the app exactly the way rich `text/html` cell outputs are
	 * (`HtmlOutput.svelte`, the precedent this follows):
	 *   • `sandbox="allow-scripts allow-popups"` and deliberately NOT
	 *     `allow-same-origin`. Scripts run — self-contained plots need them — but
	 *     in a unique OPAQUE origin, so the document cannot read the app's DOM,
	 *     cookies, `localStorage`, or same-origin `fetch`. Never add
	 *     `allow-same-origin` here: paired with `allow-scripts` it hands the file
	 *     the app's origin and the isolation is gone.
	 *   • `srcdoc` (not a URL served from the app's origin), so the app never
	 *     serves workspace HTML as `text/html` from its own origin — a route that
	 *     did would be a stored-XSS surface reachable outside any sandbox. This is
	 *     also why `/api/fs/raw` serves images only.
	 *   • The content is passed VERBATIM: no wrapper document, no injected script.
	 *     A full `<!doctype html>` export renders as authored.
	 *
	 * The one cost of that isolation is relative asset refs — see `htmlPreview.ts`
	 * `hasRelativeAssetRefs()`; the tab surfaces the limitation in one line rather
	 * than rendering a mysteriously empty page. A `srcdoc` document inherits the
	 * PARENT's base URL, so `report_files/x.js` is requested from the app and logs
	 * a harmless 404 (visible in the Logs console) before failing. A blob URL would
	 * silence that, but Chrome's blob-URL partitioning blocks blob fetches from an
	 * opaque origin — i.e. it would break the preview outright. `srcdoc` is the
	 * mechanism that keeps working; the 404 is the accepted cost.
	 *
	 * The iframe element itself paints white so a document that declares no
	 * background is readable under a dark app theme (an iframe's canvas is
	 * transparent, and rich HTML is authored for a light page) — the same
	 * convention as classic Jupyter / nbconvert. A document with its own
	 * background paints over it.
	 */
	interface Props {
		/** The file's current text (the live editor buffer, so unsaved edits preview). */
		source?: string;
		/** Shown when the page pulls sibling files the sandbox cannot resolve. */
		relativeAssets?: boolean;
	}
	let { source = '', relativeAssets = false }: Props = $props();

	const isEmpty = $derived(!source.trim());
</script>

<div class="flex h-full min-h-0 flex-col">
	{#if relativeAssets}
		<div
			class="flex items-start gap-2 border-b border-base-300 bg-warning/10 px-4 py-1.5 text-xs text-base-content/70"
			data-testid="html-preview-relative-assets"
		>
			<svg class="mt-px h-3.5 w-3.5 shrink-0 text-warning" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4" /><path d="M12 17h.01" /></svg>
			<span>This page loads files stored next to it. The sandboxed preview cannot reach the workspace, so those assets stay unloaded.</span>
		</div>
	{/if}
	{#if isEmpty}
		<div class="flex-1 p-6 text-sm text-base-content/30" data-testid="html-preview-empty">Empty file</div>
	{:else}
		<iframe
			title="HTML preview"
			srcdoc={source}
			sandbox="allow-scripts allow-popups"
			class="min-h-0 w-full flex-1 border-0 bg-white"
			data-testid="html-preview"
		></iframe>
	{/if}
</div>
