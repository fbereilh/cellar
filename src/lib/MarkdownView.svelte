<script lang="ts">
	import { browser } from '$app/environment';
	import { renderMarkdown } from '$lib/markdown';

	// Read-only rendered view of a full markdown document. Reuses the one markdown
	// engine + the shared `.cellar-md` styling (app.css), so a `.md` file preview
	// looks exactly like a rendered notebook markdown cell. Unlike a cell it does
	// not split on headings (no folding here), so the whole source renders as one
	// blob. DOMPurify needs a DOM, hence the `browser` guard.
	let { source = '' } = $props();

	const html = $derived(browser ? renderMarkdown(source) : '');
	const isEmpty = $derived(!source.trim());
</script>

<div class="cellar-md mx-auto max-w-[clamp(48rem,92%,88rem)] px-6 py-5 text-sm leading-relaxed" data-testid="markdown-preview">
	{#if isEmpty}
		<span class="text-base-content/30">Empty file</span>
	{:else}
		{@html html}
	{/if}
</div>
